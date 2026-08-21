import Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import {
  datasetConfigSchema,
  formatZodIssues,
  nocaseFold,
  queryDatasetConfigSchema,
  tableDatasetConfigSchema,
  COPY_ACTIVITY_TYPE,
  type DatasetAddress,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { COPY_BATCH_ROWS, SQLITE_BUSY_TIMEOUT_MS } from '../limits.js';
// #1196 — the store leaf and the sink, lifted out so `copy-sink.ts` can reach
// the writer without importing this adapter back. Re-exported below, so every
// call site outside `connectors/` is unchanged.
import {
  confineStorePath,
  notASqliteKind,
  parseTableTarget,
  SQLITE_DATASET_KINDS,
  sqliteConnectionConfigSchema,
  storeFailure,
  type SqliteRow,
  type SqliteValue,
} from './sqlite-store.js';
export {
  confineStorePath,
  DatasetIoError,
  isTransientSqliteCode,
  parseTableTarget,
  sqliteConnectionConfigSchema,
  type SqliteRow,
  type SqliteValue,
} from './sqlite-store.js';
import { refuseForeignSink, writeRowsToSink } from './copy-sink.js';
export {
  writeSqliteDatasetRows,
  type SinkValue,
  type SqliteDatasetWrite,
  type SqliteWriteMode,
  type SqliteWriteResult,
} from './sqlite-sink.js';
import { failed } from './activity-events.js';
import { DatasetIoError } from './dataset-io-error.js';
import { quoteIdentifier } from './sql-identifier.js';
import { runCopyActivity } from './copy.js';
// #1165 M7 slice 2 — §9's batch-yield primitive, shared with the `delimited`
// reader rather than duplicated (the macrotask choice is not the obvious one).
import { yieldToEventLoop } from './scheduling.js';
import type { ActivityContext, ActivityEvent, ConnectorAdapter } from './types.js';

/**
 * #1119 M4 — the `sqlite` STORE connector (data-movement spec §12's M4), and
 * the first connector that exists to hold data rather than to compute.
 *
 * It ships with NO activity of its own. Reading a store only becomes an
 * observable act when `copy` arrives (M5), so what M4 lands is the two halves
 * `copy` will stand on: a connection kind that can address a database file
 * safely, and a READER that streams a `table`/`query` dataset out of it in
 * bounded batches without stalling the server.
 *
 * SECURITY MODEL — three properties, each of which is a §8 requirement rather
 * than a precaution:
 *
 *  - **The database file is CONFINED.** `config.path` resolves through the
 *    shared `resolveWithinRoots` (`confine.ts`) against `config.roots`, the same
 *    admin-authored allowlist model `fs` uses, because a SQLite database is a
 *    file and an unconfined path is the same traversal risk. Neither key may be
 *    overridden per dispatch — see `CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS`.
 *  - **CONFIG identifiers are validated, then quoted.** A table or schema name
 *    cannot be bound as a parameter, so a `table` dataset's identifiers must
 *    match `SQL_IDENTIFIER_RE` before they are `"`-quoted into the statement.
 *    A name the STORE supplied is a different case and is quoted without that
 *    refusal — see `quoteStoreIdentifier` (#1127).
 *  - **Values BIND, never concatenate.** A `query` dataset's `sql` is literal
 *    and its `parameters` are bound by name, which is what makes `${}` safe by
 *    construction instead of by escaping.
 *
 * And one property that is doing more work than it looks like it is:
 * **the READER only ever `prepare(...).iterate()`s the operator's SQL — never
 * `run()` and never `exec()`.** Measured on `better-sqlite3@12.11.1`: under a
 * `readonly: true` open, `prepare("attach database '<any path>' as o").run()`
 * SUCCEEDS, and the attached database — anywhere on disk, outside every root —
 * is then readable. `iterate()` is what refuses it, because it rejects a
 * statement that returns no rows ("This statement does not return data"). Two
 * neighbouring measurements on the same build: a multi-statement string is
 * refused by `prepare` itself, and `load_extension` is "not authorized". So the
 * confinement above holds only for as long as this rule does, which is why it is
 * stated here and pinned by a test rather than left as an implementation detail.
 *
 * **That rule is reader-scoped, and #1125's SINK breaks it by construction** —
 * it opens read-WRITE and it does `run()` and `exec()`. The invariant survives
 * because it was never "no `run()`" for its own sake; it was "the operator's SQL
 * is never handed to a method that would execute an `ATTACH`". The sink executes
 * NO operator-supplied SQL at all: every statement it runs is built here from an
 * identifier that `quoteIdentifier` has already refused unless it matches
 * `SQL_IDENTIFIER_RE`, and every value BINDS. A `query` dataset — the only place
 * operator SQL exists — is refused as a sink outright. So the two halves reach
 * the same guarantee by different routes, and neither weakens the other.
 *
 * **#1127 narrowed the "already refused unless it matches `SQL_IDENTIFIER_RE`"
 * clause above, and the narrowing is by PROVENANCE.** A table or schema name
 * still is: those come from a dataset's `config`, which §8 requires be literal
 * and identifier-shaped at save time. A COLUMN name in the sink's INSERT list is
 * not, and never was operator text — it is read back out of `pragma_table_info`
 * on the confined file, so it is quoted (`quoteStoreIdentifier`) rather than
 * refused. The security property is unchanged, because a mapping's authored
 * `sink` name cannot introduce a name: `resolveSinkColumns` either resolves it
 * onto one the store already has or refuses the mapping.
 *
 * TWO RESIDUALS, stated so "it reuses the hardened `fs` guard" is not read as
 * "it has the same guarantees":
 *  - `better-sqlite3` opens the path ITSELF, so there is no `O_NOFOLLOW` to hand
 *    it. The target-symlink defence is `resolveWithinRoots`'s `lstat` alone, and
 *    the lstat→open race is genuinely open (measured: better-sqlite3 follows a
 *    symlink without complaint). `fs.ts` documents an equivalent residual for
 *    `file_list`.
 *  - A `readonly` open of a WAL database still CREATES `-shm`/`-wal` sidecars
 *    beside it (measured). So the database's directory must be writable, and
 *    those two files are opened by SQLite itself and never pass through the
 *    confinement guard.
 */

/** What one dataset read needs to know. */
export interface SqliteDatasetRead {
  /** The `sqlite` connection's stored config — RE-PARSED here, never trusted. */
  readonly connectionConfig: Record<string, unknown>;
  readonly datasetKind: DatasetKind;
  readonly datasetConfig: Record<string, unknown>;
  /** Rows per pull, and per event-loop yield. Defaults to `COPY_BATCH_ROWS`. */
  readonly batchRows?: number;
  /** Honoured at BATCH BOUNDARIES (§10) — a run cancel stops the next pull. */
  readonly signal?: AbortSignal;
}

/** The prepared statement text and its bound parameters, per dataset kind. */
function statementFor(
  datasetKind: DatasetKind,
  datasetConfig: Record<string, unknown>,
): { sql: string; parameters: Record<string, unknown> | null } {
  if (!SQLITE_DATASET_KINDS.includes(datasetKind)) {
    throw new DatasetIoError('permanent', notASqliteKind(datasetKind));
  }

  const parsed = datasetConfigSchema(datasetKind).safeParse(datasetConfig);
  if (!parsed.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid ${datasetKind} dataset config: ${formatZodIssues(parsed.error.issues)}`,
    );
  }

  if (datasetKind === 'table') {
    const cfg = tableDatasetConfigSchema.parse(parsed.data);
    const qualified =
      cfg.schema === undefined
        ? quoteIdentifier(cfg.table, 'table')
        : `${quoteIdentifier(cfg.schema, 'schema')}.${quoteIdentifier(cfg.table, 'table')}`;
    return { sql: `SELECT * FROM ${qualified}`, parameters: null };
  }

  const cfg = queryDatasetConfigSchema.parse(parsed.data);
  // An EMPTY parameters object is passed as `null`, not `{}`: better-sqlite3
  // refuses a bind object on a statement that declares no named parameters.
  const parameters =
    cfg.parameters !== undefined && Object.keys(cfg.parameters).length > 0 ? cfg.parameters : null;
  return { sql: cfg.sql, parameters };
}

/**
 * Normalise one column value.
 *
 * The database is opened with `defaultSafeIntegers(true)`, so every INTEGER
 * arrives as a `bigint`. That is not decoration: measured on 12.11.1, the
 * default `number` mode reads a stored `9007199254740993` back as
 * `9007199254740992` — a SILENT one-off corruption that M5's coercion matrix
 * could never recover, because by then the true value is already gone. Safe
 * integers make the store's value exact; this function then hands back a plain
 * `number` for everything inside `Number.MAX_SAFE_INTEGER` (which is every
 * ordinary id, count and timestamp) and keeps the `bigint` only where narrowing
 * would lose information. A consumer that sees a `bigint` is seeing a value a
 * `number` genuinely cannot hold.
 */
function normaliseValue(value: unknown): SqliteValue {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  }
  return value as SqliteValue;
}

/**
 * Stream a `table`/`query` dataset out of a `sqlite` store in bounded batches,
 * yielding to the event loop between them (§9's batch-yield).
 *
 * Always opens READ-ONLY. `config.writable` governs whether the store may be a
 * copy SINK (M5) and has no bearing on a source scan — there is no reason for a
 * read to hold a write lock.
 */
export async function* readSqliteDatasetBatches(
  read: SqliteDatasetRead,
): AsyncGenerator<SqliteRow[], void, undefined> {
  const batchRows = read.batchRows ?? COPY_BATCH_ROWS;
  if (!Number.isInteger(batchRows) || batchRows < 1) {
    throw new DatasetIoError('permanent', `batchRows must be a positive integer, got ${batchRows}`);
  }

  // §8: "a file-backed dataset must re-validate at dispatch and must not assume
  // the stored connection is well-formed" — `routes/connections.ts` runs no
  // per-kind validation on write, so any shape is storable.
  const cfg = sqliteConnectionConfigSchema.safeParse(read.connectionConfig);
  if (!cfg.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid sqlite connection config: ${formatZodIssues(cfg.error.issues)}`,
    );
  }

  const statement = statementFor(read.datasetKind, read.datasetConfig);

  const dbPath = await confineStorePath(cfg.data.roots, cfg.data.path);

  if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');

  let db: Database.Database;
  try {
    db = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
  } catch (err) {
    throw storeFailure(err, `cannot open the sqlite database at '${cfg.data.path}'`);
  }

  let iterator: IterableIterator<unknown> | undefined;
  try {
    db.defaultSafeIntegers(true);
    let cursor: IterableIterator<unknown>;
    try {
      const prepared = db.prepare(statement.sql);
      cursor = (
        statement.parameters === null ? prepared.iterate() : prepared.iterate(statement.parameters)
      ) as IterableIterator<unknown>;
    } catch (err) {
      throw storeFailure(err, 'the dataset statement could not be prepared');
    }
    iterator = cursor;

    let first = true;
    for (;;) {
      // Cancellation and the yield are BOTH at the batch boundary (§9, §10): a
      // batch is a scheduling quantum, so this is the one place the loop is not
      // holding the event loop hostage.
      if (!first) await yieldToEventLoop();
      if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');
      first = false;

      const batch: SqliteRow[] = [];
      let done = false;
      try {
        while (batch.length < batchRows) {
          const next = cursor.next();
          if (next.done === true) {
            done = true;
            break;
          }
          const row = next.value as Record<string, unknown>;
          const normalised: SqliteRow = {};
          for (const key of Object.keys(row)) normalised[key] = normaliseValue(row[key]);
          batch.push(normalised);
        }
      } catch (err) {
        throw storeFailure(err, 'the dataset statement failed mid-scan');
      }

      if (batch.length > 0) yield batch;
      if (done) return;
    }
  } finally {
    // ORDER IS LOAD-BEARING, and measured: `db.close()` with the cursor still
    // open throws "This database connection is busy executing a query", which
    // inside a `finally` would mask the real error — including on the abort path
    // this whole function exists to make correct. Close the cursor first, and
    // guard each step separately so neither failure can escape the unwind.
    try {
      iterator?.return?.(undefined);
    } catch {
      // A cursor that is already exhausted or errored has nothing to release.
    }
    try {
      db.close();
    } catch {
      // Never let a close failure replace the outcome the caller is unwinding with.
    }
  }
}

