/**
 * A bounded, streaming xlsx row reader (§5), built rather than taken.
 *
 * ## Why this is hand-rolled
 *
 * M11's dependency row (`2026-08-14-foundation-data-movement.md` §12) said *"an
 * xlsx reader — xlsx is a ZIP container; most readers materialise the sheet,
 * which fights §5 — check before choosing"*. That check was run (#1213) and
 * both candidates were disqualified on CORRECTNESS, which is a sharper problem
 * than materialisation:
 *
 * - `exceljs@4.4.0`'s streaming reader resolves shared strings and number
 *   formats only if `xl/sharedStrings.xml` and `xl/styles.xml` PRECEDE the
 *   worksheet in the zip, because it is a single forward pass. Excel writes
 *   them after. Measured on identical bytes in two entry orders, the real-Excel
 *   order returned `{sharedString: 9}` for every string and a raw serial for
 *   every date. On the layout exceljs's own `writeFile` emits it throws outright
 *   (`this.model.sheets`, unguarded). Its non-streaming reader is correct and
 *   peaked at 1001 MB RSS on a 6.8 MB workbook, OOM-crashing under a 128 MB heap.
 * - `xlsx-stream-reader@1.1.1` is order-independent, but `lib/worksheet.js:272`
 *   ends `workingVal || ''`, so `0`, `false` and `''` all return `''`. Every
 *   genuine zero becomes indistinguishable from a blank cell.
 *
 * M7 answered its own *"a CSV parser"* row the same way, hand-rolling
 * `shared/datamove/delimited.ts`. The difference here is that only the SHEET
 * grammar is hand-rolled: `yauzl` supplies random access and `saxes` the XML.
 *
 * **Random access is the whole design.** Reading the small parts by NAME —
 * `workbook.xml`, its rels, `sharedStrings.xml`, `styles.xml` — makes zip entry
 * order irrelevant BY CONSTRUCTION, which is the exact property exceljs cannot
 * have. Only `xl/worksheets/sheetN.xml`, the large part, is streamed.
 *
 * ## Why `server/` and not `shared/datamove/` beside `delimited.ts`
 *
 * `shared` is bundled into the WEB app, and `yauzl`/`saxes` must not reach a
 * browser. The asymmetry with `delimited.ts` is deliberate, not an oversight:
 * a CSV grammar is pure string work and belongs in `shared`; this needs a file
 * descriptor and a zip.
 *
 * ## What is bounded, and what is not
 *
 * Rows stream, so memory is proportional to DISTINCT STRINGS plus one row
 * batch — never to row count. The string table is inherent to the format: cells
 * hold indices into it, so no cell resolves until it is in hand. `limits.ts`'s
 * `XLSX_MAX_*` make that a guarantee rather than a hope, and inflation is
 * counted as it ARRIVES because a zip's declared `uncompressedSize` is
 * attacker-controlled.
 *
 * Nothing is ever extracted to disk, so zip-slip does not arise; entries are
 * read by exact name and their paths are never joined to anything.
 */
import { createRequire } from 'node:module';

import { SaxesParser, type SaxesTagPlain } from 'saxes';
import type { Entry, ZipFile } from 'yauzl';

import {
  COPY_BATCH_ROWS,
  XLSX_MAX_CELL_CHARS,
  XLSX_MAX_ENTRY_BYTES,
  XLSX_MAX_SHARED_STRINGS_BYTES,
} from '../limits.js';
import { yieldToEventLoop } from './scheduling.js';

// yauzl is CJS with a callback API. `createRequire` keeps the import shape
// stable under TS strict ESM, where a default-vs-namespace guess differs
// between the server build and the web build's stricter tsc.
const require = createRequire(import.meta.url);
const yauzl = require('yauzl') as typeof import('yauzl');

