import type Database from 'better-sqlite3';
import type { z } from 'zod';
import {
  SCRIPT_RESULT_ROW_CAP,
  WARNING_CODES,
  formatZodIssues,
  scriptDispatchConfigSchema,
  type ScriptCapture,
  type ScriptDispatchConfig,
} from '@autonomy-studio/shared';
import { failed } from './activity-events.js';
import { DatasetIoError } from './dataset-io-error.js';
import { LOOKUP_BYTE_CAP } from '../limits.js';
import { estimateRowLowerBound } from './lookup-bounds.js';
import { LookupValueError, logSafeRow } from './lookup.js';
import {
  authoredStatementRefusal,
  usedSqliteParameters,
  type AuthoredStatementWording,
  type PreCopyScript,
} from './pre-copy-script.js';
import { yieldToEventLoop } from './scheduling.js';
import { attachedDatabases, openSqliteWriter } from './sqlite-sink.js';
import {
  normaliseRow,
  openSqliteReadOnly,
  storeFailure,
  type sqliteConnectionConfigSchema,
} from './sqlite-store.js';
import type { ActivityContext, ActivityEvent } from './types.js';

/**
 * #1600 OR41 C10a — the Script activity (activity catalogue §4.5, after ADF's
 * Script): authored SQL blocks, run in order on one database connection.
 *
 * This module runs it on SQLite; C10b-1 runs it on PostgreSQL
 * (`postgres-script.ts`), which shares the store-agnostic parts exported here:
 * the block wording, the result-set capture and the outputs.
 *
 * **What keeps it inside the connection's roots.** A block is authored SQL, as a
 * Pre-copy script is, and the same allow-list on its leading keyword is the
 * boundary (`PRE_COPY_SCRIPT_STATEMENTS`' comment has the measurements): no
 * `ATTACH`, `VACUUM` or `PRAGMA`. `SELECT` is added, which Query blocks need;
 * a `pragma_*` table function it can call is read-only. Transaction control is
 * not listed either, because the transaction is the activity's (*Run as one
 * transaction*). better-sqlite3's `prepare` refuses a second statement, so the
 * word checked is the statement run. After every block the attached-database
 * tripwire runs, as after a Pre-copy script.
 *
 * **Writing is gated by the connection's `writable`, fail-closed.** A script
 * with a Non-query block opens the store read-write, under the process-wide
 * write queue copies take (#1423), and is refused outright on a connection not
 * marked writable. A script of Query blocks only opens it READ-ONLY and holds
 * no write lock, and each of its statements must be one SQLite itself reports
 * as read-only (`Statement.readonly`) before any of them runs. That refuses an
 * `INSERT … RETURNING` written as a Query in a script with no Non-query block,
 * which is the fail-closed side.
 *
 * **Bounded.** A Query block's rows are pulled in batches with a yield and a
 * cancel check between them, and its result set keeps at most 1000 rows within
 * 1 MiB across the whole script (`LOOKUP_ROW_CAP`, `LOOKUP_BYTE_CAP`), since the
 * result sets are outputs and outputs are durable. Every row is still counted.
 * One statement is synchronous and cannot be interrupted (this build of SQLite
 * omits the progress callback), so a single block that runs long holds the
 * server's event loop for its duration, the residual a Pre-copy script and a
 * large Overwrite carry too (#1126). The activity timeout cannot cut it short.
 */

/**
 * The statements a Script block may begin with on SQLite: the Pre-copy script's
 * list plus `SELECT`. See the module comment for what is left out and why.
 */
export const SCRIPT_SQLITE_STATEMENTS: readonly string[] = [
  'SELECT',
  'WITH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'CREATE',
  'DROP',
  'ALTER',
];

/**
 * #1600 OR41 C10b-1 — the statements a Script block may begin with on
 * PostgreSQL. Its own list rather than the Pre-copy script's, so a change to
 * one cannot silently change the other, but for the same reason
 * (`PRE_COPY_SCRIPT_STATEMENTS`' comment): it is not a privilege boundary, the
 * connection's credential is. What it keeps out is what would take the script
 * out of the activity's hands:
 *
 * - transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`), because
 *   the transaction is the activity's (*Run as one transaction*);
 * - `SET` and `RESET`. LOAD-BEARING: `SET TRANSACTION READ WRITE` as the first
 *   statement of a read-only script's `BEGIN READ ONLY` would lift the
 *   read-only guarantee, and `SET statement_timeout = 0` the server's cap on
 *   every later block;
 * - `COPY` (a `FROM STDIN` has no data to send) and `VACUUM` (refused inside a
 *   transaction).
 *
 * The extended protocol makes the server refuse a second statement, so the word
 * checked is the statement run. `VALUES`, `TABLE`, `EXPLAIN` and `SHOW` read;
 * `REFRESH` rebuilds a materialized view after a load.
 */
