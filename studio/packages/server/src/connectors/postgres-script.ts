import pg from 'pg';
import {
  formatZodIssues,
  postgresConnectionConfigSchema,
  scriptDispatchConfigSchema,
  scriptOutputParameterNames,
  sqlBindNames,
  sqlLeadingKeyword,
  type ScriptDispatchConfig,
  type SqlParameterValue,
} from '@autonomy-studio/shared';
import { LOOKUP_BYTE_CAP } from '../limits.js';
import { failed } from './activity-events.js';
import { DatasetIoError } from './dataset-io-error.js';
import { LookupValueError, keepRowWithin } from './lookup.js';
import {
  rewriteNamedParametersToPositional,
  type PostgresStatement,
} from './postgres-named-parameters.js';
import {
  isPostgresStatementTimeout,
  openSession,
  readFailure,
  statementTimeoutMsOf,
  type PostgresClient,
  type PostgresClientFactory,
  type PostgresClientOptions,
  type PostgresExtendedQuery,
} from './postgres-session.js';
import { authoredStatementRefusal } from './pre-copy-script.js';
import { yieldToEventLoop } from './scheduling.js';
import {
  MessageCapture,
  ResultCapture,
  SCRIPT_ABORTED,
  notRetried,
  SCRIPT_POSTGRES_STATEMENTS,
  asStatement,
  blockName,
  blockWording,
  type OutputParameters,
  scriptFailure,
  scriptSucceeded,
} from './script.js';
import type { ActivityContext, ActivityEvent } from './types.js';

/**
 * #1600 OR41 C10b-1 — the Script activity on PostgreSQL (activity catalogue
 * §4.5). `script.ts` runs it on SQLite and owns the parts both share.
 *
 * **Every block is checked before the session opens**: its leading statement
 * against `SCRIPT_POSTGRES_STATEMENTS`, every `:name` it binds against its
 * Parameters, and its rewrite to `$n`. Then each is sent alone over the
 * extended protocol, so the server refuses a second statement in its text.
 *
 * **Writing.** A script with a Non-query block needs a connection marked
 * `writable` (fail-closed, as the copy sink). A script of Query blocks only runs
 * inside one `BEGIN READ ONLY` transaction whatever *Run as one transaction*
 * says, so the SERVER refuses a write (SQLSTATE 25006, measured for an INSERT
 * and for `nextval`), where SQLite asks each statement whether it is read-only.
 * `SET` is not an allowed statement, so no block can lift it.
 *
 * **Rows are streamed, never accumulated.** `DECLARE CURSOR` would bound them,
 * but MEASURED on postgres:17 it refuses `INSERT … RETURNING`, a data-modifying
 * `WITH` and `CALL`, each a legitimate Query block. So a block runs as one
 * `pg.Query` whose rows are handed to the result-set capture one at a time and
 * dropped (`streamPostgresStatement`). Non-query blocks run the same way, so an
 * `INSERT … RETURNING *` written as one keeps nothing either.
 *
 * **What a failure leaves applied, outside a transaction.** A statement is
 * atomic, so a block the server refused applied nothing. Two exceptions count
 * the failing block as possibly applied too: a failure with no SQLSTATE (pg's
 * client timeout, a dropped socket), which can arrive after the server
 * committed; and a `CALL` or `DO`, which may `COMMIT` partway. Every block that
 * finished counts as applied, since a `SELECT f()` can write. Any of those makes
 * the failure `permanent`, because a retry would run them again.
 *
 * **Bounded by the connection's statement timeout.** Each block is one
 * statement under the connection's `statementTimeoutMs` (30 s by default), both
 * the server's and pg's own timer (`clientOptionsFor`). Cancel is checked
 * between blocks and before a COMMIT; a block in flight runs to completion or
 * to that timeout, which it cannot lift (`SCRIPT_POSTGRES_STATEMENTS`).
 *
 * **Out and In-out parameters (C10b-2a).** An Out parameter binds NULL, whatever
 * value it was given (ADF ignores it too); an In-out one sends its value. Both
 * are read back by NAME from the one row the block returns, which is what a
 * `CALL` of a procedure with INOUT or OUT parameters returns, its columns named
 * after them. By name, never by position: `CALL p(1, null, :z)` would map `:z`
 * to the first OUT column. A later block's value of the same name replaces an
 * earlier one, as in ADF. They are read after the statement has run, so a
 * failure to read them leaves it applied, and they are bounded as the result
 * sets are, by a 1 MiB allowance of their own.
 */

