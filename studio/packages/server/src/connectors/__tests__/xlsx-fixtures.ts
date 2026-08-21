/**
 * xlsx fixtures, built byte by byte.
 *
 * The tree's convention is inline fixtures — `delimited-io.test.ts` writes its
 * CSV bytes as a string literal — and a `.xlsx` is a ZIP, so it cannot be a
 * string literal. The choice was a committed binary blob, an `exceljs`
 * devDependency, or a zip writer. It is the writer, for three reasons:
 *
 * 1. **Entry ORDER is the property under test.** #1213 disqualified
 *    `exceljs`'s streaming reader precisely because it reads shared strings and
 *    styles only when they precede the worksheet, and Excel writes them after.
 *    A fixture library that emits one fixed layout cannot express the test.
 * 2. **A writer library would author the fixture in its own dialect.** exceljs's
 *    writer produces a layout that crashes exceljs's own reader — so a fixture
 *    it authored would not be a real-Excel fixture.
 * 3. `licenseAudit.ts` audits dev tooling too, so a 78-package tree would join
 *    the license surface to author a test file.
 *
 * Nothing here is clever: STORED or raw-DEFLATE entries, a central directory,
 * an end-of-central-directory record. It exists to produce hostile and unusual
 * containers as easily as ordinary ones.
 */
import { deflateRawSync } from 'node:zlib';

/** CRC-32 (IEEE), the one thing a zip cannot be written without. Table-driven,
 * built once — `zlib.crc32` would do, but it is newer than this repo's stated
 * node floor and a fixture helper is not the place to depend on that. */
const CRC_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  readonly name: string;
  readonly data: string | Buffer;
  /** STORED keeps a fixture readable in a hex dump; DEFLATE is what real
   * writers emit, and is what exercises the inflate path (and the bomb cap). */
  readonly method?: 'store' | 'deflate';
}

/** Assemble a zip in EXACTLY the given entry order. */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflated = entry.method === 'store' ? raw : deflateRawSync(raw);
    const method = entry.method === 'store' ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + deflated.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// The xlsx parts.
// ---------------------------------------------------------------------------

export type CellSpec =
  /** A cell that is simply not in the XML — how Excel stores a blank. */
  | { readonly kind: 'blank' }
  | { readonly kind: 'inline'; readonly text: string }
  | { readonly kind: 'shared'; readonly text: string }
  /** Rich text: one `<si>` of several `<r><t>` runs, which must concatenate. */
  | { readonly kind: 'sharedRuns'; readonly runs: readonly string[] }
  | { readonly kind: 'number'; readonly value: number; readonly style?: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'error'; readonly code: string }
  | { readonly kind: 'formula'; readonly formula: string; readonly cached: string; readonly type?: 'str' | 'n' }
  | { readonly kind: 'isoDate'; readonly iso: string }
  /** Escape hatch for malformed / unusual cells. */
  | { readonly kind: 'raw'; readonly xml: string };

export interface SheetSpec {
  readonly name: string;
  readonly rows: readonly (readonly CellSpec[])[];
  /** Omit the `r` reference on every `<c>`, which the format permits — position
   * is then implicit. */
  readonly omitCellRefs?: boolean;
}

export interface WorkbookSpec {
  readonly sheets: readonly SheetSpec[];
  /** `cellXfs` entries, as numFmtIds. A cell's `style` indexes into this. */
  readonly cellXfs?: readonly number[];
  /** Custom `numFmt` id -> formatCode. */
  readonly numFmts?: Readonly<Record<number, string>>;
  readonly date1904?: boolean;
  /**
   * Where the parts land in the container. `excel` is the order Excel itself
   * writes — strings and styles AFTER the sheet — and is the layout that broke
   * both libraries measured in #1213.
   */
  readonly order?: 'excel' | 'strings-first' | 'rels-first';
  readonly method?: 'store' | 'deflate';
}

