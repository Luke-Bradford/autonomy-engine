import net from 'node:net';
import pg from 'pg';
import {
  DEFAULT_POSTGRES_CONNECT_TIMEOUT_MS,
  DEFAULT_POSTGRES_PORT,
  DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS,
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
 * is what the cursor yields, and `rowCount` is how the copy sink learns how many
 * rows an INSERT actually kept (#1270). Optional because only that one caller
 * needs it; `pg` sets it for every INSERT. */
export interface PostgresQueryResult {
  readonly rows: Record<string, unknown>[];
  readonly fields: readonly { readonly name: string }[];
  readonly rowCount?: number | null;
  /** The command tag: a COMMIT in a failed transaction answers `ROLLBACK`. */
  readonly command?: string;
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
  query(
    sql: string | PostgresExtendedQuery,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult>;
  end(): Promise<unknown>;
  /**
   * #1600 OR41 C6f-3 — `pg.Client` emits `error` when its connection drops
   * while no query is running, and an `error` with no listener is an uncaught
   * exception that ends the server. A session left idle on purpose (a
   * partitioned read's snapshot holder) listens. Optional, so a fake need not.
   */
  on?(event: 'error', listener: (err: Error) => void): unknown;
  /**
   * #1600 OR41 C10b-2b — `pg.Client` emits `notice` for each message the server
   * sends while a statement runs (RAISE NOTICE, a WARNING, `DROP … IF EXISTS`'s
   * "skipping"). A Script under *Capture messages* listens.
   */
  on?(event: 'notice', listener: (notice: PostgresNotice) => void): unknown;
  /**
   * #1800 — the session's key from the server's BackendKeyData, which
   * `pg.Client` keeps once connected. A CancelRequest names the session by it
   * (`armPostgresCancel`). Optional, so a fake need not carry one.
   */
  readonly processID?: unknown;
  readonly secretKey?: unknown;
}

/**
 * The fields of a server message a Script keeps (pg-protocol 1.16's
 * `NoticeMessage`). `severity` is the localised one (`S`); pg does not parse the
 * untranslated `V`.
 */
export interface PostgresNotice {
  readonly severity?: string | undefined;
  readonly message?: string | undefined;
  readonly detail?: string | undefined;
  readonly hint?: string | undefined;
}

/**
 * #1600 OR41 C3b — a statement sent over the EXTENDED protocol even with no
 * values: `pg`'s own query config (`queryMode: 'extended'` makes
 * `requiresPreparation` true, pg 8.23 `lib/query.js`), passed straight to
 * `pg.Client.query`. The server then refuses a second statement in the text
 * (`42601`, measured for a valued query in `postgres.ts`'s `runBound`), which is
 * what a Pre-copy script needs: on the simple protocol `delete …; commit` would
 * run both and split the script from its copy's transaction.
 */
export interface PostgresExtendedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly queryMode: 'extended';
}

export type PostgresClientFactory = (options: PostgresClientOptions) => PostgresClient;

export const defaultClientFactory: PostgresClientFactory = (options) =>
  new pg.Client(options) as unknown as PostgresClient;

/** The port and the two timeouts applied when a config leaves them absent
 * (#1712: shared, so the connection form's notes are built from them). The port
 * is spelled rather than left to `pg`, which would read `PGPORT` — see
 * `clientOptionsFor`. */
export {
  DEFAULT_POSTGRES_CONNECT_TIMEOUT_MS,
  DEFAULT_POSTGRES_PORT,
  DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS,
};
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
    statement_timeout: statementTimeoutMsOf(config),
    query_timeout: statementTimeoutMsOf(config),
  };
}

/** The cap on one statement, both timers' value: the connection's, or the default.
 * The reader also reads it, to know when a query timeout is the nearer limit. */
export function statementTimeoutMsOf(config: { statementTimeoutMs?: number }): number {
  return config.statementTimeoutMs ?? DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS;
}
/** SQLSTATE `query_canceled`: a statement or query timeout fired. The reader
 * also matches it to tell its own query-timeout cancel from the connection's. */
