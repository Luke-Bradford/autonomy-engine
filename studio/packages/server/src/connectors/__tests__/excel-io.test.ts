import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatasetIoError } from '../dataset-io-error.js';
import {
  describeExcelDatasetColumns,
  excelCoercionFor,
  readExcelDatasetBatches,
  resolveExcelDatasetAddress,
  type ExcelDatasetRead,
} from '../excel-io.js';
import { buildXlsx, type SheetSpec, type WorkbookSpec } from './xlsx-fixtures.js';
import { cleanupTempRoots, tempRoot } from './temp-roots.js';

/**
 * #996 M11 slice 2 (#1215) — the `excel` reader over an `fs` connection.
 *
 * REAL FILES on the `delimited-io.test.ts` precedent: this layer's subject is
 * exactly what a pure parser cannot be asked about — confinement, `O_NOFOLLOW`,
 * descriptors being released, the dataset config gate.
 *
 * WHAT IS DELIBERATELY NOT RE-TESTED HERE: the container and cell grammar.
 * `xlsx-read.test.ts` already runs its corpus across all three zip entry
 * ORDERS, and pins the four value decisions (blank binds `null`, durations stay
 * numeric, serial 60 refuses, an error cell travels as a fault). What only THIS
 * layer can reach is NAMING and BINDING — which row names the columns, what a
 * missing cell becomes, which shapes refuse — plus the address and the §6.4
 * projection.
 */

let root = '';
let outside = '';

beforeEach(async () => {
  root = await tempRoot('excel-io-root');
  outside = await tempRoot('excel-io-outside');
});
afterEach(async () => {
  await cleanupTempRoots();
});

async function seed(name: string, spec: WorkbookSpec): Promise<string> {
  const path = join(root, name);
  await writeFile(path, buildXlsx(spec));
  return path;
}

const text = (t: string) => ({ kind: 'inline', text: t }) as const;
const num = (value: number) => ({ kind: 'number', value }) as const;
const blank = { kind: 'blank' } as const;

function book(sheet: Partial<SheetSpec> & Pick<SheetSpec, 'rows'>): WorkbookSpec {
  return { sheets: [{ name: 'Sales', ...sheet }] };
}

function read(path: string, config: Record<string, unknown> = {}): ExcelDatasetRead {
  return {
    connectionConfig: { roots: [root] },
    datasetKind: 'excel',
    datasetConfig: { path, header: true, sheet: 'Sales', ...config },
  };
}

async function rowsOf(r: ExcelDatasetRead): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const batch of readExcelDatasetBatches(r)) out.push(...batch);
  return out;
}

async function refusalOf(run: () => Promise<unknown>): Promise<DatasetIoError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(DatasetIoError);
    return err as DatasetIoError;
  }
  throw new Error('expected a refusal');
}