const colName = (index: number): string => {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface BuiltSheet {
  readonly xml: string;
}

function buildSheetXml(sheet: SheetSpec, shared: string[]): BuiltSheet {
  const rowsXml = sheet.rows
    .map((cells, rowIdx) => {
      const rowNum = rowIdx + 1;
      const cellsXml = cells
        .map((cell, colIdx) => {
          if (cell.kind === 'blank') return '';
          const ref = sheet.omitCellRefs === true ? '' : ` r="${colName(colIdx)}${rowNum}"`;
          switch (cell.kind) {
            case 'raw':
              return cell.xml;
            case 'inline':
              return `<c${ref} t="inlineStr"><is><t>${esc(cell.text)}</t></is></c>`;
            case 'shared': {
              const idx = shared.push(`<si><t>${esc(cell.text)}</t></si>`) - 1;
              return `<c${ref} t="s"><v>${idx}</v></c>`;
            }
            case 'sharedRuns': {
              const runs = cell.runs.map((r) => `<r><t>${esc(r)}</t></r>`).join('');
              const idx = shared.push(`<si>${runs}</si>`) - 1;
              return `<c${ref} t="s"><v>${idx}</v></c>`;
            }
            case 'number': {
              const style = cell.style === undefined ? '' : ` s="${cell.style}"`;
              return `<c${ref}${style}><v>${cell.value}</v></c>`;
            }
            case 'boolean':
              return `<c${ref} t="b"><v>${cell.value ? 1 : 0}</v></c>`;
            case 'error':
              return `<c${ref} t="e"><v>${esc(cell.code)}</v></c>`;
            case 'formula': {
              const t = cell.type === 'str' ? ' t="str"' : '';
              return `<c${ref}${t}><f>${esc(cell.formula)}</f><v>${esc(cell.cached)}</v></c>`;
            }
            case 'isoDate':
              return `<c${ref} t="d"><v>${cell.iso}</v></c>`;
          }
        })
        .join('');
      return `<row r="${rowNum}">${cellsXml}</row>`;
    })
    .join('');
  return {
    xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`,
  };
}

/** Build a workbook. Returns the zip bytes. */
export function buildXlsx(spec: WorkbookSpec): Buffer {
  const shared: string[] = [];
  const sheetXmls = spec.sheets.map((sheet) => buildSheetXml(sheet, shared));

  const sheetEntries = spec.sheets.map((sheet, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    xml: sheetXmls[i]!.xml,
    rid: `rId${i + 1}`,
    sheetName: sheet.name,
  }));

  const pr = spec.date1904 === true ? '<workbookPr date1904="1"/>' : '';
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${pr}<sheets>${sheetEntries
    .map((s, i) => `<sheet name="${esc(s.sheetName)}" sheetId="${i + 1}" r:id="${s.rid}"/>`)
    .join('')}</sheets></workbook>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetEntries
    .map(
      (s) =>
        `<Relationship Id="${s.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetEntries.indexOf(s) + 1}.xml"/>`,
    )
    .join('')}</Relationships>`;

  const sharedXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.join('')}</sst>`;

  const numFmtsXml =
    spec.numFmts === undefined
      ? ''
      : `<numFmts count="${Object.keys(spec.numFmts).length}">${Object.entries(spec.numFmts)
          .map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`)
          .join('')}</numFmts>`;
  const cellXfs = spec.cellXfs ?? [0];
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${numFmtsXml}<cellXfs count="${cellXfs.length}">${cellXfs
    .map((id) => `<xf numFmtId="${id}" xfId="0"/>`)
    .join('')}</cellXfs></styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdWb" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const parts: Record<string, string> = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rootRels,
    'xl/workbook.xml': workbookXml,
    'xl/_rels/workbook.xml.rels': relsXml,
    'xl/sharedStrings.xml': sharedXml,
    'xl/styles.xml': stylesXml,
  };
  for (const s of sheetEntries) parts[s.name] = s.xml;

  const sheetNames = sheetEntries.map((s) => s.name);
  const ORDERS: Record<NonNullable<WorkbookSpec['order']>, readonly string[]> = {
    // What Excel writes: strings and styles AFTER the worksheets.
    excel: [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      ...sheetNames,
      'xl/styles.xml',
      'xl/sharedStrings.xml',
    ],
    // The only layout exceljs's streaming reader reads correctly.
    'strings-first': [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/sharedStrings.xml',
      'xl/styles.xml',
      ...sheetNames,
    ],
    // What exceljs's own writeFile emits — rels before the sheets, workbook
    // after — the layout on which its reader throws.
    'rels-first': [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      ...sheetNames,
      'xl/sharedStrings.xml',
      'xl/styles.xml',
      'xl/workbook.xml',
    ],
  };

  const order = ORDERS[spec.order ?? 'excel'];
  return buildZip(order.map((name) => ({ name, data: parts[name]!, method: spec.method })));
}

/** Every entry order, so a test can assert the reader is indifferent to all. */
export const ALL_ORDERS = ['excel', 'strings-first', 'rels-first'] as const;
