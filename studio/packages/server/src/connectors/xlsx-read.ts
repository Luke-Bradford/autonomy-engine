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
 * Nothing is ever extracted to disk, so zip-slip does not arise. The four small
 * parts are fixed literal names; the worksheet's name comes from the workbook's
 * rels, but it is only ever a key into the in-memory entry Map built from the
 * container's own directory — never a filesystem path — so a hostile
 * `Relationship Target` can fail a lookup and nothing else.
 */
import { createRequire } from 'node:module';

import { SaxesParser, type SaxesTagPlain } from 'saxes';
import type { Entry, ZipFile } from 'yauzl';

import {
  COPY_BATCH_ROWS,
  XLSX_MAX_CELL_CHARS,
  XLSX_MAX_COLUMNS,
  XLSX_MAX_ENTRY_BYTES,
  XLSX_MAX_SHARED_STRINGS_BYTES,
  XLSX_MAX_SMALL_PART_BYTES,
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
  /** Already confined by the caller — this module opens what it is given. It
   * is also what every error message names, so it is required even when `fd`
   * is supplied. */
  readonly filePath: string;
  /** An ALREADY-OPEN descriptor, for a caller that needs `O_NOFOLLOW` to close
   * the lstat->open race. Ownership transfers: this module closes it. */
  readonly fd?: number | undefined;
  /** By NAME. Mutually exclusive with `sheetIndex`; see `resolveSheet`. */
  readonly sheet?: string | undefined;
  /** 1-BASED. */
  readonly sheetIndex?: number | undefined;
  readonly batchRows?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class XlsxReadError extends Error {
  /** `true` when re-running unchanged cannot help — a malformed or unsupported
   * container, a missing sheet, a value past a bound. Every failure this module
   * raises today is permanent; the flag exists because the caller's
   * `DatasetIoError` draws the same distinction, and a transient case (a
   * vanishing network mount, say) belongs to the layer that owns the path. */
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

/**
 * Open the container, by descriptor when one is given.
 *
 * `yauzl.open` does a plain `fs.open`, so a caller that must close the
 * lstat->open race cannot get there through a path. `confine.ts`'s docblock
 * names this exact hazard: `resolveWithinRoots` "does NOT close the
 * lstat->open race on its own ... a caller that hands the returned path to a
 * library which opens the file ITSELF gets the lstat check alone". So `fd` is
 * the supported route: the caller opens with `O_NOFOLLOW` and hands the
 * descriptor over.
 *
 * **Passing `fd` transfers OWNERSHIP.** Measured on yauzl 3.4.0: `close()`
 * closes the descriptor even under `autoClose:false`, so this module closes it
 * and the caller must not. `filePath` is still required, because it is what the
 * error messages name.
 */
function openZip(path: string, fd: number | undefined): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    // `lazyEntries` so the entry list is drained deliberately; `autoClose:false`
    // because entries are read by NAME after that drain, and yauzl would
    // otherwise close the handle at the end of it.
    const options = { lazyEntries: true, autoClose: false } as const;
    const onOpen = (err: Error | null, zip: ZipFile | undefined): void => {
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
    };
    if (fd === undefined) yauzl.open(path, options, onOpen);
    else yauzl.fromFd(fd, options, onOpen);
  });
}

function entryIndex(zip: ZipFile): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Entry>();
    const onEntry = (entry: Entry): void => {
      entries.set(entry.fileName, entry);
      zip.readEntry();
    };
    const onEnd = (): void => {
      // The drain is over; leaving these attached would be dead state on a
      // handle that outlives it. The ERROR listener deliberately stays for the
      // life of the handle: an EventEmitter 'error' with no listener THROWS,
      // and a late zip-level error would then take the process down. A late
      // error settles nothing here (the promise is already resolved) — the
      // read path surfaces its own failures, which is finding #1's fix.
      zip.removeListener('entry', onEntry);
      zip.removeListener('end', onEnd);
      resolve(entries);
    };
    zip.on('entry', onEntry);
    zip.on('end', onEnd);
    zip.on('error', (err: Error) =>
      reject(new XlsxReadError(`not a readable .xlsx: ${err.message}`)),
    );
    zip.readEntry();
  });
}

