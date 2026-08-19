import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DatasetReadError,
  isTransientSqliteCode,
  readSqliteDatasetBatches,
  sqliteAdapter,
  type SqliteRow,
} from '../sqlite.js';
import { COPY_BATCH_ROWS } from '../../limits.js';
import type { ActivityContext } from '../types.js';

/**
 * #1119 M4 — the `sqlite` store connector and its dataset reader.
 *
 * Every test runs against a REAL database file on disk, not a mock: the
 * properties under test (confinement, batch-yield, cursor/handle teardown,
 * integer fidelity, what `iterate()` refuses) are all properties of
 * `better-sqlite3` interacting with the filesystem, and a mock would assert only
 * that this file's own assumptions are self-consistent.
 */

const dirs: string[] = [];

/** A temp dir whose path is REALPATH'd.
 *
 * On macOS `os.tmpdir()` is itself a symlink (`/var` → `/private/var`), so a
 * root taken straight from `mkdtemp` never canonically contains the paths
 * resolved under it, and a confinement test would pass for the wrong reason —
 * or fail for one. `connectors/__tests__/fs.test.ts` wraps it for exactly this. */
function tempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'm4-sqlite-')));
  dirs.push(dir);
  return dir;
}

/** A database file under `root`, seeded with `rows` rows in `t(id, name)`. */
function seedDb(root: string, rows: number, name = 'app.db'): string {
  const path = join(root, name);
  const db = new Database(path);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  const insert = db.prepare('INSERT INTO t (id, name) VALUES (?, ?)');
  const many = db.transaction((count: number) => {
    for (let i = 1; i <= count; i += 1) insert.run(i, `row-${i}`);
  });
  many(rows);
  db.close();
  return path;
}

async function collect(
  batches: AsyncGenerator<SqliteRow[], void, undefined>,
): Promise<SqliteRow[][]> {
  const out: SqliteRow[][] = [];
  for await (const batch of batches) out.push(batch);
  return out;
}

afterEach(() => {
  // REMOVE them, as `fs.test.ts` does. The earlier "the OS reaps them" note was
  // true and beside the point: these dirs hold real database files, one test
  // writes a WAL sidecar pair, and `/tmp` is not reaped between runs on every
  // platform — so the departure from the sibling suite's convention just left
  // litter accumulating.
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('reading a `table` dataset', () => {
  it('streams every row, in bounded batches', async () => {
    const root = tempRoot();
    seedDb(root, 25);
    const batches = await collect(
      readSqliteDatasetBatches({
        connectionConfig: { roots: [root], path: join(root, 'app.db') },
        datasetKind: 'table',
        datasetConfig: { table: 't' },
        batchRows: 10,
      }),
    );
    expect(batches.map((b) => b.length)).toEqual([10, 10, 5]);
    expect(batches.flat()).toHaveLength(25);
    expect(batches[0]![0]).toEqual({ id: 1, name: 'row-1' });
  });

  it('yields NOTHING for an empty table rather than an empty batch', async () => {
    const root = tempRoot();
    seedDb(root, 0);
    expect(
      await collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: join(root, 'app.db') },
          datasetKind: 'table',
          datasetConfig: { table: 't' },
        }),
      ),
    ).toEqual([]);
  });

  it('defaults the batch size to COPY_BATCH_ROWS', async () => {
    const root = tempRoot();
    seedDb(root, COPY_BATCH_ROWS + 1);
    const batches = await collect(
      readSqliteDatasetBatches({
        connectionConfig: { roots: [root], path: join(root, 'app.db') },
        datasetKind: 'table',
        datasetConfig: { table: 't' },
      }),
    );
    expect(batches.map((b) => b.length)).toEqual([COPY_BATCH_ROWS, 1]);
  });

  it('YIELDS TO THE EVENT LOOP between batches', async () => {
    // The §9 property, and the version of this test that DOESN'T work is worth
    // recording: scheduling the probe before the read passes even with a
    // microtask "yield", because `resolveWithinRoots` does real `realpath`/
    // `lstat` I/O before the first batch and that turns the loop on its own. It
    // asserted nothing about the between-batch yield at all.
    //
    // So the probe is scheduled AFTER the first batch has been delivered, and
    // the assertion is that it runs before the LAST one. Only a yield that
    // actually turns the loop between batches can let it in — a microtask
    // drains before the loop turns, which is why the tree's `queueMicrotask`
    // idiom would be a silent no-op here (mutation-checked: swapping
    // `setImmediate` for `queueMicrotask` turns this red).
    const root = tempRoot();
    seedDb(root, 50);
    const order: string[] = [];
    const batches = readSqliteDatasetBatches({
      connectionConfig: { roots: [root], path: join(root, 'app.db') },
      datasetKind: 'table',
      datasetConfig: { table: 't' },
      batchRows: 5,
    });
    for await (const _batch of batches) {
      void _batch;
      if (order.length === 0) setImmediate(() => order.push('event-loop'));
      order.push('batch');
    }
    expect(order).toContain('event-loop');
    expect(order.indexOf('event-loop')).toBeLessThan(order.lastIndexOf('batch'));
  });

  it('reads an integer too large for a double WITHOUT truncating it', async () => {
    // Measured: in better-sqlite3's default number mode a stored
    // 9007199254740993 reads back as 9007199254740992. That is silent data
    // corruption in the READER, which no later coercion could undo.
    const root = tempRoot();
    const path = join(root, 'big.db');
    const db = new Database(path);
    db.exec('CREATE TABLE big (n INTEGER)');
    db.prepare('INSERT INTO big (n) VALUES (9007199254740993)').run();
    db.prepare('INSERT INTO big (n) VALUES (42)').run();
    db.close();

    const rows = (
      await collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path },
          datasetKind: 'table',
          datasetConfig: { table: 'big' },
        }),
      )
    ).flat();
    expect(rows[0]!.n).toBe(9007199254740993n);
    // ...and an ordinary integer is still a plain number, not a bigint.
    expect(rows[1]!.n).toBe(42);
  });
});

