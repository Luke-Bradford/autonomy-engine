import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DatasetIoError, writeSqliteDatasetRows, type SinkValue } from '../sqlite.js';
import { classifySinkFailure } from '../error-kind.js';
import { cleanupTempRoots, seedDb, tempRoot } from './sqlite-fixtures.js';

/**
 * #1125 M5 slice 2 — the `sqlite` SINK.
 *
 * Every test runs against a REAL database file. The properties under test are
 * properties of `better-sqlite3` interacting with the filesystem and with SQLite's
 * locking and transaction machinery — what binds, what a rollback restores, what
 * `pragma_table_info` says about a view — and a mock would assert only that this
 * file's own assumptions are self-consistent.
 *
 * On the two suites that look like duplicates of the reader's: the confinement
 * and identifier tests here are NOT re-assertions of `resolveWithinRoots` and
 * `quoteIdentifier` (which `confine.test.ts` and `sqlite.test.ts` own). They are
 * DISPATCH proofs — that the write path actually routes through those guards
 * rather than reaching the store around them. Mutation-proved as such: deleting
 * the `confineStorePath` call from the write path turns the confinement test red
 * while `confine.test.ts` stays green.
 */

afterEach(cleanupTempRoots);

/** A sink database: `t(id,name)` from the shared fixture plus a wider `sink` table. */
function seedSink(root: string, name = 'app.db'): string {
  const path = seedDb(root, 0, name);
  const db = new Database(path);
  db.exec(
    'CREATE TABLE sink (id INTEGER, name TEXT, flag INTEGER, big INTEGER, payload BLOB, note TEXT)',
  );
  db.close();
  return path;
}

function rowsOf(path: string, sql = 'SELECT * FROM sink ORDER BY rowid'): unknown[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

async function* one(rows: Record<string, SinkValue>[]): AsyncIterable<
  readonly Record<string, SinkValue>[]
> {
  yield rows;
}

const writableConfig = (root: string, path: string) => ({ roots: [root], path, writable: true });

async function failure(promise: Promise<unknown>): Promise<DatasetIoError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DatasetIoError);
  return err as DatasetIoError;
}

describe('the `writable` gate', () => {
  it('REFUSES a store whose config omits `writable` — absent withholds the permission', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: { roots: [root], path },
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id'],
          mode: 'append',
        },
        one([{ id: 1 }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/writable/);
    expect(rowsOf(path)).toHaveLength(0);
  });

  it('REFUSES `writable: false` explicitly, and does not open the store', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: { roots: [root], path, writable: false },
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id'],
          mode: 'append',
        },
        one([{ id: 1 }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.partialWritePossible).toBe(false);
  });

  it('ACCEPTS `writable: true`', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const result = await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['id', 'name'],
        mode: 'append',
      },
      one([{ id: 1, name: 'a' }]),
    );
    expect(result.rowsWritten).toBe(1);
    expect(rowsOf(path)).toEqual([
      { id: 1, name: 'a', flag: null, big: null, payload: null, note: null },
    ]);
  });
});

describe('what may be a sink at all', () => {
  it('REFUSES a `query` dataset — a SELECT has no insert target', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'query',
          datasetConfig: { sql: 'SELECT 1' },
          columns: ['id'],
          mode: 'append',
        },
        one([{ id: 1 }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/query/);
  });

  it('REFUSES a dataset kind with no writer yet', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'delimited',
          datasetConfig: { path: 'x.csv' },
          columns: ['id'],
          mode: 'append',
        },
        one([{ id: 1 }]),
      ),
    );
    expect(err.kind).toBe('permanent');
  });

  it('REFUSES a table name that is not a bare identifier (dispatch proof for quoteIdentifier)', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink"; DROP TABLE sink; --' },
          columns: ['id'],
          mode: 'append',
        },
        one([{ id: 1 }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    // The table is still there — nothing was executed.
    expect(rowsOf(path)).toHaveLength(0);
  });

  it('REFUSES a path outside `roots` (dispatch proof for confineStorePath)', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    const path = seedSink(outside);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: { roots: [root], path, writable: true },
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id'],
          mode: 'append',
        },
        one([{ id: 1 }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(rowsOf(path)).toHaveLength(0);
  });
});

