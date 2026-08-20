import { linkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DatasetIoError,
  describeSqliteDatasetColumns,
  isTransientSqliteCode,
  readSqliteDatasetBatches,
  sqliteAdapter,
  type SqliteRow,
} from '../sqlite.js';
import { sameDatasetAddress } from '@autonomy-studio/shared';
import { COPY_BATCH_ROWS } from '../../limits.js';
import type { ActivityContext } from '../types.js';
import { cleanupTempRoots, seedDb, tempRoot } from './sqlite-fixtures.js';

/**
 * #1119 M4 — the `sqlite` store connector and its dataset reader.
 *
 * Every test runs against a REAL database file on disk, not a mock: the
 * properties under test (confinement, batch-yield, cursor/handle teardown,
 * integer fidelity, what `iterate()` refuses) are all properties of
 * `better-sqlite3` interacting with the filesystem, and a mock would assert only
 * that this file's own assumptions are self-consistent.
 */

async function collect(
  batches: AsyncGenerator<SqliteRow[], void, undefined>,
): Promise<SqliteRow[][]> {
  const out: SqliteRow[][] = [];
  for await (const batch of batches) out.push(batch);
  return out;
}

afterEach(cleanupTempRoots);

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
    ).rejects.toThrow(DatasetIoError);
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
    ).rejects.toThrow(/symlink; the sqlite connector does not follow symlinks/);
  });

  /**
   * `resolveWithinRoots` deliberately does NOT fold a genuine filesystem error
   * into its `{ok:false}` result — it lets `realpath` throw, so the CALLER
   * classifies it. `fs.ts` does that in `resolveOrFail`; this reader has to do
   * the same, or an `ENOENT` on the target's parent directory escapes as a raw
   * Node error with no `kind` on it, and M5's `copy` adapter — which maps
   * `DatasetIoError.kind` straight onto `node.failed` — gets something it
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
    expect(err).toBeInstanceOf(DatasetIoError);
    expect((err as DatasetIoError).kind).toBe('permanent');
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
  it('refuses a dataset kind that does not live in a SQLITE store', async () => {
    // Was "a kind with no reader yet", and #1167 is why the question changed
    // rather than the answer: `delimited` now HAS a reader — `delimited-io.ts`'s,
    // over an `fs` connection — so "no reader exists" became false while "this
    // store cannot read it" stayed true. Reporting the old sentence here would
    // send an operator to wait for a reader that already shipped.
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
    ).rejects.toThrow(/the sqlite store reads 'table' and 'query' datasets; this one is 'delimited'/);
  });

  it('refuses a delimited config BY KIND, never by trying to parse it as a table', async () => {
    // The failure the guard exists to prevent, pinned by its MESSAGE. A
    // `delimited` config carries `path` and no `table`, so a kind check that had
    // fallen through would still refuse — as "invalid table dataset config",
    // which is a true statement about the wrong thing.
    const root = tempRoot();
    seedDb(root, 1);
    await expect(
      collect(
        readSqliteDatasetBatches({
          connectionConfig: { roots: [root], path: join(root, 'app.db') },
          datasetKind: 'delimited',
          datasetConfig: { path: '/data/in.csv', header: true },
        }),
      ),
    ).rejects.toThrow(/^(?!.*invalid table dataset config).*$/s);
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
    expect(err).toBeInstanceOf(DatasetIoError);
    expect((err as DatasetIoError).kind).toBe('permanent');
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

  // #1134 (M5 slice 4b) REWROTE this, it did not delete it. The pin was written
  // when `copy` was the hypothetical future activity and used it as the example
  // of a type this adapter refuses; `copy` is now the ONE activity it runs, so
  // the old body asserted the opposite of the contract. What it was actually
  // guarding still holds and is what matters: the registry must be TOTAL over
  // `ConnectionKind`, and a store connection binds no ORDINARY activity — so the
  // example moves to a type that really is refused.
  it('runs no activity of its own besides copy', async () => {
    const ctx = { activityType: 'http_request' } as unknown as ActivityContext;
    const events = [];
    for await (const event of sqliteAdapter.runActivity(ctx, null)) events.push(event);
    expect(events).toEqual([
      { type: 'failed', kind: 'permanent', error: expect.stringContaining('STORE binding') },
    ]);
  });

  it('names the type it refused, so a mis-dispatch is diagnosable', async () => {
    const ctx = { activityType: 'llm_call' } as unknown as ActivityContext;
    const events = [];
    for await (const event of sqliteAdapter.runActivity(ctx, null)) events.push(event);
    expect(events[0]).toMatchObject({ error: expect.stringContaining('llm_call') });
  });
});

describe("describeSqliteDatasetColumns (#1148 M6 — §7's source describe seam)", () => {
  const config = (root: string, path: string) => ({ roots: [root], path });

  it("reports a table dataset's columns without reading a row", async () => {
    const root = tempRoot();
    const path = seedDb(root, 3, 'src.db');
    expect(
      await describeSqliteDatasetColumns({
        connectionConfig: config(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 't' },
      }),
    ).toEqual(['id', 'name']);
  });

  it('reports them for an EMPTY table, which is the blind spot M6 exists to close', async () => {
    const root = tempRoot();
    const path = seedDb(root, 0, 'src.db');
    expect(
      await describeSqliteDatasetColumns({
        connectionConfig: config(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 't' },
      }),
    ).toEqual(['id', 'name']);
  });

  it("reports a query dataset's result columns with NOTHING bound", async () => {
    const root = tempRoot();
    const path = seedDb(root, 1, 'src.db');
    // Named parameters are NOT supplied: `columns()` does not execute, so it
    // needs no bind. If that ever stopped being true this would throw.
    expect(
      await describeSqliteDatasetColumns({
        connectionConfig: config(root, path),
        datasetKind: 'query',
        datasetConfig: {
          sql: 'SELECT id AS alpha, name, id + 1 AS computed FROM t WHERE id = $lim',
          parameters: { lim: 1 },
        },
      }),
    ).toEqual(['alpha', 'name', 'computed']);
  });

  it('REFUSES a statement that returns no data, which is what confines operator SQL', async () => {
    const root = tempRoot();
    const path = seedDb(root, 1, 'src.db');
    const other = seedDb(root, 1, 'other.db');
    // `prepare()` alone SUCCEEDS on an ATTACH even under a read-only open, so
    // the reader's confinement rests on never handing operator SQL to a method
    // that executes. `columns()` is that method's opposite and refuses outright.
    await expect(
      describeSqliteDatasetColumns({
        connectionConfig: config(root, path),
        datasetKind: 'query',
        datasetConfig: { sql: `attach database '${other}' as o` },
      }),
    ).rejects.toThrow(/could not be described/);
  });

  it('classifies a missing store as permanent — retrying will not create it', async () => {
    const root = tempRoot();
    seedDb(root, 1, 'src.db');
    const error = await describeSqliteDatasetColumns({
      connectionConfig: config(root, join(root, 'absent.db')),
      datasetKind: 'table',
      datasetConfig: { table: 't' },
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DatasetIoError);
    expect((error as DatasetIoError).kind).toBe('permanent');
  });

  it('refuses a path outside the connection roots', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    const path = seedDb(outside, 1, 'src.db');
    await expect(
      describeSqliteDatasetColumns({
        connectionConfig: config(root, path),
        datasetKind: 'table',
        datasetConfig: { table: 't' },
      }),
    ).rejects.toBeInstanceOf(DatasetIoError);
  });

  it('honours an already-aborted signal before it opens anything', async () => {
    const root = tempRoot();
    const path = seedDb(root, 1, 'src.db');
    const controller = new AbortController();
    controller.abort();
    const error = await describeSqliteDatasetColumns({
      connectionConfig: config(root, path),
      datasetKind: 'table',
      datasetConfig: { table: 't' },
      signal: controller.signal,
    }).catch((err: unknown) => err);
    expect((error as DatasetIoError).kind).toBe('cancelled');
  });
});

/**
 * #1149 M6 slice B (spec §2.1) — the resolved-address seam.
 *
 * Real files again, and for a sharper reason than the suite's usual one: the
 * property under test IS the filesystem's answer to "are these one store", and
 * a mock would only confirm that this file agrees with itself.
 */
