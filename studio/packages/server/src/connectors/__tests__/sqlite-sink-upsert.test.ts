import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DatasetIoError } from '../dataset-io-error.js';
import { writeSqliteDatasetRows, type SinkValue, type SqliteWriteMode } from '../sqlite-sink.js';
import { cleanupTempRoots, rowsOf, tempRoot, writableConfig } from './sqlite-fixtures.js';

/**
 * #1600 OR41 C3a — Copy's Write behaviour Truncate then insert and Upsert, on a
 * real SQLite store (catalogue §4.1). Every assertion reads the store back,
 * because the claim is about what the table holds, not what the writer said.
 */

afterEach(cleanupTempRoots);

async function* batches(
  ...chunks: Record<string, SinkValue>[][]
): AsyncIterable<readonly Record<string, SinkValue>[]> {
  for (const chunk of chunks) yield chunk;
}

function store(ddl: string): { root: string; path: string } {
  const root = tempRoot();
  const path = join(root, 'up.db');
  const db = new Database(path);
  db.exec(ddl);
  db.close();
  return { root, path };
}

function write(
  at: { root: string; path: string },
  columns: string[],
  mode: SqliteWriteMode,
  keyColumns: string[],
  ...chunks: Record<string, SinkValue>[][]
) {
  return writeSqliteDatasetRows(
    {
      connectionConfig: writableConfig(at.root, at.path),
      datasetKind: 'table',
      datasetConfig: { table: 'sink' },
      columns,
      nullOnError: [],
      mode,
      keyColumns,
    },
    batches(...chunks),
  );
}

async function refusal(promise: Promise<unknown>): Promise<DatasetIoError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DatasetIoError);
  return err as DatasetIoError;
}

const SEEDED =
  "CREATE TABLE sink (id INTEGER, name TEXT); INSERT INTO sink VALUES (1, 'a'), (2, 'b');";

describe('Truncate then insert (SQLite)', () => {
  it('empties the table, then inserts', async () => {
    const at = store(SEEDED);
    const result = await write(at, ['id', 'name'], 'truncate', [], [{ id: 9, name: 'z' }]);
    expect(result.rowsWritten).toBe(1);
    expect(rowsOf(at.path)).toEqual([{ id: 9, name: 'z' }]);
  });

  it('is a DELETE, so it cascades per the schema ON DELETE (SQLite has no TRUNCATE)', async () => {
    const at = store(
      'CREATE TABLE sink (id INTEGER PRIMARY KEY, name TEXT);' +
        'CREATE TABLE child (pid INTEGER REFERENCES sink(id) ON DELETE CASCADE);' +
        "INSERT INTO sink VALUES (1, 'a'); INSERT INTO child VALUES (1);",
    );
    await write(at, ['id', 'name'], 'truncate', [], [{ id: 2, name: 'b' }]);
    expect(rowsOf(at.path, 'SELECT * FROM child')).toEqual([]);
  });

  it('restores the rows it emptied when the copy fails', async () => {
    const at = store(SEEDED);
    const err = await refusal(
      write(at, ['id', 'name'], 'truncate', [], [{ id: 9, name: 'z' }], [{ id: 10 }]),
    );
    expect(err.message).toMatch(/no value was supplied for the sink column 'name'/);
    expect(rowsOf(at.path)).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
  });
});