export const QUERY_CANCELED = '57014';

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
  QUERY_CANCELED, // our own statement timeout fired (pg's code-less client timer: see below)
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
 * The message of pg's CLIENT-side `query_timeout` (pg@8.23.0 `lib/client.js`): a
 * plain `Error` with no `code`. `clientOptionsFor` arms it at the same value as
 * `statement_timeout`, and because it starts at submit rather than at the
 * server's receipt it usually fires first (#1741). On a READ it is the same
 * timeout as `QUERY_CANCELED` and as transient. Matched exactly, and only when
 * there is no string `code`, so every other code-less throw stays `permanent`.
 *
 * Never on a WRITE. 57014 is the server's verdict that the statement was
 * cancelled; this timer only means the client stopped waiting, and it cancels
 * nothing. A `COMMIT` it abandons may still land, and a `transient` verdict would
 * retry the copy from row 0 into rows that are already there. (The sink reports
 * such a COMMIT as of unknown outcome, #1806: its `ROLLBACK` would succeed
 * against no transaction and prove nothing.)
 */
const PG_CLIENT_QUERY_TIMEOUT_MESSAGE = 'Query read timeout';

/**
 * #1600 OR41 C10b-2b — whether a `pg` throw is a statement timeout: the
 * server's `57014` or pg's own code-less client timer. A Script names its Block
 * timeout when it was the bound. (`57014` is also a cancel: the Script's own
 * CancelRequest (#1800), which it tells apart by its aborted signal and checks
 * first, or a lower `statement_timeout` a block set through `set_config`, which
 * then reads as the Timeout per block.)
 */
export function isPostgresStatementTimeout(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code === QUERY_CANCELED;
  return err instanceof Error && err.message === PG_CLIENT_QUERY_TIMEOUT_MESSAGE;
}

/**
 * The server's SQLSTATE on a failure, or null when the failure is not the
 * server's verdict (pg's client timeout, a socket error). Every SQLSTATE holds a
 * digit; a socket code never does, and `EPIPE` is five letters.
 */
export function sqlStateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /[0-9]/.test(code) ? code : null;
}

/**
 * #1806 — whether a failed COMMIT leaves its outcome unknown. Only a server
 * ERROR proves nothing committed. pg's client timeout and a socket error carry
 * no SQLSTATE, a FATAL that ends the session (class 08, 57P) can arrive after
 * the commit record is already written, and `40003` (statement_completion_unknown,
 * which a proxy or pooler may send) says so outright.
 */
export function commitOutcomeUnknown(err: unknown): boolean {
  const code = sqlStateOf(err);
  return (
    code === null ||
    code === STATEMENT_COMPLETION_UNKNOWN ||
    code.startsWith('08') ||
    code.startsWith('57P')
  );
}

/** SQLSTATE `statement_completion_unknown`. */
const STATEMENT_COMPLETION_UNKNOWN = '40003';

/** The failure of a COMMIT whose outcome is unknown, and what may stay applied. */
export function unknownCommitMessage(failure: string, mayStayApplied: string): string {
  return `${failure} — the COMMIT's outcome is unknown, so ${mayStayApplied}`;
}

/** Where a CancelRequest goes, and how long it may take. */
export interface PostgresCancelTarget {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
}

/** Sends one CancelRequest. Resolves whatever happens; it never rejects. */
export type PostgresCancelSender = (
  target: PostgresCancelTarget,
  processID: number,
  secretKey: number,
) => Promise<void>;

/** The CancelRequest's request code (protocol 3.0, `1234 << 16 | 5678`). */
const CANCEL_REQUEST_CODE = 80877102;

/** The connection's server, its port and connect timeout as the session's own. */
export function postgresCancelTargetOf(config: {
  host: string;
  port?: number;
  connectTimeoutMs?: number;
}): PostgresCancelTarget {
  return {
    host: config.host,
    port: config.port ?? DEFAULT_POSTGRES_PORT,
    timeoutMs: config.connectTimeoutMs ?? DEFAULT_POSTGRES_CONNECT_TIMEOUT_MS,
  };
}