describe('reading a `query` dataset', () => {
  it('binds named parameters as DATA, never as SQL', async () => {
    const root = tempRoot();
    seedDb(root, 3);
    const rows = (
      await collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: join(root, 'app.db') },
          datasetKind: 'query',
          datasetConfig: {
            sql: 'SELECT * FROM t WHERE name = :name',
            // An injection-shaped VALUE: bound, so it matches nothing and drops
            // no table. If it were concatenated, the table would be gone.
            parameters: { name: "row-1'; DROP TABLE t; --" },
          },
        }),
      )
    ).flat();
    expect(rows).toEqual([]);

    const survivor = new Database(join(root, 'app.db'), { readonly: true });
    expect(survivor.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 3 });
    survivor.close();
  });

  it('runs a parameterless statement', async () => {
    const root = tempRoot();
    seedDb(root, 2);
    const rows = (
      await collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: join(root, 'app.db') },
          datasetKind: 'query',
          datasetConfig: { sql: 'SELECT name FROM t ORDER BY id' },
        }),
      )
    ).flat();
    expect(rows).toEqual([{ name: 'row-1' }, { name: 'row-2' }]);
  });

  it('REFUSES a statement that returns no rows — the ATTACH escape', async () => {
    // The load-bearing measurement in this file. Under a `readonly: true` open,
    // `prepare("attach database '<any path>' as o").run()` SUCCEEDS on
    // better-sqlite3@12.11.1, and the attached database — outside every root —
    // is then readable. What refuses it is that the reader ONLY ever
    // `prepare(...).iterate()`s, and `iterate()` rejects a non-row statement.
    // So this test is the confinement, not a syntax check.
    const root = tempRoot();
    seedDb(root, 1);
    const outside = tempRoot();
    seedDb(outside, 1, 'secret.db');

    await expect(
      collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: join(root, 'app.db') },
          datasetKind: 'query',
          datasetConfig: { sql: `ATTACH DATABASE '${join(outside, 'secret.db')}' AS o` },
        }),
      ),
    ).rejects.toThrow(DatasetReadError);
  });

  it('refuses a multi-statement string', async () => {
    const root = tempRoot();
    seedDb(root, 1);
    await expect(
      collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: join(root, 'app.db') },
          datasetKind: 'query',
          datasetConfig: { sql: 'SELECT * FROM t; DROP TABLE t' },
        }),
      ),
    ).rejects.toThrow(/more than one statement/i);
  });

  it('reports a missing named parameter as permanent, not a silent empty read', async () => {
    const root = tempRoot();
    seedDb(root, 1);
    await expect(
      collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: join(root, 'app.db') },
          datasetKind: 'query',
          datasetConfig: { sql: 'SELECT * FROM t WHERE name = :name' },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'permanent' });
  });
});

