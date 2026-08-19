import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DatasetIoError,
  writeSqliteDatasetRows,
  type SinkValue,
  type SqliteWriteMode,
} from '../sqlite.js';
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

async function* one(
  rows: Record<string, SinkValue>[],
): AsyncIterable<readonly Record<string, SinkValue>[]> {
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

  it('REFUSES `writable: false` explicitly, BEFORE opening the store', async () => {
    const root = tempRoot();
    // The same discriminator the abort test uses: a path with no database at
    // it. If the gate runs first the answer names `writable`; if the copy opens
    // first, the answer is "cannot open the sqlite database". Without this the
    // test's own name was an unproven claim.
    const path = join(root, 'never-created.db');
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
    expect(err.message).toMatch(/writable/);
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
    // Specifically the "no insert target" refusal. Drop it and `query` falls to
    // the not-yet-implemented arm, whose message also says "query".
    expect(err.message).toMatch(/has no insert target/);
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
    // Without this arm, `delimited` reaches `tableDatasetConfigSchema` and is
    // refused as an invalid table config — permanent either way, but for a
    // reason that would mislead whoever reads the run log.
    expect(err.message).toMatch(/no sink writer exists for the 'delimited'/);
  });

  it('REFUSES a table name that is not a bare identifier', async () => {
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
    // NOT a dispatch proof for `quoteIdentifier`, and the earlier label saying so
    // was wrong — verified by mutation: replace both `quoteIdentifier` calls with
    // naive interpolation and this test still passes. The refusal comes earlier,
    // from `tableDatasetConfigSchema`'s own `sqlIdentifier` check inside
    // `sinkTargetFor`, so the string never reaches a statement at all. That is
    // the better place for it; the test simply pins that gate, not the quoting.
    // The genuinely live `quoteIdentifier` call is for COLUMN names, which come
    // from the store rather than from a validated schema — covered below.
    expect(err.message).toMatch(/invalid table dataset config/);
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
    // The wording, not just the name: without the existence check the copy
    // fails anyway (reading `.type` off `undefined`), and that message quotes
    // the table name too.
    expect(err.message).toMatch(/there is no table 'nope' in the store/);
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
    // The PRE-FLIGHT wording specifically. Without the `sqlite_master` type
    // check the copy still fails — but from `DELETE FROM v` INSIDE the
    // transaction, reporting "cannot modify v because it is a view". Matching
    // only /view/i would pass on that, certifying the gate while the gate is
    // gone.
    expect(err.message).toMatch(/'v' is a view, not a table/);
  });

  it('ACCEPTS a table named in a different CASE — SQLite resolves table names case-insensitively too', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const result = await writeSqliteDatasetRows(
      {
        connectionConfig: writableConfig(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 'SINK' },
        columns: ['id'],
        mode: 'append',
      },
      one([{ id: 3 }]),
    );
    // `sqlite_master.name` compares BINARY, so an exact-match lookup refuses
    // this — while `INSERT INTO "SINK"` would have succeeded. The columns were
    // given case-insensitive treatment from the start; the table was not, and
    // that asymmetry is what this pins.
    expect(result.rowsWritten).toBe(1);
    expect(rowsOf(path, 'SELECT id FROM sink')).toEqual([{ id: 3 }]);
  });

  it('REPORTS a missing column AND a duplicate together, not whichever came first', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id', 'ID', 'nosuchcolumn'],
          mode: 'append',
        },
        one([{ id: 1, ID: 2, nosuchcolumn: 3 }]),
      ),
    );
    expect(err.message).toMatch(/nosuchcolumn/);
    expect(err.message).toMatch(/both resolve to the sink column 'id'/);
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

  it('REFUSES a STORE column that is not a bare identifier — the one live `quoteIdentifier` arm', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const db = new Database(path);
    db.exec('CREATE TABLE spaced (id INTEGER, "my col" TEXT)');
    db.close();

    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'spaced' },
          columns: ['id', 'my col'],
          mode: 'append',
        },
        one([{ id: 1, 'my col': 'x' }]),
      ),
    );
    // Column names reach the statement from `pragma_table_info`, NOT from a
    // schema-validated field, so this is the only path where `quoteIdentifier`
    // is what decides. §8's rule is that a name only a quoting rule makes safe
    // is refused rather than accommodated, and the sink follows the reader in
    // applying it. The consequence is a real limitation — an ordinary column
    // called `first name` cannot be a copy target — and it is filed rather than
    // hidden (#1127), because the refusal is at least loud and rolls back
    // cleanly.
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/not a bare SQL identifier/);
    expect(rowsOf(path, 'SELECT id FROM spaced')).toHaveLength(0);
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
    // The refusal, not the SQL syntax error a valueless INSERT would raise
    // later — both are permanent, and only one of them is this guard.
    expect(err.message).toMatch(/at least one mapped column/);
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
        one([{ id: 1, name: 'a' }, { id: 2 } as Record<string, SinkValue>]),
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

  it('REFUSES an unrecognised mode rather than silently appending', async () => {
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
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: writableConfig(root, path),
          datasetKind: 'table',
          datasetConfig: { table: 'sink' },
          columns: ['id'],
          // The cast is the test: `mode` is typed, so this can only arrive from
          // a future caller that outruns the type — and the wrong outcome there
          // is not a type error, it is the operator's existing rows quietly
          // surviving a copy that meant to replace them (or the reverse).
          mode: 'replace-all' as SqliteWriteMode,
        },
        one([{ id: 2 }]),
      ),
    );
    expect(err.kind).toBe('permanent');
    expect(err.message).toMatch(/unknown copy write mode 'replace-all'/);
    expect(rowsOf(path, 'SELECT id FROM sink')).toEqual([{ id: 1 }]);
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