/**
 * #1800 — ask the server to cancel the statement a session is running: the
 * protocol's CancelRequest, on a new connection, naming the session by its
 * BackendKeyData. The server answers nothing and closes; the statement then
 * fails `57014`, or has already finished, in which case the request is
 * ignored.
 *
 * Why this and not the alternatives:
 * - Destroying the session's socket stops nothing on the server, and outside a
 *   transaction the statement could still commit while the run reports it
 *   cancelled.
 * - `pg_cancel_backend(pid)` from a second session needs a fresh login, and
 *   behind a transaction-pooling pooler a remembered backend pid can belong to
 *   another client by then. A pooler routes a CancelRequest to the right one.
 * - `pg.Client#cancel` attaches no `error` listener to its connection, so a
 *   refused connection would be an uncaught `error` that ends the server.
 *
 * Plaintext, as `pg.Client#cancel` (pg 8.23 writes it on TCP connect, before
 * any SSL negotiation) and libpq before 17 send it: the key travels in the
 * clear and the server is not verified. An on-path party could then cancel
 * this session's statements, which resetting its TCP connection already
 * allows. A unix-socket host is reached at `<dir>/.s.PGSQL.<port>`, as pg does.
 *
 * Best effort: every error is swallowed, and the socket is destroyed at
 * `timeoutMs`, so a host that never answers cannot hold it open.
 */
export const sendPostgresCancelRequest: PostgresCancelSender = (target, processID, secretKey) =>
  new Promise((resolve) => {
    const request = Buffer.alloc(16);
    request.writeInt32BE(16, 0);
    request.writeInt32BE(CANCEL_REQUEST_CODE, 4);
    request.writeInt32BE(processID, 8);
    request.writeInt32BE(secretKey, 12);
    const socket = target.host.startsWith('/')
      ? net.connect(`${target.host}/.s.PGSQL.${String(target.port)}`)
      : net.connect(target.port, target.host);
    const done = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    };
    const timer = setTimeout(done, target.timeoutMs);
    timer.unref();
    socket.once('connect', () => socket.write(request));
    // `on`, not `once`: a second `error` with no listener would end the server.
    socket.on('error', done);
    socket.once('close', done);
  });

function isInt32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= -(2 ** 31) && (value as number) < 2 ** 31;
}

/**
 * #1800 — send `client`'s session a CancelRequest when `signal` aborts, or at
 * once if it already has. Returns the disarm, called when the statement ends,
 * so a later abort sends nothing. Arms nothing when the client carries no
 * protocol-3.0 key (a fake, or a longer key from a later protocol). The send is
 * not awaited: the statement's own failure is what the caller waits on.
 */
export function armPostgresCancel(
  client: PostgresClient,
  target: PostgresCancelTarget,
  signal: AbortSignal,
  send: PostgresCancelSender = sendPostgresCancelRequest,
): () => void {
  const { processID, secretKey } = client;
  if (!isInt32(processID) || !isInt32(secretKey)) return () => undefined;
  const fire = (): void => {
    try {
      send(target, processID, secretKey).catch(() => undefined);
    } catch {
      // Best effort: a throw from a listener would surface as uncaught.
    }
  };
  if (signal.aborted) {
    fire();
    return () => undefined;
  }
  signal.addEventListener('abort', fire, { once: true });
  return () => signal.removeEventListener('abort', fire);
}

/** Whether a `pg` throw is retryable: a named code, or, on a read only, pg's own
 * code-less client query timeout. */
function isTransientPostgresError(err: unknown, path: 'read' | 'write'): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return isTransientPostgresCode(code);
  return path === 'read' && err instanceof Error && err.message === PG_CLIENT_QUERY_TIMEOUT_MESSAGE;
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
 *
 * `path` is `'write'` from the sink, where pg's client timeout stays `permanent`
 * (see `PG_CLIENT_QUERY_TIMEOUT_MESSAGE`).
 */