describe('the confinement guard applies to the database file', () => {
  it('refuses a path outside every root', async () => {
    const root = tempRoot();
    const elsewhere = tempRoot();
    seedDb(root, 1);
    const outside = seedDb(elsewhere, 1, 'other.db');
    await expect(
      collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: outside },
          datasetKind: 'table',
          datasetConfig: { table: 't' },
        }),
      ),
    ).rejects.toThrow(/resolves outside the allowed roots/);
  });

  it('refuses a symlink AT the database path', async () => {
    const root = tempRoot();
    const elsewhere = tempRoot();
    const real = seedDb(elsewhere, 1, 'real.db');
    const link = join(root, 'link.db');
    symlinkSync(real, link);
    await expect(
      collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: link },
          datasetKind: 'table',
          datasetConfig: { table: 't' },
        }),
      ),
    ).rejects.toThrow(/symlink/);
  });

  /**
   * `resolveWithinRoots` deliberately does NOT fold a genuine filesystem error
   * into its `{ok:false}` result — it lets `realpath` throw, so the CALLER
   * classifies it. `fs.ts` does that in `resolveOrFail`; this reader has to do
   * the same, or an `ENOENT` on the target's parent directory escapes as a raw
   * Node error with no `kind` on it, and M5's `copy` adapter — which maps
   * `DatasetReadError.kind` straight onto `node.failed` — gets something it
   * cannot classify.
   */
  it('classifies a filesystem error from the guard rather than letting it escape raw', async () => {
    const root = tempRoot();
    seedDb(root, 1);
    // A parent directory that does not exist: `realpath(dirname(target))` throws
    // ENOENT from inside the guard.
    const missing = join(root, 'no-such-dir', 'db.sqlite');
    const err = await collect(
      readSqliteDatasetBatches({
        connectionConfig: { roots: [root], path: missing },
        datasetKind: 'table',
        datasetConfig: { table: 't' },
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DatasetReadError);
    expect((err as DatasetReadError).kind).toBe('permanent');
  });

  it('refuses a relative root, server-side', async () => {
    const root = tempRoot();
    seedDb(root, 1);
    await expect(
      collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: ['relative/dir'], path: join(root, 'app.db') },
          datasetKind: 'table',
          datasetConfig: { table: 't' },
        }),
      ),
    ).rejects.toThrow(/absolute path/);
  });
});

describe('what the reader refuses before it opens anything', () => {
  it('refuses a dataset kind with no reader yet', async () => {
    const root = tempRoot();
    seedDb(root, 1);
    await expect(
      collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: join(root, 'app.db') },
          datasetKind: 'delimited',
          datasetConfig: { path: '/data/in.csv' },
        }),
      ),
    ).rejects.toThrow(/no reader exists for the 'delimited' dataset kind/);
  });

  it('refuses an injection-shaped table identifier', async () => {
    const root = tempRoot();
    seedDb(root, 1);
    await expect(
      collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: join(root, 'app.db') },
          datasetKind: 'table',
          datasetConfig: { table: 't"; DROP TABLE t; --' },
        }),
      ),
    ).rejects.toThrow(/invalid table dataset config/);
  });

  it('refuses a malformed connection config rather than assuming it is well-formed', async () => {
    await expect(
      collect(
        readSqliteDatasetBatches({
          connectionConfig: { path: '/nowhere/app.db' },
          datasetKind: 'table',
          datasetConfig: { table: 't' },
        }),
      ),
    ).rejects.toThrow(/invalid sqlite connection config/);
  });
});