describe('the dispatch gate', () => {
  it('refuses a kind this READER does not read, by name', async () => {
    const path = await seed('b.xlsx', book({ rows: [[text('a')], [text('1')]] }));
    const err = await refusalOf(() => rowsOf({ ...read(path), datasetKind: 'delimited' }));
    expect(err.kind).toBe('permanent');
    expect(err.message).toBe("the excel reader reads 'excel' datasets; this one is 'delimited'");
  });

  it('re-validates BOTH configs at dispatch, never trusting the stored row', async () => {
    const path = await seed('b.xlsx', book({ rows: [[text('a')], [text('1')]] }));
    const badConn = await refusalOf(() =>
      rowsOf({ ...read(path), connectionConfig: { roots: 'not-a-list' } }),
    );
    expect(badConn.kind).toBe('permanent');
    expect(badConn.message).toMatch(/^invalid fs connection config: /);

    // The config gate is the SCHEMA's: no sheet named at all.
    const badDataset = await refusalOf(() =>
      rowsOf({ ...read(path), datasetConfig: { path, header: true } }),
    );
    expect(badDataset.kind).toBe('permanent');
    expect(badDataset.message).toMatch(/^invalid excel dataset config: .*sheet/);
  });

  it('confines the path and refuses a symlinked target', async () => {
    const escape = join(outside, 'escape.xlsx');
    await writeFile(escape, buildXlsx(book({ rows: [[text('a')]] })));
    const out = await refusalOf(() => rowsOf(read(escape)));
    expect(out.kind).toBe('permanent');
    expect(out.message).toMatch(/outside the allowed roots/);

    const link = join(root, 'link.xlsx');
    await symlink(escape, link);
    const linked = await refusalOf(() => rowsOf(read(link)));
    expect(linked.kind).toBe('permanent');
    expect(linked.message).toMatch(/symlink/);
  });

  it('refuses a directory rather than reporting it as an empty workbook', async () => {
    const err = await refusalOf(() => rowsOf(read(root)));
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/is not a regular file/);
  });

  it('names the CONFIG when the sheet is the problem, and the FILE otherwise', async () => {
    // #1216's bounded `code` earning its place: the two refusals are worded by
    // code, not by matching the reader's prose.
    const path = await seed('b.xlsx', book({ rows: [[text('a')]] }));
    const missing = await refusalOf(() => rowsOf(read(path, { sheet: 'Nope' })));
    expect(missing.message).toMatch(/^this dataset's config does not fit the workbook: /);
    expect(missing.message).toMatch(/no sheet named "Nope"/);

    const junk = join(root, 'junk.xlsx');
    await writeFile(junk, 'this is not a zip at all');
    const broken = await refusalOf(() => rowsOf(read(junk)));
    expect(broken.kind).toBe('permanent');
    expect(broken.message).toMatch(/could not be read: not a readable \.xlsx/);
  });
});

