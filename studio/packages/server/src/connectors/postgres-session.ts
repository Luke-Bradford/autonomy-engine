import pg from 'pg';
import {
  formatZodIssues,
  postgresConnectionConfigSchema,
  type DatasetKind,
  type PostgresSslMode,
} from '@autonomy-studio/shared';
import type { ConnectorErrorKind } from './types.js';
import { DatasetIoError } from './dataset-io-error.js';
import { redactSecrets } from './redact.js';
import { quoteIdentifier } from './sql-identifier.js';

/**
 * #1196 M10 slice 3a — the postgres SESSION leaf: everything about REACHING a
 * postgres server, with nothing about what is then done there.
 *
 * It exists because slice 3a gives postgres a second consumer. Until now one
 * module (`postgres.ts`) both opened sessions and read from them, so the two
 * lived together with nothing to separate. The sink writer needs the opening
 * half and none of the reading half — and it cannot get it from `postgres.ts`
 * without a cycle, because `postgres.ts` (as a copy SOURCE) must in turn reach
 * the sink writers to dispatch a heterogeneous copy.
 *
 * That is the same extraction `fs-connection.ts` and `sql-identifier.ts` already
 * made for the same reason, and the shape `copy.ts`'s registry docblock predicted
 * would be needed "when a second SINK exists". This module imports no adapter and
 * no writer, so it is a LEAF and the cycle cannot re-form through it.
 *
 * Every export below is a pure MOVE out of `postgres.ts` with one deliberate
 * change, called out at `openSession`: the per-client type-parser table is now a
 * PARAMETER rather than a hardcoded call to the reader's own, because the sink
 * reads no data rows and has no business carrying the reader's OID overrides.
 */

/** What `pg` is actually given for a `Client`, once this module has finished
 * translating. Narrow on purpose: see `clientOptionsFor` on why nothing here may
 * be `undefined`. */
export interface PostgresClientOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: false | { rejectUnauthorized: boolean };
  connectionTimeoutMillis: number;
  statement_timeout: number;
  query_timeout: number;
  /** The per-CLIENT type-parser table (#1190). Absent on the probe, which reads
   * no data; supplied by the reader, where a default parser is measurably wrong
   * (see `readerTypes`). */
  types?: { getTypeParser: (oid: number, format?: unknown) => unknown };
}

/** What a statement hands back. Narrow on purpose: `fields` is what
 * `describeSource` reads (the source's columns, without reading a row), `rows`
 * is what the cursor yields. */
export interface PostgresQueryResult {
  readonly rows: Record<string, unknown>[];
  readonly fields: readonly { readonly name: string }[];
}

/**
 * The surface this module needs from a client, so the option mapping, the
 * refusal ladder and the READ path can all be asserted without a live server —
 * and so the live tests pass the real `pg.Client` through the same door.
 *
 * WIDENED BY #1190 from a probe-only `query(sql): Promise<unknown>`. That
 * signature could express "did it throw" and nothing else, so every test of the
 * reader would have had to be a LIVE one, gated behind
 * `STUDIO_TEST_POSTGRES_HOST` and therefore skipped on a developer machine — a
 * suite that certifies nothing exactly where it is most often run.
 */
export interface PostgresClient {
  connect(): Promise<unknown>;
  /**
   * WIDENED AGAIN BY #1196 with the optional `values`. The reader never bound a
   * parameter — it refused a `query` dataset's named ones outright, because `pg`
   * has none — so a one-argument seam was the whole truth. #1194 then made the
   * READER a binder too, by rewriting `:name` to `$n`
   * (`postgres-named-parameters.ts`); `values` stays OPTIONAL rather than
   * becoming required, because a read that binds nothing must keep reaching the
   * simple query protocol it was measured on (see `runBound` in `postgres.ts`).
   * The SINK binds every
   * value it writes, which §8 requires ("parameterised binding only, never
   * concatenated"), and resolves its target through `to_regclass($1)` so a
   * relation name cannot be interpolated either.
   */
  query(sql: string, values?: readonly unknown[]): Promise<PostgresQueryResult>;
  end(): Promise<unknown>;
}

export type PostgresClientFactory = (options: PostgresClientOptions) => PostgresClient;

export const defaultClientFactory: PostgresClientFactory = (options) =>
  new pg.Client(options) as unknown as PostgresClient;

/** libpq's default port, applied when `config.port` is absent. Spelled here
 * rather than left to `pg`, which would read `PGPORT` — see `clientOptionsFor`. */
export const DEFAULT_POSTGRES_PORT = 5432;
/** Applied when `config.connectTimeoutMs` is absent. `pg`'s own default is 0 =
 * wait forever, which would hang a dispatch on a black-holed host. */
