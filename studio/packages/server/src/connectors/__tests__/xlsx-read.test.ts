import { constants, fstatSync, openSync, writeFileSync } from 'node:fs';
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
import { XLSX_MAX_ENTRIES } from '../../limits.js';
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

/**
 * Whether `fd` STILL refers to the file it was opened on.
 *
 * Not `readSync(fd)` — that only asks whether the NUMBER is readable, and the
 * kernel recycles descriptor numbers, so any later open in this process can
 * make the probe succeed against an unrelated file. That made the ownership
 * assertion below non-deterministic (it failed once in CI and never locally).
 * Comparing the inode answers the question actually being asked, and closing a
 * recycled descriptor — which the old probe did on its success path — could
 * have shut a file belonging to something else.
 */
function stillRefersTo(fd: number, ino: number): boolean {
  try {
    return fstatSync(fd).ino === ino;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EBADF') return false;
    throw err;
  }
}

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

    const results = await Promise.all(
      ALL_ORDERS.map(async (o) => cellsOf(await readAll(seed(spec(o))))),
    );

    const expected = [
      ['name', 'when'],
      ['ada', new Date('2020-01-03T00:00:00.000Z')],
    ];
    for (const result of results) expect(result).toEqual(expected);
  });

  it('refuses a file that is not a zip, naming the likely cause', async () => {
    seq += 1;
    const path = join(root, `notzip-${seq}.xlsx`);
    writeFileSync(path, 'this is a .xls, or a CSV somebody renamed');

    await expect(readAll(path)).rejects.toThrowError(XlsxReadError);
    await expect(readAll(path)).rejects.toThrowError(/not a readable \.xlsx/i);
  });

  it('classifies a CORRUPT entry as an XlsxReadError, not a raw Error', async () => {
    // yauzl validates sizes and CRCs on the ENTRY's own stream, not on the
    // zip-level error channel, so this is the one damage class that could
    // escape the module's classification contract.
    seq += 1;
    const path = join(root, `corrupt-${seq}.xlsx`);
    const good = buildXlsx({ sheets: [{ name: 'S', rows: [[{ kind: 'inline', text: 'a' }]] }] });
    // Rebuild with the worksheet's payload truncated.
    writeFileSync(
      path,
      buildZip([
        {
          name: 'xl/workbook.xml',
          data: '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
        },
        {
          name: 'xl/_rels/workbook.xml.rels',
          data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        },
        {
          name: 'xl/worksheets/sheet1.xml',
          data: `<worksheet><sheetData>${'<row r="1"><c r="A1" t="inlineStr"><is><t>padding padding padding</t></is></c></row>'.repeat(200)}</sheetData></worksheet>`,
          corrupt: true,
        },
      ]),
    );
    expect(good.length).toBeGreaterThan(0);

    await expect(readAll(path)).rejects.toThrowError(XlsxReadError);
    await expect(readAll(path)).rejects.toThrowError(/truncated or corrupt/);
  });

  it('REFUSES a container declaring more entries than it will index', async () => {
    // The directory walk runs to completion before any `XLSX_MAX_*_BYTES`
    // applies — those bound an entry's CONTENT, and this is the pass that finds
    // the entries at all. Tiny and unbounded in number is the same exhaustion
    // shape as the derived column index, reached from the other direction.
    seq += 1;
    const path = join(root, `many-entries-${seq}.xlsx`);
    const many = Array.from({ length: XLSX_MAX_ENTRIES + 8 }, (_, i) => ({
      name: `pad/${i}.bin`,
      data: 'x',
    }));
    writeFileSync(path, buildZip(many));

    await expect(readAll(path)).rejects.toThrowError(XlsxReadError);
    await expect(readAll(path)).rejects.toThrowError(/more than 16384 entries/);
  });

  it('honours an already-aborted signal DURING the directory walk', async () => {
    // Asserting "an aborted read rejects" would be vacuous — `throwIfAborted`
    // downstream already guarantees that, and this test passed with the walk's
    // own check deleted. What is specific to the walk is WHICH failure wins.
    // On an over-long container the cap and the abort are both live, and the
    // abort must answer FIRST: a cancelled read should not be made to index
    // every entry before it is allowed to stop.
    seq += 1;
    const path = join(root, `abort-walk-${seq}.xlsx`);
    writeFileSync(
      path,
      buildZip(
        Array.from({ length: XLSX_MAX_ENTRIES + 8 }, (_, i) => ({
          name: `pad/${i}.bin`,
          data: 'x',
        })),
      ),
    );

    const err: unknown = await readAll(path, { signal: AbortSignal.abort() }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    // Not the cap's refusal — that is what surfaces if the walk stops checking.
    expect(err).not.toBeInstanceOf(XlsxReadError);
    expect((err as Error).name).toBe('AbortError');
  });

  it('reads from an already-open descriptor, and takes ownership of it', async () => {
    // The route a caller needs for O_NOFOLLOW: yauzl.open would do a plain
    // fs.open, leaving the lstat->open race that confine.ts warns about.
    const path = seed({ sheets: [{ name: 'S', rows: [[{ kind: 'inline', text: 'via-fd' }]] }] });
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const ino = fstatSync(fd).ino;

    const rows: XlsxRow[] = [];
    for await (const batch of readXlsxRowBatches({ filePath: path, fd })) rows.push(...batch);
    expect(cellsOf(rows)).toEqual([['via-fd']]);

    // Ownership transferred: the reader closed it, so the caller must not.
    expect(stillRefersTo(fd, ino)).toBe(false);
  });

  it('closes a caller-supplied fd when the container cannot be opened', async () => {
    // The other half of the ownership contract, and the half that was missing:
    // yauzl hands an open error back and leaves the caller's descriptor OPEN
    // (measured), so a module that only closes on success leaks one descriptor
    // per refused file — and every `.xls` or password-protected workbook an
    // operator points at is a refused file.
    seq += 1;
    const path = join(root, `notzip-${seq}.bin`);
    writeFileSync(path, 'this is not a zip container');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const ino = fstatSync(fd).ino;

    await expect(
      // The open fails before any batch is produced; draining is what forces
      // the generator to start at all.
      (async () => {
        for await (const batch of readXlsxRowBatches({ filePath: path, fd })) void batch;
      })(),
    ).rejects.toThrowError(XlsxReadError);

    expect(stillRefersTo(fd, ino)).toBe(false);
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

  it('REFUSES a sheet whose rId the workbook never defines', async () => {
    // `relTarget === undefined` is reachable two ways, and they are NOT the
    // same fact: a sheet with no rId at all (positional naming is the only
    // option) versus a sheet carrying an rId the rels part never defines.
    // The second is a malformed container. Guessing `sheet{n}.xml` there
    // reads whatever happens to sit at that position and SUCCEEDS — here,
    // another sheet's data — which is the silent-wrong-data outcome §6.2
    // exists to prevent. Refuse instead, naming the dangling rId.
    seq += 1;
    const path = join(root, `dangling-rid-${seq}.xlsx`);
    writeFileSync(
      path,
      buildZip([
        {
          name: 'xl/workbook.xml',
          data:
            '<workbook><sheets>' +
            '<sheet name="First" sheetId="1" r:id="rId1"/>' +
            '<sheet name="Second" sheetId="2" r:id="rId7"/>' +
            '</sheets></workbook>',
        },
        {
          name: 'xl/_rels/workbook.xml.rels',
          data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        },
        {
          name: 'xl/worksheets/sheet1.xml',
          data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row></sheetData></worksheet>',
        },
        {
          name: 'xl/worksheets/sheet2.xml',
          data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>NOT-Seconds-data</t></is></c></row></sheetData></worksheet>',
        },
      ]),
    );

    await expect(readAll(path, { sheet: 'Second' })).rejects.toThrowError(XlsxReadError);
    await expect(readAll(path, { sheet: 'Second' })).rejects.toThrowError(/rId7/);
    // The sheet that IS wired up still reads.
    expect(cellsOf(await readAll(path, { sheet: 'First' }))).toEqual([['first']]);
  });

  it('falls back to positional naming for a sheet that declares NO rId', async () => {
    // The other half of the split above: no rId is not malformed, it is
    // simply nothing to resolve, so `sheet{n}.xml` is the only answer.
    seq += 1;
    const path = join(root, `no-rid-${seq}.xlsx`);
    writeFileSync(
      path,
      buildZip([
        {
          name: 'xl/workbook.xml',
          data: '<workbook><sheets><sheet name="Solo" sheetId="1"/></sheets></workbook>',
        },
        {
          name: 'xl/_rels/workbook.xml.rels',
          data: '<Relationships></Relationships>',
        },
        {
          name: 'xl/worksheets/sheet1.xml',
          data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>positional</t></is></c></row></sheetData></worksheet>',
        },
      ]),
    );

    expect(cellsOf(await readAll(path))).toEqual([['positional']]);
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
              [{ kind: 'inline', text: 'a' }, { kind: 'blank' }, { kind: 'inline', text: 'c' }],
            ],
          },
        ],
      }),
    );
    expect(cellsOf(rows)).toEqual([['a', null, 'c']]);
    expect(rows[0]!.cells[1]).toBeNull();
    expect(coerceValue(rows[0]!.cells[1], 'string').ok).toBe(true);
  });

  it('REFUSES a row whose cell references go backwards or repeat', async () => {
    // Such a reference resolves to an index already written, so the earlier
    // value would vanish while the copy still reported success.
    const path = seed({
      sheets: [
        {
          name: 'S',
          rows: [
            [
              { kind: 'raw', xml: '<c r="B1" t="inlineStr"><is><t>first-B1</t></is></c>' },
              { kind: 'raw', xml: '<c r="A1" t="inlineStr"><is><t>later-A1</t></is></c>' },
            ],
          ],
        },
      ],
    });
    await expect(readAll(path)).rejects.toThrowError(/after a later column/);
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
        {
          name: 'xl/workbook.xml',
          data: '<workbook><sheets><sheet name="S" sheetId="1"/></sheets></workbook>',
        },
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
  const dated = (
    value: number,
    numFmtId: number,
    opts: Partial<WorkbookSpec> = {},
  ): WorkbookSpec => ({
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

  it('refuses a serial before the 1900 system begins', async () => {
    const rows = await readAll(seed(dated(-1, 14)));
    expect(rows[0]!.cells[0]).toEqual({
      xlsxFault: 'phantom-date',
      detail: expect.stringContaining('before the 1900 date system') as unknown as string,
    });
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

  it('keeps a ZONE-LESS ISO date UTC whatever the host timezone is', async () => {
    // ECMA-376 §18.17.4 writes `t="d"` with no zone, and ECMA-262 parses a
    // zone-less date-TIME in the host's zone. The TZ is pinned rather than left
    // to the runner ON PURPOSE: CI runs UTC, where the offset is 0 and a naive
    // assertion passes even with the bug present. Measured shift under
    // America/New_York is +4h.
    const path = seed({
      sheets: [{ name: 'S', rows: [[{ kind: 'isoDate', iso: '2026-08-21T00:00:00' }]] }],
    });
    const before = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      expect(cellsOf(await readAll(path))).toEqual([[new Date('2026-08-21T00:00:00.000Z')]]);
      process.env.TZ = 'Asia/Tokyo';
      expect(cellsOf(await readAll(path))).toEqual([[new Date('2026-08-21T00:00:00.000Z')]]);
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('HONOURS an explicit offset on an ISO date cell rather than forcing UTC', async () => {
    const rows = await readAll(
      seed({
        sheets: [{ name: 'S', rows: [[{ kind: 'isoDate', iso: '2026-08-21T00:00:00+02:00' }]] }],
      }),
    );
    expect(cellsOf(rows)).toEqual([[new Date('2026-08-20T22:00:00.000Z')]]);
  });

  it('yields a date-ONLY ISO cell as midnight UTC', async () => {
    const rows = await readAll(
      seed({ sheets: [{ name: 'S', rows: [[{ kind: 'isoDate', iso: '2026-08-21' }]] }] }),
    );
    expect(cellsOf(rows)).toEqual([[new Date('2026-08-21T00:00:00.000Z')]]);
  });
});

describe('readXlsxRowBatches — malformed references', () => {
  it('REFUSES a column reference past the format’s last column, without allocating it', async () => {
    // The one bound that is not a byte count. `limits.ts` measures what ARRIVES;
    // a column index is DERIVED, and exponentially so — `r="ZZZZZZ1"` is
    // fifteen bytes and decodes to ~321 million. The gap fill below
    // (`while (cells.length < column) cells.push(null)`) would grow the row to
    // that length synchronously, so a few bytes of XML force a multi-gigabyte
    // allocation the byte caps cannot see. XFD (16,384) is the format's own last
    // column, so refusing past it turns an exhaustion path into a fast failure
    // and refuses nothing Excel can emit.
    const huge = seed({
      sheets: [
        {
          name: 'S',
          rows: [[{ kind: 'raw', xml: '<c r="ZZZZZZ1" t="inlineStr"><is><t>x</t></is></c>' }]],
        },
      ],
    });
    await expect(readAll(huge)).rejects.toThrowError(XlsxReadError);
    await expect(readAll(huge)).rejects.toThrowError(/16384-column ceiling/);

    // One past the ceiling is refused by the same rule, not by its size.
    const justOver = seed({
      sheets: [
        {
          name: 'S',
          rows: [[{ kind: 'raw', xml: '<c r="XFE1" t="inlineStr"><is><t>x</t></is></c>' }]],
        },
      ],
    });
    await expect(readAll(justOver)).rejects.toThrowError(/16384-column ceiling/);
  });

  it('still reads XFD, the last column the format allows', async () => {
    // The other half: the ceiling must refuse the malformed, never the legal.
    const path = seed({
      sheets: [
        {
          name: 'S',
          rows: [[{ kind: 'raw', xml: '<c r="XFD1" t="inlineStr"><is><t>last</t></is></c>' }]],
        },
      ],
    });
    const rows = await readAll(path);
    expect(rows[0]!.cells).toHaveLength(16_384);
    expect(rows[0]!.cells[16_383]).toBe('last');
  });

  it('EXCLUDES phonetic <rPh> runs from a shared string', async () => {
    // ECMA-376's CT_Rst admits `<rPh>` alongside the content runs: a phonetic
    // READING (furigana), routinely present in Japanese-authored workbooks. It
    // is not part of the string's value. Capturing every `<t>` under `<si>`
    // concatenates the reading onto the word — "present-but-different-shape
    // read as if it were the plain case", and it corrupts the cell silently.
    const path = seed({
      sheets: [
        {
          name: 'S',
          rows: [
            [
              {
                kind: 'sharedRaw',
                si: '<r><t>東京</t></r><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/>',
              },
            ],
          ],
        },
      ],
    });
    expect(cellsOf(await readAll(path))).toEqual([['東京']]);
  });

  it('EXCLUDES phonetic <rPh> runs from an INLINE string', async () => {
    // `<is>` is the same CT_Rst type as `<si>`, so it carries `<rPh>` too — the
    // sheet parser needs the identical exclusion, not just the string table.
    const path = seed({
      sheets: [
        {
          name: 'S',
          rows: [
            [
              {
                kind: 'raw',
                xml: '<c r="A1" t="inlineStr"><is><r><t>大阪</t></r><rPh sb="0" eb="2"><t>オオサカ</t></rPh></is></c>',
              },
            ],
          ],
        },
      ],
    });
    expect(cellsOf(await readAll(path))).toEqual([['大阪']]);
  });

  it('still concatenates ordinary rich-text runs, phonetics aside', async () => {
    // The other half: `<rPh>` is the only thing excluded. Content runs — the
    // reason the walker captures across `<r>` at all — must still join.
    const path = seed({
      sheets: [
        {
          name: 'S',
          rows: [
            [
              {
                kind: 'sharedRaw',
                si: '<r><t>Hello, </t></r><rPh sb="0" eb="1"><t>IGNORED</t></rPh><r><t>world</t></r>',
              },
            ],
          ],
        },
      ],
    });
    expect(cellsOf(await readAll(path))).toEqual([['Hello, world']]);
  });

  it('REFUSES a numeric cell whose <v> is explicitly empty', async () => {
    // `sawValue` already returned the ABSENT cell before this branch, so an
    // empty `raw` here means the cell carried `<v></v>` — present and
    // unparseable. Excel writes a blank as a cell with NO `<v>` at all, so this
    // is corruption, and returning null would file it as an innocuous blank:
    // the same collapse the `s` and `b` branches beside it already refuse.
    const path = seed({
      sheets: [{ name: 'S', rows: [[{ kind: 'raw', xml: '<c r="A1"><v></v></c>' }]] }],
    });
    await expect(readAll(path)).rejects.toThrowError(XlsxReadError);
    await expect(readAll(path)).rejects.toThrowError(/empty <v>/);
  });

  it('still reads a cell with no <v> as a blank', async () => {
    // The other half: absent is not corrupt. An interior gap stays null, which
    // is what makes it distinguishable from the refusal above.
    const path = seed({
      sheets: [
        {
          name: 'S',
          rows: [
            [
              { kind: 'raw', xml: '<c r="A1"/>' },
              { kind: 'raw', xml: '<c r="B1" t="inlineStr"><is><t>b</t></is></c>' },
            ],
          ],
        },
      ],
    });
    expect(cellsOf(await readAll(path))).toEqual([[null, 'b']]);
  });

  it('REFUSES a cell whose r attribute is not a cell reference', async () => {
    // `columnIndexOf(cellRef) ?? nextColumn` collapsed two different facts, the
    // same way the dangling rId did: a cell declaring NO ref (position is the
    // only answer) and one declaring a ref that will not parse. Real Excel
    // emits uppercase LETTERS+DIGITS always, so `r="a1"` is malformed — and
    // placing it at the next sequential column is a guess that lands real data
    // in the wrong column while succeeding.
    for (const ref of ['a1', 'A', '1A', 'A1B', '$A$1']) {
      const path = seed({
        sheets: [
          {
            name: 'S',
            rows: [[{ kind: 'raw', xml: `<c r="${ref}" t="inlineStr"><is><t>x</t></is></c>` }]],
          },
        ],
      });
      await expect(readAll(path)).rejects.toThrowError(XlsxReadError);
      await expect(readAll(path)).rejects.toThrowError(/not a cell reference/);
    }
  });

  it('still places a cell that declares NO ref at the next column', async () => {
    // The other half. Absent is not malformed: Excel may omit `r`, and then
    // sequential position is the only answer there is.
    const path = seed({
      sheets: [
        {
          name: 'S',
          rows: [
            [
              { kind: 'raw', xml: '<c t="inlineStr"><is><t>one</t></is></c>' },
              { kind: 'raw', xml: '<c t="inlineStr"><is><t>two</t></is></c>' },
            ],
          ],
        },
      ],
    });
    expect(cellsOf(await readAll(path))).toEqual([['one', 'two']]);
  });

  it('REFUSES a row whose r attribute is not a row number', async () => {
    // `Number(tag.attributes['r'])` accepted anything, so `r="abc"` bound NaN
    // as the row number and travelled with the data — a guess, where every
    // other malformed reference here fails instead.
    seq += 1;
    const path = join(root, `bad-rownum-${seq}.xlsx`);
    writeFileSync(
      path,
      buildZip([
        {
          name: 'xl/workbook.xml',
          data: '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
        },
        {
          name: 'xl/_rels/workbook.xml.rels',
          data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        },
        {
          name: 'xl/worksheets/sheet1.xml',
          data: '<worksheet><sheetData><row r="abc"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>',
        },
      ]),
    );

    await expect(readAll(path)).rejects.toThrowError(XlsxReadError);
    await expect(readAll(path)).rejects.toThrowError(/r="abc"/);
  });

  it('REFUSES a non-positive batchRows rather than looping forever', async () => {
    // `while (pending.length >= batchRows) yield pending.splice(0, batchRows)`
    // never terminates at 0: the predicate always holds and each splice yields
    // an empty batch. A caller bug should be a fast error, not a hung server.
    const path = seed({ sheets: [{ name: 'S', rows: [[{ kind: 'inline', text: 'a' }]] }] });
    await expect(readAll(path, { batchRows: 0 })).rejects.toThrowError(/batchRows/);
    await expect(readAll(path, { batchRows: -1 })).rejects.toThrowError(/batchRows/);
    await expect(readAll(path, { batchRows: 1.5 })).rejects.toThrowError(/batchRows/);
  });

  it('REFUSES a shared-string reference the table does not hold', async () => {
    // Silently reading as a blank would turn a truncated workbook into an
    // apparently-successful, quietly-incomplete import.
    const path = seed({
      sheets: [{ name: 'S', rows: [[{ kind: 'raw', xml: '<c r="A1" t="s"><v>999</v></c>' }]] }],
    });
    await expect(readAll(path)).rejects.toThrowError(/references shared string "999"/);
  });

  it('REFUSES an empty shared-string reference instead of yielding the FIRST string', async () => {
    // `Number('')` is 0, so without the guard B1 returns shared[0] — an
    // unrelated cell's value wearing B1's position, which reads as data.
    const path = seed({
      sheets: [
        {
          name: 'S',
          rows: [
            [
              { kind: 'shared', text: 'REAL_STRING_ZERO' },
              { kind: 'raw', xml: '<c r="B1" t="s"><v></v></c>' },
            ],
          ],
        },
      ],
    });
    await expect(readAll(path)).rejects.toThrowError(/references shared string ""/);
  });

  it('REFUSES a boolean cell that is neither 0 nor 1', async () => {
    const path = seed({
      sheets: [{ name: 'S', rows: [[{ kind: 'raw', xml: '<c r="A1" t="b"><v>2</v></c>' }]] }],
    });
    await expect(readAll(path)).rejects.toThrowError(/neither 0 nor 1/);
  });

  it('accepts the true/false spelling of a boolean', async () => {
    const rows = await readAll(
      seed({
        sheets: [
          {
            name: 'S',
            rows: [
              [
                { kind: 'raw', xml: '<c r="A1" t="b"><v>true</v></c>' },
                { kind: 'raw', xml: '<c r="B1" t="b"><v>false</v></c>' },
              ],
            ],
          },
        ],
      }),
    );
    expect(cellsOf(rows)).toEqual([[true, false]]);
  });

  it('resolves a MULTI-LETTER column reference to the right index', async () => {
    const rows = await readAll(
      seed({
        sheets: [
          {
            name: 'S',
            rows: [
              [
                { kind: 'raw', xml: '<c r="A1"><v>1</v></c>' },
                { kind: 'raw', xml: '<c r="Z1"><v>26</v></c>' },
                { kind: 'raw', xml: '<c r="AA1"><v>27</v></c>' },
                { kind: 'raw', xml: '<c r="AB1"><v>28</v></c>' },
              ],
            ],
          },
        ],
      }),
    );
    const cells = cellsOf(rows)[0]!;
    expect(cells).toHaveLength(28);
    expect([cells[0], cells[25], cells[26], cells[27]]).toEqual([1, 26, 27, 28]);
  });

  it('treats a SELF-CLOSING cell carrying attributes as blank', async () => {
    const rows = await readAll(
      seed({
        sheets: [
          {
            name: 'S',
            rows: [
              [
                { kind: 'raw', xml: '<c r="A1"><v>1</v></c>' },
                { kind: 'raw', xml: '<c r="B1" s="0"/>' },
                { kind: 'raw', xml: '<c r="C1"><v>3</v></c>' },
              ],
            ],
          },
        ],
      }),
    );
    expect(cellsOf(rows)).toEqual([[1, null, 3]]);
  });

  it('refuses a SMALL PART that inflates past its own tighter cap', async () => {
    // The small parts are materialised whole, so they carry
    // XLSX_MAX_SMALL_PART_BYTES (16 MiB) rather than the streamed entry's
    // 256 MiB — 20 MiB of styles refuses here and would be accepted under the
    // worksheet's cap.
    seq += 1;
    const path = join(root, `small-part-bomb-${seq}.xlsx`);
    writeFileSync(
      path,
      buildZip([
        {
          name: 'xl/workbook.xml',
          data: '<workbook><sheets><sheet name="S" sheetId="1"/></sheets></workbook>',
        },
        {
          name: 'xl/styles.xml',
          data: `<?xml version="1.0"?><styleSheet><!--${'a'.repeat(20_971_520)}--></styleSheet>`,
        },
        { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData/></worksheet>' },
      ]),
    );

    await expect(readAll(path)).rejects.toThrowError(/inflates past/);
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

  it('honours an ALREADY-aborted signal during the SMALL-PARTS phase', async () => {
    // The shared-string table can be read up to its 64 MiB cap before the first
    // row exists, so cancellation must bite in that phase too — not merely at
    // the first batch boundary, which would be reached anyway.
    //
    // The workbook DECLARES a sheet the container does not hold, so the two
    // phases fail differently and the test can tell them apart: reaching
    // `resolveSheet` at all produces the missing-sheet refusal, while honouring
    // the signal first produces an abort.
    seq += 1;
    const path = join(root, `abort-phase-${seq}.xlsx`);
    writeFileSync(
      path,
      buildZip([
        {
          name: 'xl/workbook.xml',
          data: '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
        },
        {
          name: 'xl/_rels/workbook.xml.rels',
          data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        },
      ]),
    );

    // Without a signal it gets far enough to miss the sheet.
    await expect(readAll(path)).rejects.toThrowError(/does not hold/);
    // With one already aborted, it never gets there.
    await expect(readAll(path, { signal: AbortSignal.abort() })).rejects.toThrowError(/abort/i);
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
          rows: [
            [{ kind: 'inline', text: 'one' }],
            [{ kind: 'blank' }],
            [{ kind: 'inline', text: 'three' }],
          ],
        },
      ],
    });
    const rows = await readAll(path);
    expect(rows.map((r) => r.rowNumber)).toEqual([1, 2, 3]);
    expect(rows[1]!.cells).toEqual([]);
  });
});
