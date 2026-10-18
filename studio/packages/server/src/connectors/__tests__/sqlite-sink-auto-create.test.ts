import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AutoCreateColumn } from '../auto-create-table.js';
import { DatasetIoError } from '../dataset-io-error.js';
import type { PreCopyScript } from '../pre-copy-script.js';
import { writeSqliteDatasetRows, type SinkValue, type SqliteWriteMode } from '../sqlite-sink.js';
import { cleanupTempRoots, rowsOf, tempRoot, writableConfig } from './sqlite-fixtures.js';

/**
 * #1600 OR41 C3c — Copy's Table option *Auto-create from mapping* on a real
 * SQLite store (catalogue §4.1). Every assertion reads the store back: the
 * claims are what the schema and the table hold, not what the writer said.
 */

afterEach(cleanupTempRoots);

async function* batches(
  ...chunks: Record<string, SinkValue>[][]
): AsyncIterable<readonly Record<string, SinkValue>[]> {
  for (const chunk of chunks) yield chunk;
}

function store(ddl = ''): { root: string; path: string } {
  const root = tempRoot();
  const path = join(root, 'auto.db');
  const db = new Database(path);
  db.exec(ddl);
  db.close();
  return { root, path };
}

function write(
  at: { root: string; path: string },
  autoCreate: readonly AutoCreateColumn[] | null,
  chunks: Record<string, SinkValue>[][],
  opts: {
    mode?: SqliteWriteMode;
    preCopyScript?: PreCopyScript;
    schema?: string;
    keyColumns?: string[];
    signal?: AbortSignal;
  } = {},
) {
  return writeSqliteDatasetRows(
    {
      connectionConfig: writableConfig(at.root, at.path),
      datasetKind: 'table',
      datasetConfig: {
        table: 'sink',
        ...(opts.schema === undefined ? {} : { schema: opts.schema }),
      },
      columns: (autoCreate ?? [{ name: 'id' }]).map((c) => c.name),
      nullOnError: [],
      mode: opts.mode ?? 'append',
      keyColumns: opts.keyColumns ?? [],
      preCopyScript: opts.preCopyScript ?? null,
      autoCreate,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
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

function schemaOf(path: string, table = 'sink'): { name: string; type: string }[] {
  return rowsOf(path, `SELECT name, type FROM pragma_table_info('${table}') ORDER BY cid`) as {
    name: string;
    type: string;
  }[];
}

function tablesOf(path: string): string[] {
  return (
    rowsOf(path, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name") as {
      name: string;
    }[]
  ).map((r) => r.name);
}

const EVERY_TYPE: AutoCreateColumn[] = [
  { name: 's', type: 'string' },
  { name: 'i', type: 'integer' },
  { name: 'n', type: 'number' },
  { name: 'b', type: 'boolean' },
  { name: 'd', type: 'date' },
  { name: 't', type: 'timestamp' },
  { name: 'x', type: 'binary' },
];

describe('Auto-create from mapping (SQLite)', () => {
  it('creates the table from the mapping, one column per type, and writes the rows', async () => {
    const at = store();
    const bytes = new Uint8Array([0, 1, 254]);
    const result = await write(at, EVERY_TYPE, [
      [
        {
          s: 'Ann',
          i: 9007199254740993n,
          n: 1.5,
          b: true,
          d: '2026-07-15',
          t: '2026-07-15T13:45:00.000Z',
          x: bytes,
        },
        { s: null, i: 42n, n: null, b: false, d: null, t: null, x: null },
      ],
    ]);
    expect(result.rowsWritten).toBe(2);
    expect(schemaOf(at.path)).toEqual([
      { name: 's', type: 'TEXT' },
      { name: 'i', type: 'INTEGER' },
      { name: 'n', type: 'REAL' },
      { name: 'b', type: 'INTEGER' },
      { name: 'd', type: 'TEXT' },
      { name: 't', type: 'TEXT' },
      { name: 'x', type: 'BLOB' },
    ]);
    // Every column is nullable and there is no primary key.
    expect(
      rowsOf(
        at.path,
        'SELECT count(*) AS c FROM pragma_table_info(\'sink\') WHERE "notnull" OR pk',
      ),
    ).toEqual([{ c: 0 }]);
    const db = new Database(at.path, { readonly: true });
    try {
      db.defaultSafeIntegers(true);
      const rows = db.prepare('SELECT * FROM sink ORDER BY rowid').all() as Record<
        string,
        unknown
      >[];
      expect(rows[0]).toMatchObject({
        s: 'Ann',
        i: 9007199254740993n,
        n: 1.5,
        b: 1n,
        d: '2026-07-15',
        t: '2026-07-15T13:45:00.000Z',
      });
      expect(new Uint8Array(rows[0]!['x'] as Buffer)).toEqual(bytes);
      expect(rows[1]).toMatchObject({ s: null, i: 42n, n: null, b: 0n });
    } finally {
      db.close();
    }
  });

  it('creates the table for a source with no rows', async () => {
    const at = store();
    expect((await write(at, EVERY_TYPE.slice(0, 1), [])).rowsWritten).toBe(0);
    expect(tablesOf(at.path)).toEqual(['sink']);
  });

  it('uses an existing table as it is, matched without case, and alters nothing', async () => {
    const at = store(
      "CREATE TABLE Sink (id TEXT, extra INTEGER); INSERT INTO Sink VALUES ('a', 1);",
    );
    await write(at, [{ name: 'ID', type: 'integer' }], [[{ ID: 7n }]]);
    expect(schemaOf(at.path, 'Sink')).toEqual([
      { name: 'id', type: 'TEXT' },
      { name: 'extra', type: 'INTEGER' },
    ]);
    expect(tablesOf(at.path)).toEqual(['Sink']);
    expect(rowsOf(at.path, 'SELECT id, extra FROM Sink ORDER BY rowid')).toEqual([
      { id: 'a', extra: 1 },
      { id: '7', extra: null },
    ]);
  });

  it('leaves a view of the same name alone and refuses it as the sink', async () => {
    const at = store('CREATE TABLE base (id INTEGER); CREATE VIEW sink AS SELECT id FROM base;');
    const err = await refusal(write(at, [{ name: 'id', type: 'integer' }], [[{ id: 1 }]]));
    expect(err.message).toBe("'sink' is a view, not a table, so it cannot be written to");
    expect(tablesOf(at.path)).toEqual(['base']);
  });

  it('rolls the create back when the copy fails', async () => {
    const at = store();
    // A new table has no primary key, so Upsert with no Key columns is refused
    // after the create, inside the transaction.
    const err = await refusal(
      write(at, [{ name: 'id', type: 'integer' }], [[{ id: 1 }]], { mode: 'upsert' }),
    );
    expect(err.message).toBe(
      "Upsert needs Key columns: 'sink' has no primary key to match rows on",
    );
    expect(tablesOf(at.path)).toEqual([]);
  });

  it('upserts into the table it created when Key columns are given', async () => {
    const at = store();
    const cols: AutoCreateColumn[] = [
      { name: 'id', type: 'integer' },
      { name: 'name', type: 'string' },
    ];
    const upsert = { mode: 'upsert' as const, keyColumns: ['id'] };
    await write(at, cols, [[{ id: 1, name: 'Ann' }]], upsert);
    await write(
      at,
      cols,
      [
        [
          { id: 1, name: 'Bea' },
          { id: 2, name: 'Cal' },
        ],
      ],
      upsert,
    );
    expect(rowsOf(at.path)).toEqual([
      { id: 1, name: 'Bea' },
      { id: 2, name: 'Cal' },
    ]);
  });

  it('runs the Pre-copy script after the create, so it can alter the new table', async () => {
    const at = store();
    await write(at, [{ name: 'id', type: 'integer' }], [[{ id: 1 }]], {
      preCopyScript: { sql: "ALTER TABLE sink ADD COLUMN note TEXT DEFAULT 'new'", parameters: {} },
    });
    expect(rowsOf(at.path)).toEqual([{ id: 1, note: 'new' }]);
  });

  it('refuses two sink names that differ only by case before creating anything', async () => {
    const at = store();
    const err = await refusal(
      write(
        at,
        [
          { name: 'id', type: 'integer' },
          { name: 'ID', type: 'string' },
        ],
        [[{ id: 1, ID: 'a' }]],
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toBe(
      "Auto-create cannot create both 'id' and 'ID': the copy matches sink columns without case",
    );
    expect(tablesOf(at.path)).toEqual([]);
  });

  it('refuses a schema the connection has not attached', async () => {
    const at = store();
    const err = await refusal(
      write(at, [{ name: 'id', type: 'integer' }], [[{ id: 1 }]], { schema: 'other' }),
    );
    expect(err.kind).toBe('permanent');
    expect(tablesOf(at.path)).toEqual([]);
  });

  it('creates a column name the sink can write into an existing table, a space included', async () => {
    const at = store();
    await write(at, [{ name: 'Full Name', type: 'string' }], [[{ 'Full Name': 'Ann' }]]);
    expect(rowsOf(at.path)).toEqual([{ 'Full Name': 'Ann' }]);
  });

  it('rolls the create back on a cancel between batches', async () => {
    const at = store();
    const controller = new AbortController();
    async function* cancelling(): AsyncIterable<readonly Record<string, SinkValue>[]> {
      yield [{ id: 1 }];
      controller.abort();
      yield [{ id: 2 }];
    }
    const err = await refusal(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(at.root, at.path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id'],
          nullOnError: [],
          mode: 'append',
          autoCreate: [{ name: 'id', type: 'integer' }],
          signal: controller.signal,
        },
        cancelling(),
      ),
    );
    expect(err.kind).toBe('cancelled');
    expect(tablesOf(at.path)).toEqual([]);
  });

  it('without Auto-create, a missing table is still refused', async () => {
    const at = store();
    const err = await refusal(write(at, null, [[{ id: 1 }]]));
    expect(err.message).toBe("there is no table 'sink' in the store");
  });
});
