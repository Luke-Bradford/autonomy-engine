import pg from 'pg';
import {
  COPY_ACTIVITY_TYPE,
  datasetConfigSchema,
  formatZodIssues,
  postgresConnectionConfigSchema,
  queryDatasetConfigSchema,
  sqliteConnectionConfigSchema,
  tableDatasetConfigSchema,
  type DatasetAddress,
  type DatasetKind,
  type PostgresSslMode,
} from '@autonomy-studio/shared';
import type {
  ActivityContext,
  ActivityEvent,
  ConnectorAdapter,
  ConnectorErrorKind,
  ResolvedDataset,
} from './types.js';
import { failed } from './activity-events.js';
import { COPY_BATCH_ROWS } from '../limits.js';
import { DatasetIoError } from './dataset-io-error.js';
import { runCopyActivity } from './copy.js';
import { redactSecrets } from './redact.js';
import { yieldToEventLoop } from './scheduling.js';
import { quoteIdentifier } from './sql-identifier.js';
// #1196 — the session leaf. `postgres.ts` is the READER + adapter; everything
// about reaching a server lives one module down, where the sink writer can also
// reach it without importing this file back (see `postgres-session.ts`).
import {
  clientOptionsFor,
  defaultClientFactory,
  DEFAULT_POSTGRES_PORT,
  notAPostgresKind,
  openSession,
  POSTGRES_DATASET_KINDS,
  qualifiedTable,
  readFailure,
  type PostgresClient,
  type PostgresClientFactory,
  type PostgresClientOptions,
} from './postgres-session.js';
export {
  clientOptionsFor,
  DEFAULT_POSTGRES_CONNECT_TIMEOUT_MS,
  DEFAULT_POSTGRES_PORT,
  DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS,
  isTransientPostgresCode,
  sslOptionFor,
  type PostgresClient,
  type PostgresClientFactory,
  type PostgresClientOptions,
  type PostgresQueryResult,
} from './postgres-session.js';
import { writeSqliteDatasetRows } from './sqlite.js';

/**
 * #1189 M10 slice 1 (data-movement spec §2.6/§12) — the `postgres` STORE
 * connector: the first NETWORKED store, and the first store that holds a
 * credential.
 *
 * SLICE 1 IS THE CONNECTION HALF AND MOVES NO DATA. `DATASET_CONNECTION_KINDS`
 * still binds `table`/`query` to `sqlite` alone, so no dataset can name a
 * postgres connection yet; slice 2 adds the `CopyIo` reader in the same commit
 * that opens that binding. What lands here is the kind itself, its config, its
 * credential requirement, and a probe that tells the truth about all three.
 */
/**
 * SQLSTATEs and socket-level codes worth naming in the operator's own terms.
 * Every one was MEASURED against `postgres:17` rather than read from a table —
 * see the ticket for the probe. Anything not listed falls back to the driver's
 * own message, which for postgres is generally a sentence already.
 *
 * THE FALLBACK IS SCRUBBED, and that is the whole reason `secret` is a parameter
 * here. The named codes return fixed sentences that never touch `err.message`,
 * so they cannot leak anything; the default branch hands an UPSTREAM string
 * straight to a caller. `pg@8.23.0` and `pg-protocol@1.16.0` have no error
 * template that embeds the password today — we pass discrete options and never a
 * connection string, so `pg-connection-string` never sees the config either —
 * but that is a property of a dependency we do not control, on a path that is
 * the FIRST line rather than the executor's redaction backstop. A driver that
 * started quoting its options into an error would otherwise put the credential
 * in a UI string, and nothing here would have noticed.
 */
function probeFailureSentence(err: unknown, secret: string): string {
  const code = (err as { code?: unknown } | null)?.code;
  const raw = err instanceof Error ? err.message : String(err);
  const message = secret === '' ? raw : raw.split(secret).join('[redacted]');
  switch (code) {
    case '28P01':
      return 'the server refused the password for that user';
    case '28000':
      return 'the server refused that user';
    case '3D000':
      return 'the server has no database of that name';
    case 'ECONNREFUSED':
      return 'nothing is listening at that host and port';
    case 'ENOTFOUND':
      return 'that host name does not resolve';
    case 'ETIMEDOUT':
      return 'the host did not answer before the connect timeout';
    default:
      return message;
  }
}