describe('the one state the sink cannot prove clean', () => {
  it('reports `partialWritePossible` when the ROLLBACK ITSELF fails — the one state it cannot prove clean', async () => {
    const root = tempRoot();
    const path = seedSink(root);

    // The only mock in this file, and it is here because this branch is
    // otherwise unreachable: SQLite does not offer a way to make a rollback
    // fail on demand. The property is worth reaching for — it is the whole
    // reason the rollback is explicit rather than left to `close()`, which
    // unwinds silently and would let the sink report "nothing landed" without
    // ever having checked. Everything else in this suite runs against a real
    // store.
    const exec = Database.prototype.exec;
    const spy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
      if (sql === 'rollback') throw new Error('disk I/O error');
      return exec.call(this, sql);
    });

    try {
      async function* explodes(): AsyncIterable<readonly Record<string, SinkValue>[]> {
        yield [{ id: 1 }];
        throw new Error('the source died');
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
      expect(err.partialWritePossible).toBe(true);
      expect(err.message).toMatch(/rollback FAILED/);
    } finally {
      spy.mockRestore();
    }
  });

  it('DOWNGRADES a transient cause to permanent when the rollback failed (§4.2, applied not just reported)', async () => {
    const root = tempRoot();
    const path = seedSink(root);

    const exec = Database.prototype.exec;
    const spy = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
      if (sql === 'rollback') throw new Error('disk I/O error');
      return exec.call(this, sql);
    });

    try {
      async function* locked(): AsyncIterable<readonly Record<string, SinkValue>[]> {
        yield [{ id: 1 }];
        // The shape a real lock contention arrives in — and on its own it is
        // `transient`, which is what makes this the dangerous case.
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
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
          locked(),
        ),
      );
      // The whole point. `retryEligible` reads only `kind`, so shipping
      // `transient` next to `partialWritePossible: true` would be a retry from
      // row 0 into a table that may already hold these rows.
      expect(err.partialWritePossible).toBe(true);
      expect(err.kind).toBe('permanent');
      // The same cause WITHOUT a failed rollback stays transient — the downgrade
      // is caused by the unprovable state, not by the cause.
      expect(classifySinkFailure({ kind: 'transient', partialWritePossible: false })).toBe(
        'transient',
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the busy timeout (§9)', () => {
  it('reports a contended store as `transient` FAST, rather than busy-waiting the default 5s', async () => {
    const root = tempRoot();
    const path = seedSink(root);

    // A second connection holding the write lock. better-sqlite3's busy wait is
    // SYNCHRONOUS, so the default 5000ms would freeze the event loop for five
    // seconds; `SQLITE_BUSY_TIMEOUT_MS` is what bounds it.
    const blocker = new Database(path);
    blocker.exec('begin immediate');
    const started = Date.now();
    try {
      const err = await failure(
        writeSqliteDatasetRows(
          {
            connectionConfig: writableConfig(root, path),
            datasetKind: 'table',
            datasetConfig: { table: 'sink' },
            columns: ['id'],
            mode: 'append',
          },
          one([{ id: 1 }]),
        ),
      );
      const elapsed = Date.now() - started;
      // `transient` is the correct classification: nothing was written, so a
      // retry from row 0 is safe (§4.1).
      expect(err.kind).toBe('transient');
      expect(err.partialWritePossible).toBe(false);
      // The margin is deliberately wide (250ms configured vs 5000ms default), so
      // this asserts the constant is threaded through without being a timing
      // race. Restore the default and it goes red.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      blocker.exec('rollback');
      blocker.close();
    }
  });
});

describe('cancellation (§10)', () => {
  it('aborts at a batch boundary and leaves the sink in its pre-copy state', async () => {
    const root = tempRoot();
    const path = seedSink(root);
    const controller = new AbortController();
    // THREE batches, and `pulled`, are what make this a BATCH-BOUNDARY test
    // rather than a "cancelled eventually" one. `for await` pulls before the
    // body runs, so batch two is always drawn from the source; what the in-loop
    // check decides is whether the copy stops THERE. Without it, batch two is
    // inserted and batch three is pulled and inserted too, and only the
    // pre-commit check refuses — the same `cancelled` and the same empty table,
    // reached after doing all the work the abort was meant to stop.
    let pulled = 0;
    async function* threeBatches(): AsyncIterable<readonly Record<string, SinkValue>[]> {
      pulled += 1;
      yield [{ id: 1 }];
      controller.abort();
      pulled += 1;
      yield [{ id: 2 }];
      pulled += 1;
      yield [{ id: 3 }];
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
        threeBatches(),
      ),
    );
    expect(err.kind).toBe('cancelled');
    expect(err.partialWritePossible).toBe(false);
    expect(pulled).toBe(2);
    expect(rowsOf(path)).toHaveLength(0);
  });

  it('refuses an ALREADY-aborted signal BEFORE opening the store', async () => {
    const root = tempRoot();
    // A path that does not exist, which is the whole trick: if the pre-open
    // check is doing its job the answer is `cancelled`; if the copy opens first
    // and only notices the abort later, the answer is `permanent` ("cannot open
    // the sqlite database"). Nothing else distinguishes the two.
    const path = join(root, 'never-created.db');
    const err = await failure(
      writeSqliteDatasetRows(
        {
          connectionConfig: { roots: [root], path, writable: true },
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
    expect(classifySinkFailure({ kind: 'transient', partialWritePossible: true })).toBe(
      'permanent',
    );
    expect(classifySinkFailure({ kind: 'rate_limit', partialWritePossible: true })).toBe(
      'permanent',
    );
  });

  it('leaves `cancelled` alone — it is already never retried, and the label carries information', () => {
    expect(classifySinkFailure({ kind: 'cancelled', partialWritePossible: true })).toBe(
      'cancelled',
    );
  });
});
