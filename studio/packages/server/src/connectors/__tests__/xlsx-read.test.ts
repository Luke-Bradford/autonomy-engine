import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { coerceValue } from '@autonomy-studio/shared';

import {
  XlsxReadError,
  listXlsxSheetNames,
  readXlsxRowBatches,
  type XlsxCell,
  type XlsxRow,
} from '../xlsx-read.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';
import { ALL_ORDERS, buildXlsx, buildZip, type WorkbookSpec } from './xlsx-fixtures.js';

afterAll(() => {
  cleanupTempRoots();
});

const root = tempRoot('xlsx-read');
let seq = 0;

function seed(spec: WorkbookSpec): string {
  seq += 1;
  const path = join(root, `book-${seq}.xlsx`);
  writeFileSync(path, buildXlsx(spec));
  return path;
}

async function readAll(
  path: string,
  opts: { sheet?: string; sheetIndex?: number; batchRows?: number; signal?: AbortSignal } = {},
): Promise<XlsxRow[]> {
  const rows: XlsxRow[] = [];
  for await (const batch of readXlsxRowBatches({ filePath: path, ...opts })) rows.push(...batch);
  return rows;
}

const cellsOf = (rows: readonly XlsxRow[]): XlsxCell[][] => rows.map((r) => [...r.cells]);

describe('readXlsxRowBatches — the container', () => {
  it('reads the same rows whichever ORDER the zip entries are in', async () => {
    // The property both measured libraries failed. exceljs resolves shared
    // strings only when they precede the sheet, and Excel writes them after.
    const spec = (order: WorkbookSpec['order']): WorkbookSpec => ({
      order,
      cellXfs: [0, 14],
      sheets: [
        {
          name: 'Data',
          rows: [
            [
              { kind: 'shared', text: 'name' },
              { kind: 'shared', text: 'when' },
            ],
            [
              { kind: 'shared', text: 'ada' },
              { kind: 'number', value: 43833, style: 1 },
            ],
          ],
        },
      ],
    });

    const results = await Promise.all(ALL_ORDERS.map(async (o) => cellsOf(await readAll(seed(spec(o))))));

    const expected = [['name', 'when'], ['ada', new Date('2020-01-03T00:00:00.000Z')]];
    for (const result of results) expect(result).toEqual(expected);
  });

  it('refuses a file that is not a zip, naming the likely cause', async () => {
    seq += 1;
    const path = join(root, `notzip-${seq}.xlsx`);
    writeFileSync(path, 'this is a .xls, or a CSV somebody renamed');

    await expect(readAll(path)).rejects.toThrowError(XlsxReadError);
    await expect(readAll(path)).rejects.toThrowError(/not a readable \.xlsx/i);
  });

  it('refuses a zip that carries no workbook part', async () => {
    seq += 1;
    const path = join(root, `nowb-${seq}.xlsx`);
    writeFileSync(path, buildZip([{ name: 'sheetN.bin', data: 'binary workbook' }]));

    await expect(readAll(path)).rejects.toThrowError(/xl\/workbook\.xml/);
  });
});

