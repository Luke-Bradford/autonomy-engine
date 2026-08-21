import Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  datasetConfigSchema,
  formatZodIssues,
  nocaseFold,
  queryDatasetConfigSchema,
  sqliteConnectionConfigSchema as sharedSqliteConnectionConfigSchema,
  tableDatasetConfigSchema,
  COPY_ACTIVITY_TYPE,
  type CoercedValue,
  type DatasetAddress,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { COPY_BATCH_ROWS, SQLITE_BUSY_TIMEOUT_MS } from '../limits.js';
import { failed } from './activity-events.js';
import { DatasetIoError } from './dataset-io-error.js';
import { doubleQuoted, quoteIdentifier } from './sql-identifier.js';
import { runCopyActivity } from './copy.js';
// #1165 M7 slice 2 — §9's batch-yield primitive, shared with the `delimited`
// reader rather than duplicated (the macrotask choice is not the obvious one).
import { yieldToEventLoop } from './scheduling.js';
import { resolveWithinRoots } from './confine.js';
import { classifySinkFailure } from './error-kind.js';
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

/**
 * The server-side `sqlite` connection config: the SHARED schema plus the one
 * check that cannot live in a browser-safe package.
 *
 * Exactly the divergence `fs.ts` already documents and
 * `connection-config-ssot.test.ts` pins — `node:path`'s `isAbsolute` is
 * platform-aware, so the shared schema carries `roots`' shape and the server
 * refines it. It REFINES rather than re-declares, so the form and the adapter
 * can never describe different objects.
 *
 * EXPORTED as of #1167, because a sqlite SINK is no longer only reached from
 * this file. `fs.ts`'s copy arm gates the sink connection before handing it to
 * `writeSqliteDatasetRows`, and gating it with the SHARED schema would make that
 * rung strictly weaker than the identical rung on this adapter — a relative
 * root would pass `fs.ts`'s check and be refused one layer down, with a
 * different message for the same fault. The inner re-parse in
 * `writeSqliteDatasetRows` still catches it either way, but "the callee happens
 * to re-check" is defence in depth that this gate should not be leaning on
 * silently. One schema, both arms.
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
 * Re-exported so the three test suites and every existing importer keep their
 * `from './sqlite.js'` path: #1134 moved the class to its own module only to
 * break an import cycle (`copy.ts` needs it to unwrap a mapping failure, and
 * this module imports `copy.ts` to dispatch), not to re-home its public name.
 */
export { DatasetIoError };

/** SQLite result codes that mean "try again", not "this will never work". */
const TRANSIENT_SQLITE_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_PROTOCOL']);

/**
 * Whether a SQLite result code means "busy right now" rather than "this will
 * never work" — the fail-safe classification rule, named and exported so the
 * claim `readFailure` rests on can be asserted directly.
 *
 * The prefix reduction is the part worth pinning. better-sqlite3 reports
 * EXTENDED result codes (`SQLITE_<PRIMARY>_<EXTENDED>`), so a real lock
 * contention arrives as `SQLITE_BUSY_SNAPSHOT`, not `SQLITE_BUSY`; taking the
 * first two segments is what makes the set match it. It also has to NOT
 * over-match: `SQLITE_IOERR_READ` reduces to `SQLITE_IOERR`, which is absent
 * from the set and therefore stays permanent — a disk read error is not
 * something to retry into.
 */
export function isTransientSqliteCode(code: string): boolean {
  return TRANSIENT_SQLITE_CODES.has(code.split('_').slice(0, 2).join('_'));
}

/** Map a thrown store error onto a `DatasetIoError` (fail-safe: unrecognised → permanent).
 *
 * `partialWritePossible` defaults to false and is passed explicitly by the SINK,
 * the only caller that can leave rows behind. A read never can. */
function storeFailure(err: unknown, context: string, partialWritePossible = false): DatasetIoError {
  if (err instanceof DatasetIoError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | undefined)?.code;
  const kind: ConnectorErrorKind =
    typeof code === 'string' && isTransientSqliteCode(code) ? 'transient' : 'permanent';
  return new DatasetIoError(kind, `${context}: ${message}`, { cause: err, partialWritePossible });
}