/** What a streamed statement hands back once it completes. */
export interface PostgresStreamedResult {
  /** Whether the statement returned a row description, i.e. is one that returns rows. */
  readonly hasFields: boolean;
  /** The command tag's verb (`INSERT`, `SELECT`, `CALL`), or null. */
  readonly command: string | null;
  /** The command tag's count: rows written for DML, rows returned for a SELECT. */
  readonly rowCount: number | null;
}

/**
 * Run one statement, handing each row to `onRow` and keeping none. Injected so
 * the script's logic is testable without a server; `streamPostgresStatement` is
 * what a run uses.
 */
export type PostgresStatementStream = (
  client: PostgresClient,
  statement: PostgresStatement,
  onRow: (row: Record<string, unknown>) => void,
) => Promise<PostgresStreamedResult>;

/**
 * A `pg.Query` that never keeps its rows. pg 8.23 keeps every row whenever the
 * query has a callback (`query.js` `handleRowDescription`: `_accumulateRows =
 * this.callback || …`), and `client.query` always gives it one here, because
 * `clientOptionsFor` arms `query_timeout` and the client wraps the callback to
 * clear that timer. So the flag is turned off after pg sets it. The live test
 * pins it: a streamed result holds no rows.
 */
export class StreamedQuery extends pg.Query {
  /**
   * Whether the server described a row, even one of no columns (`SELECT FROM
   * t`). A statement that returns no rows (an UPDATE, a `SELECT … INTO`) sends
   * NoData instead.
   */
  described = false;

  handleRowDescription(msg: unknown): void {
    (
      pg.Query.prototype as unknown as { handleRowDescription(m: unknown): void }
    ).handleRowDescription.call(this, msg);
    (this as unknown as { _accumulateRows: boolean })._accumulateRows = false;
    this.described = true;
  }
}

/**
 * The run's `PostgresStatementStream`, on a real `pg.Client`. Settles through
 * the callback, which pg calls exactly once: on completion, on an error, or on
 * its read timeout (an `'error'` event is not emitted while a callback is set).
 * A throw from `onRow` cannot stop a statement already running, so the first is
 * kept, later rows are ignored, and it is the outcome once the statement ends.
 */
export const streamPostgresStatement: PostgresStatementStream = (client, statement, onRow) =>
  new Promise((resolve, reject) => {
    let rowError: unknown;
    let failedRow = false;
    const config: PostgresExtendedQuery = {
      text: statement.sql,
      values: statement.values,
      queryMode: 'extended',
    };
    const query = new StreamedQuery(
      // `queryMode` is pg's own, missing from its types.
      config as unknown as pg.QueryConfig,
      undefined,
      (err: Error | null | undefined, result?: pg.QueryResult) => {
        if (err !== null && err !== undefined) {
          reject(err);
          return;
        }
        if (failedRow) {
          reject(rowError);
          return;
        }
        resolve({
          hasFields: query.described,
          command: result?.command ?? null,
          rowCount: result?.rowCount ?? null,
        });
      },
    );
    query.on('row', (row: Record<string, unknown>) => {
      if (failedRow) return;
      try {
        onRow(row);
      } catch (e) {
        failedRow = true;
        rowError = e;
      }
    });
    (client as unknown as pg.Client).query(query);
  });

/** The command tags whose count is rows changed, summed into `recordsAffected`. */
const CHANGED_ROW_COMMANDS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/** A block that may `COMMIT` partway through, outside a transaction block. */
const MAY_COMMIT_PARTWAY: ReadonlySet<string> = new Set(['CALL', 'DO']);

/** SQLSTATE `read_only_sql_transaction`. */
const READ_ONLY_SQL_TRANSACTION = '25006';