async function* entryChunks(
  zip: ZipFile,
  entry: Entry,
  maxBytes: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<Buffer> {
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
      signal?.throwIfAborted();
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
  } catch (err) {
    // yauzl validates entry sizes and CRCs on the ENTRY's own stream, not on
    // the zip-level 'error' channel, so a truncated or corrupt member arrives
    // here as a bare Error. Every failure this module raises is an
    // XlsxReadError carrying `permanent`; letting a raw one through would break
    // that contract for the most ordinary real-world damage there is.
    if (err instanceof XlsxReadError) throw err;
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new XlsxReadError(
      `${entry.fileName} could not be inflated: ${err instanceof Error ? err.message : String(err)}. ` +
        'The workbook is truncated or corrupt.',
    );
  } finally {
    (stream as unknown as { destroy?: () => void }).destroy?.();
  }
}

async function entryText(
  zip: ZipFile,
  entry: Entry,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const decoder = new TextDecoder('utf-8');
  let text = '';
  for await (const chunk of entryChunks(zip, entry, maxBytes, signal))
    text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

/**
 * Collect a saxes parser's first error.
 *
 * A holder object rather than a `let`, because the only writes happen inside
 * the callback and TS's control-flow analysis would otherwise narrow the
 * variable to `null` at every read. Both parsers in this module also use it as
 * the channel for their OWN refusals, so a failure raised inside a handler is
 * reported the same way as one saxes raises.
 */
function attachErrorHolder(parser: SaxesParser): { failure: Error | null } {
  const state: { failure: Error | null } = { failure: null };
  parser.on('error', (err) => {
    state.failure ??= err;
  });
  return state;
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
  const state = attachErrorHolder(parser);
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
  signal: AbortSignal | undefined,
): Promise<WorkbookParts> {
  const workbookEntry = entries.get('xl/workbook.xml');
  if (!workbookEntry) {
    throw new XlsxReadError(
      'the container has no xl/workbook.xml, so it is not a spreadsheet — an .xlsb workbook stores sheets as sheetN.bin and is not supported',
    );
  }

  const sheets: { name: string; rid: string | undefined }[] = [];
  let date1904 = false;
  walkXml(await entryText(zip, workbookEntry, XLSX_MAX_SMALL_PART_BYTES, signal), {
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
    walkXml(await entryText(zip, relsEntry, XLSX_MAX_SMALL_PART_BYTES, signal), {
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
    walkXml(await entryText(zip, sharedEntry, XLSX_MAX_SHARED_STRINGS_BYTES, signal), {
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
    walkXml(await entryText(zip, stylesEntry, XLSX_MAX_SMALL_PART_BYTES, signal), {
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

  const sheet = sheets[index]!;
  const { rid } = sheet;
  // Positional naming is a fallback for a sheet that declares NO rId — there
  // is nothing to resolve, so `sheet{n}.xml` is the only answer. It is NOT a
  // fallback for an rId the rels part never defines: that is a malformed
  // container, and guessing the position there reads whatever file happens to
  // sit at it — another sheet's data — while SUCCEEDING, the silent-wrong-data
  // outcome §6.2 exists to prevent. Refuse, naming the dangling rId.
  if (rid === undefined) return { target: `xl/worksheets/sheet${index + 1}.xml` };

  const relTarget = parts.rels.get(rid);
  if (relTarget === undefined) {
    throw new XlsxReadError(
      `sheet "${sheet.name}" points at relationship ${rid}, which this workbook does not define`,
    );
  }
  return { target: relTarget.startsWith('/') ? relTarget.slice(1) : `xl/${relTarget}` };
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
  // The 1900 system has no serial below 1: Excel renders 0 as the non-date
  // "1900-01-00" and cannot hold a negative one at all, so anything below 1 is
  // corrupt input rather than an early date. Letting it through would invent
  // plausible 1899 instants. The 1904 system genuinely starts at 0, so this is
  // 1900-only.
  if (!date1904 && serial < 1) {
    return {
      xlsxFault: 'phantom-date',
      detail: `serial ${serial} is before the 1900 date system begins`,
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

// Anchored on the WHOLE reference, not just its head. A leading-letters match
// would accept `A1B` and `A` as readily as `A1`, and each of those is a
// malformed cell that the caller must be able to tell apart from one carrying
// no `r` at all. Excel emits uppercase letters followed by a 1-based row,
// always.
const CELL_REF_RE = /^([A-Z]+)[1-9][0-9]*$/;

function columnIndexOf(ref: string): number | null {
  const match = CELL_REF_RE.exec(ref);
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
  // `while (pending.length >= batchRows) yield pending.splice(0, batchRows)`
  // does not terminate at 0 — the predicate always holds and every splice
  // yields an empty batch — so a caller's bad value would hang the server
  // rather than fail. Refuse it at the boundary instead.
  if (!Number.isInteger(batchRows) || batchRows < 1) {
    throw new XlsxReadError(`batchRows must be a positive integer; got ${batchRows}`);
  }
  const zip = await openZip(opts.filePath, opts.fd);

  try {
    const entries = await entryIndex(zip);
    const parts = await readWorkbookParts(zip, entries, opts.signal);
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
    let lastColumn = -1;

    let cellRef: string | undefined;
    let cellType = 'n';
    let cellStyle: string | undefined;
    let buffer = '';
    let inValue = false;
    let inText = false;
    let inInline = false;
    let sawValue = false;

    const parser = new SaxesParser();
    const state = attachErrorHolder(parser);

    parser.on('opentag', (tag: SaxesTagPlain) => {
      switch (tag.name) {
        case 'row': {
          const declared = tag.attributes['r'];
          if (declared === undefined) {
            rowNumber += 1;
          } else {
            // `Number()` alone accepted anything, so `r="abc"` bound NaN as the
            // row number and travelled WITH the data — a guess, where every
            // other malformed reference in this module refuses (§6.2).
            const parsed = Number(declared);
            if (!Number.isInteger(parsed) || parsed < 1) {
              state.failure ??= new XlsxReadError(
                `a row declares r="${declared}", which is not a positive row number`,
              );
            } else {
              rowNumber = parsed;
            }
          }
          cells = [];
          nextColumn = 0;
          lastColumn = -1;
          break;
        }
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
          // Absent and unparseable are DIFFERENT facts, and `?? nextColumn`
          // collapsed them. A cell declaring no `r` has only its position to go
          // on, and sequential placement is correct. A cell declaring an `r`
          // that will not parse is malformed, and placing it sequentially is a
          // guess that lands real data in the wrong column while SUCCEEDING —
          // §6.2's outcome, reached by the same route as the dangling rId.
          let column: number;
          if (cellRef === undefined) {
            column = nextColumn;
          } else {
            const parsed = columnIndexOf(cellRef);
            if (parsed === null) {
              state.failure ??= new XlsxReadError(
                `row ${rowNumber} declares cell r="${cellRef}", which is not a cell reference`,
              );
              cellRef = undefined;
              break;
            }
            column = parsed;
          }
          // Cells are declared left to right. A reference that goes BACKWARDS
          // (or repeats one already read) resolves to an index already written
          // and would silently REPLACE it — a value the operator authored would
          // vanish with the copy still reporting success. Real Excel never
          // emits this, so a workbook that does is malformed or hostile, and
          // §6.2's posture is to fail rather than guess.
          // The bytes are bounded; the index DERIVED from them is not, and
          // exponentially so — `r="ZZZZZZ1"` is fifteen bytes and decodes to
          // ~321 million, which the gap fill below would allocate synchronously.
          // Every `XLSX_MAX_*_BYTES` measures what ARRIVES and is blind to this.
          // XFD is the format's own last column, so past it is malformed rather
          // than merely large.
          if (column >= XLSX_MAX_COLUMNS) {
            state.failure ??= new XlsxReadError(
              `row ${rowNumber} declares cell ${cellRef ?? `column ${column + 1}`}, past the ` +
                `${XLSX_MAX_COLUMNS}-column ceiling the format allows`,
            );
            cellRef = undefined;
            break;
          }
          if (column <= lastColumn) {
            state.failure ??= new XlsxReadError(
              `row ${rowNumber} declares cell ${cellRef ?? `column ${column + 1}`} after a later ` +
                'column; refusing rather than overwriting a value already read',
            );
            cellRef = undefined;
            break;
          }
          lastColumn = column;
          nextColumn = column + 1;
          // An interior gap is a BLANK cell, and binds null rather than
          // `undefined`: Excel omits blanks from the XML entirely, and
          // `coerceValue` reads `undefined` as `absent_value` and fails the row.
          while (cells.length < column) cells.push(null);
          cells[column] = materialise(cellType, buffer, cellStyle, sawValue, parts, state);
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
    for await (const chunk of entryChunks(zip, sheetEntry, XLSX_MAX_ENTRY_BYTES, opts.signal)) {
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

/**
 * `state` is the same failure holder the caller uses for a backwards column
 * ref: a refusal is RECORDED and raised by `throwIfMalformed` after the current
 * `parser.write`, because saxes calls this synchronously from inside its own
 * event dispatch and a throw across that boundary is not the module's contract.
 * The returned value after a refusal is never read.
 */
function materialise(
  type: string,
  raw: string,
  style: string | undefined,
  sawValue: boolean,
  parts: WorkbookParts,
  state: { failure: Error | null },
): XlsxCell {
  if (!sawValue) return null;

  switch (type) {
    case 's': {
      // A shared-string cell is a REFERENCE, so one that does not resolve is a
      // corrupt container, not a blank cell — and the two failure shapes here
      // are both silent without this guard. `Number('')` is 0, so an empty
      // `<v>` would return the table's FIRST string: an unrelated cell's value
      // wearing this cell's position, which is worse than a blank because it
      // looks like data. An index past the end would read as an ordinary blank,
      // turning a truncated workbook into an apparently-successful import.
      const index = Number(raw);
      if (raw === '' || !Number.isInteger(index) || index < 0 || index >= parts.shared.length) {
        state.failure ??= new XlsxReadError(
          `a cell references shared string ${JSON.stringify(raw)}, which this workbook's ` +
            `table of ${parts.shared.length} does not hold`,
        );
        return null;
      }
      return parts.shared[index]!;
    }
    case 'inlineStr':
    case 'str':
      // An empty string here is a genuine empty-string VALUE, distinct from the
      // absent cell `sawValue` already handled above. It survives intact.
      return raw;
    case 'b':
      // ECMA-376 admits 0/1; `true`/`false` appear in the wild. Anything else is
      // malformed, and folding it to `false` would be exactly the silent guess
      // that `workingVal || ''` cost `xlsx-stream-reader` its place in #1213.
      if (raw === '1' || raw === 'true') return true;
      if (raw === '0' || raw === 'false') return false;
      state.failure ??= new XlsxReadError(
        `a boolean cell holds ${JSON.stringify(raw)}, which is neither 0 nor 1`,
      );
      return null;
    case 'e':
      return { xlsxFault: 'error-cell', detail: raw };
    case 'd': {
      // ECMA-376 §18.17.4's date form carries NO zone, and ECMA-262 parses a
      // zone-less date-TIME in the HOST's zone: measured under
      // TZ=America/New_York, "2026-08-21T00:00:00" reads as 04:00Z. That
      // smuggles the server's offset into the operator's data — the one thing
      // §6.2 forbids by name, and which `serialToInstant` is scrupulous about.
      // Absent an explicit designator the value is UTC. An explicit offset is
      // honoured, so a writer that emits one is not second-guessed.
      const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
      const parsed = new Date(zoned ? raw : `${raw}Z`);
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
export async function listXlsxSheetNames(
  filePath: string,
  opts: { readonly fd?: number | undefined; readonly signal?: AbortSignal | undefined } = {},
): Promise<readonly string[]> {
  const zip = await openZip(filePath, opts.fd);
  try {
    const entries = await entryIndex(zip);
    const parts = await readWorkbookParts(zip, entries, opts.signal);
    return parts.sheets.map((s) => s.name);
  } finally {
    zip.close();
  }
}