/**
 * Quote an identifier the STORE told us about — no shape refusal (#1127).
 *
 * The difference from `quoteIdentifier` (now `sql-identifier.ts`, lifted there
 * by #1190 when postgres needed it too) is a difference in PROVENANCE, not
 * in strictness for its own sake. §8's rule — "a name that only a quoting rule
 * makes safe is refused, not accommodated" — is about a name that reaches SQL
 * from operator-authored text, which cannot be bound as a parameter and so has
 * to be constrained rather than escaped. A column name read back out of
 * `pragma_table_info` is not that: it is the schema's own content, from a
 * database file `confineStorePath` has already confined, and the operator
 * created it by executing DDL against their own store. Doubling an embedded `"`
 * is genuinely sufficient there, and refusing it instead made an ordinary table
 * with a column called `first name` — or any CSV header with a space in it —
 * impossible to copy into, against the any-to-any intent of #993.
 *
 * WHAT KEEPS THIS SAFE, stated because "we relaxed the identifier check" is the
 * kind of sentence that deserves an argument under it. A mapping's `sink` name
 * is operator-authored, and it never reaches SQL as written: `resolveSinkColumns`
 * looks it up against the store's own columns and emits `actual`, the store's
 * spelling, or refuses the mapping. So an authored name can only ever select
 * from the set of names the store already has — it cannot introduce one. That
 * holds even for a mapping supplied dynamically through a whole-value `${}`,
 * which is why the save-time gate can leave that shape alone.
 *
 * TABLE and SCHEMA names keep `quoteIdentifier` and its refusal. Those DO come
 * from a dataset's `config`, which §8 requires be literal and identifier-shaped
 * at save time (`catalog/dataset-config.ts`'s `SQL_IDENTIFIER_RE`), so the two
 * cases have genuinely different threat models and the split is the point.
 *
 * ONE RESIDUAL, in the spirit of the module docblock's two: a column name
 * containing a NUL is the one shape doubling cannot make safe, because
 * `better-sqlite3` hands `prepare()` a C string and SQLite parses only as far as
 * the NUL — the statement is truncated mid-identifier. That fails CLOSED
 * (`prepare` throws, `storeFailure` classifies it, the transaction rolls back,
 * no partial write), so it is a poor error message rather than a hole, and it
 * needs a column no ordinary DDL through this tooling can create. Recorded so
 * the "doubling is genuinely sufficient" claim above is read with its one
 * exception rather than as unqualified.
 */