/**
 * A cell the coercion matrix must REFUSE.
 *
 * The reader has no per-row error channel — `delimited-io.ts`'s `bindRow`
 * records the same constraint — so a cell that cannot be represented has to
 * travel AS a value, and the value has to be one `coerceValue` rejects for
 * every target type. An object does: `toStringValue` ends
 * `unsupported_source_type`, so the row fails (or nulls under `onError:'null'`)
 * and is counted, instead of `"#N/A"` landing in a text column looking like data.
 */
export interface XlsxCellFault {
  readonly xlsxFault: 'error-cell' | 'phantom-date';
  readonly detail: string;
}

export type XlsxCell = string | number | boolean | Date | XlsxCellFault | null;

export interface XlsxRow {
  /** The sheet's own 1-based row number, so a gap is visible rather than closed. */
  readonly rowNumber: number;
  /** Indexed from column A. An interior blank is `null`; trailing blanks are absent. */
  readonly cells: readonly XlsxCell[];
}

export interface ReadXlsxOptions {
  /** Already confined by the caller — this module opens what it is given. */
  readonly filePath: string;
  /** By NAME. Mutually exclusive with `sheetIndex`; see `resolveSheet`. */
  readonly sheet?: string | undefined;
  /** 1-BASED. */
  readonly sheetIndex?: number | undefined;
  readonly batchRows?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class XlsxReadError extends Error {
  /** `true` when re-running unchanged cannot help — a malformed or unsupported
   * container, a missing sheet, a value past a bound. */
  readonly permanent: boolean;

  constructor(message: string, permanent = true) {
    super(message);
    this.name = 'XlsxReadError';
    this.permanent = permanent;
  }
}

// ---------------------------------------------------------------------------
// zip plumbing
// ---------------------------------------------------------------------------

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    // `lazyEntries` so the entry list is drained deliberately; `autoClose:false`
    // because entries are read by NAME after that drain, and yauzl would
    // otherwise close the handle at the end of it.
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) {
        reject(
          new XlsxReadError(
            `not a readable .xlsx: ${err?.message ?? 'the file could not be opened'}. ` +
              'A .xls, .xlsb or password-protected workbook is not a zip and cannot be read here.',
          ),
        );
        return;
      }
      resolve(zip);
    });
  });
}

function entryIndex(zip: ZipFile): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Entry>();
    zip.on('entry', (entry: Entry) => {
      entries.set(entry.fileName, entry);
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', (err: Error) =>
      reject(new XlsxReadError(`not a readable .xlsx: ${err.message}`)),
    );
    zip.readEntry();
  });
}

async function* entryChunks(zip: ZipFile, entry: Entry, maxBytes: number): AsyncGenerator<Buffer> {
  const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zip.openReadStream(entry, (err, s) => {
      if (err || !s) {
        reject(
          new XlsxReadError(`could not read ${entry.fileName}: ${err?.message ?? 'no stream'}`),
        );
        return;
      }
      resolve(s);
    });
  });

  let seen = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      // The DECLARED uncompressedSize is attacker-controlled, so the bound is
      // on what actually arrives.
      seen += chunk.length;
      if (seen > maxBytes) {
        throw new XlsxReadError(
          `${entry.fileName} inflates past ${maxBytes} bytes; refusing rather than reading it into memory`,
        );
      }
      yield chunk;
    }
  } finally {
    (stream as unknown as { destroy?: () => void }).destroy?.();
  }
}