/**
 * #1148 M6 (spec §7) — the source's ACTUAL column names, WITHOUT reading a row.
 *
 * This is the source half of §7's gate: the mapping (schema 2) is checked
 * against what the store really has (schema 3) BEFORE the first row moves. Until
 * M6 there was no source introspection at all — `planColumns` resolved from the
 * first row's key set, which meant the check ran from inside the sink's open
 * write transaction and did not run AT ALL against an empty source (a mapping
 * naming a column that does not exist reported success over 0 rows).
 *
 * `Statement.columns()` AND NOTHING ELSE, and that is a security invariant, not
 * a performance one. This function is handed operator SQL for a `query` dataset,
 * and the reader's confinement (`:52-62`) rests entirely on never passing that
 * SQL to a method that EXECUTES — `prepare("attach database '…' as o")`
 * succeeds even under a read-only open. Measured (better-sqlite3 12.11.1):
 * `.columns()` on that statement refuses outright with "The columns() method is
 * only for statements that return data", so the seam is safe exactly as long as
 * it stays a `.columns()` call. A later `.get()` "to make describe more
 * informative" would silently reopen the hole. Measured too: `.columns()` needs
 * NO parameters bound, works on an empty table, and reports a computed column
 * with `type: null` — only names are taken here, so that is immaterial.
 *
 * Every throw goes through `storeFailure`, which is what keeps #1148's
 * constraint honest: "a failure to REACH the store to describe it is `transient`
 * and must not be reported as drift". Measured: a missing file raises
 * `SQLITE_CANTOPEN` (permanent, correctly — retrying will not create it) while a
 * store held by a concurrent writer raises `SQLITE_BUSY` from `prepare` ITSELF
 * (transient). Classified anywhere but here, a busy store would be reported as a
 * mapping the operator has to go and fix.
 */