function quoteStoreIdentifier(value: string): string {
  return doubleQuoted(value);
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
 * failure `kind`, which breaks the one contract `DatasetIoError` exists to
 * uphold: that M5's `copy` adapter can map `.kind` straight onto `node.failed`.
 */
async function confineStorePath(roots: readonly string[], requested: string): Promise<string> {
  let confined: Awaited<ReturnType<typeof resolveWithinRoots>>;
  try {
    confined = await resolveWithinRoots(roots, requested, 'sqlite');
  } catch (err) {
    throw storeFailure(err, `cannot resolve the sqlite database path '${requested}'`);
  }
  if (!confined.ok) throw new DatasetIoError('permanent', confined.error);
  return confined.path;
}

/**
 * The dataset kinds THIS STORE reads, named literally.
 *
 * Not `datasetKindIsImplemented`, which is what both guards below used to ask
 * and which stopped being the right question at M7 slice 3 (#1167).
 * `IMPLEMENTED_DATASET_KINDS` answers "does a reader exist ANYWHERE", and from
 * that slice on it spans two stores — so a `delimited` dataset would have passed
 * here and then been handed to `parseTableTarget`, which reports "invalid table
 * dataset config": a true statement about the wrong thing, sending an operator
 * to fix a config that is correct for the store it actually lives in.
 *
 * ONE guard and ONE message, deliberately, rather than a not-implemented arm
 * stacked on a not-mine arm. Layered, one of the two is unreachable for every
 * kind (`excel` is neither implemented nor a sqlite kind), and the pair would
 * only ever say which of two true things a given ordering happened to reach
 * first. `delimited-io.ts`'s `prepareRead` is the same shape from the other
 * store, which is what keeps the two symmetric.
 *
 * The MISMATCH this refuses is a dispatch the executor should already have
 * refused — `DATASET_CONNECTION_MISMATCH` fires when the dataset's store is not
 * the one the node bound — so this is defence in depth on a diagnostics path,
 * not the gate. It stays because a guard that reports the wrong fault is worse
 * than one that never runs.
 */
const SQLITE_DATASET_KINDS: readonly DatasetKind[] = ['table', 'query'];

/** The refusal for a dataset kind that does not live in a sqlite store. */
function notASqliteKind(kind: DatasetKind): string {
  return `the sqlite store reads ${SQLITE_DATASET_KINDS.map((k) => `'${k}'`).join(' and ')} datasets; this one is '${kind}'`;
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
 * The `table` dataset config both the SINK writer and the address resolver
 * need, with SQLite's default database applied.
 *
 * A SQLite "schema" is an ATTACHed database and this connector attaches
 * nothing, so an unqualified dataset means `main`. Shared rather than
 * duplicated because the address gate and the writer MUST agree on what "the
 * same table" is: two spellings of one default would let the gate compare
 * `users` against `main.users` and find them different, which is precisely the
 * silent pass this slice exists to remove.
 */
function parseTableTarget(datasetConfig: Record<string, unknown>): {
  schema: string;
  table: string;
} {
  const parsed = tableDatasetConfigSchema.safeParse(datasetConfig);
  if (!parsed.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid table dataset config: ${formatZodIssues(parsed.error.issues)}`,
    );
  }
  return { schema: parsed.data.schema ?? 'main', table: parsed.data.table };
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

/**
 * One value a sink may bind.
 *
 * `CoercedValue` (slice 1) is the vocabulary the coercion matrix produces, and
 * taking it rather than `unknown` is what stops this file writing casts — "a
 * cast that claims a type its value is outside of is the failure no type error
 * catches" (`datamove/coerce.ts`). It is widened by exactly one member:
 * `Uint8Array`, because the M4 reader hands BLOBs back as `Buffer` (a
 * `Uint8Array`) and a BLOB→BLOB copy must not be silently unsupported. The
 * widening is written down here rather than left implicit at the call site.
 *
 * AMENDED by slice 3 (#1129), because that last sentence now overstates what
 * the product can do: `DataTypeSchema` has no binary member, so `coerceValue`
 * fails every `Uint8Array` against every declared target and no BLOB can reach
 * this sink THROUGH A COPY. The member stays — a direct caller may bind one, and
 * removing it would put the cast back — but the capability is filed as #1131
 * rather than implied by a type.
 */
export type SinkValue = CoercedValue | Uint8Array;

/** `append` adds to what is there; `overwrite` replaces the table's contents. */
export type SqliteWriteMode = 'append' | 'overwrite';

/** What one dataset write needs to know. */
export interface SqliteDatasetWrite {
  /** The `sqlite` connection's stored config — RE-PARSED here, never trusted. */
  readonly connectionConfig: Record<string, unknown>;
  readonly datasetKind: DatasetKind;
  readonly datasetConfig: Record<string, unknown>;
  /** The sink columns this copy writes, matched case-insensitively (§7). */
  readonly columns: readonly string[];
  readonly mode: SqliteWriteMode;
  /** Honoured at BATCH BOUNDARIES (§10) — a run cancel rolls the copy back. */
  readonly signal?: AbortSignal;
  /**
   * §5's progress channel: the RUNNING TOTAL after each batch is inserted into
   * the OPEN transaction. Per batch, never per row — one event per row is the
   * log-volume problem §5 forbids. It exists now rather than at slice 3 because
   * a `Promise<{rowsWritten}>` gives the pump nothing to tick from until the
   * write has already finished, and adding it later would change a shipped
   * signature.
   *
   * **A tick is progress, not committed truth**, and the pump must not present
   * it as the latter: these rows sit in an uncommitted transaction, so a later
   * failure rolls every ticked row back. An operator can legitimately see
   * "500 rows" moments before the copy reports that it wrote none.
   */
  readonly onBatch?: (rowsWritten: number) => void;
}

/** What a completed write reports. */
export interface SqliteWriteResult {
  readonly rowsWritten: number;
}

/**
 * Bind one value, converting only where better-sqlite3 cannot take the value as
 * it stands.
 *
 * The boolean arm is load-bearing and measured, not defensive: on 12.11.1,
 * `run(true)` THROWS — "SQLite3 can only bind numbers, strings, bigints,
 * buffers, and null" — while `CoercedValue` includes `boolean`, so EVERY
 * `boolean`-typed mapping column would fail at bind time without it. 1/0 is
 * SQLite's own boolean representation.
 *
 * `undefined` is REFUSED rather than bound. Measured: better-sqlite3 accepts it
 * and stores NULL, which would turn a mapping row whose value never arrived into
 * a silent null in the operator's data — the shape of failure this codebase
 * refuses elsewhere as "an absent fact must never be manufactured".
 */
function bindValue(value: SinkValue | undefined, column: string): SqliteValue {
  if (value === undefined) {
    throw new DatasetIoError(
      'permanent',
      `no value was supplied for the sink column '${column}' (an absent value is refused, never written as NULL)`,
    );
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

/**
 * The sink table's ACTUAL column spellings, or why it cannot be a sink.
 *
 * Two measured reasons this is not "`pragma_table_info` returned rows":
 *  - a **VIEW** reports its columns through `pragma_table_info` exactly as a
 *    table does, so an emptiness check passes for one — and the real refusal
 *    ("cannot modify v because it is a view") then fires INSIDE the transaction,
 *    in `overwrite` mode after `DELETE FROM v` was already attempted. §7 requires
 *    the gate before the first row moves, so the type comes from `sqlite_master`;
 *  - a GENERATED column is absent from `table_info` (it is in `table_xinfo` with
 *    `hidden=2`) and refuses an INSERT with "cannot INSERT into generated
 *    column". Mapping one is therefore reported as "absent from the sink", which
 *    is imprecise but never wrong about the outcome. Named here so M6 does not
 *    rediscover it.
 *
 * Returns a discriminated result rather than an empty array, so "no such table",
 * "it is a view" and "here are the columns" are three answers and not one
 * overloaded one.
 */
function describeSinkTable(
  db: Database.Database,
  schemaName: string,
  table: string,
): { ok: true; name: string; columns: string[] } | { ok: false; reason: string } {
  const qualifiedSchema = quoteIdentifier(schemaName, 'schema');
  // `COLLATE NOCASE`, for the same reason `resolveSinkColumns` lower-cases:
  // SQLite resolves identifiers case-insensitively, so `SELECT * FROM "SINK"`
  // finds a table created as `sink` — but `sqlite_master.name` compares with
  // BINARY collation, so an exact match would refuse a dataset SQLite would
  // happily have executed. Getting this right for columns and wrong for the
  // table would have been one bug in two spellings. At most one row can come
  // back: SQLite refuses to create `SINK` alongside `sink`.
  const found = db
    .prepare(
      `SELECT name, type FROM ${qualifiedSchema}.sqlite_master WHERE name = ? COLLATE NOCASE`,
    )
    .get(table) as { name: string; type?: unknown } | undefined;
  if (found === undefined) {
    return { ok: false, reason: `there is no table '${table}' in the store` };
  }
  if (found.type !== 'table') {
    return {
      ok: false,
      reason: `'${table}' is a ${String(found.type)}, not a table, so it cannot be written to`,
    };
  }
  // The store's own spelling from here on, so the statement reads like the schema.
  const columns = db
    .prepare('SELECT name FROM pragma_table_info(?, ?)')
    .all(found.name, schemaName) as { name: string }[];
  return { ok: true, name: found.name, columns: columns.map((c) => c.name) };
}

/**
 * Resolve each mapped column onto the store's own spelling of it, CASE-INSENSITIVELY.
 *
 * SQLite matches column names without regard to case — measured: `INSERT INTO
 * "t" ("ID")` succeeds against a column declared `id` — and §6.3's auto-map is
 * itself "case-insensitive, trimmed", so the authoring surface generates exactly
 * this input. §7's refusal is for a column that is ABSENT, and a case variant is
 * not absent; an exact-string match would `permanent`-refuse a mapping SQLite
 * would have executed.
 *
 * BOTH spellings are kept, and that is not tidiness. The store's spelling goes
 * into the statement, so the SQL reads the way the schema does; the MAPPED
 * spelling is what the incoming rows are keyed by, because the pump keys a row
 * by the mapping's `sink` name and has never seen the store. Collapsing the two
 * makes a case-differing mapping bind `undefined` for every row.
 *
 * Two mapped columns collapsing onto one actual column is REFUSED: it is silent
 * last-wins into the operator's table, the same defect `CopyMappingSchema`'s
 * duplicate-sink rule exists for, and one that rule cannot see because the two
 * names differ as strings.
 */
interface SinkColumn {
  /** The key the incoming rows use — the mapping's `sink` name. */
  readonly mapped: string;
  /** The store's own spelling, which is what the statement names. */
  readonly actual: string;
}

function resolveSinkColumns(mapped: readonly string[], actual: readonly string[]): SinkColumn[] {
  /* `nocaseFold`, NOT `toLowerCase()` — #1151. SQLite's NOCASE collation folds
     ASCII `A-Z` only, so `\u212A` (KELVIN SIGN) and `k` are different identifiers
     to the store, while `toLowerCase()` folds one onto the other. Using the JS
     fold here made this resolver claim a column SQLite would never have matched,
     and left the sink and the source-side drift gate — which already shares this
     function — able to disagree about whether two names are the same column. */
  const byFold = new Map<string, string>();
  for (const name of actual) byFold.set(nocaseFold(name), name);

  const resolved: SinkColumn[] = [];
  const claimed = new Map<string, string>();
  const missing: string[] = [];
  const collisions: string[] = [];
  for (const name of mapped) {
    const match = byFold.get(nocaseFold(name));
    if (match === undefined) {
      missing.push(name);
      continue;
    }
    const earlier = claimed.get(match);
    if (earlier !== undefined) {
      collisions.push(`'${earlier}' and '${name}' both resolve to the sink column '${match}'`);
      continue;
    }
    claimed.set(match, name);
    resolved.push({ mapped: name, actual: match });
  }
  // BOTH problems, in ONE refusal. Throwing on the first collision mid-pass
  // reports only whichever defect the array order happened to reach first, so a
  // mapping with two faults takes two runs to diagnose.
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(`the sink has no column named ${missing.map((m) => `'${m}'`).join(', ')}`);
  }
  if (collisions.length > 0) {
    problems.push(`${collisions.join('; ')} (each sink column may be written by one mapping row)`);
  }
  if (problems.length > 0) throw new DatasetIoError('permanent', problems.join('. '));
  return resolved;
}

/** The `table` dataset config of a SINK, or a refusal. */
function sinkTargetFor(
  datasetKind: DatasetKind,
  datasetConfig: Record<string, unknown>,
): { schema: string; table: string } {
  if (datasetKind === 'query') {
    throw new DatasetIoError(
      'permanent',
      'a `query` dataset is a SELECT and has no insert target, so it cannot be a copy sink',
    );
  }
  if (datasetKind !== 'table') {
    throw new DatasetIoError(
      'permanent',
      `no sink writer exists for the '${datasetKind}' dataset kind yet`,
    );
  }
  // A SQLite "schema" is an ATTACHed database, and this connector attaches
  // nothing — so an unqualified dataset means `main`. A different name reaches
  // `pragma_table_info`, which refuses it with "unknown database". Shared with
  // the address resolver so the gate and the writer cannot disagree about which
  // table a dataset names.
  return parseTableTarget(datasetConfig);
}

/**
 * Write batches of mapped rows into a `table` dataset on a `sqlite` store —
 * §4's atomic sink, and the consumer that finally makes `config.writable` mean
 * something.
 *
 * **ONE transaction, committed once (§4.1).** `BEGIN IMMEDIATE` … inserts …
 * `COMMIT`, with a `ROLLBACK` on every failure path including cancel. That is
 * the SQL equivalent of what `fs.ts`'s `atomicReplace` does for file sinks
 * (temp file + `rename`), and it is what makes a copy safely retryable: §4's
 * measured trap is that `retryEligible` consults only `kind === 'transient'` and
 * never `idempotent`, so a copy that dies at row 500,000 IS retried from row 0.
 * That retry is only safe because this transaction guarantees the first attempt
 * left nothing behind. Consequently the sink reports
 * `partialWritePossible: false`, and §4.2's downgrade does not apply — except in
 * the one case where the rollback itself failed, which is the only state this
 * code cannot prove clean.
 *
 * A staging table was the alternative §4 also allows. It is not used: it means
 * creating a real named object in the operator's database (collision surface, a
 * leaked table if the process dies, and DDL inside a confinement model that has
 * so far executed only SELECT), and it is not even expressible for `append`.
 *
 * **The operational consequence, stated rather than discovered.** The copy holds
 * the store's write lock for its whole duration, so two copies into one store
 * serialise and the loser gets `SQLITE_BUSY` → `transient` → a retry from row 0.
 * `BEGIN IMMEDIATE` front-loads that contention so it is reported before any
 * work is done; it does NOT make the copy immune to a busy `COMMIT`, which is
 * measurable in rollback-journal mode (the default for an operator's database —
 * this sink deliberately does not mutate their `journal_mode`, which would be a
 * persistent side effect on someone else's file).
 *
 * **`overwrite` deletes inside the transaction**, so a failure restores the rows
 * it was replacing and a zero-row source legitimately empties the table. Note
 * that better-sqlite3 enables `foreign_keys` by default, so a `DELETE` from a
 * parent table CASCADEs per the operator's own schema; that is their declared
 * intent and is left alone, but it is not visible in `rowsWritten`.
 *
 * `db.transaction()` is deliberately NOT used: it is synchronous-only, so it
 * cannot span the `await` this function needs between batches (§9's yield).
 * Measured: an explicit `begin`/`commit` pair does span one, and `inTransaction`
 * is still true across it.
 */
export async function writeSqliteDatasetRows(
  write: SqliteDatasetWrite,
  batches: AsyncIterable<readonly Record<string, SinkValue>[]>,
): Promise<SqliteWriteResult> {
  if (write.columns.length === 0) {
    throw new DatasetIoError('permanent', 'a copy sink needs at least one mapped column');
  }

  // §8: the stored connection is not assumed well-formed — `routes/connections.ts`
  // runs no per-kind validation on write, so any shape is storable.
  const cfg = sqliteConnectionConfigSchema.safeParse(write.connectionConfig);
  if (!cfg.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid sqlite connection config: ${formatZodIssues(cfg.error.issues)}`,
    );
  }

  // THE `writable` GATE. Fail-closed, as the config field's own docstring
  // promises: absent means "nobody declared this store writable", which
  // withholds a permission rather than granting one. `writable` is also in
  // `CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS`, so no dispatch-time parameter can
  // turn a read-only store into a sink.
  if (cfg.data.writable !== true) {
    throw new DatasetIoError(
      'permanent',
      'this sqlite connection is not marked `writable`, so it cannot be a copy sink',
    );
  }

  const target = sinkTargetFor(write.datasetKind, write.datasetConfig);
  const dbPath = await confineStorePath(cfg.data.roots, cfg.data.path);

  if (write.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');

  let db: Database.Database;
  try {
    db = new Database(dbPath, { fileMustExist: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
  } catch (err) {
    throw storeFailure(err, `cannot open the sqlite database at '${cfg.data.path}'`);
  }

  try {
    let rowsWritten = 0;
    try {
      // The lock comes BEFORE the pre-flight so the §7 gate cannot be read
      // through a snapshot another writer then changes: a concurrent
      // `ALTER TABLE` between describing the sink and the first insert would be
      // a live TOCTOU on exactly the check that exists to prevent it.
      db.exec('begin immediate');

      const described = describeSinkTable(db, target.schema, target.table);
      if (!described.ok) throw new DatasetIoError('permanent', described.reason);
      const columns = resolveSinkColumns(write.columns, described.columns);

      const qualified =
        target.schema === 'main'
          ? quoteIdentifier(described.name, 'table')
          : `${quoteIdentifier(target.schema, 'schema')}.${quoteIdentifier(described.name, 'table')}`;

      if (write.mode !== 'append' && write.mode !== 'overwrite') {
        // `mode` is typed, so this is unreachable from in-repo callers — but an
        // unrecognised value silently behaving like `append` is the wrong
        // failure mode for the field that decides whether the operator's
        // existing rows survive.
        throw new DatasetIoError('permanent', `unknown copy write mode '${String(write.mode)}'`);
      }
      if (write.mode === 'overwrite') {
        // Inside the transaction, so a later failure restores these rows.
        //
        // ONE unbatched statement, and its bound is worth stating: SQLite's
        // truncate optimisation makes this cheap on a plain table (measured,
        // 2,000,000 rows in 27ms), but better-sqlite3 enables `foreign_keys` by
        // default and that optimisation is disabled once the sink is an FK
        // parent (measured, ~198ms per 1,000,000 rows, scaling with row count
        // rather than with batch size). That is a synchronous block, so on a
        // large enough FK-parent table it becomes the §9 event-loop stall the
        // rest of this file is careful about. Batching it wants a rowid cursor,
        // which is wrong for a WITHOUT ROWID table — so it is filed rather than
        // bodged: #1126.
        db.prepare(`DELETE FROM ${qualified}`).run();
      }

      const insert = db.prepare(
        `INSERT INTO ${qualified} (${columns.map((c) => quoteStoreIdentifier(c.actual)).join(', ')})` +
          ` VALUES (${columns.map(() => '?').join(', ')})`,
      );

      let first = true;
      for await (const batch of batches) {
        // Cancellation and the yield are BOTH at the batch boundary (§9, §10).
        if (!first) await yieldToEventLoop();
        if (write.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');
        first = false;

        for (const row of batch) {
          insert.run(columns.map((column) => bindValue(row[column.mapped], column.mapped)));
          rowsWritten += 1;
        }
        write.onBatch?.(rowsWritten);
      }

      if (write.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset write aborted');
      db.exec('commit');
    } catch (err) {
      const failure = storeFailure(err, `the copy into '${target.table}' failed`);
      // Only NOW can the honest answer to "did anything land?" be given. A
      // blanket swallowed rollback would report `partialWritePossible: false`
      // unconditionally — fail-open in the one place §4.2 exists.
      let unwound = true;
      if (db.inTransaction) {
        try {
          db.exec('rollback');
        } catch {
          unwound = false;
        }
      }
      if (unwound) throw failure;
      // §4.2 is APPLIED here, not merely reported. Carrying `transient` out
      // alongside `partialWritePossible: true` would be the fail-open this whole
      // section exists to prevent: `retryEligible` reads only `kind`, so a
      // `SQLITE_BUSY` whose rollback also failed would be retried from row 0
      // into a table that may already hold some of these rows. The fact and the
      // verdict travel together, and the caller does not have to remember to
      // combine them.
      throw new DatasetIoError(
        classifySinkFailure({ kind: failure.kind, partialWritePossible: true }),
        `${failure.message} — and the rollback FAILED, so rows may have landed in '${target.table}'`,
        { cause: err, partialWritePossible: true },
      );
    }
    return { rowsWritten };
  } finally {
    try {
      // Measured: `close()` with an open transaction rolls it back, so this is
      // also the backstop for a throw that escaped the handler above.
      db.close();
    } catch {
      // Never let a close failure replace the outcome the caller is unwinding with.
    }
  }
}

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
        // The sink is resolved from `ctx.sink`, never from this adapter's own
        // connection: the running adapter is the SOURCE's and a paired node may
        // well write into a different store. Its KIND is checked because
        // nothing else can. AS OF 4c (#1139) the catalog's `sinkConnectionKinds`
        // allowlist exists and refuses a non-sqlite sink before dispatch, so this
        // is no longer the ONLY gate — it is defence in depth, and it stays: the
        // rung is what a caller passing a sink this adapter cannot write hits,
        // and an unchecked non-sqlite config would reach the writer to be refused as
        // "invalid sqlite connection config", which is a true statement about
        // the wrong thing. It is supplied as a LADDER RUNG rather than checked
        // before dispatch so it takes its declared place behind the two
        // preconditions, instead of pre-empting them.
        refuseSink: (connection) =>
          connection.kind === 'sqlite'
            ? null
            : `a sqlite copy writes into a sqlite store, but the sink connection is '${connection.kind}'`,
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
        writeRows: ({ dataset, connection, columns, mode, onBatch, batches, signal }) => {
          // Parsed HERE, where the sink connection is proved present, rather
          // than defaulted to this adapter's own config further up. A fallback
          // to the source store is the one wrong answer available — it would
          // write the right rows into the wrong database and report success.
          const parsedSink = sqliteConnectionConfigSchema.safeParse(connection.connectionConfig);
          if (!parsedSink.success) {
            throw new DatasetIoError(
              'permanent',
              `invalid sqlite sink connection config: ${formatZodIssues(parsedSink.error.issues)}`,
            );
          }
          return writeSqliteDatasetRows(
            {
              connectionConfig: parsedSink.data,
              datasetKind: dataset.kind,
              datasetConfig: dataset.config,
              columns,
              mode,
              onBatch,
              ...(signal === undefined ? {} : { signal }),
            },
            batches,
          );
        },
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