describe('the pre-flight, before the first row moves (§7, sink half)', () => {
  it('REFUSES a table that does not exist, naming it', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'nope' },
          columns: ['id'],
          mode: 'append',
        },
        one([{ id: 1 }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/nope/);
  });

  it('REFUSES a VIEW — `pragma_table_info` reports its columns, so an empty-columns check would pass', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const db = new Database(path);
    db.exec('CREATE VIEW v AS SELECT id, name FROM sink');
    db.close();

    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'v' },
          columns: ['id'],
          mode: 'overwrite',
        },
        one([{ id: 1 }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/view/i);
  });

  it('REFUSES a mapped column absent from the sink, naming it', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id', 'nosuchcolumn'],
          mode: 'append',
        },
        one([{ id: 1, nosuchcolumn: 'x' }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/nosuchcolumn/);
  });

  it('ACCEPTS a mapped column that differs only in CASE — SQLite matches names case-insensitively', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const result = await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['ID', 'NaMe'],
        mode: 'append',
      },
      one([{ ID: 7, NaMe: 'cased' }]),
    );
    expect(result.rowsWritten).toBe(1);
    expect(rowsOf(path, 'SELECT id, name FROM sink')).toEqual([{ id: 7, name: 'cased' }]);
  });

  it('REFUSES two mapped columns that resolve to ONE sink column — silent last-wins otherwise', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id', 'ID'],
          mode: 'append',
        },
        one([{ id: 1, ID: 2 }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/id/i);
  });

  it('REFUSES an empty column list rather than building a valueless INSERT', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: [],
          mode: 'append',
        },
        one([{}]),
      ),
    );
    expect(err.kind).toBe('permanent');
  });
});

describe('value binding', () => {
  it('binds a BOOLEAN as 1/0 — better-sqlite3 refuses a boolean outright', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const result = await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['id', 'flag'],
        mode: 'append',
      },
      one([
        { id: 1, flag: true },
        { id: 2, flag: false },
      ]),
    );
    expect(result.rowsWritten).toBe(2);
    expect(rowsOf(path, 'SELECT id, flag FROM sink ORDER BY id')).toEqual([
      { id: 1, flag: 1 },
      { id: 2, flag: 0 },
    ]);
  });

  it('binds a bigint beyond MAX_SAFE_INTEGER without narrowing it', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['big'],
        mode: 'append',
      },
      one([{ big: 9007199254740993n }]),
    );
    const db = new Database(path, { readonly: true });
    db.defaultSafeIntegers(true);
    const got = db.prepare('SELECT big FROM sink').get() as { big: bigint };
    db.close();
    expect(got.big).toBe(9007199254740993n);
  });

  it('binds null, a string and a blob', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['name', 'payload', 'note'],
        mode: 'append',
      },
      one([{ name: 'x', payload: new Uint8Array([1, 2, 3]), note: null }]),
    );
    const got = rowsOf(path, 'SELECT name, payload, note FROM sink')[0] as {
      name: string;
      payload: Buffer;
      note: null;
    };
    expect(got.name).toBe('x');
    expect([...got.payload]).toEqual([1, 2, 3]);
    expect(got.note).toBeNull();
  });

  it('REFUSES an absent value rather than binding a silent NULL, and rolls back', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id', 'name'],
          mode: 'append',
        },
        one([
          { id: 1, name: 'a' },
          { id: 2 } as Record<string, SinkValue>,
        ]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/name/);
    expect(rowsOf(path)).toHaveLength(0);
  });

  it('classifies a bigint too large for SQLite as permanent, not transient', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['big'],
          mode: 'append',
        },
        one([{ big: 2n ** 70n }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(rowsOf(path)).toHaveLength(0);
  });
});

describe('write modes', () => {
  it('APPEND leaves existing rows alone', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const write = (id: number) =>
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id'],
          mode: 'append',
        },
        one([{ id }]),
      );
    await write(1);
    await write(2);
    expect(rowsOf(path, 'SELECT id FROM sink ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('OVERWRITE replaces the table contents', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['id'],
        mode: 'append',
      },
      one([{ id: 1 }, { id: 2 }]),
    );
    const result = await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['id'],
        mode: 'overwrite',
      },
      one([{ id: 9 }]),
    );
    expect(result.rowsWritten).toBe(1);
    expect(rowsOf(path, 'SELECT id FROM sink')).toEqual([{ id: 9 }]);
  });

  it('OVERWRITE with ZERO source rows EMPTIES the table — that is what overwrite means', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['id'],
        mode: 'append',
      },
      one([{ id: 1 }]),
    );
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* nothing(): AsyncIterable<readonly Record<string, SinkValue>[]> {}
    const result = await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['id'],
        mode: 'overwrite',
      },
      nothing(),
    );
    expect(result.rowsWritten).toBe(0);
    expect(rowsOf(path)).toHaveLength(0);
  });
});