async function entryText(zip: ZipFile, entry: Entry, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder('utf-8');
  let text = '';
  for await (const chunk of entryChunks(zip, entry, maxBytes))
    text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

/** Walk an XML string with saxes. saxes hands `closetag` a TAG OBJECT, not a
 * name, and throws from `write()` unless an error handler is attached. */
function walkXml(
  xml: string,
  handlers: {
    open?: (tag: SaxesTagPlain) => void;
    text?: (text: string) => void;
    close?: (tag: SaxesTagPlain) => void;
  },
): void {
  const parser = new SaxesParser();
  // A holder rather than a `let`: the only writes happen inside the error
  // callback, and TS's control-flow analysis would otherwise narrow the
  // variable to `null` at every read.
  const state: { failure: Error | null } = { failure: null };
  parser.on('error', (err) => {
    state.failure ??= err;
  });
  if (handlers.open) parser.on('opentag', handlers.open);
  if (handlers.text) parser.on('text', handlers.text);
  if (handlers.close) parser.on('closetag', handlers.close);
  parser.write(xml).close();
  if (state.failure) throw new XlsxReadError(`malformed xlsx XML: ${state.failure.message}`);
}

// ---------------------------------------------------------------------------
// the small parts
// ---------------------------------------------------------------------------

interface WorkbookParts {
  readonly sheets: readonly { readonly name: string; readonly rid: string | undefined }[];
  readonly date1904: boolean;
  readonly rels: ReadonlyMap<string, string>;
  readonly shared: readonly string[];
  /** Indexed by `cellXfs` position: does that style bear a DATE? */
  readonly styleIsDate: readonly boolean[];
}

/**
 * Builtin number formats that carry a DATE.
 *
 * Deliberately not "everything date-ish". 18-21 are times of day and 45-47 are
 * DURATIONS — `[h]:mm:ss` over `30.5` means 732 elapsed hours, and rendering
 * that as 1900-01-30T12:00Z is exactly the corruption §6.2 forbids. 22
 * (`m/d/yy h:mm`) does bear a date and is included.
 *
 * The locale date formats (27-36, 50-58) are NOT included, which is a knowing
 * omission with a safe failure: such a cell reads as a number, and a number
 * coerced to a `date` column FAILS the row visibly rather than landing a wrong
 * instant. Widening this set is additive when a workbook needs it.
 */
const BUILTIN_DATE_FORMATS: ReadonlySet<number> = new Set([14, 15, 16, 17, 22]);

/** A custom formatCode bears a date if, once literals are stripped, it still
 * mentions a year or a day. `m` alone is ambiguous — it is MINUTES next to `h`
 * or `s` — so it is not sufficient on its own. */
function formatCodeIsDate(code: string): boolean {
  const bare = code
    .replace(/\[[^\]]*\]/g, '') // [h], [$-409], colour tokens
    .replace(/"[^"]*"/g, '') // quoted literals
    .replace(/\\./g, ''); // escaped characters
  return /[yd]/i.test(bare);
}