export async function describeSqliteDatasetColumns(read: SqliteDatasetRead): Promise<string[]> {
  const cfg = sqliteConnectionConfigSchema.safeParse(read.connectionConfig);
  if (!cfg.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid sqlite connection config: ${formatZodIssues(cfg.error.issues)}`,
    );
  }
  const statement = statementFor(read.datasetKind, read.datasetConfig);
  const dbPath = await confineStorePath(cfg.data.roots, cfg.data.path);
  if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset describe aborted');

  let db: Database.Database;
  try {
    // A second read-only open, separate from the scan's. It creates the usual
    // `-wal`/`-shm` sidecars beside a WAL store, as the reader already does.
    db = new Database(dbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
  } catch (err) {
    throw storeFailure(err, `cannot open the sqlite database at '${cfg.data.path}'`);
  }
  try {
    return db
      .prepare(statement.sql)
      .columns()
      .map((column) => column.name);
  } catch (err) {
    throw storeFailure(err, 'the dataset statement could not be described');
  } finally {
    try {
      db.close();
    } catch {
      // Never let a close failure replace the outcome the caller is unwinding with.
    }
  }
}

/**
 * #1149 M6 slice B (spec §2.1) — where a `sqlite` dataset PHYSICALLY is.
 *
 * A pure read: it confines the path (which canonicalises the parent, so a
 * traversal or a symlinked directory cannot smuggle the address out of
 * `config.roots`) and asks the OS for the file's identity. Nothing is opened,
 * prepared or executed — in particular the operator SQL of a `query` dataset is
 * never handed to anything, which is the same invariant
 * `describeSqliteDatasetColumns` states for `.columns()`.
 *
 * `storeIdentity` is `dev:ino`, and it is the reason this is not just the path.
 * Measured on this machine's APFS volume: `/private/tmp/x/db.sqlite` and
 * `/private/tmp/x/DB.sqlite` confine to two DIFFERENT strings and one inode
 * (`resolveWithinRoots` joins the final component as spelled). A path-only
 * comparison would therefore let a case-alias pair past the self-copy gate and
 * the sink would delete the rows the source was streaming. A `stat` failure
 * yields `null` rather than throwing: an address that cannot be identified
 * still RECORDS, and the comparison degrades to the path rather than inventing
 * a refusal — the copy's own `fileMustExist: true` open is what refuses a store
 * that is not there, with a message about the store rather than about drift.
 *
 * `object` is `schema.table` folded the way SQLite compares identifiers, and
 * `null` for a `query`: a SELECT names no single object, and guessing one from
 * its text is not something a gate may do.
 */
async function resolveSqliteDatasetAddress(args: {
  readonly connectionConfig: Record<string, unknown>;
  readonly dataset: { readonly kind: DatasetKind; readonly config: Record<string, unknown> };
}): Promise<DatasetAddress> {
  const cfg = sqliteConnectionConfigSchema.safeParse(args.connectionConfig);
  if (!cfg.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid sqlite connection config: ${formatZodIssues(cfg.error.issues)}`,
    );
  }
  if (!SQLITE_DATASET_KINDS.includes(args.dataset.kind)) {
    throw new DatasetIoError('permanent', notASqliteKind(args.dataset.kind));
  }
  const dbPath = await confineStorePath(cfg.data.roots, cfg.data.path);

  let storeIdentity: string | null = null;
  try {
    const stats = await stat(dbPath);
    storeIdentity = `${stats.dev}:${stats.ino}`;
  } catch {
    // Unidentifiable — recorded as such. This must never become a refusal, and
    // never a FALSE identity either.
    //
    // UNIFORM across errno, deliberately, and the argument is not "ENOENT is
    // the only case worth handling": every way `stat` can fail here leaves the
    // COPY unable to proceed anyway, so the degraded comparison cannot admit a
    // copy that would otherwise have been refused. `stat` needs exactly what
    // `better-sqlite3` needs to open the file — the path, and search permission
    // on its parent. ENOENT ⇒ the open raises `SQLITE_CANTOPEN`;
    // EACCES/EPERM/ELOOP/ENAMETOOLONG ⇒ the open hits the same wall; a genuine
    // I/O error ⇒ the first read does. In each the STORE refuses the copy, with
    // a message about the store, which is strictly better than a dispatch-time
    // refusal about an address. Branching on errno would buy nothing and would
    // add the one path this seam must not have: an unidentifiable store
    // becoming a `permanent` refusal.
  }

  const object =
    args.dataset.kind === 'query'
      ? null
      : (() => {
          const target = parseTableTarget(args.dataset.config);
          return `${nocaseFold(target.schema)}.${nocaseFold(target.table)}`;
        })();

  return { kind: 'sqlite', store: dbPath, storeIdentity, object };
}