describe('atomicity (§4)', () => {
  it('a throw from the SOURCE mid-copy leaves the sink in its pre-copy state', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['id'],
        mode: 'append',
      },
      one([{ id: 1 }]),
    );

    // eslint-disable-next-line @typescript-eslint/require-await
    async function* explodes(): AsyncIterable<readonly Record<string, SinkValue>[]> {
      yield [{ id: 2 }, { id: 3 }];
      throw new Error('the source died at row 500000');
    }
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id'],
          mode: 'append',
        },
        explodes(),
      ),
    );
    expect(err.partialWritePossible).toBe(false);
    expect(rowsOf(path, 'SELECT id FROM sink')).toEqual([{ id: 1 }]);
  });

  it('OVERWRITE that fails mid-copy does not lose the rows it was replacing', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['id'],
        mode: 'append',
      },
      one([{ id: 1 }, { id: 2 }]),
    );
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* explodes(): AsyncIterable<readonly Record<string, SinkValue>[]> {
      yield [{ id: 9 }];
      throw new Error('boom');
    }
    await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id'],
          mode: 'overwrite',
        },
        explodes(),
      ),
    );
    expect(rowsOf(path, 'SELECT id FROM sink ORDER BY id')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('a constraint violation rolls the whole copy back', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const db = new Database(path);
    db.exec('CREATE TABLE strict_sink (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    db.close();
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'strict_sink' },
          columns: ['id', 'name'],
          mode: 'append',
        },
        one([
          { id: 1, name: 'ok' },
          { id: 2, name: null },
        ]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.partialWritePossible).toBe(false);
    expect(rowsOf(path, 'SELECT id FROM strict_sink')).toHaveLength(0);
  });
});

describe('cancellation (§10)', () => {
  it('aborts at a batch boundary and leaves the sink in its pre-copy state', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const controller = new AbortController();
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* twoBatches(): AsyncIterable<readonly Record<string, SinkValue>[]> {
      yield [{ id: 1 }];
      controller.abort();
      yield [{ id: 2 }];
    }
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id'],
          mode: 'append',
          signal: controller.signal,
        },
        twoBatches(),
      ),
    );
    expect(err.kind).toBe('cancelled');
    expect(err.partialWritePossible).toBe(false);
    expect(rowsOf(path)).toHaveLength(0);
  });

  it('refuses an ALREADY-aborted signal before opening the store', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id'],
          mode: 'append',
          signal: AbortSignal.abort(),
        },
        one([{ id: 1 }]),
      ),
    );
    expect(err.kind).toBe('cancelled');
  });
});

describe('progress (§5)', () => {
  it('reports a running total per BATCH, never per row', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const seen: number[] = [];
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* batches(): AsyncIterable<readonly Record<string, SinkValue>[]> {
      yield [{ id: 1 }, { id: 2 }];
      yield [{ id: 3 }];
    }
    await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 'sink' },
        columns: ['id'],
        mode: 'append',
        onBatch: (rowsWritten) => seen.push(rowsWritten),
      },
      batches(),
    );
    expect(seen).toEqual([2, 3]);
  });
});

describe('classifySinkFailure (§4.2)', () => {
  it('passes everything through when no partial write is possible', () => {
    for (const kind of ['transient', 'permanent', 'auth', 'rate_limit', 'cancelled'] as const) {
      expect(classifySinkFailure({ kind, partialWritePossible: false })).toBe(kind);
    }
  });

  it('downgrades a RETRYABLE kind to permanent when rows may already have landed', () => {
    expect(classifySinkFailure({ kind: 'transient', partialWritePossible: true })).toBe('permanent');
    expect(classifySinkFailure({ kind: 'rate_limit', partialWritePossible: true })).toBe(
      'permanent',
    );
  });

  it('leaves `cancelled` alone — it is already never retried, and the label carries information', () => {
    expect(classifySinkFailure({ kind: 'cancelled', partialWritePossible: true })).toBe('cancelled');
  });
});