async function readWorkbookParts(
  zip: ZipFile,
  entries: ReadonlyMap<string, Entry>,
): Promise<WorkbookParts> {
  const workbookEntry = entries.get('xl/workbook.xml');
  if (!workbookEntry) {
    throw new XlsxReadError(
      'the container has no xl/workbook.xml, so it is not a spreadsheet — an .xlsb workbook stores sheets as sheetN.bin and is not supported',
    );
  }

  const sheets: { name: string; rid: string | undefined }[] = [];
  let date1904 = false;
  walkXml(await entryText(zip, workbookEntry, XLSX_MAX_ENTRY_BYTES), {
    open: (tag) => {
      if (tag.name === 'sheet') {
        sheets.push({ name: tag.attributes['name'] ?? '', rid: tag.attributes['r:id'] });
      }
      if (tag.name === 'workbookPr') {
        const flag = tag.attributes['date1904'];
        if (flag === '1' || flag === 'true') date1904 = true;
      }
    },
  });

  const rels = new Map<string, string>();
  const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
  if (relsEntry) {
    walkXml(await entryText(zip, relsEntry, XLSX_MAX_ENTRY_BYTES), {
      open: (tag) => {
        if (tag.name === 'Relationship') {
          const id = tag.attributes['Id'];
          const target = tag.attributes['Target'];
          if (id !== undefined && target !== undefined) rels.set(id, target);
        }
      },
    });
  }

  const shared: string[] = [];
  const sharedEntry = entries.get('xl/sharedStrings.xml');
  if (sharedEntry) {
    let current: string | null = null;
    let inText = false;
    walkXml(await entryText(zip, sharedEntry, XLSX_MAX_SHARED_STRINGS_BYTES), {
      open: (tag) => {
        if (tag.name === 'si') current = '';
        // Rich text is <si><r><t>..</t></r><r><t>..</t></r></si>; every run's
        // text belongs to one value.
        if (tag.name === 't') inText = true;
      },
      text: (text) => {
        if (current !== null && inText) current += text;
      },
      close: (tag) => {
        if (tag.name === 't') inText = false;
        if (tag.name === 'si') {
          shared.push(current ?? '');
          current = null;
        }
      },
    });
  }

  const styleIsDate: boolean[] = [];
  const stylesEntry = entries.get('xl/styles.xml');
  if (stylesEntry) {
    const custom = new Map<number, string>();
    let inCellXfs = false;
    walkXml(await entryText(zip, stylesEntry, XLSX_MAX_ENTRY_BYTES), {
      open: (tag) => {
        if (tag.name === 'numFmt') {
          const id = Number(tag.attributes['numFmtId']);
          const code = tag.attributes['formatCode'];
          if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
        }
        if (tag.name === 'cellXfs') inCellXfs = true;
        if (tag.name === 'xf' && inCellXfs) {
          const id = Number(tag.attributes['numFmtId'] ?? '0');
          const code = custom.get(id);
          styleIsDate.push(
            BUILTIN_DATE_FORMATS.has(id) || (code !== undefined && formatCodeIsDate(code)),
          );
        }
      },
      close: (tag) => {
        if (tag.name === 'cellXfs') inCellXfs = false;
      },
    });
  }

  return { sheets, date1904, rels, shared, styleIsDate };
}

/**
 * Pick the sheet.
 *
 * `sheet` and `sheetIndex` are separate inputs rather than one name-or-index
 * value, because a worksheet can legitimately be NAMED `"3"`. Collapsing them
 * would make that sheet unaddressable and — worse — would read a DIFFERENT
 * sheet while succeeding. A sheet that does not exist is refused, listing what
 * is there; falling back to the first would copy the wrong data silently.
 */
function resolveSheet(parts: WorkbookParts, opts: ReadXlsxOptions): { target: string } {
  const { sheets } = parts;
  if (sheets.length === 0) throw new XlsxReadError('the workbook declares no sheets');

  let index: number;
  if (opts.sheet !== undefined) {
    index = sheets.findIndex((s) => s.name === opts.sheet);
    if (index < 0) {
      const names = sheets.map((s) => `"${s.name}"`).join(', ');
      throw new XlsxReadError(`no sheet named "${opts.sheet}" in this workbook; it has ${names}`);
    }
  } else if (opts.sheetIndex !== undefined) {
    if (
      !Number.isInteger(opts.sheetIndex) ||
      opts.sheetIndex < 1 ||
      opts.sheetIndex > sheets.length
    ) {
      throw new XlsxReadError(
        `sheet index ${opts.sheetIndex} is out of range; this workbook has only ${sheets.length} sheet(s)`,
      );
    }
    index = opts.sheetIndex - 1;
  } else {
    index = 0;
  }

  const rid = sheets[index]!.rid;
  const relTarget = rid === undefined ? undefined : parts.rels.get(rid);
  // Fall back to positional naming only when the workbook carries no rels at
  // all; a present-but-unmatched rId is a malformed container, not a default.
  const target =
    relTarget === undefined
      ? `xl/worksheets/sheet${index + 1}.xml`
      : relTarget.startsWith('/')
        ? relTarget.slice(1)
        : `xl/${relTarget}`;
  return { target };
}

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const EPOCH_1900 = Date.UTC(1900, 0, 1);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/**
 * Excel serial -> UTC instant.
 *
 * The 1900 workbook deliberately reproduces Lotus 1-2-3's belief that 1900 was
 * a leap year, so serial 60 denotes 1900-02-29 — a day that never existed — and
 * every serial after it is shifted by one. Serial 60 is therefore REFUSED: it
 * cannot be represented, and mapping it to 1900-03-01 would make it
 * indistinguishable from serial 61.
 */