// ---------------------------------------------------------------------------
// #1125 M5 slice 2 — the SINK.
// ---------------------------------------------------------------------------

export const sqliteAdapter: ConnectorAdapter = {
  kind: 'sqlite',
  configSchema: sqliteConnectionConfigSchema,

  resolveDatasetAddress: resolveSqliteDatasetAddress,

  async testConnection(config) {
    const cfg = sqliteConnectionConfigSchema.safeParse(config);
    if (!cfg.success) {
      return {
        ok: false,
        error: `invalid sqlite connection config: ${formatZodIssues(cfg.error.issues)}`,
      };
    }
    // `testConnection` is typed to RESOLVE, never reject, so the guard's raw
    // throw is caught here too — otherwise a missing directory reaches a caller
    // as an unhandled rejection instead of a message an operator can read.
    let dbPath: string;
    try {
      dbPath = await confineStorePath(cfg.data.roots, cfg.data.path);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath, {
        readonly: true,
        fileMustExist: true,
        timeout: SQLITE_BUSY_TIMEOUT_MS,
      });
      // The query is what actually tests it. Measured: opening a NON-SQLite file
      // read-only SUCCEEDS, and it is the first statement that reports "file is
      // not a database" — so an open alone would call a text file a working
      // store.
      db.prepare('select 1 as ok').get();
      return { ok: true, probed: 'liveness' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      try {
        db?.close();
      } catch {
        // Nothing to report — the probe already produced its answer.
      }
    }
  },

  async *runActivity(
    ctx: ActivityContext,
    _secret: string | null,
    _secretFields?: Readonly<Record<string, string>>,
    // #1196 — the SINK's plaintext credential, decrypted at dispatch into this
    // side channel exactly as `secret` is for the source (M1 #1104 built it;
    // slice 3a is its first consumer). A sqlite sink needs none, but a copy from
    // a sqlite SOURCE into a postgres SINK does — and this adapter is the one
    // running. It is never placed in `ctx` or an event.
    sinkSecret?: string | null,
  ): AsyncIterable<ActivityEvent> {
    // #1134 (M5 slice 4b) — `copy` is the ONE activity a store connection runs,
    // and it runs as the SOURCE end: the executor dispatches by the source
    // connection's kind, resolves the sink connection alongside it, and hands
    // both dataset ends over on `ctx` (slice 4a). Everything store-agnostic —
    // the dispatch schema, the mapping refusals, the counters and the failure
    // mapping — lives in `copy.ts`; this branch supplies only the two halves
    // that are sqlite's.
    if (ctx.activityType === COPY_ACTIVITY_TYPE) {
      const cfg = sqliteConnectionConfigSchema.safeParse(ctx.connectionConfig);
      if (!cfg.success) {
        yield failed(
          'permanent',
          `invalid sqlite connection config: ${formatZodIssues(cfg.error.issues)}`,
        );
        return;
      }
      yield* runCopyActivity(ctx, {
        // #1196 — ONE rung, shared. The sink allowlist is the CATALOG's, so
        // this refusal and the entry that makes a dispatch reachable cannot
        // drift apart; before slice 3a each of the three source adapters
        // hand-wrote its own sentence around a hardcoded `'sqlite'`. It stays a
        // LADDER RUNG rather than a pre-dispatch check so it takes its declared
        // place behind the two preconditions instead of pre-empting them.
        refuseSink: refuseForeignSink,
        // §2.6 gives the SQL kinds no format facts to declare — "a database
        // column already has a type and a real `NULL`, so there is nothing to
        // declare" — so `{}` here is a true statement about `table`/`query`,
        // not an unimplemented stub. The channel is REQUIRED precisely so a
        // store has to say which of the two it means.
        sourceCoercion: () => ({}),
        describeSource: ({ dataset, signal }) =>
          describeSqliteDatasetColumns({
            connectionConfig: cfg.data,
            datasetKind: dataset.kind,
            datasetConfig: dataset.config,
            ...(signal === undefined ? {} : { signal }),
          }),
        readBatches: ({ dataset, signal }) =>
          readSqliteDatasetBatches({
            connectionConfig: cfg.data,
            datasetKind: dataset.kind,
            datasetConfig: dataset.config,
            ...(signal === undefined ? {} : { signal }),
          }),
        // #1196 — dispatched by SINK KIND, so a sqlite source can now write into
        // a postgres store as readily as its own. The sink connection is
        // re-validated inside, against the schema of the kind it claims to be
        // and never this adapter's — a fallback to the source store is the one
        // wrong answer available, because it would write the right rows into the
        // wrong database and report success.
        writeRows: ({ dataset, connection, columns, mode, onBatch, batches, signal }) =>
          writeRowsToSink(
            { dataset, connection, sinkSecret: sinkSecret ?? null, columns, mode, onBatch, signal },
            batches,
          ),
      });
      return;
    }

    // Any OTHER activity type: a store connection binds none of its own. This
    // body exists because the registry must be TOTAL over `ConnectionKind`
    // (`connection-config-ssot.test.ts` asserts an adapter for every kind), and
    // refusing loudly is the honest content for it.
    //
    // Reachable as of 4c (#1139), where it was not before: the `copy` entry now
    // lists `sqlite` in `connectionKinds`, so a `sqlite` connection is bindable
    // and the executor no longer refuses every such node with
    // `CONNECTION_KIND_INVALID` ahead of dispatch. `copy` is the one activity
    // this adapter runs; anything else still lands here.
    yield failed(
      'permanent',
      `a sqlite connection is a STORE binding and runs no activity of its own (got '${ctx.activityType}')`,
    );
  },
};