export const SCRIPT_POSTGRES_STATEMENTS: readonly string[] = [
  'SELECT',
  'WITH',
  'VALUES',
  'TABLE',
  'EXPLAIN',
  'SHOW',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'TRUNCATE',
  'CREATE',
  'DROP',
  'ALTER',
  'REFRESH',
  'CALL',
  'DO',
];

/** Rows pulled between yields to the event loop while a Query block steps. */
const SCRIPT_BATCH_ROWS = 100;

export const SCRIPT_ABORTED = 'script aborted';

type SqliteConnectionConfig = z.infer<typeof sqliteConnectionConfigSchema>;
export type ScriptBlock = ScriptDispatchConfig['blocks'][number];

/** One Query block's result set, as the `resultSets` output holds it. */
export interface ResultSet {
  rowCount: number;
  rows: Record<string, unknown>[];
}

/** 1-based, as the editor numbers the rows. */
export function blockName(index: number): string {
  return `Script block ${index + 1}`;
}

export function blockWording(index: number): AuthoredStatementWording {
  return { the: blockName(index), any: 'a Script block', values: 'its Parameters' };
}

export function asStatement(block: ScriptBlock): PreCopyScript {
  return { sql: block.sql, parameters: block.parameters ?? {} };
}

/**
 * The result sets a script keeps: at most `SCRIPT_RESULT_ROW_CAP` rows each, and
 * `LOOKUP_BYTE_CAP` across them all, measured as the row will be serialised.
 * Off keeps none and truncates nothing.
 *
 * Each cap LATCHES, so what is kept is always a prefix: a set that reached its
 * rows keeps none after them, and once the bytes are spent no later row of any
 * set is kept, however small. Past a cap a row is only counted, never read
 * into a value (`add` takes it lazily), so a value that cannot be kept cannot
 * fail the script either.
 */
export class ResultCapture {
  readonly sets: ResultSet[] = [];
  private bytes = 0;
  private cause: 'rows' | 'bytes' | null = null;
  private bytesSpent = false;

  constructor(private readonly mode: ScriptCapture) {}

  begin(): ResultSet {
    const set: ResultSet = { rowCount: 0, rows: [] };
    this.sets.push(set);
    return set;
  }

  add(set: ResultSet, read: () => Record<string, unknown>): void {
    set.rowCount += 1;
    if (this.mode === 'off' || this.bytesSpent) return;
    if (set.rows.length >= SCRIPT_RESULT_ROW_CAP) {
      this.cause ??= 'rows';
      return;
    }
    const raw = read();
    const remaining = LOOKUP_BYTE_CAP - this.bytes;
    // Lookup's two checks, in its order: the estimate refuses a row that cannot
    // fit before `logSafeRow` copies it, and the exact size decides the rest.
    if (estimateRowLowerBound(raw, undefined, remaining) > remaining) {
      this.spend();
      return;
    }
    const row = logSafeRow(raw, set.rowCount - 1, undefined);
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
    if (size > remaining) {
      this.spend();
      return;
    }
    set.rows.push(row);
    this.bytes += size;
  }

  private spend(): void {
    this.bytesSpent = true;
    this.cause = 'bytes';
  }

  get truncated(): boolean {
    return this.cause !== null;
  }

  /** The prose for a truncation, naming the bound, never a row value. */
  reason(): string {
    return this.cause === 'rows'
      ? `a result set kept its first ${SCRIPT_RESULT_ROW_CAP} rows; rowCount counts them all`
      : `the result sets reached the ${LOOKUP_BYTE_CAP}-byte cap a script may keep, so later rows were counted and not kept`;
  }
}

/**
 * A failure as the node reports it. The store's own verdict passes through, as
 * Lookup's does (`lookupFailure`): a `SQLITE_BUSY` is transient.
 */
export function scriptFailure(err: unknown): ActivityEvent {
  if (err instanceof LookupValueError) {
    return failed('permanent', `a Script result set cannot hold a value — ${err.message}`);
  }
  if (err instanceof DatasetIoError) return failed(err.kind, err.message);
  // Fail-safe: an unrecognised throw is a programming fault, never something to
  // blind-retry against an operator's store.
  return failed('permanent', err instanceof Error ? err.message : String(err));
}