export const DEFAULT_POSTGRES_CONNECT_TIMEOUT_MS = 10_000;
/** Applied when `config.statementTimeoutMs` is absent, to BOTH statement timers
 * (see `clientOptionsFor`). `pg`'s own defaults are `false` for each — no cap at
 * all on either side. */
export const DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS = 30_000;
/**
 * `sslmode` → `pg`'s `ssl` option, BY HAND and never by passthrough.
 *
 * MEASURED on `pg@8.23.0`: a `Client` silently IGNORES an `sslmode` key on its
 * options object — `new Client({ …, sslmode: 'require' })` connects in plaintext
 * and reports success. `sslmode` is a connection-URL concept that only
 * `pg-connection-string` parses. Forwarding the operator's string would
 * therefore give someone who asked for TLS an unencrypted socket and no error,
 * which is the fail-open direction this codebase refuses everywhere else.
 *
 * `require` maps to `rejectUnauthorized: false` deliberately: that is libpq's
 * meaning for it — encrypt, but do not verify who you are talking to — and
 * conflating it with `verify-full` would make a setting mean something stronger
 * than its name promises. An operator who wants the certificate checked asks for
 * `verify-full`, which is why the enum offers it as a separate, nameable choice.
 */
export function sslOptionFor(sslmode: PostgresSslMode): false | { rejectUnauthorized: boolean } {
  switch (sslmode) {
    case 'disable':
      return false;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-full':
      return { rejectUnauthorized: true };
  }
}

/**
 * Build the `pg` client options for a parsed config + password.
 *
 * EVERY FIELD IS SET, and that is the point of the function rather than an
 * incidental tidiness. MEASURED on `pg@8.23.0`: an option that is `undefined`
 * OR an empty string falls back to the AMBIENT ENVIRONMENT — `PGHOST`, `PGPORT`,
 * `PGUSER`, `PGDATABASE`, `PGPASSWORD`, and (via
 * `readSSLConfigFromEnvironment`) `PGSSLMODE`. Two things follow, and both are
 * why the defaults above are spelled out here instead of being left to the
 * driver:
 *
 * - A connection would silently reach a server the operator never named,
 *   differently on every machine, depending on what happens to be in the studio
 *   server process's environment.
 * - `PGPASSWORD` would supply a CREDENTIAL that was never bound to this
 *   connection — the readiness gate would pass, the connection would work, and
 *   nothing in the product would record which secret it actually used.
 *
 * So an empty password is refused by the caller before this is reached, and no
 * key here is ever left absent.
 */
export function clientOptionsFor(
  config: {
    host: string;
    port?: number;
    database: string;
    user: string;
    sslmode: PostgresSslMode;
    connectTimeoutMs?: number;
    statementTimeoutMs?: number;
  },
  password: string,
): PostgresClientOptions {
  return {
    host: config.host,
    port: config.port ?? DEFAULT_POSTGRES_PORT,
    database: config.database,
    user: config.user,
    password,
    ssl: sslOptionFor(config.sslmode),
    connectionTimeoutMillis: config.connectTimeoutMs ?? DEFAULT_POSTGRES_CONNECT_TIMEOUT_MS,
    // `statementTimeoutMs` arms BOTH statement timers, because either one alone
    // leaves a way for a query to run forever. MEASURED on pg@8.23.0 against
    // postgres:17, with `select pg_sleep(5)` and a 600ms budget:
    //   - `statement_timeout` is a SERVER-side startup parameter. It cancelled
    //     at 623ms with SQLSTATE 57014 — but only because the server chose to
    //     honour it. A tarpit, a proxy, or anything that is not really postgres
    //     need not.
    //   - `query_timeout` is a CLIENT-side timer. It gave up at 617ms with
    //     "Query read timeout", which is the one that holds regardless of what
    //     the far end does.
    // `connectionTimeoutMillis` does NOT cover this: pg arms that timer in
    // `_connect` and clears it once the session is ready, so a host that
    // completes the handshake quickly and then goes silent would leave the probe
    // waiting forever — a `testConnection` that neither resolves nor rejects.
    statement_timeout: config.statementTimeoutMs ?? DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS,
    query_timeout: config.statementTimeoutMs ?? DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS,
  };
}
/**
 * SQLSTATEs and socket codes that make a READ worth retrying, FAIL-SAFE: only a
 * named code is `transient` and everything unrecognised is `permanent`, which is
 * `isTransientSqliteCode`'s polarity and for its reason — a wrongly-transient
 * classification retries a copy that cannot succeed, burning the store's time on
 * every attempt.
 *
 * A read `partialWritePossible` is always false: a read writes nothing.
 */