export function readFailure(
  err: unknown,
  context: string,
  secret: string | null,
  path: 'read' | 'write' = 'read',
): DatasetIoError {
  if (err instanceof DatasetIoError) return err;
  const kind: ConnectorErrorKind = isTransientPostgresError(err, path) ? 'transient' : 'permanent';
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

/**
 * #1193 — WHAT PHYSICALLY IDENTIFIES A POSTGRES STORE, and why it takes three
 * parts rather than one.
 *
 * `datamove/address.ts` compares two ends by `storeIdentity` when both have one,
 * and falls back to the `store` STRING when either is null. For a networked
 * store that string is `host:port/database`, which an operator can spell two
 * ways for one server (`localhost` and `127.0.0.1`, a name and its CNAME, the
 * default port written or omitted). Two such spellings made the physical
 * self-copy gate fail open the moment #1196 let postgres be a SINK as well as a
 * source — the hole this closes.
 *
 * The three parts, each load-bearing:
 *  - `system_identifier` from `pg_control_system()` is cluster-unique, and
 *    MEASURED readable by an ordinary unprivileged role (a freshly created
 *    `LOGIN`-only role read it) — it is not superuser-gated;
 *  - the current database's OID, because one cluster holds many databases and a
 *    copy between two of them is a copy between two stores. `nspname.relname`
 *    is only database-unique, so the object half cannot carry this;
 *  - `pg_is_in_recovery()`, which separates a PRIMARY from a physical STANDBY.
 *    A standby's control file is a byte copy of its primary's, so it reports the
 *    SAME `system_identifier` and the same database OIDs — without this part,
 *    `standby -> primary`, an ordinary ETL shape, would resolve to one address
 *    and be refused as a self-copy. That refusal would be work-that-would-have-
 *    succeeded, the one direction §7 says this gate must never fail in. It is
 *    also sound in the other direction: a standby is read-only and can never be
 *    a sink, so the pair can never be a genuine self-copy. (The byte-copy claim
 *    is REASONED from `pg_basebackup`'s mechanism and walreceiver's
 *    `IDENTIFY_SYSTEM` check, not measured here — no replica was to hand. The
 *    part is included precisely so that the answer does not depend on it.)
 */
const STORE_IDENTITY_SQL = `
  select (select system_identifier::text from pg_control_system()) as sysid,
         (select oid::text from pg_database where datname = current_database()) as dboid,
         pg_is_in_recovery() as in_recovery`;

export async function resolveStoreIdentity(client: PostgresClient): Promise<string | null> {
  const result = await client.query(STORE_IDENTITY_SQL);
  const row = result.rows[0] as
    { sysid: string | null; dboid: string | null; in_recovery: boolean | null } | undefined;
  if (row?.sysid == null || row.dboid == null) return null;
  return `${row.sysid}:${row.dboid}:${row.in_recovery === true ? 'standby' : 'primary'}`;
}

/**
 * #1600 OR41 C8c — the `pg_class.relkind`s that are a TABLE to read: tables,
 * partitioned tables, views, materialized views and foreign tables. List tables
 * offers exactly these, and Get metadata answers `exists` for exactly these, so
 * an index or sequence of that name is not a table either one sees.
 */
export const READABLE_RELKINDS_SQL = "('r', 'p', 'v', 'm', 'f')";

/**
 * The CANONICAL `schema.relation` a name addresses in this session, or `null`.
 *
 * `to_regclass` is what applies `search_path`, which is why this needs a session
 * at all: an unqualified `people` is the DEFAULT spelling of a table dataset
 * (`schema` is optional), and resolving it is not something a config can be read
 * for. Measured — `to_regclass('people')` and `to_regclass('s1193.people')`
 * return the same OID, while `to_regclass('"People"')` returns a different
 * relation. So the QUOTED name from {@link qualifiedTable} is what must be
 * passed; handing it the raw spelling would fold `People` onto `people` and
 * report two distinct tables as one address.
 *
 * The bound parameter is not decoration. `postgres-sink.ts`'s `DESCRIBE_SINK_SQL`
 * measured that `to_regclass('"public"."plain"; drop table public.plain')`
 * returns NULL — a name that does not parse is simply not a relation, and
 * nothing executes. Same idiom, same reason.
 *
 * NOT SHARED WITH `DESCRIBE_SINK_SQL`, though the `pg_class`/`pg_namespace` join
 * is the same shape. That query fetches `relkind` and the column list in the
 * SAME round trip, deliberately per its own docblock, so the sink's describe and
 * its write cannot disagree about the relation they mean. An address needs the
 * name alone. Factoring the join out would either make this over-fetch a column
 * list nothing reads, or split the sink's one round trip into two and give the
 * describe a window to straddle — paying a real cost to remove four lines of
 * duplicated SQL that has one measured behaviour between them.
 *
 * `null` covers only the relation NOT EXISTING. `to_regclass` can also THROW —
 * measured, a role without `USAGE` on a named schema gets `42501` rather than a
 * NULL — and that throw is left to the caller, which treats every query-level
 * failure here alike.
 */
const RELATION_NAME_SQL = `
  select n.nspname || '.' || c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where c.oid = to_regclass($1)`;

export async function resolveRelationName(
  client: PostgresClient,
  qualified: string,
): Promise<string | null> {
  const result = await client.query(RELATION_NAME_SQL, [qualified]);
  const row = result.rows[0] as { name: string | null } | undefined;
  return row?.name ?? null;
}