/**
 * The server's SQLSTATE on a failure, or null when the failure is not the
 * server's verdict (pg's client timeout, a socket error). Every SQLSTATE holds a
 * digit; a socket code never does, and `EPIPE` is five letters.
 */
function sqlStateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /[0-9]/.test(code) ? code : null;
}

interface PreparedBlock {
  readonly statement: PostgresStatement;
  readonly mayCommitPartway: boolean;
  /** The Out and In-out names read back from the block's row, or none. */
  readonly outputNames: readonly string[];
}

/**
 * A block's bind values as sent: its Parameters, with NULL for each Out one,
 * whatever value it was given. Built by `Object.fromEntries`, so every name
 * stays an own property.
 */
function boundParameters(
  block: ScriptDispatchConfig['blocks'][number],
): Record<string, SqlParameterValue> {
  const directions = block.parameterDirections ?? {};
  const out = (name: string) => Object.hasOwn(directions, name) && directions[name] === 'out';
  return Object.fromEntries([
    ...Object.entries(block.parameters ?? {}).filter(([name]) => !out(name)),
    ...Object.keys(directions)
      .filter(out)
      .map((name): [string, SqlParameterValue] => [name, null]),
  ]);
}

/**
 * Check and rewrite every block, before any session opens, so nothing runs when
 * a later block is refused. Returns the refusal, or the prepared blocks.
 */
export function preparePostgresBlocks(config: ScriptDispatchConfig): string | PreparedBlock[] {
  const prepared: PreparedBlock[] = [];
  for (const [i, block] of config.blocks.entries()) {
    // An Out parameter needs no value of its own, so it is bound before the
    // refusal looks for every :name's value.
    const parameters = boundParameters(block);
    const refusal = authoredStatementRefusal(
      { ...asStatement(block), parameters },
      'postgres',
      SCRIPT_POSTGRES_STATEMENTS,
      blockWording(i),
    );
    if (refusal !== null) return refusal;
    const outputNames = scriptOutputParameterNames(block);
    const bound = sqlBindNames(block.sql, 'postgres');
    const unbound = outputNames.find((name) => !bound.includes(name));
    if (unbound !== undefined) {
      return `${blockName(i)} gives '${unbound}' a direction, but its SQL never binds :${unbound}`;
    }
    let statement: PostgresStatement;
    try {
      statement = rewriteNamedParametersToPositional(block.sql, parameters);
    } catch (err) {
      // Its one refusal is a positional placeholder beside named values. Its
      // sentence names a query dataset; this one names the block.
      if (!(err instanceof DatasetIoError)) throw err;
      return `${blockName(i)} uses a positional placeholder ($1) as well as named Parameters; write :name for every value`;
    }
    const keyword = sqlLeadingKeyword(block.sql, 'postgres') ?? '';
    prepared.push({
      statement,
      mayCommitPartway: MAY_COMMIT_PARTWAY.has(keyword),
      outputNames,
    });
  }
  return prepared;
}

/**
 * Run every prepared block on the open session, in order. Throws a
 * `DatasetIoError` whose kind and message are the node's outcome.
 */