function prepareBlock(
  db: Database.Database,
  block: ScriptBlock,
  index: number,
): Database.Statement {
  let statement: Database.Statement;
  try {
    statement = db.prepare(block.sql);
  } catch (err) {
    throw storeFailure(err, `${blockName(index)} could not be prepared`);
  }
  if (block.type === 'query' && !statement.reader) {
    throw new DatasetIoError(
      'permanent',
      `${blockName(index)} is a Query, but its statement returns no rows; make it a Non-query block`,
    );
  }
  return statement;
}

/**
 * Run every block on the open store, in order. Throws a `DatasetIoError` whose
 * kind and message are the node's outcome. Exported for its test, which drives
 * a cancel between two blocks.
 */
export async function executeSqliteScript(
  db: Database.Database,
  config: ScriptDispatchConfig,
  readOnly: boolean,
  signal: AbortSignal,
): Promise<{ capture: ResultCapture; recordsAffected: number }> {
  db.defaultSafeIntegers(true);

  // A read-only script is checked whole before anything runs: it writes
  // nothing, so no block can depend on an earlier one having run.
  if (readOnly) {
    config.blocks.forEach((block, i) => {
      if (!prepareBlock(db, block, i).readonly) {
        throw new DatasetIoError(
          'permanent',
          `${blockName(i)} writes to the store, which a script with no Non-query block may not; make it a Non-query block`,
        );
      }
    });
  }

  const capture = new ResultCapture(config.captureResultSets);
  let recordsAffected = 0;
  // Blocks that changed the store and committed, outside a transaction.
  let committedWrites = 0;
  let inTransaction = false;
  let cursor: IterableIterator<unknown> | undefined;

  try {
    if (config.runAsOneTransaction) {
      db.exec(readOnly ? 'begin' : 'begin immediate');
      inTransaction = true;
    }

    for (const [i, block] of config.blocks.entries()) {
      if (i > 0) await yieldToEventLoop();
      if (signal.aborted) throw new DatasetIoError('cancelled', SCRIPT_ABORTED);

      const statement = prepareBlock(db, block, i);
      const parameters = usedSqliteParameters(asStatement(block));
      // Counted once it starts, not once it ends: a Query block that writes
      // (`INSERT … RETURNING`) has written by its first row, so a failure later
      // in its rows still leaves the write applied.
      const writes = !inTransaction && !statement.readonly;
      try {
        if (block.type === 'query') {
          const set = capture.begin();
          cursor = (
            parameters === undefined ? statement.iterate() : statement.iterate(parameters)
          ) as IterableIterator<unknown>;
          for (;;) {
            let done = false;
            for (let n = 0; n < SCRIPT_BATCH_ROWS; n += 1) {
              const next = cursor.next();
              if (next.done === true) {
                done = true;
                break;
              }
              const row = next.value as Record<string, unknown>;
              capture.add(set, () => normaliseRow(row));
            }
            if (done) break;
            await yieldToEventLoop();
            if (signal.aborted) throw new DatasetIoError('cancelled', SCRIPT_ABORTED);
          }
          cursor = undefined;
        } else {
          const info = parameters === undefined ? statement.run() : statement.run(parameters);
          recordsAffected += Number(info.changes);
        }
      } catch (err) {
        if (writes && block.type === 'query') committedWrites += 1;
        if (err instanceof DatasetIoError || err instanceof LookupValueError) throw err;
        throw storeFailure(err, `${blockName(i)} failed`);
      }

      if (writes) committedWrites += 1;
      const attached = attachedDatabases(db);
      if (attached.length > 0) {
        throw new DatasetIoError(
          'permanent',
          `${blockName(i)} attached a database (${attached.join(', ')}), which a Script never may`,
        );
      }
    }

    if (inTransaction) {
      db.exec('commit');
      inTransaction = false;
    }
    return { capture, recordsAffected };
  } catch (err) {
    // ORDER IS LOAD-BEARING (measured): a rollback with a cursor still open
    // throws "This database connection is busy", as `close()` does.
    try {
      cursor?.return?.(undefined);
    } catch {
      // A cursor that is exhausted or errored has nothing to release.
    }
    let failure =
      err instanceof DatasetIoError || err instanceof LookupValueError
        ? err
        : storeFailure(err, 'the script failed');
    // SQLite may have ended the transaction itself (`INSERT OR ROLLBACK`, a
    // `RAISE(ROLLBACK)`, an I/O error), and a rollback then throws: the store is
    // already rolled back, which is what this would have done.
    if (inTransaction && db.inTransaction) {
      try {
        db.exec('rollback');
      } catch {
        throw new DatasetIoError(
          'permanent',
          `${failure.message} — and the rollback FAILED, so some blocks may have been applied`,
        );
      }
    }
    if (committedWrites > 0) {
      // A retry would run the applied blocks again, so it is refused.
      const kind =
        failure instanceof DatasetIoError && failure.kind === 'cancelled'
          ? 'cancelled'
          : 'permanent';
      failure = new DatasetIoError(
        kind,
        `${failure.message} — ${committedWrites} block(s) had already changed the store and stay applied, so this is not retried. Turn on Run as one transaction to make the script all or nothing`,
      );
    }
    throw failure;
  }
}