describe('Upsert (SQLite)', () => {
  it('updates the rows whose keys match and inserts the rest', async () => {
    const at = store(SEEDED);
    const result = await write(
      at,
      ['id', 'name'],
      'upsert',
      ['id'],
      [
        { id: 2, name: 'B' },
        { id: 3, name: 'c' },
      ],
    );
    expect(result.rowsWritten).toBe(2);
    expect(rowsOf(at.path)).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'B' },
      { id: 3, name: 'c' },
    ]);
  });

  it('is idempotent: the same copy run again changes nothing and adds no row', async () => {
    const at = store(SEEDED);
    const rows = [
      { id: 2, name: 'B' },
      { id: 3, name: 'c' },
    ];
    await write(at, ['id', 'name'], 'upsert', ['id'], rows);
    await write(at, ['id', 'name'], 'upsert', ['id'], rows);
    expect(rowsOf(at.path)).toHaveLength(3);
  });

  it("uses the table's primary key when Key columns is empty", async () => {
    const at = store(
      "CREATE TABLE sink (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO sink VALUES (1, 'a');",
    );
    await write(at, ['id', 'name'], 'upsert', [], [{ id: 1, name: 'A' }]);
    expect(rowsOf(at.path)).toEqual([{ id: 1, name: 'A' }]);
  });

  it('matches on every column of a composite primary key', async () => {
    const at = store(
      'CREATE TABLE sink (a INTEGER, b INTEGER, v TEXT, PRIMARY KEY (b, a));' +
        "INSERT INTO sink VALUES (1, 1, 'x'), (1, 2, 'y');",
    );
    await write(
      at,
      ['a', 'b', 'v'],
      'upsert',
      [],
      [
        { a: 1, b: 2, v: 'Y' },
        { a: 2, b: 1, v: 'n' },
      ],
    );
    expect(rowsOf(at.path, 'SELECT * FROM sink ORDER BY a, b')).toEqual([
      { a: 1, b: 1, v: 'x' },
      { a: 1, b: 2, v: 'Y' },
      { a: 2, b: 1, v: 'n' },
    ]);
  });

  it('refuses a table with no primary key and no Key columns, before any row moves', async () => {
    const at = store(SEEDED);
    const err = await refusal(write(at, ['id', 'name'], 'upsert', [], [{ id: 1, name: 'A' }]));
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/Upsert needs Key columns: 'sink' has no primary key/);
    expect(rowsOf(at.path)).toHaveLength(2);
  });

  it('refuses an unmapped primary key column, suggesting Key columns', async () => {
    const at = store('CREATE TABLE sink (id INTEGER PRIMARY KEY, name TEXT);');
    const err = await refusal(write(at, ['name'], 'upsert', [], [{ name: 'A' }]));
    expect(err.message).toMatch(/the primary key column 'id' of 'sink' is not mapped/);
  });

  it('tells a real but unmapped key column from a column the table lacks', async () => {
    const at = store(SEEDED);
    expect((await refusal(write(at, ['name'], 'upsert', ['id'], [{ name: 'A' }]))).message).toMatch(
      /the Upsert key column 'id' is not mapped/,
    );
    expect(
      (await refusal(write(at, ['id', 'name'], 'upsert', ['nope'], [{ id: 1, name: 'A' }])))
        .message,
    ).toMatch(/the sink has no column named 'nope'/);
  });

  it('refuses two Key columns that are one column to the store, naming Key columns', async () => {
    const at = store(SEEDED);
    const err = await refusal(
      write(at, ['id', 'name'], 'upsert', ['id', 'ID'], [{ id: 1, name: 'A' }]),
    );
    expect(err.message).toMatch(
      /^Upsert's Key columns: 'id' and 'ID' both resolve to the sink column 'id'/,
    );
  });

  it("resolves a key by the store's own case rule", async () => {
    const at = store(SEEDED);
    await write(at, ['id', 'name'], 'upsert', ['ID'], [{ id: 1, name: 'A' }]);
    expect(rowsOf(at.path)).toEqual([
      { id: 1, name: 'A' },
      { id: 2, name: 'b' },
    ]);
  });

  it('fails on a NULL key and rolls back what the copy had written', async () => {
    const at = store(SEEDED);
    const err = await refusal(
      write(
        at,
        ['id', 'name'],
        'upsert',
        ['id'],
        [{ id: 1, name: 'A' }],
        [{ id: null, name: 'n' }],
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/row 2: the Upsert key column 'id' is NULL/);
    expect(rowsOf(at.path)).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
  });

  it('applies a key repeated in the source in order, so the last row wins', async () => {
    const at = store(SEEDED);
    const result = await write(
      at,
      ['id', 'name'],
      'upsert',
      ['id'],
      [
        { id: 5, name: 'first' },
        { id: 5, name: 'last' },
      ],
    );
    // An insert, then an update of the row it inserted.
    expect(result.rowsWritten).toBe(2);
    expect(rowsOf(at.path, 'SELECT * FROM sink WHERE id = 5')).toEqual([{ id: 5, name: 'last' }]);
  });

  it('with every mapped column a key, inserts only the keys it lacks', async () => {
    const at = store(SEEDED);
    const result = await write(at, ['id'], 'upsert', ['id'], [{ id: 1 }, { id: 7 }]);
    expect(result.rowsWritten).toBe(1);
    expect(rowsOf(at.path, 'SELECT id FROM sink ORDER BY id')).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 7 },
    ]);
  });
});
