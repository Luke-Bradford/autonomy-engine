import Database from 'better-sqlite3';
import { isAbsolute } from 'node:path';
import {
  datasetConfigSchema,
  datasetKindIsImplemented,
  isSqlIdentifier,
  queryDatasetConfigSchema,
  sqliteConnectionConfigSchema as sharedSqliteConnectionConfigSchema,
  tableDatasetConfigSchema,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { COPY_BATCH_ROWS } from '../limits.js';
import { resolveWithinRoots } from './confine.js';
import type {
  ActivityContext,
  ActivityEvent,
  ConnectorAdapter,
  ConnectorErrorKind,
} from './types.js';

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
 *  - **Identifiers are validated, then quoted.** A table or schema name cannot
 *    be bound as a parameter, so a `table` dataset's identifiers must match
 *    `SQL_IDENTIFIER_RE` before they are `"`-quoted into the statement.
 *  - **Values BIND, never concatenate.** A `query` dataset's `sql` is literal
 *    and its `parameters` are bound by name, which is what makes `${}` safe by
 *    construction instead of by escaping.
 *
 * And one property that is doing more work than it looks like it is:
 * **the reader only ever `prepare(...).iterate()`s the operator's SQL — never
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

/**
 * The server-side `sqlite` connection config: the SHARED schema plus the one
 * check that cannot live in a browser-safe package.
 *
 * Exactly the divergence `fs.ts` already documents and
 * `connection-config-ssot.test.ts` pins — `node:path`'s `isAbsolute` is
 * platform-aware, so the shared schema carries `roots`' shape and the server
 * refines it. It REFINES rather than re-declares, so the form and the adapter
 * can never describe different objects.
 */
export const sqliteConnectionConfigSchema = sharedSqliteConnectionConfigSchema.extend({
  roots: sharedSqliteConnectionConfigSchema.shape.roots.superRefine((roots, ctx) => {
    roots.forEach((root, index) => {
      if (isAbsolute(root)) return;
      ctx.addIssue({
        code: 'custom',
        message: 'every sqlite root must be an absolute path',
        // Indexed, so with several roots the message names WHICH one is wrong.
        path: [index],
      });
    });
  }),
});

/** A value SQLite can hand back for one column. */
export type SqliteValue = string | number | bigint | Uint8Array | null;
/** One row, keyed by column name as the store reports it. */
export type SqliteRow = Record<string, SqliteValue>;

/**
 * A dataset read that failed, carrying the failure `kind` the M5 `copy` adapter
 * will map straight onto its terminal `node.failed` event (#1 F0's structured
 * failure kind).
 *
 * Classification is FAIL-SAFE, exactly as `fs.ts`'s errno mapper is: only the
 * two SQLite codes that genuinely mean "busy right now" are `transient`, and
 * everything else — including any unrecognised throw — is `permanent`, never
 * blind-retried.
 */
export class DatasetReadError extends Error {
  readonly kind: ConnectorErrorKind;

  constructor(kind: ConnectorErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DatasetReadError';
    this.kind = kind;
  }
}

/** SQLite result codes that mean "try again", not "this will never work". */
const TRANSIENT_SQLITE_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_PROTOCOL']);

/** Map a thrown store error onto a `DatasetReadError` (fail-safe: unrecognised → permanent). */
function readFailure(err: unknown, context: string): DatasetReadError {
  if (err instanceof DatasetReadError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | undefined)?.code;
  const kind: ConnectorErrorKind =
    typeof code === 'string' && TRANSIENT_SQLITE_CODES.has(code.split('_').slice(0, 2).join('_'))
      ? 'transient'
      : 'permanent';
  return new DatasetReadError(kind, `${context}: ${message}`, { cause: err });
}

/**
 * Quote a SQL identifier — AFTER refusing anything that is not one.
 *
 * Both halves matter and neither is redundant. The shape check is the policy
 * (§8: a name that only a quoting rule makes safe is refused, not accommodated);
 * the quoting is what stops a reserved word being a syntax error. Doubling an
 * embedded `"` cannot fire given the shape check, and is kept so the function is
 * correct on its own terms rather than only in its current caller.
 */
function quoteIdentifier(value: string, label: string): string {
  if (!isSqlIdentifier(value)) {
    throw new DatasetReadError(
      'permanent',
      `${label} '${value}' is not a bare SQL identifier, so it cannot be used as a table name`,
    );
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Resolve the store's path through the shared confinement guard, CLASSIFYING the
 * guard's own throws.
 *
 * `resolveWithinRoots` deliberately does not fold a genuine filesystem error
 * into its `{ ok: false }` result — it lets `realpath` throw so the CALLER
 * decides what kind of failure it is, which is exactly what `fs.ts` does in its
 * `resolveOrFail`. Without this wrapper an `ENOENT` on the target's parent
 * directory (or an `EACCES` on a root) escapes as a raw Node error carrying no
 * failure `kind`, which breaks the one contract `DatasetReadError` exists to
 * uphold: that M5's `copy` adapter can map `.kind` straight onto `node.failed`.
 */
async function confineStorePath(roots: readonly string[], requested: string): Promise<string> {
  let confined: Awaited<ReturnType<typeof resolveWithinRoots>>;
  try {
    confined = await resolveWithinRoots(roots, requested);
  } catch (err) {
    throw readFailure(err, `cannot resolve the sqlite database path '${requested}'`);
  }
  if (!confined.ok) throw new DatasetReadError('permanent', confined.error);
  return confined.path;
}

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
  if (!datasetKindIsImplemented(datasetKind)) {
    throw new DatasetReadError(
      'permanent',
      `no reader exists for the '${datasetKind}' dataset kind yet`,
    );
  }

  const parsed = datasetConfigSchema(datasetKind).safeParse(datasetConfig);
  if (!parsed.success) {
    throw new DatasetReadError(
      'permanent',
      `invalid ${datasetKind} dataset config: ${parsed.error.message}`,
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

/** Yield to the event loop between batches — a MACROTASK, deliberately.
 *
 * Measured, because the tree's existing yield idiom would silently be a no-op
 * here: 200 `queueMicrotask` yields served ZERO pending HTTP requests, while 5
 * `setImmediate` yields served one. A microtask drains before the loop turns, so
 * it does not let I/O in — which is the whole purpose of §9's between-batch
 * yield. `run/launcher.ts`, `run/child.ts` and `scheduler/tumbling.ts` all use
 * `queueMicrotask` correctly for ordering; this is not that. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
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
    throw new DatasetReadError(
      'permanent',
      `batchRows must be a positive integer, got ${batchRows}`,
    );
  }

  // §8: "a file-backed dataset must re-validate at dispatch and must not assume
  // the stored connection is well-formed" — `routes/connections.ts` runs no
  // per-kind validation on write, so any shape is storable.
  const cfg = sqliteConnectionConfigSchema.safeParse(read.connectionConfig);
  if (!cfg.success) {
    throw new DatasetReadError(
      'permanent',
      `invalid sqlite connection config: ${cfg.error.message}`,
    );
  }

  const statement = statementFor(read.datasetKind, read.datasetConfig);

  const dbPath = await confineStorePath(cfg.data.roots, cfg.data.path);

  if (read.signal?.aborted) throw new DatasetReadError('cancelled', 'dataset read aborted');

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw readFailure(err, `cannot open the sqlite database at '${cfg.data.path}'`);
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
      throw readFailure(err, 'the dataset statement could not be prepared');
    }
    iterator = cursor;

    let first = true;
    for (;;) {
      // Cancellation and the yield are BOTH at the batch boundary (§9, §10): a
      // batch is a scheduling quantum, so this is the one place the loop is not
      // holding the event loop hostage.
      if (!first) await yieldToEventLoop();
      if (read.signal?.aborted) throw new DatasetReadError('cancelled', 'dataset read aborted');
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
        throw readFailure(err, 'the dataset statement failed mid-scan');
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

export const sqliteAdapter: ConnectorAdapter = {
  kind: 'sqlite',
  configSchema: sqliteConnectionConfigSchema,

  async testConnection(config) {
    const cfg = sqliteConnectionConfigSchema.safeParse(config);
    if (!cfg.success) {
      return { ok: false, error: `invalid sqlite connection config: ${cfg.error.message}` };
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
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      // The query is what actually tests it. Measured: opening a NON-SQLite file
      // read-only SUCCEEDS, and it is the first statement that reports "file is
      // not a database" — so an open alone would call a text file a working
      // store.
      db.prepare('select 1 as ok').get();
      return { ok: true };
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

  async *runActivity(ctx: ActivityContext): AsyncIterable<ActivityEvent> {
    // A store connection binds no activity of its own — reading one is `copy`
    // (M5), which resolves it as a dataset's store rather than as the node's
    // adapter. This body exists because the registry must be TOTAL over
    // `ConnectionKind` (`connection-config-ssot.test.ts` asserts an adapter for
    // every kind), and refusing loudly is the honest content for it.
    //
    // It is also unreachable today, and that is worth knowing before someone
    // "fixes" it: no catalog entry lists `sqlite` in `connectionKinds`, so the
    // executor refuses with `CONNECTION_KIND_INVALID` before dispatch ever
    // reaches an adapter, and the node picker never offers it.
    yield {
      type: 'failed',
      kind: 'permanent',
      error: `a sqlite connection is a STORE binding and runs no activity of its own (got '${ctx.activityType}')`,
    };
  },
};
