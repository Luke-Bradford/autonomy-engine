import pg from 'pg';
import {
  formatZodIssues,
  postgresConnectionConfigSchema,
  type PostgresSslMode,
} from '@autonomy-studio/shared';
import type { ActivityContext, ActivityEvent, ConnectorAdapter } from './types.js';
import { failed } from './activity-events.js';

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
}

/** The one-statement surface this module needs from a client, so the mapping
 * above can be asserted without a live server (and so the live smoke test can
 * pass the real thing through the same door). */
export interface PostgresProbeClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<unknown>;
}

export type PostgresClientFactory = (options: PostgresClientOptions) => PostgresProbeClient;

const defaultClientFactory: PostgresClientFactory = (options) => new pg.Client(options);

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
      let client: PostgresProbeClient | undefined;
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

    async *runActivity(ctx: ActivityContext): AsyncIterable<ActivityEvent> {
      // A store connection binds no activity of its own. This body exists
      // because the registry must be TOTAL over `ConnectionKind`
      // (`connection-config-ssot.test.ts` asserts an adapter for every kind), and
      // refusing loudly is the honest content for it — the sqlite adapter says
      // the same thing for the same reason.
      //
      // UNREACHABLE in slice 1, unlike sqlite's equivalent: no catalog entry
      // lists `postgres` in `connectionKinds`, so the executor refuses such a
      // node with `CONNECTION_KIND_INVALID` before dispatch ever gets here. It
      // becomes reachable in slice 2, when `copy` admits a postgres source.
      yield failed(
        'permanent',
        `a postgres connection is a STORE binding and runs no activity of its own (got '${ctx.activityType}')`,
      );
    },
  };
}

export const postgresAdapter: ConnectorAdapter = createPostgresAdapter();