describe('failure classification', () => {
  /**
   * `readFailure`'s fail-safe rule is a claim the file makes in prose and
   * nothing asserted. Pinned on the PREDICATE rather than by forcing a real
   * lock, because what can actually be got wrong here is the extended-result-code
   * reduction, not whether SQLite reports a busy database.
   */
  it('treats a busy/locked EXTENDED code as transient and everything else as permanent', () => {
    // The shapes better-sqlite3 really reports: primary + extended.
    expect(isTransientSqliteCode('SQLITE_BUSY')).toBe(true);
    expect(isTransientSqliteCode('SQLITE_BUSY_SNAPSHOT')).toBe(true);
    expect(isTransientSqliteCode('SQLITE_LOCKED_SHAREDCACHE')).toBe(true);
    expect(isTransientSqliteCode('SQLITE_PROTOCOL')).toBe(true);

    // And the over-match this must NOT make: a disk read error reduces to
    // SQLITE_IOERR, which is not something to retry into.
    expect(isTransientSqliteCode('SQLITE_IOERR_READ')).toBe(false);
    expect(isTransientSqliteCode('SQLITE_CORRUPT_VTAB')).toBe(false);
    expect(isTransientSqliteCode('SQLITE_ERROR')).toBe(false);
    expect(isTransientSqliteCode('SQLITE_READONLY_DBMOVED')).toBe(false);
  });

  it('classifies an unrecognised throw as permanent, never blind-retried', async () => {
    const root = tempRoot();
    seedDb(root, 1);
    const err = await collect(
      readSqliteDatasetBatches({
        connectionConfig: { roots: [root], path: join(root, 'app.db') },
        datasetKind: 'query',
        datasetConfig: { sql: 'SELECT * FROM no_such_table' },
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DatasetReadError);
    expect((err as DatasetReadError).kind).toBe('permanent');
  });
});

describe('teardown', () => {
  /**
   * A consumer that `break`s out of `for await` calls the generator's own
   * `.return()`, which is a DIFFERENT route into the `finally` than the abort
   * check throwing — and it is the route a real `copy` will take when its sink
   * fails part-way. Asserted by spying on `close` rather than by inspecting a
   * handle the caller cannot reach, so deleting the `db.close()` in the `finally`
   * makes it red.
   */
  it('closes the database when the CONSUMER stops early', async () => {
    const root = tempRoot();
    const path = seedDb(root, 10);
    const closeSpy = vi.spyOn(Database.prototype, 'close');
    try {
      for await (const batch of readSqliteDatasetBatches({
        connectionConfig: { roots: [root], path },
        datasetKind: 'table',
        datasetConfig: { table: 't' },
        batchRows: 2,
      })) {
        expect(batch).toHaveLength(2);
        break;
      }
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      closeSpy.mockRestore();
    }
  });
});

describe('cancellation', () => {
  it('stops at the next batch boundary and closes cleanly', async () => {
    const root = tempRoot();
    seedDb(root, 100);
    const controller = new AbortController();
    const batches = readSqliteDatasetBatches({
      connectionConfig: { roots: [root], path: join(root, 'app.db') },
      datasetKind: 'table',
      datasetConfig: { table: 't' },
      batchRows: 10,
      signal: controller.signal,
    });

    const seen: SqliteRow[][] = [];
    await expect(
      (async () => {
        for await (const batch of batches) {
          seen.push(batch);
          controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(seen).toHaveLength(1);

    // The teardown property: `db.close()` with the cursor still open throws
    // "This database connection is busy executing a query", and inside a
    // `finally` that would MASK the cancellation above. Reaching this line with
    // a `cancelled` error rather than a busy-connection one is the assertion.
    const reopened = new Database(join(root, 'app.db'), { readonly: true });
    expect(reopened.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 100 });
    reopened.close();
  });

  it('refuses before opening when already aborted', async () => {
    const root = tempRoot();
    seedDb(root, 1);
    await expect(
      collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: join(root, 'app.db') },
          datasetKind: 'table',
          datasetConfig: { table: 't' },
          signal: AbortSignal.abort(),
        }),
      ),
    ).rejects.toMatchObject({ kind: 'cancelled' });
  });
});

describe('the adapter', () => {
  it('tests a real database, and a non-database file that merely opens', async () => {
    const root = tempRoot();
    seedDb(root, 1);
    await expect(
      sqliteAdapter.testConnection({ roots: [root], path: join(root, 'app.db') }, null),
    ).resolves.toEqual({ ok: true });

    // Measured: opening a NON-SQLite file read-only SUCCEEDS — it is the first
    // statement that reports "file is not a database". An open-only probe would
    // call a text file a working store.
    const notADb = join(root, 'notes.txt');
    writeFileSync(notADb, 'this is not a database');
    const probe = await sqliteAdapter.testConnection({ roots: [root], path: notADb }, null);
    expect(probe.ok).toBe(false);
    expect(probe.error).toMatch(/not a database/i);
  });

  /** `ConnectorAdapter.testConnection` is typed to RESOLVE, never reject, so the
   * guard's raw throw has to be caught here too — otherwise wiring a
   * "test connection" route turns a missing directory into an unhandled
   * rejection instead of a message the operator can read. */
  it('RESOLVES rather than rejecting when the guard throws a filesystem error', async () => {
    const root = tempRoot();
    seedDb(root, 1);
    await expect(
      sqliteAdapter.testConnection(
        { roots: [root], path: join(root, 'no-such-dir', 'db.sqlite') },
        null,
      ),
    ).resolves.toMatchObject({ ok: false });
  });

  it('reports a path outside the roots as the probe failure', async () => {
    const root = tempRoot();
    const elsewhere = tempRoot();
    const outside = seedDb(elsewhere, 1, 'other.db');
    await expect(
      sqliteAdapter.testConnection({ roots: [root], path: outside }, null),
    ).resolves.toMatchObject({ ok: false });
  });

  it('runs no activity of its own', async () => {
    const ctx = { activityType: 'copy' } as unknown as ActivityContext;
    const events = [];
    for await (const event of sqliteAdapter.runActivity(ctx, null)) events.push(event);
    expect(events).toEqual([
      { type: 'failed', kind: 'permanent', error: expect.stringContaining('STORE binding') },
    ]);
  });
});