describe('naming the columns', () => {
  it('takes the header from row 1 and does not copy it as data', async () => {
    const path = await seed(
      'b.xlsx',
      book({ rows: [[text('id'), text('name')], [num(1), text('alpha')]] }),
    );
    expect(await rowsOf(read(path))).toEqual([{ id: 1, name: 'alpha' }]);
    expect(await describeExcelDatasetColumns(read(path))).toEqual(['id', 'name']);
  });

  it('skips title rows above `headerRow` — the shape a CSV never has', async () => {
    const path = await seed(
      'b.xlsx',
      book({
        rows: [
          [text('Quarterly report')],
          [blank],
          [text('id'), text('name')],
          [num(7), text('gamma')],
        ],
      }),
    );
    expect(await rowsOf(read(path, { headerRow: 3 }))).toEqual([{ id: 7, name: 'gamma' }]);
    expect(await describeExcelDatasetColumns(read(path, { headerRow: 3 }))).toEqual(['id', 'name']);
  });

  it('refuses a `headerRow` the sheet STEPS OVER rather than naming columns after data', async () => {
    // Excel omits a row that never held anything, so a sheet can jump 2 -> 5.
    // Falling through to the next row would name the columns after real data
    // and SUCCEED, which is the silent-wrong-data outcome §6.2 exists to stop.
    const path = await seed(
      'b.xlsx',
      book({ rows: [[text('a')], [num(1)], [num(2)]], rowNumbers: [1, 2, 5] }),
    );
    const err = await refusalOf(() => rowsOf(read(path, { headerRow: 3 })));
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/has no row 3 to name its columns/);
  });

  it('refuses a `headerRow` past the last row, and says which row was last', async () => {
    const path = await seed('b.xlsx', book({ rows: [[text('a')], [num(1)]] }));
    const err = await refusalOf(() => rowsOf(read(path, { headerRow: 9 })));
    expect(err.message).toMatch(/has no row 9 to name its columns; its last row is 2/);
  });

  it('refuses a header row that is PRESENT and blank', async () => {
    // A blank row is skipped as DATA. At `headerRow` it must not be — skipping
    // would silently promote the next row into the column names.
    const path = await seed(
      'b.xlsx',
      book({ rows: [[blank], [text('id')], [num(1)]] }),
    );
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.message).toMatch(/has a header that names no columns/);
  });

  it('applies the SHARED naming refusals — duplicates and interior blanks', async () => {
    const dup = await seed(
      'dup.xlsx',
      book({ rows: [[text('a'), text('b'), text('a')], [num(1), num(2), num(3)]] }),
    );
    expect((await refusalOf(() => rowsOf(read(dup)))).message).toMatch(
      /names the header column 'a' more than once/,
    );

    const hole = await seed(
      'hole.xlsx',
      book({ rows: [[text('a'), blank, text('c')], [num(1), num(2), num(3)]] }),
    );
    expect((await refusalOf(() => rowsOf(read(hole)))).message).toMatch(
      /has no name for header column 2/,
    );
  });

  it('names the SHEET, not just the file — a workbook holds several', async () => {
    const path = await seed('b.xlsx', book({ rows: [[text('a'), blank, text('c')], [num(1)]] }));
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.message).toContain(`sheet "Sales" of '${path}'`);
  });

  it('refuses a DATE-typed header cell rather than inventing a name for it', async () => {
    // Monthly date headers are real, and there is no "as authored" text to
    // recover — the reader consumes the format code to classify the cell. Any
    // name studio produced would be an invention every mapping then depends on.
    const path = await seed('b.xlsx', {
      sheets: [{ name: 'Sales', rows: [[text('id'), { kind: 'number', value: 46255, style: 0 }], [num(1), num(2)]] }],
      cellXfs: [14],
    });
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/has a date cell in header column 2/);
    expect(err.message).toMatch(/format that row as text, point headerRow at a text row/);
  });

  it('refuses an ERROR header cell for the same reason', async () => {
    const path = await seed(
      'b.xlsx',
      book({ rows: [[text('id'), { kind: 'error', code: '#N/A' }], [num(1), num(2)]] }),
    );
    expect((await refusalOf(() => rowsOf(read(path)))).message).toMatch(
      /has an error cell in header column 2/,
    );
  });

  it('gives a numeric or boolean header its CANONICAL text form', async () => {
    const path = await seed(
      'b.xlsx',
      book({ rows: [[num(2026), { kind: 'boolean', value: true }], [num(1), num(2)]] }),
    );
    expect(await describeExcelDatasetColumns(read(path))).toEqual(['2026', 'true']);
  });

  it('names positionally with `header: false`, and keeps the first row as DATA', async () => {
    const path = await seed('b.xlsx', book({ rows: [[num(1), text('alpha')], [num(2), text('beta')]] }));
    expect(await rowsOf(read(path, { header: false }))).toEqual([
      { column1: 1, column2: 'alpha' },
      { column1: 2, column2: 'beta' },
    ]);
  });

  it('takes the headerless WIDTH from a blank predicate, not from the naming rules', async () => {
    // A date or an error in row 1 is a perfectly good DATA value; only a header
    // cell has to become a name. Deriving the width through the naming path
    // would refuse this sheet for a reason that has nothing to do with naming.
    const path = await seed('b.xlsx', {
      sheets: [
        {
          name: 'Sales',
          rows: [[{ kind: 'number', value: 46255, style: 0 }, text('alpha'), blank]],
        },
      ],
      cellXfs: [14],
    });
    const rows = await rowsOf(read(path, { header: false }));
    expect(Object.keys(rows[0]!)).toEqual(['column1', 'column2']);
    expect(rows[0]!.column1).toBeInstanceOf(Date);
  });
});