export async function executePostgresScript(args: {
  client: PostgresClient;
  config: ScriptDispatchConfig;
  blocks: readonly PreparedBlock[];
  readOnly: boolean;
  secret: string | null;
  signal: AbortSignal;
  stream: PostgresStatementStream;
  /** C10b-2b — the Block timeout, when it is the session's statement bound. */
  blockTimeoutSeconds?: number | null;
}): Promise<{
  capture: ResultCapture;
  recordsAffected: number;
  outputParameters: OutputParameters;
}> {
  const { client, config, blocks, readOnly, secret, signal, stream } = args;
  const blockTimeoutSeconds = args.blockTimeoutSeconds ?? null;
  // C10b-2b — a failure names the Timeout per block when it was the session's
  // bound and the statement timed out. The kind stays the path's.
  const within = (context: string, err: unknown): string =>
    blockTimeoutSeconds !== null && isPostgresStatementTimeout(err)
      ? `${context} within the Timeout per block of ${String(blockTimeoutSeconds)} seconds`
      : context;
  const outputParameters = new OutputParameterValues();
  const path = readOnly ? 'read' : 'write';
  const capture = new ResultCapture(config.captureResultSets);
  let recordsAffected = 0;
  // Blocks that may have changed the store and committed, outside a transaction.
  let applied = 0;
  // A read-only script is one READ ONLY transaction, so the server refuses a write.
  const inTransaction = readOnly || config.runAsOneTransaction;
  let open = false;

  try {
    if (inTransaction) {
      try {
        await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      } catch (err) {
        throw readFailure(
          err,
          within('the script could not begin its transaction', err),
          secret,
          path,
        );
      }
      open = true;
    }

    for (const [i, block] of config.blocks.entries()) {
      if (i > 0) await yieldToEventLoop();
      if (signal.aborted) throw new DatasetIoError('cancelled', SCRIPT_ABORTED);
      const prepared = blocks[i] as PreparedBlock;
      const set = block.type === 'query' ? capture.begin() : undefined;
      // Counted here and judged once the statement has run: a throw from
      // `onRow` would read as the statement's own failure.
      const reads = prepared.outputNames.length > 0;
      let rowsSeen = 0;
      let firstRow: Record<string, unknown> | undefined;

      let result: PostgresStreamedResult;
      try {
        result = await stream(client, prepared.statement, (row) => {
          if (reads && ++rowsSeen === 1) firstRow = row;
          if (set !== undefined) capture.add(set, () => row);
        });
      } catch (err) {
        if (err instanceof LookupValueError) {
          // The statement completed; only a row could not be kept.
          if (!inTransaction) applied += 1;
          throw err;
        }
        if (!inTransaction && (sqlStateOf(err) === null || prepared.mayCommitPartway)) {
          // The server may have committed it before the failure reached us.
          applied += 1;
        }
        if (readOnly && sqlStateOf(err) === READ_ONLY_SQL_TRANSACTION) {
          // The server's own words follow, for a store that is read-only itself
          // (a hot standby), where a Non-query block would be refused too.
          throw readFailure(
            err,
            `${blockName(i)} writes to the store, which a script with no Non-query block may not; make it a Non-query block`,
            secret,
            path,
          );
        }
        // C10b-2b — the kind stays the path's; only the wording names the bound.
        const context =
          blockTimeoutSeconds !== null && isPostgresStatementTimeout(err)
            ? `${blockName(i)} ran past the Timeout per block of ${String(blockTimeoutSeconds)} seconds`
            : `${blockName(i)} failed`;
        throw readFailure(err, context, secret, path);
      }

      if (!inTransaction) applied += 1;
      if (block.type === 'query' && !result.hasFields) {
        throw new DatasetIoError(
          'permanent',
          `${blockName(i)} is a Query, but its statement returns no rows; make it a Non-query block`,
        );
      }
      if (
        block.type === 'nonQuery' &&
        result.command !== null &&
        CHANGED_ROW_COMMANDS.has(result.command)
      ) {
        recordsAffected += result.rowCount ?? 0;
      }
      if (reads) {
        outputParameters.read(i, prepared.outputNames, rowsSeen, firstRow);
      }
    }

    // A cancel during the last block still undoes a script in one transaction.
    if (signal.aborted) throw new DatasetIoError('cancelled', SCRIPT_ABORTED);
    if (open) {
      // ROLLBACK, never COMMIT, for a read-only script: it has nothing to commit.
      const end = readOnly ? 'ROLLBACK' : 'COMMIT';
      try {
        await client.query(end);
      } catch (err) {
        if (!readOnly && sqlStateOf(err) === null) {
          throw new DatasetIoError(
            'permanent',
            `${readFailure(err, within('the script could not commit', err), secret, path).message} — the COMMIT's outcome is unknown, so the script may have been applied`,
          );
        }
        throw readFailure(err, within('the script could not commit', err), secret, path);
      } finally {
        open = false;
      }
    }
    return { capture, recordsAffected, outputParameters: outputParameters.toOutput() };
  } catch (err) {
    let failure =
      err instanceof DatasetIoError || err instanceof LookupValueError
        ? err
        : readFailure(err, 'the script failed', secret, path);
    if (open) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The session is closed next, and the server rolls back a transaction
        // whose session ends, so nothing of it stays applied.
      }
    }
    if (applied > 0) {
      failure = notRetried(
        failure,
        `${String(applied)} block(s) had already run outside a transaction and may have changed the store`,
      );
    }
    throw failure;
  }
}

