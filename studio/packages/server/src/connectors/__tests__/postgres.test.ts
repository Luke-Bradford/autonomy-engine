import { afterEach, describe, expect, it } from 'vitest';
import {
  clientOptionsFor,
  createPostgresAdapter,
  postgresAdapter,
  sslOptionFor,
  DEFAULT_POSTGRES_PORT,
  DEFAULT_POSTGRES_CONNECT_TIMEOUT_MS,
  DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS,
  type PostgresClientOptions,
  type PostgresProbeClient,
} from '../postgres.js';

/**
 * #1189 M10 slice 1 — the `postgres` connector's probe.
 *
 * MOSTLY HERMETIC, and that is a decision rather than a shortcut. The sqlite
 * suite deliberately uses a real file DB because what it needs to measure IS the
 * filesystem. What this file needs to measure is a TRANSLATION — `sslmode` to
 * `pg`'s `ssl`, a config to a fully-populated options object, a driver error to
 * an operator's sentence — and every one of those is a property of code written
 * here. A live server cannot assert them any better, and it cannot assert the
 * most important one AT ALL: that nothing is left `undefined` for `pg` to fill
 * in from the ambient environment. A recording client can, by being handed the
 * options and read.
 *
 * The one thing a fake cannot prove — that a real `pg` behaves as measured — is
 * covered by the live smoke test at the bottom, which runs against a real
 * postgres when `STUDIO_TEST_POSTGRES_*` names one.
 */

const CONFIG = {
  host: 'db.example.test',
  port: 6543,
  database: 'app',
  user: 'app_ro',
  sslmode: 'require' as const,
  connectTimeoutMs: 4_000,
  statementTimeoutMs: 9_000,
};

interface Recorder {
  readonly options: PostgresClientOptions[];
  readonly queries: string[];
  ended: number;
}

/** A client that records what it was given and fails (or not) on demand. */
function recordingFactory(behaviour: { connectError?: unknown; queryError?: unknown } = {}) {
  const rec: Recorder = { options: [], queries: [], ended: 0 };
  const factory = (options: PostgresClientOptions): PostgresProbeClient => {
    rec.options.push(options);
    return {
      async connect() {
        if (behaviour.connectError !== undefined) throw behaviour.connectError;
      },
      async query(sql: string) {
        rec.queries.push(sql);
        if (behaviour.queryError !== undefined) throw behaviour.queryError;
        return { rows: [{ ok: 1 }] };
      },
      async end() {
        rec.ended += 1;
      },
    };
  };
  return { rec, factory };
}

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('sslOptionFor (#1189 M10)', () => {
  it('maps each mode to an explicit pg ssl option, never a passthrough', () => {
    // MEASURED on pg@8.23.0: `new Client({ sslmode: 'require' })` connects in
    // PLAINTEXT and reports success, because a Client ignores `sslmode`
    // entirely. So the mapping is the security control, not decoration.
    expect(sslOptionFor('disable')).toBe(false);
    expect(sslOptionFor('require')).toEqual({ rejectUnauthorized: false });
    expect(sslOptionFor('verify-full')).toEqual({ rejectUnauthorized: true });
  });

  it('distinguishes require from verify-full — they are not the same promise', () => {
    expect(sslOptionFor('require')).not.toEqual(sslOptionFor('verify-full'));
  });
});