describe('readXlsxRowBatches — sheet selection', () => {
  const twoSheets: WorkbookSpec = {
    sheets: [
      { name: 'First', rows: [[{ kind: 'inline', text: 'a' }]] },
      { name: 'Second', rows: [[{ kind: 'inline', text: 'b' }]] },
    ],
  };

  it('selects by NAME', async () => {
    expect(cellsOf(await readAll(seed(twoSheets), { sheet: 'Second' }))).toEqual([['b']]);
  });

  it('selects by 1-BASED INDEX', async () => {
    expect(cellsOf(await readAll(seed(twoSheets), { sheetIndex: 2 }))).toEqual([['b']]);
  });

  it('defaults to the first sheet when neither is given', async () => {
    expect(cellsOf(await readAll(seed(twoSheets)))).toEqual([['a']]);
  });

  it('REFUSES a sheet that does not exist, and lists the ones that do', async () => {
    // Never silently fall back to the first sheet: that reads the wrong data
    // and succeeds, which is the outcome §6.2 exists to prevent.
    const path = seed(twoSheets);
    await expect(readAll(path, { sheet: 'Missing' })).rejects.toThrowError(
      /no sheet named "Missing".*First.*Second/s,
    );
    await expect(readAll(path, { sheetIndex: 3 })).rejects.toThrowError(/only 2 sheet/);
  });

  it('treats a sheet NAMED like a number as a name, never an index', async () => {
    // Why `sheet` and `sheetIndex` are separate keys rather than one union.
    const path = seed({
      sheets: [
        { name: 'alpha', rows: [[{ kind: 'inline', text: 'first' }]] },
        { name: '1', rows: [[{ kind: 'inline', text: 'named-one' }]] },
      ],
    });
    expect(cellsOf(await readAll(path, { sheet: '1' }))).toEqual([['named-one']]);
    expect(cellsOf(await readAll(path, { sheetIndex: 1 }))).toEqual([['first']]);
  });

  it('lists sheet names without reading a row', async () => {
    expect(await listXlsxSheetNames(seed(twoSheets))).toEqual(['First', 'Second']);
  });
});