/** The columns a missing-column failure lists before it stops. */
const LISTED_COLUMNS = 20;

/**
 * The script's Out and In-out values by name, within one `LOOKUP_BYTE_CAP`
 * allowance of their own. A Map, so no name can reach a prototype. A later
 * block's value of a name replaces the earlier one, and its bytes with it.
 */
class OutputParameterValues {
  private readonly values = new Map<string, { value: unknown; size: number }>();
  private bytes = 0;

  /**
   * Read a block's names from the one row it returned. Throws a
   * `DatasetIoError` naming the block when there is not exactly one row, a
   * name has no column, a value cannot be kept, or the values would pass the
   * allowance, which is checked before a large value is copied.
   */
  read(
    index: number,
    names: readonly string[],
    rowsSeen: number,
    row: Record<string, unknown> | undefined,
  ): void {
    const has = `${blockName(index)} has Out or In-out parameters, but its statement returned`;
    if (row === undefined) {
      throw new DatasetIoError(
        'permanent',
        `${has} no row to read them from; a CALL returns one when its procedure has INOUT or OUT parameters`,
      );
    }
    if (rowsSeen > 1) {
      throw new DatasetIoError(
        'permanent',
        `${has} ${String(rowsSeen)} rows; they are read from one`,
      );
    }
    const picked = Object.fromEntries(
      names.map((name) => {
        if (!Object.hasOwn(row, name)) throw missingColumn(index, name, row);
        return [name, row[name]];
      }),
    );
    // The bytes this block's values would replace are free again.
    const replaced = names.reduce((sum, name) => sum + (this.values.get(name)?.size ?? 0), 0);
    let kept: ReturnType<typeof keepRowWithin>;
    try {
      kept = keepRowWithin(picked, 0, undefined, LOOKUP_BYTE_CAP - (this.bytes - replaced));
    } catch (err) {
      if (!(err instanceof LookupValueError)) throw err;
      throw new DatasetIoError(
        'permanent',
        `${blockName(index)}'s Out parameter '${err.column}' cannot hold its value: ${err.detail}`,
      );
    }
    if (kept === null) {
      throw new DatasetIoError(
        'permanent',
        `${blockName(index)}'s Out parameters would pass the ${String(LOOKUP_BYTE_CAP)}-byte cap a script may keep of them`,
      );
    }
    // Charged per name, as each serialises on its own, so a replaced value
    // gives back exactly what it took.
    for (const [name, value] of Object.entries(kept.row)) {
      const size = Buffer.byteLength(JSON.stringify(Object.fromEntries([[name, value]])), 'utf8');
      this.bytes += size - (this.values.get(name)?.size ?? 0);
      this.values.set(name, { value, size });
    }
  }

  toOutput(): OutputParameters {
    return Object.fromEntries([...this.values].map(([name, { value }]) => [name, value]));
  }
}

function missingColumn(index: number, name: string, row: Record<string, unknown>): DatasetIoError {
  const columns = Object.keys(row);
  const listed =
    columns.length === 0
      ? 'no columns'
      : columns.length > LISTED_COLUMNS
        ? `${columns.slice(0, LISTED_COLUMNS).join(', ')} and ${String(columns.length - LISTED_COLUMNS)} more`
        : columns.join(', ');
  return new DatasetIoError(
    'permanent',
    `${blockName(index)} returned no column '${name}' for its Out parameter; name the parameter after the procedure's (the row has ${listed}; postgres lower-cases an unquoted name)`,
  );
}

/**
 * Run one `script` on a postgres connection: at most two warnings, then one
 * terminal event. The messages kept under *Capture messages* are an output, so
 * a failed script reports none of them (its failure carries the server's error).
 */