function serialToInstant(serial: number, date1904: boolean): Date | XlsxCellFault {
  if (!Number.isFinite(serial)) {
    return { xlsxFault: 'phantom-date', detail: `${serial} is not a finite date serial` };
  }
  if (!date1904 && serial >= 60 && serial < 61) {
    return {
      xlsxFault: 'phantom-date',
      detail: 'serial 60 is Excel’s 1900-02-29, a date that never existed',
    };
  }

  let days: number;
  let base: number;
  if (date1904) {
    days = serial;
    base = EPOCH_1904;
  } else {
    days = serial - 1;
    if (serial >= 61) days -= 1;
    base = EPOCH_1900;
  }

  const ms = base + Math.round(days * MS_PER_DAY);
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) {
    return {
      xlsxFault: 'phantom-date',
      detail: `serial ${serial} is outside the representable range`,
    };
  }
  return new Date(ms);
}

const COLUMN_RE = /^([A-Z]+)/;

function columnIndexOf(ref: string): number | null {
  const match = COLUMN_RE.exec(ref);
  if (!match) return null;
  let index = 0;
  for (const ch of match[1]!) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

// ---------------------------------------------------------------------------
// the sheet
// ---------------------------------------------------------------------------

/**
 * Stream one worksheet's rows, in batches.
 *
 * Batching mirrors `readDelimitedDatasetBatches`: `COPY_BATCH_ROWS` by default,
 * an abort check at every batch boundary and every inflated chunk, and
 * `yieldToEventLoop` between batches so a long sheet cannot starve the server
 * (§9).
 */
export async function* readXlsxRowBatches(
  opts: ReadXlsxOptions,
): AsyncGenerator<readonly XlsxRow[]> {
  const batchRows = opts.batchRows ?? COPY_BATCH_ROWS;
  const zip = await openZip(opts.filePath);

  try {
    const entries = await entryIndex(zip);
    const parts = await readWorkbookParts(zip, entries);
    const { target } = resolveSheet(parts, opts);

    const sheetEntry = entries.get(target);
    if (!sheetEntry)
      throw new XlsxReadError(
        `the workbook names a sheet at ${target}, which the container does not hold`,
      );

    const pending: XlsxRow[] = [];
    let rowNumber = 0;
    let cells: XlsxCell[] = [];
    let nextColumn = 0;

    let cellRef: string | undefined;
    let cellType = 'n';
    let cellStyle: string | undefined;
    let buffer = '';
    let inValue = false;
    let inText = false;
    let inInline = false;
    let sawValue = false;

    const parser = new SaxesParser();
    const state: { failure: Error | null } = { failure: null };
    parser.on('error', (err) => {
      state.failure ??= err;
    });

    parser.on('opentag', (tag: SaxesTagPlain) => {
      switch (tag.name) {
        case 'row':
          rowNumber = Number(tag.attributes['r'] ?? rowNumber + 1);
          cells = [];
          nextColumn = 0;
          break;
        case 'c':
          cellRef = tag.attributes['r'];
          cellType = tag.attributes['t'] ?? 'n';
          cellStyle = tag.attributes['s'];
          buffer = '';
          sawValue = false;
          break;
        case 'v':
          inValue = true;
          sawValue = true;
          break;
        case 'is':
          inInline = true;
          sawValue = true;
          break;
        case 't':
          if (inInline) inText = true;
          break;
        default:
          break;
      }
    });

    parser.on('text', (text: string) => {
      // Text counts ONLY inside <v> or an inline <t>. That is what excludes a
      // formula's own text: <f>SUM(A1:A2)</f> is neither, so a formula cell
      // yields its cached <v> and never the expression that produced it.
      if (!inValue && !inText) return;
      buffer += text;
      if (buffer.length > XLSX_MAX_CELL_CHARS) {
        state.failure ??= new XlsxReadError(
          `a cell exceeds ${XLSX_MAX_CELL_CHARS} characters; refusing rather than accumulating it`,
        );
        buffer = '';
      }
    });

    parser.on('closetag', (tag: SaxesTagPlain) => {
      switch (tag.name) {
        case 'v':
          inValue = false;
          break;
        case 't':
          inText = false;
          break;
        case 'is':
          inInline = false;
          break;
        case 'c': {
          const column =
            cellRef === undefined ? nextColumn : (columnIndexOf(cellRef) ?? nextColumn);
          nextColumn = column + 1;
          // An interior gap is a BLANK cell, and binds null rather than
          // `undefined`: Excel omits blanks from the XML entirely, and
          // `coerceValue` reads `undefined` as `absent_value` and fails the row.
          while (cells.length < column) cells.push(null);
          cells[column] = materialise(cellType, buffer, cellStyle, sawValue, parts);
          cellRef = undefined;
          break;
        }
        case 'row':
          pending.push({ rowNumber, cells });
          cells = [];
          break;
        default:
          break;
      }
    });

    const decoder = new TextDecoder('utf-8');
    for await (const chunk of entryChunks(zip, sheetEntry, XLSX_MAX_ENTRY_BYTES)) {
      opts.signal?.throwIfAborted();
      // `{ stream: true }` so a multi-byte character split across an inflate
      // chunk boundary is not corrupted.
      parser.write(decoder.decode(chunk, { stream: true }));
      throwIfMalformed(state.failure);

      while (pending.length >= batchRows) {
        opts.signal?.throwIfAborted();
        yield pending.splice(0, batchRows);
        await yieldToEventLoop();
      }
    }
    parser.write(decoder.decode()).close();
    throwIfMalformed(state.failure);

    while (pending.length > 0) {
      opts.signal?.throwIfAborted();
      yield pending.splice(0, batchRows);
      if (pending.length > 0) await yieldToEventLoop();
    }
  } finally {
    // Reached by the generator's `.return()` too, which is the COMMON path:
    // a drift check reads one row and stops. Without this each check would
    // leak a descriptor.
    zip.close();
  }
}

function throwIfMalformed(failure: Error | null): void {
  if (!failure) return;
  throw failure instanceof XlsxReadError
    ? failure
    : new XlsxReadError(`malformed sheet XML: ${failure.message}`);
}

function materialise(
  type: string,
  raw: string,
  style: string | undefined,
  sawValue: boolean,
  parts: WorkbookParts,
): XlsxCell {
  if (!sawValue) return null;

  switch (type) {
    case 's': {
      const index = Number(raw);
      return parts.shared[index] ?? null;
    }
    case 'inlineStr':
    case 'str':
      return raw;
    case 'b':
      return raw === '1' || raw === 'true';
    case 'e':
      return { xlsxFault: 'error-cell', detail: raw };
    case 'd': {
      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime())
        ? { xlsxFault: 'phantom-date', detail: `"${raw}" is not a readable ISO date` }
        : parsed;
    }
    default: {
      if (raw === '') return null;
      const value = Number(raw);
      if (Number.isNaN(value)) return raw;
      const isDate = style !== undefined && parts.styleIsDate[Number(style)] === true;
      return isDate ? serialToInstant(value, parts.date1904) : value;
    }
  }
}

/** The sheet names, without reading a row — §2.1's "nothing is opened" posture
 * for an address is not available here (the container must be opened), but no
 * worksheet is streamed. */
export async function listXlsxSheetNames(filePath: string): Promise<readonly string[]> {
  const zip = await openZip(filePath);
  try {
    const entries = await entryIndex(zip);
    const parts = await readWorkbookParts(zip, entries);
    return parts.sheets.map((s) => s.name);
  } finally {
    zip.close();
  }
}