describe('readXlsxRowBatches — cell values', () => {
  it('keeps 0, false and the empty string DISTINCT', async () => {
    // xlsx-stream-reader collapses all three to '' (`workingVal || ''`), which
    // makes every genuine zero indistinguishable from a blank cell.
    const rows = await readAll(
      seed({
        sheets: [
          {
            name: 'Z',
            rows: [
              [
                { kind: 'number', value: 0 },
                { kind: 'boolean', value: false },
                { kind: 'inline', text: '' },
                { kind: 'number', value: -7 },
              ],
            ],
          },
        ],
      }),
    );
    expect(cellsOf(rows)).toEqual([[0, false, '', -7]]);
  });

  it('binds a BLANK cell to null, positioned by its column reference', async () => {
    // Excel sheets are sparse by construction: a blank cell is simply absent
    // from the XML. Binding it to `undefined` would make coerceValue report
    // `absent_value` and fail a row per blank.
    const rows = await readAll(
      seed({
        sheets: [
          {
            name: 'S',
            rows: [
              [
                { kind: 'inline', text: 'a' },
                { kind: 'blank' },
                { kind: 'inline', text: 'c' },
              ],
            ],
          },
        ],
      }),
    );
    expect(cellsOf(rows)).toEqual([['a', null, 'c']]);
    expect(rows[0]!.cells[1]).toBeNull();
    expect(coerceValue(rows[0]!.cells[1], 'string').ok).toBe(true);
  });

  it('positions cells correctly when the `r` reference is OMITTED', async () => {
    // The reference attribute is optional; position is then implicit.
    const rows = await readAll(
      seed({
        sheets: [
          {
            name: 'S',
            omitCellRefs: true,
            rows: [
              [
                { kind: 'inline', text: 'a' },
                { kind: 'inline', text: 'b' },
              ],
            ],
          },
        ],
      }),
    );
    expect(cellsOf(rows)).toEqual([['a', 'b']]);
  });

  it('concatenates rich-text RUNS into one string', async () => {
    const rows = await readAll(
      seed({ sheets: [{ name: 'S', rows: [[{ kind: 'sharedRuns', runs: ['bo', 'ld'] }]] }] }),
    );
    expect(cellsOf(rows)).toEqual([['bold']]);
  });

  it('yields a formula CELL as its cached result, never its formula text', async () => {
    const rows = await readAll(
      seed({
        sheets: [
          {
            name: 'S',
            rows: [
              [
                { kind: 'formula', formula: 'SUM(A1:A2)', cached: '3' },
                { kind: 'formula', formula: 'A1&"!"', cached: 'hi!', type: 'str' },
              ],
            ],
          },
        ],
      }),
    );
    expect(cellsOf(rows)).toEqual([[3, 'hi!']]);
  });

  it('yields an ERROR cell as a fault the coercion matrix REFUSES', async () => {
    // The reader has no per-row error channel, so the fault has to travel as a
    // value that cannot be coerced — never as the string "#N/A", which would
    // land in a text column looking like data.
    const rows = await readAll(
      seed({ sheets: [{ name: 'S', rows: [[{ kind: 'error', code: '#N/A' }]] }] }),
    );
    const cell = rows[0]!.cells[0];
    expect(cell).toEqual({ xlsxFault: 'error-cell', detail: '#N/A' });
    for (const target of ['string', 'integer', 'number', 'boolean', 'date'] as const) {
      expect(coerceValue(cell, target).ok).toBe(false);
    }
  });

  it('refuses a shared-string table that inflates past its cap', async () => {
    // The bound is on bytes ACTUALLY inflated, never on the zip's declared
    // uncompressedSize, which an attacker writes. 64 MiB of one repeated byte
    // deflates to a ~65 KB fixture, which is the whole point of the check.
    seq += 1;
    const path = join(root, `bomb-${seq}.xlsx`);
    const huge = `<?xml version="1.0"?><sst><si><t>${'a'.repeat(67_108_900)}</t></si></sst>`;
    writeFileSync(
      path,
      buildZip([
        { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="S" sheetId="1"/></sheets></workbook>' },
        { name: 'xl/sharedStrings.xml', data: huge },
        { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData/></worksheet>' },
      ]),
    );

    await expect(readAll(path)).rejects.toThrowError(/inflates past/);
  });

  it('refuses a cell longer than XLSX_MAX_CELL_CHARS', async () => {
    const path = seed({
      sheets: [{ name: 'S', rows: [[{ kind: 'inline', text: 'x'.repeat(1_048_577) }]] }],
    });
    await expect(readAll(path)).rejects.toThrowError(/cell/i);
  });
});

describe('readXlsxRowBatches — dates', () => {
  const dated = (value: number, numFmtId: number, opts: Partial<WorkbookSpec> = {}): WorkbookSpec => ({
    ...opts,
    cellXfs: [0, numFmtId],
    sheets: [{ name: 'S', rows: [[{ kind: 'number', value, style: 1 }]] }],
  });

  it('converts a serial under a DATE format to a UTC instant', async () => {
    expect(cellsOf(await readAll(seed(dated(46255, 14))))).toEqual([
      [new Date('2026-08-21T00:00:00.000Z')],
    ]);
  });

  it('converts a serial under a custom date formatCode', async () => {
    const rows = await readAll(
      seed({
        cellXfs: [0, 200],
        numFmts: { 200: 'yyyy\\-mm\\-dd' },
        sheets: [{ name: 'S', rows: [[{ kind: 'number', value: 46255, style: 1 }]] }],
      }),
    );
    expect(cellsOf(rows)).toEqual([[new Date('2026-08-21T00:00:00.000Z')]]);
  });

  it('leaves a DURATION format numeric — 45, 46 and 47 measure elapsed time', async () => {
    // `[h]:mm:ss` over 30.5 means 732 hours of runtime. Converting it to
    // 1900-01-30T12:00Z would be precisely the corruption §6.2 forbids.
    for (const numFmtId of [45, 46, 47]) {
      expect(cellsOf(await readAll(seed(dated(30.5, numFmtId))))).toEqual([[30.5]]);
    }
  });

  it('leaves a TIME-ONLY format numeric', async () => {
    for (const numFmtId of [18, 19, 20, 21]) {
      expect(cellsOf(await readAll(seed(dated(0.5, numFmtId))))).toEqual([[0.5]]);
    }
    const custom = await readAll(
      seed({
        cellXfs: [0, 201],
        numFmts: { 201: 'h:mm:ss' },
        sheets: [{ name: 'S', rows: [[{ kind: 'number', value: 0.5, style: 1 }]] }],
      }),
    );
    expect(cellsOf(custom)).toEqual([[0.5]]);
  });

  it('treats a DATE+TIME builtin (22) as a date', async () => {
    expect(cellsOf(await readAll(seed(dated(46255.5, 22))))).toEqual([
      [new Date('2026-08-21T12:00:00.000Z')],
    ]);
  });

  it('leaves a serial numeric when no date format applies', async () => {
    expect(cellsOf(await readAll(seed(dated(46255, 0))))).toEqual([[46255]]);
  });

  it('handles the 1900 leap-year bug at the 59/60/61 boundary', async () => {
    // Serial 60 is Excel's phantom 1900-02-29, a day that never existed. It
    // must FAIL rather than silently land on 1900-03-01, where it would be
    // indistinguishable from serial 61.
    expect(cellsOf(await readAll(seed(dated(59, 14))))).toEqual([
      [new Date('1900-02-28T00:00:00.000Z')],
    ]);
    expect(cellsOf(await readAll(seed(dated(61, 14))))).toEqual([
      [new Date('1900-03-01T00:00:00.000Z')],
    ]);

    const phantom = await readAll(seed(dated(60, 14)));
    expect(phantom[0]!.cells[0]).toEqual({
      xlsxFault: 'phantom-date',
      detail: expect.stringContaining('1900-02-29') as unknown as string,
    });
    expect(coerceValue(phantom[0]!.cells[0], 'date').ok).toBe(false);
  });

  it('honours a date1904 workbook', async () => {
    expect(cellsOf(await readAll(seed(dated(0, 14, { date1904: true }))))).toEqual([
      [new Date('1904-01-01T00:00:00.000Z')],
    ]);
  });

  it('reads an ISO-typed date cell', async () => {
    const rows = await readAll(
      seed({ sheets: [{ name: 'S', rows: [[{ kind: 'isoDate', iso: '2026-08-21T00:00:00Z' }]] }] }),
    );
    expect(cellsOf(rows)).toEqual([[new Date('2026-08-21T00:00:00.000Z')]]);
  });
});

describe('readXlsxRowBatches — streaming', () => {
  const wideBook = (rows: number): WorkbookSpec => ({
    sheets: [
      {
        name: 'S',
        rows: Array.from({ length: rows }, (_, i) => [
          { kind: 'number' as const, value: i },
          { kind: 'shared' as const, text: `row-${i}` },
        ]),
      },
    ],
  });

  it('yields in batches of batchRows', async () => {
    const batches: number[] = [];
    for await (const batch of readXlsxRowBatches({ filePath: seed(wideBook(25)), batchRows: 10 })) {
      batches.push(batch.length);
    }
    expect(batches).toEqual([10, 10, 5]);
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const seen: XlsxRow[] = [];
    await expect(
      (async () => {
        for await (const batch of readXlsxRowBatches({
          filePath: seed(wideBook(500)),
          batchRows: 10,
          signal: controller.signal,
        })) {
          seen.push(...batch);
          controller.abort();
        }
      })(),
    ).rejects.toThrowError(/abort/i);
    expect(seen.length).toBe(10);
  });

  it('survives a multi-byte character split across read chunks', async () => {
    // The sheet is inflated in chunks; decoding each with `toString()` would
    // corrupt any character straddling a boundary.
    const text = '€'.repeat(400);
    const rows = await readAll(
      seed({
        method: 'deflate',
        sheets: [
          {
            name: 'S',
            rows: Array.from({ length: 200 }, () => [{ kind: 'inline' as const, text }]),
          },
        ],
      }),
    );
    expect(rows).toHaveLength(200);
    for (const row of rows) expect(row.cells[0]).toBe(text);
  });

  it('reports the sheet row NUMBER, so a gap in rows is not silently closed', async () => {
    const path = seed({
      sheets: [
        {
          name: 'S',
          rows: [[{ kind: 'inline', text: 'one' }], [{ kind: 'blank' }], [{ kind: 'inline', text: 'three' }]],
        },
      ],
    });
    const rows = await readAll(path);
    expect(rows.map((r) => r.rowNumber)).toEqual([1, 2, 3]);
  });
});