describe('resolveDatasetAddress', () => {
  /** The seam, proved present rather than asserted away — it is optional on
   * `ConnectorAdapter` and REQUIRED at the point of use, so a build that lost it
   * must fail this suite rather than skip it. */
  function resolveAddress(
    connectionConfig: Record<string, unknown>,
    dataset: { kind: 'table' | 'query' | 'delimited'; config: Record<string, unknown> },
  ) {
    const resolve = sqliteAdapter.resolveDatasetAddress;
    if (resolve === undefined) throw new Error('the sqlite adapter must resolve dataset addresses');
    return resolve({
      connectionConfig,
      dataset: { id: 'ds_1', name: 'D', kind: dataset.kind, config: dataset.config, columns: [] },
    });
  }

  it('names the confined store, its OS identity and the qualified table', async () => {
    const root = tempRoot();
    const path = seedDb(root, 1);
    const address = await resolveAddress(
      { roots: [root], path },
      { kind: 'table', config: { table: 't' } },
    );
    expect(address).toEqual({
      kind: 'sqlite',
      store: path,
      // `dev:ino`, whose exact values are the OS's business — the SHAPE is what
      // this asserts, and the next test asserts what it is FOR.
      storeIdentity: expect.stringMatching(/^\d+:\d+$/),
      object: 'main.t',
    });
  });

  it('gives two names for ONE file the same identity, and different paths', async () => {
    // A hard link, deliberately, rather than a case-spelling alias: the alias
    // that motivated `storeIdentity` is a case-insensitive filesystem (the
    // operator's APFS Mac), which CI's ext4 does not reproduce. A hard link is
    // the same defect — two paths, one inode — on every platform this runs on.
    const root = tempRoot();
    const path = seedDb(root, 1);
    const alias = join(root, 'alias.db');
    linkSync(path, alias);

    const a = await resolveAddress(
      { roots: [root], path },
      { kind: 'table', config: { table: 't' } },
    );
    const b = await resolveAddress(
      { roots: [root], path: alias },
      { kind: 'table', config: { table: 't' } },
    );

    expect(a.store).not.toBe(b.store);
    expect(a.storeIdentity).toBe(b.storeIdentity);
    // Which is the whole point: the pair is one physical address, so the gate
    // that refuses a self-copy sees it as one.
    expect(sameDatasetAddress(a, b)).toBe(true);
  });

  it('resolves an unqualified table to `main` and folds case the way SQLite does', async () => {
    const root = tempRoot();
    const path = seedDb(root, 1);
    const bare = await resolveAddress(
      { roots: [root], path },
      { kind: 'table', config: { table: 'T' } },
    );
    const qualified = await resolveAddress(
      { roots: [root], path },
      { kind: 'table', config: { schema: 'MAIN', table: 't' } },
    );
    expect(bare.object).toBe('main.t');
    expect(qualified.object).toBe('main.t');
  });

  it('gives a `query` dataset NO object, so it can never be refused as a self-copy', async () => {
    const root = tempRoot();
    const path = seedDb(root, 1);
    const address = await resolveAddress(
      { roots: [root], path },
      { kind: 'query', config: { sql: 'SELECT * FROM t' } },
    );
    expect(address.object).toBeNull();
    expect(address.store).toBe(path);
    expect(sameDatasetAddress(address, address)).toBe(false);
  });

  it('still resolves when the database file does not exist, with a NULL identity', async () => {
    // Unidentifiable is recorded, never thrown and never faked: the copy's own
    // `fileMustExist: true` open is what refuses a store that is not there,
    // with a message about the store rather than about an address.
    const root = tempRoot();
    const address = await resolveAddress(
      { roots: [root], path: join(root, 'absent.db') },
      { kind: 'table', config: { table: 't' } },
    );
    expect(address.storeIdentity).toBeNull();
    expect(address.object).toBe('main.t');
  });

  it('refuses a path outside the connection roots, permanently', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    await expect(
      resolveAddress(
        { roots: [root], path: join(outside, 'app.db') },
        { kind: 'table', config: { table: 't' } },
      ),
    ).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('refuses a dataset kind that does not live in a SQLITE store', async () => {
    // Both guards moved together (#1167) and both are pinned by message, so the
    // address seam and the reader cannot start describing the same mismatch
    // differently. `excel` is the kind that has no reader ANYWHERE and it is
    // refused by the same sentence — one guard, one message.
    const root = tempRoot();
    const path = seedDb(root, 1);
    for (const kind of ['delimited', 'excel'] as const) {
      await expect(
        resolveAddress({ roots: [root], path }, { kind, config: {} }),
      ).rejects.toMatchObject({
        kind: 'permanent',
        message: `the sqlite store reads 'table' and 'query' datasets; this one is '${kind}'`,
      });
    }
  });

  it('refuses a table dataset whose config is not a table config', async () => {
    const root = tempRoot();
    const path = seedDb(root, 1);
    await expect(
      resolveAddress({ roots: [root], path }, { kind: 'table', config: { nope: 1 } }),
    ).rejects.toBeInstanceOf(DatasetIoError);
  });
});