describe('clientOptionsFor (#1189 M10)', () => {
  it('sets every option pg would otherwise read from the environment', () => {
    // The guard this function exists for. MEASURED on pg@8.23.0: an option that
    // is undefined OR '' falls back to PGHOST/PGPORT/PGUSER/PGDATABASE/
    // PGPASSWORD, and an undefined `ssl` falls back to PGSSLMODE. An options
    // object with a hole in it is a connection that goes somewhere the operator
    // never named, with a credential they never bound.
    const options = clientOptionsFor(CONFIG, 'pw');
    for (const [key, value] of Object.entries(options)) {
      expect(value, `${key} must not be left for pg to infer`).not.toBeUndefined();
    }
    expect(Object.keys(options).sort()).toEqual(
      [
        'connectionTimeoutMillis',
        'database',
        'host',
        'password',
        'port',
        'ssl',
        'statement_timeout',
        'user',
      ].sort(),
    );
  });

  it('carries the config through unchanged', () => {
    expect(clientOptionsFor(CONFIG, 'pw')).toEqual({
      host: 'db.example.test',
      port: 6543,
      database: 'app',
      user: 'app_ro',
      password: 'pw',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 4_000,
      statement_timeout: 9_000,
    });
  });

  it('fills the three optional keys from OUR defaults, not the driver’s', () => {
    // pg's own defaults are the reason these are spelled out: port would come
    // from PGPORT, connectionTimeoutMillis defaults to 0 (wait forever, which
    // hangs a dispatch on a black-holed host), and statement_timeout to false
    // (no server-side cap at all).
    const options = clientOptionsFor(
      { host: 'h', database: 'd', user: 'u', sslmode: 'verify-full' },
      'pw',
    );
    expect(options.port).toBe(DEFAULT_POSTGRES_PORT);
    expect(options.connectionTimeoutMillis).toBe(DEFAULT_POSTGRES_CONNECT_TIMEOUT_MS);
    expect(options.statement_timeout).toBe(DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS);
    expect(options.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('maps the two timeouts onto the two DIFFERENT pg timers', () => {
    // `connectTimeoutMs` is how long to wait for the socket
    // (`connectionTimeoutMillis`); `statementTimeoutMs` is the server-side cap
    // on one statement (`statement_timeout`). Crossing them would silently make
    // one of the two settings do nothing.
    const options = clientOptionsFor({ ...CONFIG, connectTimeoutMs: 1, statementTimeoutMs: 2 }, 'p');
    expect(options.connectionTimeoutMillis).toBe(1);
    expect(options.statement_timeout).toBe(2);
  });
});

describe('postgresAdapter.testConnection (#1189 M10)', () => {
  it('refuses an invalid config as a sentence naming the field', async () => {
    const { rec, factory } = recordingFactory();
    const result = await createPostgresAdapter(factory).testConnection(
      { ...CONFIG, host: '' },
      'pw',
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^invalid postgres connection config: /);
    expect(result.error).toContain('host');
    // Refused BEFORE any client is built — a bad config never opens a socket.
    expect(rec.options).toHaveLength(0);
  });

  it.each([
    ['null', null],
    ['empty', ''],
  ])('refuses a %s secret rather than letting pg read PGPASSWORD', async (_label, secret) => {
    // The credential half of the ambient-environment guard, and the reason ''
    // is tested alongside null: MEASURED on pg@8.23.0, BOTH fall back to
    // PGPASSWORD, so a connection with no bound secret would succeed using a
    // credential nothing in the product recorded.
    const { rec, factory } = recordingFactory();
    const result = await createPostgresAdapter(factory).testConnection(CONFIG, secret);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no secret/);
    expect(rec.options).toHaveLength(0);
  });

  it('probes with a statement, not merely an open', async () => {
    const { rec, factory } = recordingFactory();
    const result = await createPostgresAdapter(factory).testConnection(CONFIG, 'pw');
    expect(result).toEqual({ ok: true });
    expect(rec.queries).toEqual(['select 1']);
    expect(rec.ended).toBe(1);
  });

  it.each([
    ['28P01', 'password authentication failed for user "app_ro"', /refused the password/],
    ['3D000', 'database "nope" does not exist', /no database of that name/],
    ['ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:6543', /nothing is listening/],
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND db.example.test', /does not resolve/],
  ])('turns a %s into an operator-readable sentence', async (code, message, expected) => {
    // Every code here was MEASURED against postgres:17, not read from a table.
    const { factory } = recordingFactory({ connectError: pgError(code, message) });
    const result = await createPostgresAdapter(factory).testConnection(CONFIG, 'pw');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(expected);
  });

  it('never echoes the password into a refusal', async () => {
    // pg's own connect errors do not carry the password today, but the probe is
    // the first line rather than the executor's redaction backstop, and a driver
    // that started including it would otherwise leak it into a UI string.
    const { factory } = recordingFactory({
      connectError: pgError('28P01', 'password authentication failed: hunter2'),
    });
    const result = await createPostgresAdapter(factory).testConnection(CONFIG, 'hunter2');
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('hunter2');
  });

  it('closes the client even when the probe throws', async () => {
    const { rec, factory } = recordingFactory({ queryError: pgError('57014', 'canceled') });
    await createPostgresAdapter(factory).testConnection(CONFIG, 'pw');
    expect(rec.ended).toBe(1);
  });

  it('RESOLVES on a client that cannot even be constructed', async () => {
    // Typed to resolve, never reject: a caller gets a sentence, not an unhandled
    // rejection. A factory that throws is the harshest version of that.
    const result = await createPostgresAdapter(() => {
      throw new Error('client construction blew up');
    }).testConnection(CONFIG, 'pw');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('client construction blew up');
  });
});

describe('postgresAdapter.runActivity (#1189 M10)', () => {
  it('refuses every activity — a store connection binds none of its own', async () => {
    const events = [];
    for await (const event of postgresAdapter.runActivity(
      { activityType: 'http_request' } as never,
      null,
    )) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(JSON.stringify(events[0])).toMatch(/runs no activity of its own/);
  });
});

/**
 * The live half. Opt-in via `STUDIO_TEST_POSTGRES_HOST` (+ `_PORT`, `_DATABASE`,
 * `_USER`, `_PASSWORD`), so the suite is green on a machine with no postgres —
 * which is every machine in CI today, deliberately: slice 1's only pg-touching
 * code is a probe with no route and no UI caller yet, and standing up a service
 * container to cover it would be disproportionate. Slice 2 moves data, needs the
 * container regardless, and is where this stops being opt-in (#1190).
 *
 * SKIPPED IS NOT PASSED. `describe.skipIf` reports these as skipped rather than
 * silently absent, so the count in the run output says which half ran.
 */
const LIVE_HOST = process.env.STUDIO_TEST_POSTGRES_HOST;
describe.skipIf(LIVE_HOST === undefined)('against a live postgres', () => {
  const live = {
    host: LIVE_HOST ?? '',
    port: Number(process.env.STUDIO_TEST_POSTGRES_PORT ?? DEFAULT_POSTGRES_PORT),
    database: process.env.STUDIO_TEST_POSTGRES_DATABASE ?? 'postgres',
    user: process.env.STUDIO_TEST_POSTGRES_USER ?? 'postgres',
    sslmode: 'disable' as const,
    connectTimeoutMs: 5_000,
  };
  const password = process.env.STUDIO_TEST_POSTGRES_PASSWORD ?? '';

  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('connects and answers', async () => {
    expect(await postgresAdapter.testConnection(live, password)).toEqual({ ok: true });
  });

  it('reports a wrong password as a refused password', async () => {
    const result = await postgresAdapter.testConnection(live, `${password}-wrong`);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refused the password/);
  });

  it('reports an unknown database as one', async () => {
    const result = await postgresAdapter.testConnection(
      { ...live, database: 'no_such_database_1189' },
      password,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no database of that name/);
  });

  it('reports a closed port as one, within the connect budget', async () => {
    const started = Date.now();
    const result = await postgresAdapter.testConnection(
      { ...live, port: 1, connectTimeoutMs: 3_000 },
      password,
    );
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does NOT fall back to PGPASSWORD when the connection has no secret', async () => {
    // The measured hazard, proven end to end against a real server: with the
    // correct password in the environment, an unbound connection must still be
    // refused. If the guard were removed this would CONNECT.
    process.env.PGPASSWORD = password;
    const result = await postgresAdapter.testConnection(live, '');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no secret/);
  });

  it('does NOT fall back to PGHOST for a config that names its host', async () => {
    process.env.PGHOST = '127.0.0.1';
    process.env.PGPORT = String(live.port);
    const result = await postgresAdapter.testConnection(
      { ...live, host: 'no-such-host-1189.invalid', connectTimeoutMs: 3_000 },
      password,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not resolve/);
  });
});