export async function* runPostgresScript(
  ctx: ActivityContext,
  deps: {
    createClient: PostgresClientFactory;
    secret: string | null;
    types: PostgresClientOptions['types'];
    stream?: PostgresStatementStream;
  },
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

  const blocks = preparePostgresBlocks(config);
  if (typeof blocks === 'string') {
    yield failed('permanent', blocks);
    return;
  }

  const cfg = postgresConnectionConfigSchema.safeParse(ctx.connectionConfig);
  if (!cfg.success) {
    yield failed(
      'permanent',
      `invalid postgres connection config: ${formatZodIssues(cfg.error.issues)}`,
    );
    return;
  }
  const firstWrite = config.blocks.findIndex((b) => b.type === 'nonQuery');
  const readOnly = firstWrite === -1;
  // THE `writable` GATE, fail-closed as the copy sink's. `writable` cannot be
  // overridden at dispatch (`CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS`).
  if (!readOnly && cfg.data.writable !== true) {
    yield failed(
      'permanent',
      `this postgres connection is not marked \`writable\`, so ${blockName(firstWrite)}, a Non-query block, cannot run on it`,
    );
    return;
  }
  if (ctx.signal.aborted) {
    yield failed('cancelled', SCRIPT_ABORTED);
    return;
  }

  // C10b-2b — the Block timeout arms both statement timers (`clientOptionsFor`)
  // for the whole session, so it bounds every block and the BEGIN and COMMIT
  // around them. It only ever LOWERS the connection's Statement timeout: that is
  // its owner's bound, which a node may not lift (`queryTimeoutSeconds`' rule).
  const connectionTimeoutMs = statementTimeoutMsOf(cfg.data);
  const blockTimeoutSeconds =
    config.blockTimeoutSeconds !== undefined &&
    config.blockTimeoutSeconds * 1000 < connectionTimeoutMs
      ? config.blockTimeoutSeconds
      : null;
  const sessionConfig =
    blockTimeoutSeconds === null
      ? ctx.connectionConfig
      : { ...ctx.connectionConfig, statementTimeoutMs: blockTimeoutSeconds * 1000 };

  let client: PostgresClient;
  try {
    client = await openSession(
      deps.createClient,
      sessionConfig,
      deps.secret,
      'cannot reach the postgres server to run the script',
      deps.types,
    );
  } catch (err) {
    yield scriptFailure(err);
    return;
  }
  // pg emits `error` when the connection drops (client.js `_handleErrorEvent`),
  // even under a running statement, and an `error` with no listener ends the
  // server. The statement in flight is rejected through its callback anyway.
  client.on?.('error', () => undefined);
  // C10b-2b — registered once the session is open, so the messages are the
  // script's own, never `openSession`'s set-up. The session is never pooled and
  // is ended below, so the listener goes with it.
  const messages = new MessageCapture(deps.secret);
  if (config.captureMessages) {
    client.on?.('notice', (notice) => {
      // A listener's throw would surface inside pg's message handling; a
      // message never fails the script (ADF: an error caused by log won't).
      try {
        messages.add(notice);
      } catch {
        // Dropped, as a message past the cap is.
      }
    });
  }

  // The outcome is decided, and the session closed, before anything is yielded.
  let result: Awaited<ReturnType<typeof executePostgresScript>> | undefined;
  let failure: ActivityEvent | undefined;
  try {
    result = await executePostgresScript({
      client,
      config,
      blocks,
      readOnly,
      secret: deps.secret,
      signal: ctx.signal,
      stream: deps.stream ?? streamPostgresStatement,
      blockTimeoutSeconds,
    });
  } catch (err) {
    failure = scriptFailure(err);
  } finally {
    try {
      await client.end();
    } catch {
      // Never let a close failure replace the outcome being reported.
    }
  }

  if (result === undefined) {
    yield failure ?? failed('permanent', 'the script failed');
    return;
  }
  yield* scriptSucceeded(result.capture, result.recordsAffected, result.outputParameters, messages);
}