/** Run one `script` on a sqlite connection: at most one warning, then one terminal event. */
export async function* runSqliteScript(
  ctx: ActivityContext,
  cfg: SqliteConnectionConfig,
): AsyncGenerator<ActivityEvent> {
  const parsed = scriptDispatchConfigSchema.safeParse(ctx.input);
  if (!parsed.success) {
    yield failed(
      'permanent',
      `invalid script activity config: ${formatZodIssues(parsed.error.issues)}`,
    );
    return;
  }
  const config = parsed.data;

  // Every block is checked before the store is opened, so nothing runs when a
  // later block is refused.
  for (const [i, block] of config.blocks.entries()) {
    const refusal = authoredStatementRefusal(
      asStatement(block),
      'sqlite',
      SCRIPT_SQLITE_STATEMENTS,
      blockWording(i),
    );
    if (refusal !== null) {
      yield failed('permanent', refusal);
      return;
    }
  }

  const firstWrite = config.blocks.findIndex((b) => b.type === 'nonQuery');
  const readOnly = firstWrite === -1;
  // THE `writable` GATE, fail-closed as the copy sink's: absent withholds the
  // permission. `writable` cannot be overridden at dispatch
  // (`CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS`).
  if (!readOnly && cfg.writable !== true) {
    yield failed(
      'permanent',
      `this sqlite connection is not marked \`writable\`, so ${blockName(firstWrite)}, a Non-query block, cannot run on it`,
    );
    return;
  }
  if (ctx.signal.aborted) {
    yield failed('cancelled', SCRIPT_ABORTED);
    return;
  }

  let db: Database.Database;
  let release: (() => void) | undefined;
  try {
    if (readOnly) {
      db = await openSqliteReadOnly(cfg, ctx.signal, SCRIPT_ABORTED);
    } else {
      ({ db, release } = await openSqliteWriter(cfg, ctx.signal, SCRIPT_ABORTED));
    }
  } catch (err) {
    yield scriptFailure(err);
    return;
  }

  // The outcome is decided, and the store closed and its lock released, before
  // anything is yielded: a consumer that stops after the terminal event must
  // not be what releases the write lock.
  let result: Awaited<ReturnType<typeof executeSqliteScript>> | undefined;
  let failure: ActivityEvent | undefined;
  try {
    result = await executeSqliteScript(db, config, readOnly, ctx.signal);
  } catch (err) {
    failure = scriptFailure(err);
  } finally {
    try {
      // Measured: `close()` with an open transaction rolls it back, so this is
      // also the backstop for a throw that escaped the handler.
      db.close();
    } catch {
      // Never let a close failure replace the outcome being reported.
    }
    // AFTER close, so the next writer finds SQLite's own lock already free.
    release?.();
  }

  if (result === undefined) {
    yield failure ?? failed('permanent', 'the script failed');
    return;
  }
  yield* scriptSucceeded(result.capture, result.recordsAffected);
}

/** A finished script's events, on either store: the truncation warning, then its outputs. */
export function* scriptSucceeded(
  capture: ResultCapture,
  recordsAffected: number,
): Generator<ActivityEvent> {
  if (capture.truncated) {
    yield { type: 'warned', code: WARNING_CODES.SCRIPT_RESULT_TRUNCATED, reason: capture.reason() };
  }
  yield {
    type: 'succeeded',
    outputs: {
      resultSetCount: capture.sets.length,
      resultSets: capture.sets,
      recordsAffected,
      // C10b-2 fills it from PostgreSQL's Out parameters; SQLite has none.
      outputParameters: {},
      truncated: capture.truncated,
    },
  };
}