const TRANSIENT_POSTGRES_CODES: ReadonlySet<string> = new Set([
  '57014', // query_canceled — our own statement/query timeout fired
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now — the server is starting up
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '53200', // out_of_memory
  '55P03', // lock_not_available
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** Whether a postgres error code names a retryable READ failure. Exported so the
 * allowlist is assertable rather than only reachable through a live server. */
export function isTransientPostgresCode(code: string): boolean {
  return TRANSIENT_POSTGRES_CODES.has(code);
}

/**
 * Classify a `pg` throw into the failure model, SCRUBBING the secret.
 *
 * The scrub is not belt-and-braces over `probeFailureSentence`'s: that one
 * guards the PROBE's default branch, and this is a different door. Every message
 * here is upstream text reaching `node.failed.error`, which lands in the run log
 * and the UI. `redactSecrets` is the shared helper `http.ts`, `agent.ts` and
 * `llm-shared.ts` already use — a third hand-rolled `split/join` is how the
 * halves drift.
 */
export function readFailure(err: unknown, context: string, secret: string | null): DatasetIoError {
  if (err instanceof DatasetIoError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  const kind: ConnectorErrorKind =
    typeof code === 'string' && isTransientPostgresCode(code) ? 'transient' : 'permanent';
  const raw = err instanceof Error ? err.message : String(err);
  return new DatasetIoError(kind, `${context}: ${redactSecrets(raw, [secret])}`, { cause: err });
}

/** The dataset kinds a postgres connection can hold — the store half of
 * `DATASET_CONNECTION_KINDS`, spelled here so a dispatch can refuse a foreign
 * kind with a sentence rather than a cast. */
export const POSTGRES_DATASET_KINDS: readonly DatasetKind[] = ['table', 'query'];

export function notAPostgresKind(kind: DatasetKind): string {
  return `a postgres connection holds ${POSTGRES_DATASET_KINDS.join(' and ')} datasets, not '${kind}'`;
}
/** One connected, configured session. Every entry point below opens one and
 * closes it in a `finally`; nothing here pools, because a copy is one long read
 * and a pool would only add a way to leak a session into a transaction. */
export async function openSession(
  createClient: PostgresClientFactory,
  connectionConfig: Record<string, unknown>,
  secret: string | null,
  context: string,
  types?: PostgresClientOptions['types'],
): Promise<PostgresClient> {
  const cfg = postgresConnectionConfigSchema.safeParse(connectionConfig);
  if (!cfg.success) {
    throw new DatasetIoError(
      'permanent',
      `invalid postgres connection config: ${formatZodIssues(cfg.error.issues)}`,
    );
  }
  // The probe's rule, at the second door: `pg` reads `PGPASSWORD` for an absent
  // or empty password and would authenticate with a credential this connection
  // never bound. `clientOptionsFor` explains the whole ambient-environment
  // family; this is the one that carries a secret.
  if (secret === null || secret === '') {
    throw new DatasetIoError(
      'permanent',
      'this postgres connection has no secret — postgres needs a password, bound as the connection secret',
    );
  }
  // #1196 — the type-parser table is the CALLER's, not this module's. The reader
  // supplies `readerTypes()` (its naive-timestamp-as-UTC override); the sink
  // supplies nothing, because it reads no data rows and applying the reader's OID
  // overrides to a write session would be a claim about values that never arrive.
  const client = createClient({
    ...clientOptionsFor(cfg.data, secret),
    ...(types === undefined ? {} : { types }),
  });
  try {
    await client.connect();
    // Pin the text form the naive-timestamp parser expects. `DateStyle` is a
    // SERVER setting (measured default `ISO, MDY`, and `ISO` is what makes the
    // output `YYYY-MM-DD`), so a server configured `German` or `Postgres` would
    // otherwise hand back text `PG_CIVIL_DATETIME_RE` cannot match — every
    // timestamp would fall to the text branch and refuse. Set, never assumed.
    await client.query(`SET SESSION DateStyle = 'ISO, YMD'`);
    return client;
  } catch (err) {
    try {
      await client.end();
    } catch {
      // The open already failed; its reason is the one worth reporting.
    }
    throw readFailure(err, context, secret);
  }
}

/** `schema.table`, or a bare table left for the session's `search_path`. Both
 * halves go through `quoteIdentifier`, whose case-fold note is the one thing a
 * postgres reader must read before trusting this. */
export function qualifiedTable(cfg: { schema?: string; table: string }): string {
  return cfg.schema === undefined
    ? quoteIdentifier(cfg.table, 'table')
    : `${quoteIdentifier(cfg.schema, 'schema')}.${quoteIdentifier(cfg.table, 'table')}`;
}