describe('binding a row', () => {
  it('binds a blank cell to `null`, NOT to absent', async () => {
    // The whole reason `bindRow` was not lifted into `source-columns.ts`. A
    // CSV's short row binds `undefined` and fails on `absent_value`; a sheet is
    // sparse by construction, so that would fail one row per blank.
    const path = await seed(
      'b.xlsx',
      book({ rows: [[text('a'), text('b'), text('c')], [num(1), blank, num(3)]] }),
    );
    expect(await rowsOf(read(path))).toEqual([{ a: 1, b: null, c: 3 }]);
  });

  it('pads a SHORT row to null and keeps the key set uniform', async () => {
    // Uniform keys are a contract with the pump: `planColumns` resolves the plan
    // ONCE from the first row's `Object.keys`.
    const path = await seed(
      'b.xlsx',
      book({ rows: [[text('a'), text('b'), text('c')], [num(1)], [num(9), num(8), num(7)]] }),
    );
    const rows = await rowsOf(read(path));
    expect(rows[0]).toEqual({ a: 1, b: null, c: null });
    expect(Object.keys(rows[0]!)).toEqual(Object.keys(rows[1]!));
  });

  it('refuses an extra cell that CARRIES something, and tolerates a blank one', async () => {
    const carries = await seed(
      'x.xlsx',
      book({ rows: [[text('a')], [num(1), num(2)]] }),
    );
    const err = await refusalOf(() => rowsOf(read(carries)));
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/row 2 carries 2 cells but the source has 1 columns/);

    // A styled-but-empty cell past the last column is a formatting artifact and
    // appears on every row of the files that have it.
    const padded = await seed('p.xlsx', {
      sheets: [
        {
          name: 'Sales',
          rows: [[text('a')], [{ kind: 'raw', xml: '<c r="A2"><v>1</v></c><c r="B2" s="0"/>' }]],
        },
      ],
      cellXfs: [0],
    });
    expect(await rowsOf(read(padded))).toEqual([{ a: 1 }]);
  });

  it('SKIPS a row that is present and wholly blank, as a CSV skips a blank line', async () => {
    // Measured: Excel writes a bare `<row r="2"/>` for a row whose height or
    // fill was ever touched, so a blank row is PRESENT. Binding it would emit an
    // all-null record per formatting artifact — a different `rowsRead` from the
    // same logical data as a CSV, and a constraint violation against a
    // `nullable: false` column on a row nobody authored.
    const path = await seed(
      'b.xlsx',
      book({ rows: [[text('a')], [num(1)], [blank], [num(3)]] }),
    );
    expect(await rowsOf(read(path))).toEqual([{ a: 1 }, { a: 3 }]);
  });

  it('numbers a refusal by the SHEET row, which survives skipped rows', async () => {
    const path = await seed(
      'b.xlsx',
      book({ rows: [[text('a')], [num(1)], [blank], [num(3), num(4)]] }),
    );
    // Row 4 in the sheet; a data-row ordinal would have called it row 2.
    expect((await refusalOf(() => rowsOf(read(path)))).message).toMatch(/row 4 carries 2 cells/);
  });

  it('lets an error cell travel as a value the coercion matrix rejects', async () => {
    const path = await seed(
      'b.xlsx',
      book({ rows: [[text('a')], [{ kind: 'error', code: '#N/A' }]] }),
    );
    const rows = await rowsOf(read(path));
    expect(rows[0]!.a).toMatchObject({ xlsxFault: 'error-cell' });
    expect(typeof rows[0]!.a).toBe('object');
  });
});

describe('the empty and the near-empty', () => {
  it('succeeds over ZERO rows for a sheet that has a header and no data', async () => {
    const path = await seed('b.xlsx', book({ rows: [[text('a'), text('b')]] }));
    expect(await rowsOf(read(path))).toEqual([]);
    // And the drift gate still learns the columns, which is the case a
    // yield-driven describe could never see.
    expect(await describeExcelDatasetColumns(read(path))).toEqual(['a', 'b']);
  });

  it('refuses a sheet with no rows at all, distinctly from an empty one', async () => {
    const path = await seed('b.xlsx', book({ rows: [] }));
    const err = await refusalOf(() => rowsOf(read(path)));
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/contains no rows, so it has no header row to name its columns/);

    const headerless = await refusalOf(() =>
      rowsOf({ ...read(path), datasetConfig: { path, header: false, sheet: 'Sales' } }),
    );
    expect(headerless.message).toMatch(/contains no rows, so its columns cannot be counted/);
  });
});