/** Build the adapter over an injectable client factory. The default is a real
 * `pg.Client`; tests substitute a recorder so the option mapping, the ambient-env
 * guard and the refusal sentences are assertable WITHOUT a live server, and the
 * live smoke test passes the real factory through the same seam. */
export function createPostgresAdapter(
  createClient: PostgresClientFactory = defaultClientFactory,
): ConnectorAdapter {
  return {
    kind: 'postgres',
    configSchema: postgresConnectionConfigSchema,

    async testConnection(config, secret) {
      const cfg = postgresConnectionConfigSchema.safeParse(config);
      if (!cfg.success) {
        return {
          ok: false,
          error: `invalid postgres connection config: ${formatZodIssues(cfg.error.issues)}`,
        };
      }
      // Refused HERE rather than passed on, because `pg` would read `PGPASSWORD`
      // for an absent or empty password and connect with a credential this
      // connection never bound (see `clientOptionsFor`). An empty string is as
      // much a miss as a null: both are "the operator has not supplied one".
      if (secret === null || secret === '') {
        return {
          ok: false,
          error:
            'this postgres connection has no secret — postgres needs a password, bound as the connection secret',
        };
      }

      // Typed to RESOLVE, never reject: a caller gets a sentence, not an
      // unhandled rejection. The sqlite adapter's probe makes the same promise.
      let client: PostgresClient | undefined;
      try {
        client = createClient(clientOptionsFor(cfg.data, secret));
        await client.connect();
        // The query is what actually tests it, on the sqlite probe's measured
        // precedent that an open alone can succeed against something that is not
        // a usable store. It also proves the credential reached a real session
        // rather than only a completed TCP handshake.
        await client.query('select 1');
        return { ok: true };
      } catch (err) {
        return { ok: false, error: probeFailureSentence(err, secret) };
      } finally {
        try {
          await client?.end();
        } catch {
          // Nothing to report — the probe already produced its answer.
        }
      }
    },

    resolveDatasetAddress: resolvePostgresDatasetAddress,

    async *runActivity(ctx: ActivityContext, secret: string | null): AsyncIterable<ActivityEvent> {
      // #1190 (M10 slice 2) — `copy` is the ONE activity a store connection
      // runs, and postgres runs it as the SOURCE end: the executor dispatches on
      // the source connection's kind, resolves the sink alongside it, and hands
      // both dataset ends over on `ctx`. Everything store-agnostic — the
      // dispatch schema, the refusal ladder, the counters and the failure
      // mapping — is `copy.ts`'s; this branch supplies only the halves that are
      // postgres'.
      if (ctx.activityType === COPY_ACTIVITY_TYPE) {
        const read = (dataset: ResolvedDataset, signal: AbortSignal | undefined) => ({
          connectionConfig: ctx.connectionConfig,
          secret,
          datasetKind: dataset.kind,
          datasetConfig: dataset.config,
          createClient,
          ...(signal === undefined ? {} : { signal }),
        });
        yield* runCopyActivity(ctx, {
          // There is no postgres WRITER in slice 2, so a postgres copy reads a
          // postgres store and writes into a sqlite one. The catalog says so too
          // (`sinkConnectionKinds: ['sqlite']`), and this stays as the ladder's
          // rung for the reason `fs.ts` gives: it is what a caller bypassing the
          // catalog hits, and an unchecked sink config would reach the writer to
          // be refused as "invalid sqlite connection config" — a true statement
          // about the wrong thing.
          refuseSink: (connection) =>
            connection.kind === 'sqlite'
              ? null
              : `a postgres copy reads a postgres store and writes into a sqlite store, but the sink connection is '${connection.kind}'`,
          // §2.6 gives `table`/`query` no `nullValue`/`dateFormat` to declare, so
          // `{}` is a TRUE statement about the SQL kinds rather than a stub —
          // the polarity `CopyIo.sourceCoercion` requires of every store.
          sourceCoercion: () => ({}),
          describeSource: ({ dataset, signal }) =>
            describePostgresDatasetColumns(read(dataset, signal)),
          readBatches: ({ dataset, signal }) => readPostgresDatasetBatches(read(dataset, signal)),
          writeRows: ({ dataset, connection, columns, mode, onBatch, batches, signal }) => {
            // Parsed from `ctx.sink`, never from this adapter's own connection:
            // a postgres config has no sqlite database path in it at all.
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

      // Every other activity: a store connection binds none of its own. This
      // body exists because the registry must be TOTAL over `ConnectionKind`
      // (`connection-config-ssot.test.ts` asserts an adapter for every kind), and
      // refusing loudly is the honest content for it — the sqlite adapter says
      // the same thing for the same reason. Reachable as of slice 2, where it
      // was not before: `copy`'s `connectionKinds` now lists `postgres`, so the
      // executor no longer refuses every postgres node with
      // `CONNECTION_KIND_INVALID` ahead of dispatch.
      yield failed(
        'permanent',
        `a postgres connection is a STORE binding and runs no activity of its own (got '${ctx.activityType}')`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// #1190 M10 slice 2 — the READER. `postgres` becomes a copy SOURCE.
// ---------------------------------------------------------------------------

/**
 * The postgres type OIDs this module re-parses, and WHY each default is wrong
 * for a copy. MEASURED on `pg@8.23.0` against `postgres:17`.
 *
 * `timestamp without time zone` (1114) and `date` (1082) are NAIVE — they carry
 * no zone, so there is no instant in them to recover. `pg` nevertheless builds a
 * `Date` by reading the text as LOCAL time, which makes the parsed value a
 * property of the studio server process's `TZ` rather than of the operator's
 * data. Measured, one row holding `2026-07-15 13:45:00`:
 *
 * | process `TZ`       | `pg`'s default parse       |
 * | ------------------ | -------------------------- |
 * | `UTC`              | `2026-07-15T13:45:00.000Z` |
 * | `Europe/London`    | `2026-07-15T12:45:00.000Z` |
 * | `America/New_York` | `2026-07-15T17:45:00.000Z` |
 *
 * `coerce.ts` then renders a `Date` with `toISOString()`, i.e. in UTC, so the
 * same source row COPIES DIFFERENT TEXT depending on where the server runs —
 * silently, and reading as success. `date` is worse than a shift: measured in
 * `Europe/London`, `2026-07-15` parses to `2026-07-14T23:00:00.000Z`, so the
 * DAY moves backwards for every process east of UTC.
 *
 * That is #473's rule in a new place — an absent fact (the zone) must never be
 * manufactured as a benign one (the server's). So both OIDs are re-parsed as
 * UTC, which is TZ-invariant and preserves the wall-clock digits the store
 * holds.
 *
 * `timestamptz` (1184) is deliberately NOT overridden: it names a real instant,
 * `pg` resolves it correctly, and it measured identically under all three zones.
 */
const OID_TIMESTAMP = 1114;
const OID_DATE = 1082;

/**
 * Postgres' ISO text form for a finite civil datetime, under `DateStyle=ISO`.
 * MEASURED outputs this must and must not match:
 *   `2026-07-15 13:45:00` · `2026-07-15 13:45:00.123456` · `2026-07-15`
 *   `0001-01-01 00:00:00` · `9999-12-31 23:59:59` · `10000-01-01`
 * and, deliberately NOT matched: `infinity`, `-infinity`, `0044-03-15 12:00:00 BC`.
 */
const PG_CIVIL_DATETIME_RE =
  /^(\d{4,})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?$/;

/**
 * Re-parse a naive `timestamp`/`date` as UTC, or hand back postgres' own text.
 *
 * THE FALLBACK IS NOT A GIVE-UP, it is the honest branch. `infinity`, BC dates
 * and years past 9999 have no `Date`, and inventing one would be the
 * reinterpretation §6.2 forbids. Returned as text they reach `coerce.ts`, which
 * already has an outcome for every one of them: a `string` target copies the
 * store's own spelling (`infinity` really is what that column says), while a
 * `date`/`timestamp` target refuses with `no_date_format` — a refusal, which is
 * the correct direction for a value this code cannot represent.
 */
export function parseNaiveTimestampAsUtc(text: string): Date | string {
  const m = PG_CIVIL_DATETIME_RE.exec(text);
  if (m === null) return text;
  const [, y, mo, d, hh, mi, ss, frac] = m;
  const ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh ?? '0'),
    Number(mi ?? '0'),
    Number(ss ?? '0'),
    // Postgres carries microseconds; a `Date` holds milliseconds. TRUNCATED
    // rather than rounded, so a value never moves forward past its own second.
    frac === undefined ? 0 : Number(frac.padEnd(6, '0').slice(0, 3)),
  );
  if (!Number.isFinite(ms)) return text;
  // `Date.UTC` maps years 0-99 onto 1900-1999. Postgres can emit `0044-...`, so
  // the two-digit-year legacy would silently move it 19 centuries.
  const year = Number(y);
  if (year >= 0 && year <= 99) {
    const exact = new Date(ms);
    exact.setUTCFullYear(year);
    return exact;
  }
  return new Date(ms);
}

/**
 * The per-CLIENT type-parser table. Per-client and never `pg.types.setTypeParser`,
 * which is process-GLOBAL: studio runs one server process, and a global override
 * would silently change how every other `pg` consumer in it reads a timestamp.
 * MEASURED that a second `Client` built without this option still receives a
 * `Date` — the override does not leak.
 */
function readerTypes(): { getTypeParser: (oid: number, format?: unknown) => unknown } {
  return {
    getTypeParser: (oid: number, format?: unknown) => {
      if (oid === OID_TIMESTAMP || oid === OID_DATE) return parseNaiveTimestampAsUtc;
      return (pg.types.getTypeParser as (o: number, f?: unknown) => unknown)(oid, format);
    },
  };
}

/**
 * #1148 §7 row 1/4/5 — the source's ACTUAL columns, before the first row moves.
 *
 * Names are returned UNCOLLAPSED, exactly as `describeSqliteDatasetColumns`
 * does. MEASURED that postgres reports `select a, a` as `['a','a']` while the
 * row object carries `a` once — the same shape §7 ② settled — and the collapse
 * that handles it is `indexSourceColumns` in `datamove/schema-drift.ts`,
 * downstream of this seam and shared by every store. Collapsing here would put a
 * second, divergent copy of that rule in one store.
 */
export async function describePostgresDatasetColumns(read: PostgresDatasetRead): Promise<string[]> {
  const sql = sourceStatementFor(read.datasetKind, read.datasetConfig);
  if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset describe aborted');
  const client = await openSession(
    read.createClient,
    read.connectionConfig,
    read.secret,
    'cannot reach the postgres server to describe the source',
    readerTypes(),
  );
  try {
    const result = await client.query(describeStatementFor(sql));
    return result.fields.map((f) => f.name);
  } catch (err) {
    throw readFailure(err, 'the source statement could not be described', read.secret);
  } finally {
    try {
      await client.end();
    } catch {
      // A close that fails must never replace the outcome being unwound.
    }
  }
}

/**
 * The source, streamed in bounded batches through a SERVER-SIDE CURSOR.
 *
 * WHY A CURSOR and not the alternatives. A plain `client.query` buffers the
 * WHOLE result in memory before yielding a row, which is the one thing a copy
 * over an arbitrarily large table must not do. `LIMIT`/`OFFSET` paging reads a
 * new snapshot per page (so a concurrent write can duplicate or skip rows) and
 * re-scans from the top each time. `pg-cursor`/`pg-query-stream` would do this
 * properly, but they are separate packages that are NOT installed, and `DECLARE`
 * + `FETCH` is plain SQL that needs no dependency: MEASURED at 4,4,2,0 rows over
 * a 10-row table with a 4-row batch, with the field list still present on the
 * final empty fetch.
 *
 * THE TRANSACTION IS `READ ONLY`, and that is a measured guard rather than
 * tidiness — see `describeStatementFor` for the smuggle it blocks. MEASURED:
 * under `BEGIN READ ONLY` a smuggled `drop table` fails with SQLSTATE `25006`,
 * `cannot execute DROP TABLE in a read-only transaction`.
 *
 * WHAT READ-ONLY DOES NOT DO, stated so the docblock does not over-promise: it
 * is a transaction property, not a sandbox. It refuses DDL and DML in the
 * transaction; it does not constrain a `SELECT` that calls a VOLATILE or
 * SECURITY DEFINER function, which can still have effects of its own. The claim
 * here is exactly the one that was measured.
 *
 * THE TIMEOUT NOW BOUNDS A FETCH, NOT THE COPY. `statementTimeoutMs` (default
 * 30s) arms both pg timers per statement, and each `FETCH` is a statement — so
 * it caps how long ONE batch may take, and a copy of any total duration is fine
 * so long as no single batch stalls. A slow first batch on an unindexed scan is
 * the shape that trips it, and it surfaces as SQLSTATE `57014`, which this
 * module classifies `transient`.
 */
export async function* readPostgresDatasetBatches(
  read: PostgresDatasetRead,
): AsyncIterable<readonly Record<string, unknown>[]> {
  const sql = sourceStatementFor(read.datasetKind, read.datasetConfig);
  const batchRows = read.batchRows ?? COPY_BATCH_ROWS;
  if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');

  const client = await openSession(
    read.createClient,
    read.connectionConfig,
    read.secret,
    'cannot reach the postgres server to read the source',
    readerTypes(),
  );
  let inTransaction = false;
  try {
    try {
      await client.query('BEGIN READ ONLY');
      inTransaction = true;
      await client.query(`DECLARE ${CURSOR_NAME} NO SCROLL CURSOR FOR ${sql}`);
    } catch (err) {
      throw readFailure(err, 'the source statement could not be opened for reading', read.secret);
    }

    let first = true;
    for (;;) {
      // Cancellation and the yield are BOTH at the batch boundary (§9, §10) —
      // `readSqliteDatasetBatches`' shape, for its reason: a batch is a
      // scheduling quantum, not merely a read unit.
      if (!first) await yieldToEventLoop();
      if (read.signal?.aborted) throw new DatasetIoError('cancelled', 'dataset read aborted');
      first = false;

      let rows: Record<string, unknown>[];
      try {
        const fetched = await client.query(
          `FETCH FORWARD ${String(batchRows)} FROM ${CURSOR_NAME}`,
        );
        rows = fetched.rows;
      } catch (err) {
        throw readFailure(err, 'the source could not be read', read.secret);
      }
      if (rows.length === 0) return;
      yield rows;
      if (rows.length < batchRows) return;
    }
  } finally {
    // ROLLBACK, never COMMIT: the transaction is read-only, so there is nothing
    // to commit, and rolling back is the one ending that is correct whether this
    // block is unwinding normally or on a throw.
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The session is being closed regardless.
      }
    }
    try {
      await client.end();
    } catch {
      // A close that fails must never replace the outcome being unwound.
    }
  }
}

/**
 * The alias the describe wrap gives the operator's statement. Fixed and quoted:
 * it is this module's own spelling, never anything authored.
 */
const SOURCE_ALIAS = '"__studio_src"';
/** The cursor's name. Same provenance, same treatment. */
const CURSOR_NAME = '"__studio_copy"';

/**
 * The SELECT a source dataset resolves to, with every refusal this module owes
 * BEFORE either the describe or the cursor is built.
 *
 * `query`'s two refusals are both measured, and both would otherwise surface as
 * a raw postgres syntax error naming a character rather than a cause:
 *
 * - **Named parameters.** `queryDatasetConfigSchema.parameters` is a record of
 *   NAMED binds, "keyed WITHOUT the `:` prefix the SQL carries", which
 *   better-sqlite3 supports and `pg` does not have at all. MEASURED: `where a =
 *   :id` reaches postgres as SQLSTATE `42601`, `syntax error at or near ":"`.
 *   Rewriting `:name` to `$1` is not something to guess at — a `:` inside a
 *   string literal must not be rewritten — so this REFUSES and #1194 owns the
 *   per-kind parameter style.
 * - **A trailing `;`.** MEASURED: the describe wrap below turns `select 1;` into
 *   `syntax error at or near ";"`. It is REFUSED rather than stripped, because
 *   stripping would mean the SQL that runs is not the SQL the operator saved,
 *   and it would only ever fix the LAST separator — `select 1; select 2` reaches
 *   the same bare syntax error either way.
 */
function sourceStatementFor(
  datasetKind: DatasetKind,
  datasetConfig: Record<string, unknown>,
): string {
  if (!POSTGRES_DATASET_KINDS.includes(datasetKind)) {
    throw new DatasetIoError('permanent', notAPostgresKind(datasetKind));
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
    return `SELECT * FROM ${qualifiedTable(cfg)}`;
  }

  const cfg = queryDatasetConfigSchema.parse(parsed.data);
  if (cfg.parameters !== undefined && Object.keys(cfg.parameters).length > 0) {
    throw new DatasetIoError(
      'permanent',
      "this query dataset declares named `parameters`, which postgres cannot bind — it binds positionally ($1), and rewriting ':name' automatically is not safe because a ':' inside a string literal must not be rewritten",
    );
  }
  if (cfg.sql.trimEnd().endsWith(';')) {
    throw new DatasetIoError(
      'permanent',
      'this query dataset ends in a semicolon; postgres reads the statement as part of a larger one, so remove the trailing `;`',
    );
  }
  return cfg.sql;
}

/**
 * The describe statement: the source's own columns, WITHOUT reading a row.
 *
 * MEASURED that `LIMIT 0` returns zero rows and the full field list, including
 * through a subquery carrying its own `ORDER BY`/`LIMIT`.
 *
 * THE WRAP IS ALSO THE MULTI-STATEMENT GATE, and that is why it is used for
 * `table` as well as `query` when a bare `SELECT *` would have done. MEASURED,
 * and this is the finding that shaped the whole read path: `DECLARE ... CURSOR
 * FOR select 1; drop table victim` raises NO ERROR — the `;` terminates the
 * DECLARE and the second statement EXECUTES. Wrapped in a subquery the same text
 * is a syntax error, and a data-modifying CTE is refused too ("WITH clause
 * containing a data-modifying statement must be at the top level"). Because
 * `copy.ts`'s ladder calls `describeSource` BEFORE `readBatches`, the wrap runs
 * first and a smuggled statement never reaches a cursor. The read-only
 * transaction below is the backstop, not the only guard.
 */
function describeStatementFor(sql: string): string {
  return `SELECT * FROM (${sql}) ${SOURCE_ALIAS} LIMIT 0`;
}

/**
 * One source read, in `readSqliteDatasetBatches`' argument shape — the
 * convention `datamove/delimited.ts` records, so a third store is a third
 * implementation of one signature rather than a third signature.
 *
 * The CONNECTION CONFIG is passed unparsed on purpose: §8 requires it to
 * re-validate at dispatch, and handing a pre-parsed config down would make that
 * re-validation a claim rather than a check.
 */
export interface PostgresDatasetRead {
  readonly connectionConfig: Record<string, unknown>;
  readonly secret: string | null;
  readonly datasetKind: DatasetKind;
  readonly datasetConfig: Record<string, unknown>;
  readonly createClient: PostgresClientFactory;
  readonly batchRows?: number;
  readonly signal?: AbortSignal;
}

/**
 * #1149 §2.1 — WHERE a postgres dataset physically is, resolved at DISPATCH.
 *
 * REQUIRED, not optional: `executor.ts` refuses a dataset-bound dispatch whose
 * adapter omits this seam (`DATASET_ADDRESS_UNSUPPORTED`), so opening
 * `DATASET_CONNECTION_KINDS` to postgres without it would have shipped a dataset
 * kind that ALWAYS fails at dispatch — precisely the trap §12's M5 row was split
 * four ways to avoid, and the trap slice 1 held the binding shut to dodge.
 *
 * `storeIdentity` IS NULL, AND THAT IS A MEASURED LIMIT OF THE SEAM RATHER THAN
 * A SHRUG. Postgres can identify itself precisely — measured, `select
 * system_identifier from pg_control_system()` returns a cluster-unique value and
 * is readable by an ORDINARY role, which paired with the database OID is the
 * exact analogue of sqlite's `dev:ino`. It cannot be used here: this seam
 * receives `connectionConfig` and `dataset` and NO SECRET, deliberately, because
 * it must be answerable for the SINK — whose adapter never runs and whose
 * credential is therefore never resolved. A networked store's physical identity
 * needs a session, and a session needs a password.
 *
 * So `null` is the honest value, and it is the FAIL-OPEN direction the schema
 * documents for exactly this case: the comparison degrades to `store` rather
 * than inventing a refusal on a fact nobody established. In slice 2 nothing
 * turns on it — `sameDatasetAddress` short-circuits on `kind`, and a postgres
 * source can only ever meet a sqlite sink — but slice 3 makes postgres a SINK,
 * at which point two postgres connections naming one cluster through different
 * host spellings become comparable ONLY by `store`. That is a real hole for the
 * self-copy gate, it is recorded as such (#1193), and closing it means giving
 * this seam a credential.
 *
 * `object` is NOT case-folded, unlike sqlite's. `quoteIdentifier` quotes always,
 * so a postgres `table: 'Users'` addresses the relation spelled `Users` and
 * `users` is a DIFFERENT relation — folding them together here would report two
 * distinct tables as one address. It is `null` when the schema is not declared:
 * resolving an unqualified name needs `search_path`, which needs the session
 * this seam cannot open. A null object never matches, which is the same
 * fail-open direction, stated rather than approximated.
 */
export function resolvePostgresDatasetAddress(args: {
  readonly connectionConfig: Record<string, unknown>;
  readonly dataset: ResolvedDataset;
}): Promise<DatasetAddress> {
  const cfg = postgresConnectionConfigSchema.safeParse(args.connectionConfig);
  if (!cfg.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid postgres connection config: ${formatZodIssues(cfg.error.issues)}`,
    );
  }
  if (!POSTGRES_DATASET_KINDS.includes(args.dataset.kind)) {
    throw new DatasetIoError('permanent', notAPostgresKind(args.dataset.kind));
  }

  // NON-SECRET by construction: host, port and database are config, and the
  // password is not in this string. `datamove/address.ts` requires that — the
  // address travels into the run log and the UI.
  const port = cfg.data.port ?? DEFAULT_POSTGRES_PORT;
  const store = `${cfg.data.host}:${String(port)}/${cfg.data.database}`;

  let object: string | null = null;
  if (args.dataset.kind === 'table') {
    // Same shape as `sourceStatementFor`: the OUTER parse is the one that can
    // fail on operator-authored config, so it is a `safeParse` classified
    // `permanent` rather than a bare `ZodError` escaping the failure contract.
    // The inner narrowing runs on data the union has already validated.
    const parsed = datasetConfigSchema('table').safeParse(args.dataset.config);
    if (!parsed.success) {
      throw new DatasetIoError(
        'permanent',
        `invalid table dataset config: ${formatZodIssues(parsed.error.issues)}`,
      );
    }
    const target = tableDatasetConfigSchema.parse(parsed.data);
    object = target.schema === undefined ? null : `${target.schema}.${target.table}`;
  }

  return Promise.resolve({ kind: 'postgres', store, storeIdentity: null, object });
}

export const postgresAdapter: ConnectorAdapter = createPostgresAdapter();