describe('scheduling and cancellation', () => {
  it('yields batches of the requested size and honours an abort between them', async () => {
    const rows = [[text('a')], ...Array.from({ length: 6 }, (_, i) => [num(i)])];
    const path = await seed('b.xlsx', book({ rows }));
    const batches: number[] = [];
    for await (const batch of readExcelDatasetBatches({ ...read(path), batchRows: 2 })) {
      batches.push(batch.length);
    }
    // `batchRows` is a CEILING and a scheduling quantum, not an exact size, and
    // the first batch is short for the same reason `delimited`'s is: the header
    // occupies a slot in the underlying reader's batch and is then consumed.
    // Rows skipped above `headerRow`, and blank rows, shorten one the same way.
    // What the contract owes is that no batch exceeds the ceiling and no row is
    // lost, so that is what is asserted.
    expect(batches.every((n) => n > 0 && n <= 2)).toBe(true);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(6);

    const controller = new AbortController();
    const err = await refusalOf(async () => {
      for await (const batch of readExcelDatasetBatches({
        ...read(path),
        batchRows: 2,
        signal: controller.signal,
      })) {
        expect(batch.length).toBeLessThanOrEqual(2);
        controller.abort();
      }
    });
    expect(err.kind).toBe('cancelled');
  });

  it('refuses an already-cancelled read before it opens anything', async () => {
    const path = await seed('b.xlsx', book({ rows: [[text('a')], [num(1)]] }));
    const controller = new AbortController();
    controller.abort();
    const err = await refusalOf(() => rowsOf({ ...read(path), signal: controller.signal }));
    expect(err.kind).toBe('cancelled');
  });

  it('refuses a bad `batchRows` BEFORE the descriptor is opened', async () => {
    // The one throw inside `readXlsxRowBatches` that happens before `openZip`,
    // so a descriptor handed over on that path would never be closed. Refusing
    // ahead of the open makes the window not exist.
    const path = await seed('b.xlsx', book({ rows: [[text('a')], [num(1)]] }));
    const err = await refusalOf(() => rowsOf({ ...read(path), batchRows: 0 }));
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/batchRows must be a positive integer/);
  });
});

describe('where an excel dataset physically is (§2.1)', () => {
  const resolve = (path: string, config: Record<string, unknown> = {}) =>
    resolveExcelDatasetAddress({
      connectionConfig: { roots: [root] },
      dataset: { kind: 'excel', config: { path, header: true, sheet: 'Sales', ...config } },
    });

  it('reports the confined path as BOTH store and object, with a real identity', async () => {
    const path = await seed('b.xlsx', book({ rows: [[text('a')]] }));
    const address = await resolve(path);
    expect(address).toMatchObject({ kind: 'fs', store: path, object: path });
    expect(address.storeIdentity).toMatch(/^\d+:\d+$/);
  });

  it('does NOT put the sheet in the address — two sheets are one physical object', async () => {
    const path = await seed('b.xlsx', {
      sheets: [
        { name: 'Sales', rows: [[text('a')]] },
        { name: 'Costs', rows: [[text('b')]] },
      ],
    });
    expect(await resolve(path, { sheet: 'Sales' })).toEqual(await resolve(path, { sheet: 'Costs' }));
  });

  it('reports an unidentifiable store as `null`, never as a refusal', async () => {
    const address = await resolve(join(root, 'not-here.xlsx'));
    expect(address).toMatchObject({ store: join(root, 'not-here.xlsx'), storeIdentity: null });
  });

  it('refuses a kind this reader does not read, BY NAME', async () => {
    await expect(
      resolveExcelDatasetAddress({
        connectionConfig: { roots: [root] },
        dataset: { kind: 'table', config: { table: 'orders' } },
      }),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message: "the excel reader reads 'excel' datasets; this one is 'table'",
    });
  });
});

describe('the §6.4 projection', () => {
  it('returns only the DECLARED keys, so an absent one is an absent PROPERTY', async () => {
    expect(excelCoercionFor({ path: '/b.xlsx', header: true, sheet: 'S' })).toEqual({});
    expect(
      excelCoercionFor({ path: '/b.xlsx', header: true, sheet: 'S', nullValue: '', dateFormat: 'yyyy-MM-dd' }),
    ).toEqual({ nullValue: '', dateFormat: 'yyyy-MM-dd' });
    expect(
      'nullValue' in excelCoercionFor({ path: '/b.xlsx', header: true, sheet: 'S' }),
    ).toBe(false);
  });

  it('THROWS on an unparseable config rather than degrading to `{}`', () => {
    // `{}` would run the copy with the operator's declared sentinel silently
    // doing nothing — the fail-open direction the REQUIRED channel exists to
    // prevent.
    expect(() => excelCoercionFor({ path: '/b.xlsx' })).toThrow(DatasetIoError);
  });
});
