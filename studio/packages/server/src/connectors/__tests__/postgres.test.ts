import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clientOptionsFor,
  createPostgresAdapter,
  postgresAdapter,
  sslOptionFor,
  DEFAULT_POSTGRES_PORT,
  DEFAULT_POSTGRES_CONNECT_TIMEOUT_MS,
  DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS,
  describePostgresDatasetColumns,
  isTransientPostgresCode,
  parseNaiveTimestampAsUtc,
  readPostgresDatasetBatches,
  resolvePostgresDatasetAddress,
  type PostgresClientFactory,
  type PostgresClientOptions,
  type PostgresClient,
} from '../postgres.js';
import { COPY_BATCH_ROWS } from '../../limits.js';
import { sameDatasetAddress, type DatasetKind } from '@autonomy-studio/shared';
import { liveSuiteMustRun } from './live-postgres.js';
import { readSqliteDatasetBatches } from '../sqlite.js';
import type { ResolvedDataset } from '../types.js';

/** A `ResolvedDataset` with only the fields the address seam reads. */
function dataset(kind: DatasetKind, config: Record<string, unknown>): ResolvedDataset {
  return { id: 'ds1', name: 'ds', kind, config, columns: [] };
}

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
  const factory = (options: PostgresClientOptions): PostgresClient => {
    rec.options.push(options);
    return {
      async connect() {
        if (behaviour.connectError !== undefined) throw behaviour.connectError;
      },
      async query(sql: string) {
        rec.queries.push(sql);
        if (behaviour.queryError !== undefined) throw behaviour.queryError;
        return { rows: [{ ok: 1 }], fields: [{ name: 'ok' }] };
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
        'query_timeout',
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
      query_timeout: 9_000,
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
    expect(options.query_timeout).toBe(DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS);
    expect(options.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('maps the two timeouts onto the two DIFFERENT pg timers', () => {
    // `connectTimeoutMs` is how long to wait for the socket
    // (`connectionTimeoutMillis`); `statementTimeoutMs` is the server-side cap
    // on one statement (`statement_timeout`). Crossing them would silently make
    // one of the two settings do nothing.
    const options = clientOptionsFor(
      { ...CONFIG, connectTimeoutMs: 1, statementTimeoutMs: 2 },
      'p',
    );
    expect(options.connectionTimeoutMillis).toBe(1);
    expect(options.statement_timeout).toBe(2);
  });

  it('arms BOTH statement timers, so a server that ignores its own cap cannot hang the probe', () => {
    // `connectionTimeoutMillis` covers the handshake and is then CLEARED, so a
    // host that connects fast and then goes silent would leave `testConnection`
    // neither resolving nor rejecting. `statement_timeout` is server-side and
    // binds only a server that honours it; `query_timeout` is the client-side
    // timer that holds regardless. Measured at ~620ms each for a 600ms budget
    // against postgres:17, with `select pg_sleep(5)`.
    const options = clientOptionsFor({ ...CONFIG, statementTimeoutMs: 1_500 }, 'p');
    expect(options.statement_timeout).toBe(1_500);
    expect(options.query_timeout).toBe(1_500);
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
    if (result.ok) throw new Error('expected a failed probe');
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
    if (result.ok) throw new Error('expected a failed probe');
    expect(result.error).toMatch(/no secret/);
    expect(rec.options).toHaveLength(0);
  });

  it('probes with a statement, not merely an open', async () => {
    const { rec, factory } = recordingFactory();
    const result = await createPostgresAdapter(factory).testConnection(CONFIG, 'pw');
    expect(result).toEqual({ ok: true, probed: 'liveness' });
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
    if (result.ok) throw new Error('expected a failed probe');
    expect(result.error).toMatch(expected);
  });

  it('never echoes the password into a refusal, on the branch that can', async () => {
    // The code MUST be one `probeFailureSentence` does not name. A mapped code
    // (28P01, 3D000, …) returns a fixed sentence that never touches
    // `err.message`, so asserting redaction on one of those proves nothing — it
    // would pass with the scrubbing deleted. The DEFAULT branch is the one that
    // hands an upstream string to a caller, so that is the branch to test.
    const { factory } = recordingFactory({
      connectError: pgError('XX000', 'internal error while connecting as app_ro/hunter2'),
    });
    const result = await createPostgresAdapter(factory).testConnection(CONFIG, 'hunter2');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed probe');
    expect(result.error).not.toContain('hunter2');
    // Scrubbed, not swallowed: the operator still gets the diagnostic.
    expect(result.error).toContain('internal error while connecting');
    expect(result.error).toContain('[redacted]');
  });

  it('still reports an UNMAPPED failure verbatim when there is nothing to scrub', async () => {
    // The scrubbing must not eat the message. A code the sentence table does not
    // name falls through to the driver's own words, which for postgres is
    // usually a sentence already.
    const { factory } = recordingFactory({ connectError: pgError('53300', 'too many clients') });
    const result = await createPostgresAdapter(factory).testConnection(CONFIG, 'pw');
    expect(result).toEqual({ ok: false, error: 'too many clients' });
  });

  it('closes the client even when the probe throws', async () => {
    const { rec, factory } = recordingFactory({ queryError: pgError('57014', 'canceled') });
    await createPostgresAdapter(factory).testConnection(CONFIG, 'pw');
    expect(rec.ended).toBe(1);
  });

  it('still answers when CLOSING the client is what throws', async () => {
    // The last resolve-path permutation: `end()` runs in a `finally`, so an
    // unguarded throw there would replace an answer the probe had already
    // computed with a rejection — including on the SUCCESS path.
    const factory = (): PostgresClient => ({
      connect: async () => undefined,
      query: async () => ({ rows: [], fields: [] }),
      end: async () => {
        throw new Error('socket already gone');
      },
    });
    expect(await createPostgresAdapter(factory).testConnection(CONFIG, 'pw')).toEqual({ ok: true, probed: 'liveness' });
  });

  it('RESOLVES on a client that cannot even be constructed', async () => {
    // Typed to resolve, never reject: a caller gets a sentence, not an unhandled
    // rejection. A factory that throws is the harshest version of that.
    const result = await createPostgresAdapter(() => {
      throw new Error('client construction blew up');
    }).testConnection(CONFIG, 'pw');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed probe');
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

// ---------------------------------------------------------------------------
// #1190 M10 slice 2 — the READER.
// ---------------------------------------------------------------------------

/** A recording client whose `query` answers from a scripted table, so the READ
 * path's statement sequence is assertable without a server. */
function readerFactory(script: {
  fields?: readonly string[];
  fetches?: readonly Record<string, unknown>[][];
  failOn?: { match: string; error: unknown };
}) {
  const rec = {
    queries: [] as string[],
    // #1194 — recorded ALONGSIDE `queries` rather than by widening it, because
    // every existing assertion in this file indexes `queries` positionally.
    // `undefined` is a distinct reading from `[]`: it is what proves a read that
    // binds nothing still reaches the SIMPLE query protocol.
    values: [] as (readonly unknown[] | undefined)[],
    ended: 0,
    options: [] as PostgresClientOptions[],
  };
  let fetchIndex = 0;
  const factory: PostgresClientFactory = (options) => {
    rec.options.push(options);
    return {
      connect: async (): Promise<undefined> => undefined,
      query: async (sql: string, values?: readonly unknown[]) => {
        rec.queries.push(sql);
        rec.values.push(values);
        if (script.failOn !== undefined && sql.includes(script.failOn.match)) {
          throw script.failOn.error;
        }
        if (sql.startsWith('FETCH')) {
          const batch = script.fetches?.[fetchIndex] ?? [];
          fetchIndex += 1;
          return { rows: [...batch], fields: (script.fields ?? []).map((name) => ({ name })) };
        }
        return { rows: [], fields: (script.fields ?? []).map((name) => ({ name })) };
      },
      end: async () => {
        rec.ended += 1;
      },
    };
  };
  return { rec, factory };
}

const READ_BASE = {
  connectionConfig: CONFIG,
  secret: 'pw',
  datasetKind: 'table' as const,
  datasetConfig: { table: 't' },
};

describe('parseNaiveTimestampAsUtc (#1190 M10) — the TZ-invariance pin', () => {
  // The measurement this function exists for: `pg`'s DEFAULT parser reads a
  // naive `timestamp` as LOCAL time, so one row yields three different instants
  // under three `TZ`s, and `coerce.ts` then renders it in UTC — a silent,
  // machine-dependent corruption that reads as success.
  it('reads a naive timestamp as UTC, so the wall clock survives', () => {
    const parsed = parseNaiveTimestampAsUtc('2026-07-15 13:45:00');
    expect(parsed).toBeInstanceOf(Date);
    expect((parsed as Date).toISOString()).toBe('2026-07-15T13:45:00.000Z');
  });

  it('reads a naive date without moving the DAY', () => {
    // Measured: pg's default parse of `2026-07-15` in Europe/London is
    // `2026-07-14T23:00:00.000Z` — the previous day.
    expect((parseNaiveTimestampAsUtc('2026-07-15') as Date).toISOString()).toBe(
      '2026-07-15T00:00:00.000Z',
    );
  });

  it('TRUNCATES postgres microseconds to milliseconds, never rounding forward', () => {
    expect((parseNaiveTimestampAsUtc('2026-07-15 13:45:00.123456') as Date).toISOString()).toBe(
      '2026-07-15T13:45:00.123Z',
    );
    expect((parseNaiveTimestampAsUtc('2026-07-15 13:45:00.999999') as Date).toISOString()).toBe(
      '2026-07-15T13:45:00.999Z',
    );
  });

  it('does not let a two-digit year become 19xx', () => {
    // `Date.UTC(44, ...)` is 1944. Postgres really does emit `0044-03-15`.
    expect((parseNaiveTimestampAsUtc('0044-03-15 12:00:00') as Date).getUTCFullYear()).toBe(44);
  });

  it.each(['infinity', '-infinity', '0044-03-15 12:00:00 BC', 'not a date'])(
    'hands back postgres own text for %s, rather than inventing a Date',
    (text) => {
      // The honest branch: these have no `Date`. As text, `coerce.ts` copies
      // them to a `string` target verbatim and REFUSES a date/timestamp target,
      // which is the correct direction for a value this code cannot represent.
      expect(parseNaiveTimestampAsUtc(text)).toBe(text);
    },
  );
});

describe('the reader type-parser wiring (#1190 M10)', () => {
  it('routes BOTH naive OIDs through the UTC parser, per client', async () => {
    // Pins the WIRING rather than the parse, and it is deliberately independent
    // of the runner's `TZ`. The live TZ-invariance test below cannot do this job
    // on its own: on a UTC runner `pg`'s local-time parse and ours COINCIDE, so
    // removing the override would leave that test green. This one reds wherever
    // it runs.
    const { rec, factory } = readerFactory({ fields: ['a'] });
    await describePostgresDatasetColumns({ ...READ_BASE, createClient: factory });
    const types = rec.options[0]?.types;
    expect(types).toBeDefined();
    // 1114 = timestamp without time zone, 1082 = date.
    expect(types?.getTypeParser(1114)).toBe(parseNaiveTimestampAsUtc);
    expect(types?.getTypeParser(1082)).toBe(parseNaiveTimestampAsUtc);
  });

  it('leaves timestamptz on pg own parser — it names a real instant', async () => {
    const { rec, factory } = readerFactory({ fields: ['a'] });
    await describePostgresDatasetColumns({ ...READ_BASE, createClient: factory });
    expect(rec.options[0]?.types?.getTypeParser(1184)).not.toBe(parseNaiveTimestampAsUtc);
  });
});

describe('describePostgresDatasetColumns (#1190 M10)', () => {
  it('describes WITHOUT reading a row, and wraps the statement', async () => {
    const { rec, factory } = readerFactory({ fields: ['a', 'b'] });
    const columns = await describePostgresDatasetColumns({ ...READ_BASE, createClient: factory });
    expect(columns).toEqual(['a', 'b']);
    const describeSql = rec.queries.find((q) => q.startsWith('SELECT * FROM ('));
    expect(describeSql).toBe('SELECT * FROM (SELECT * FROM "t") "__studio_src" LIMIT 0');
    expect(rec.ended).toBe(1);
  });

  it('returns duplicate result columns UNCOLLAPSED, as sqlite does', async () => {
    // Measured: postgres reports `select a, a` as ['a','a'] while the row object
    // carries `a` once. The collapse is `indexSourceColumns` in
    // `datamove/schema-drift.ts`, downstream and shared — a second copy here
    // would be a divergent rule in one store.
    const { factory } = readerFactory({ fields: ['a', 'a'] });
    expect(await describePostgresDatasetColumns({ ...READ_BASE, createClient: factory })).toEqual([
      'a',
      'a',
    ]);
  });

  it('quotes a schema-qualified table, and quotes ALWAYS so case survives', async () => {
    const { rec, factory } = readerFactory({ fields: ['a'] });
    await describePostgresDatasetColumns({
      ...READ_BASE,
      datasetConfig: { schema: 'Reporting', table: 'Users' },
      createClient: factory,
    });
    // Postgres folds an UNQUOTED identifier to lower case, so quoting is what
    // makes `Users` address `Users` rather than `users`.
    expect(rec.queries.some((q) => q.includes('"Reporting"."Users"'))).toBe(true);
  });

  it('pins DateStyle before reading, so the timestamp text form is not the server choice', async () => {
    const { rec, factory } = readerFactory({ fields: ['a'] });
    await describePostgresDatasetColumns({ ...READ_BASE, createClient: factory });
    expect(rec.queries[0]).toBe("SET SESSION DateStyle = 'ISO, YMD'");
  });

  it("BINDS a query dataset's named parameters, rewritten to $n (#1194)", async () => {
    // Slice 2 REFUSED this outright, so the same dataset config meant something
    // on sqlite and nothing on postgres. The rewrite itself is
    // `postgres-named-parameters.ts`' subject; what this pins is that the
    // describe seam carries the rewritten text AND its values to the driver.
    const { rec, factory } = readerFactory({ fields: ['a'] });
    expect(
      await describePostgresDatasetColumns({
        ...READ_BASE,
        datasetKind: 'query',
        datasetConfig: { sql: 'select a from t where a = :id', parameters: { id: 1 } },
        createClient: factory,
      }),
    ).toEqual(['a']);
    const describe = rec.queries.findIndex((q) => q.includes('__studio_src'));
    expect(rec.queries[describe]).toContain('where a = $1');
    expect(rec.queries[describe]).not.toContain(':id');
    expect(rec.values[describe]).toEqual([1]);
  });

  it('carries the same values onto the CURSOR, not just the describe', async () => {
    // The two seams are separate `client.query` calls, so binding one and not
    // the other would describe fine and then read the wrong rows — or, since a
    // `$1` with no value is `08P01`, fail at the DECLARE with a driver message.
    const { rec, factory } = readerFactory({ fields: ['a'], fetches: [[{ a: 5 }]] });
    const batches = [];
    for await (const batch of readPostgresDatasetBatches({
      ...READ_BASE,
      datasetKind: 'query',
      datasetConfig: {
        sql: 'select a from t where a > :lo and a < :hi',
        parameters: { hi: 9, lo: 1 },
      },
      createClient: factory,
    })) {
      batches.push(batch);
      break;
    }
    const declare = rec.queries.findIndex((q) => q.startsWith('DECLARE'));
    expect(rec.queries[declare]).toContain('a > $1 and a < $2');
    // FIRST-APPEARANCE order, which is the SQL's order and not the record's.
    expect(rec.values[declare]).toEqual([1, 9]);
  });

  it('refuses a statement that mixes named parameters with its own $n', async () => {
    // The rewriter's one refusal, asserted THROUGH the seam rather than only
    // against the function: it must reach the caller as a `permanent`
    // DatasetIoError and not as a raw throw escaping the failure contract.
    const { rec, factory } = readerFactory({ fields: [] });
    await expect(
      describePostgresDatasetColumns({
        ...READ_BASE,
        datasetKind: 'query',
        datasetConfig: { sql: 'select a from t where a > $1 and b = :id', parameters: { id: 3 } },
        createClient: factory,
      }),
    ).rejects.toMatchObject({ kind: 'permanent', message: expect.stringMatching(/positional/i) });
    // Refused BEFORE a session is opened, so nothing reached the server.
    expect(rec.options).toHaveLength(0);
  });

  it('sends NO values at all when the statement binds none', async () => {
    // `undefined`, never `[]`. MEASURED on pg@8.23.0: a valueless call goes over
    // the SIMPLE query protocol and a valued one over the EXTENDED protocol, and
    // they differ on multi-statement text. Every pre-#1194 read must stay on the
    // protocol the smuggle gate above was measured against.
    const { rec, factory } = readerFactory({ fields: ['a'] });
    await describePostgresDatasetColumns({
      ...READ_BASE,
      datasetKind: 'query',
      datasetConfig: { sql: 'select a from t', parameters: {} },
      createClient: factory,
    });
    expect(rec.values.every((v) => v === undefined)).toBe(true);
  });

  it('refuses a trailing semicolon rather than silently rewriting the operator SQL', async () => {
    const { factory } = readerFactory({ fields: [] });
    await expect(
      describePostgresDatasetColumns({
        ...READ_BASE,
        datasetKind: 'query',
        datasetConfig: { sql: 'select a from t;' },
        createClient: factory,
      }),
    ).rejects.toMatchObject({ kind: 'permanent', message: expect.stringContaining('semicolon') });
  });

  it('classifies an unreachable server as transient, never as drift', async () => {
    // `CopyIo.describeSource`'s stated polarity: a store that cannot be REACHED
    // is transient and is not a schema fact.
    const { factory } = readerFactory({
      failOn: { match: 'SET SESSION', error: pgError('08006', 'terminating connection') },
    });
    await expect(
      describePostgresDatasetColumns({ ...READ_BASE, createClient: factory }),
    ).rejects.toMatchObject({ kind: 'transient' });
  });

  it('classifies an UNRECOGNISED code as permanent — fail-safe, never retry forever', async () => {
    const { factory } = readerFactory({
      failOn: { match: 'LIMIT 0', error: pgError('42P01', 'relation "t" does not exist') },
    });
    await expect(
      describePostgresDatasetColumns({ ...READ_BASE, createClient: factory }),
    ).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('never echoes the password into a failure message', async () => {
    const { factory } = readerFactory({
      failOn: {
        match: 'LIMIT 0',
        error: new Error('connection string was host=x password=hunter2'),
      },
    });
    await expect(
      describePostgresDatasetColumns({ ...READ_BASE, secret: 'hunter2', createClient: factory }),
    ).rejects.toMatchObject({ message: expect.not.stringContaining('hunter2') });
  });

  it('refuses a missing secret before building a client, as the probe does', async () => {
    const { rec, factory } = readerFactory({ fields: [] });
    await expect(
      describePostgresDatasetColumns({ ...READ_BASE, secret: '', createClient: factory }),
    ).rejects.toMatchObject({ kind: 'permanent', message: expect.stringContaining('secret') });
    expect(rec.options).toHaveLength(0);
  });

  it('refuses a dataset kind a postgres store cannot hold', async () => {
    const { factory } = readerFactory({ fields: [] });
    await expect(
      describePostgresDatasetColumns({
        ...READ_BASE,
        datasetKind: 'delimited',
        datasetConfig: { path: 'x.csv' },
        createClient: factory,
      }),
    ).rejects.toMatchObject({ kind: 'permanent' });
  });
});

describe('readPostgresDatasetBatches (#1190 M10)', () => {
  async function drain(iterable: AsyncIterable<readonly Record<string, unknown>[]>) {
    const out: Record<string, unknown>[][] = [];
    for await (const batch of iterable) out.push([...batch]);
    return out;
  }

  it('reads through a READ ONLY transaction and a server-side cursor, then rolls back', async () => {
    const { rec, factory } = readerFactory({ fetches: [[{ a: 1 }, { a: 2 }], []] });
    const batches = await drain(
      readPostgresDatasetBatches({ ...READ_BASE, createClient: factory, batchRows: 2 }),
    );
    expect(batches).toEqual([[{ a: 1 }, { a: 2 }]]);
    expect(rec.queries).toEqual([
      "SET SESSION DateStyle = 'ISO, YMD'",
      'BEGIN READ ONLY',
      'DECLARE "__studio_copy" NO SCROLL CURSOR FOR SELECT * FROM "t"',
      'FETCH FORWARD 2 FROM "__studio_copy"',
      'FETCH FORWARD 2 FROM "__studio_copy"',
      'ROLLBACK',
    ]);
    expect(rec.ended).toBe(1);
  });

  it('stops on a SHORT batch without a further round trip', async () => {
    const { rec, factory } = readerFactory({ fetches: [[{ a: 1 }]] });
    expect(
      await drain(
        readPostgresDatasetBatches({ ...READ_BASE, createClient: factory, batchRows: 5 }),
      ),
    ).toEqual([[{ a: 1 }]]);
    expect(rec.queries.filter((q) => q.startsWith('FETCH'))).toHaveLength(1);
  });

  it('yields nothing for an empty source, and still closes cleanly', async () => {
    const { rec, factory } = readerFactory({ fetches: [[]] });
    expect(
      await drain(readPostgresDatasetBatches({ ...READ_BASE, createClient: factory })),
    ).toEqual([]);
    expect(rec.queries).toContain('ROLLBACK');
    expect(rec.ended).toBe(1);
  });

  it('honours an abort at the batch boundary, and still rolls back and closes', async () => {
    const controller = new AbortController();
    const { rec, factory } = readerFactory({
      fetches: [[{ a: 1 }], [{ a: 2 }]],
    });
    const iterable = readPostgresDatasetBatches({
      ...READ_BASE,
      createClient: factory,
      batchRows: 1,
      signal: controller.signal,
    });
    await expect(
      (async () => {
        for await (const batch of iterable) {
          expect(batch).toHaveLength(1);
          controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(rec.queries).toContain('ROLLBACK');
    expect(rec.ended).toBe(1);
  });

  it('defaults the batch size to the shared COPY_BATCH_ROWS', async () => {
    const { rec, factory } = readerFactory({ fetches: [[]] });
    await drain(readPostgresDatasetBatches({ ...READ_BASE, createClient: factory }));
    expect(rec.queries).toContain(`FETCH FORWARD ${String(COPY_BATCH_ROWS)} FROM "__studio_copy"`);
  });
});

describe('isTransientPostgresCode (#1190 M10)', () => {
  it.each(['57014', '08006', '40001', '53300', 'ECONNRESET'])('retries %s', (code) => {
    expect(isTransientPostgresCode(code)).toBe(true);
  });
  it.each(['42P01', '42601', '28P01', '3D000', '25006', ''])(
    'does NOT retry %s — an unrecognised code is permanent',
    (code) => {
      expect(isTransientPostgresCode(code)).toBe(false);
    },
  );
});

/**
 * A session that answers the ADDRESS seam's two questions.
 *
 * Deliberately not `recordingClient` above: that one scripts a CURSOR read
 * (`FETCH`, `fields`) and its `queries` array is indexed positionally by a dozen
 * existing assertions. Widening it to also script `pg_control_system()` would
 * put the address path's behaviour behind the reader's shape.
 */
function addressClient(
  script: {
    identity?: { sysid: string | null; dboid: string | null; in_recovery?: boolean };
    relation?: string | null;
    failOn?: { match: string; error: unknown };
    failConnect?: unknown;
  } = {},
) {
  const rec = {
    created: 0,
    queries: [] as string[],
    values: [] as (readonly unknown[] | undefined)[],
    ended: 0,
  };
  const factory: PostgresClientFactory = (): PostgresClient => {
    rec.created += 1;
    return {
      connect: async (): Promise<undefined> => {
        if (script.failConnect !== undefined) throw script.failConnect;
        return undefined;
      },
      query: async (sql: string, values?: readonly unknown[]) => {
        rec.queries.push(sql);
        rec.values.push(values);
        if (script.failOn !== undefined && sql.includes(script.failOn.match)) {
          throw script.failOn.error;
        }
        if (sql.includes('pg_control_system')) {
          const id = script.identity ?? { sysid: '76763954965725102', dboid: '16384' };
          return {
            rows: [{ sysid: id.sysid, dboid: id.dboid, in_recovery: id.in_recovery ?? false }],
            fields: [],
          };
        }
        if (sql.includes('to_regclass')) {
          const name = script.relation === undefined ? 'public.t' : script.relation;
          return { rows: name === null ? [] : [{ name }], fields: [] };
        }
        return { rows: [], fields: [] };
      },
      end: async () => {
        rec.ended += 1;
      },
    };
  };
  return { rec, factory };
}

/** The two arguments #1193 added, defaulted so each case states only its own point. */
function addressArgs(
  ds: ResolvedDataset,
  factory: PostgresClientFactory,
  overrides: { connectionConfig?: Record<string, unknown>; secret?: string | null } = {},
) {
  return {
    connectionConfig: overrides.connectionConfig ?? (CONFIG as Record<string, unknown>),
    dataset: ds,
    secret: overrides.secret === undefined ? 'pw' : overrides.secret,
    createClient: factory,
  };
}

describe('resolvePostgresDatasetAddress (#1190 M10, credentialled by #1193)', () => {
  it('records a non-secret store string, the cluster identity and the canonical object', async () => {
    const { rec, factory } = addressClient();
    const address = await resolvePostgresDatasetAddress(
      addressArgs(dataset('table', { schema: 'public', table: 't' }), factory),
    );
    expect(address).toEqual({
      kind: 'postgres',
      store: 'db.example.test:6543/app',
      // #1193 — was `null`. `<system_identifier>:<database oid>:<primary|standby>`, the
      // analogue of sqlite's `dev:ino`, which is what makes two spellings of one
      // host compare EQUAL and so lets the self-copy gate fire at all.
      storeIdentity: '76763954965725102:16384:primary',
      object: 'public.t',
    });
    expect(rec.ended).toBe(1);
  });

  it('separates a physical standby from its primary, which share a system_identifier', async () => {
    // A standby's control file is a byte copy of its primary's, so without the
    // recovery part `standby -> primary` — an ordinary ETL shape — would resolve
    // to one address and be refused as a self-copy.
    const primary = addressClient({ identity: { sysid: '1', dboid: '2', in_recovery: false } });
    const standby = addressClient({ identity: { sysid: '1', dboid: '2', in_recovery: true } });
    const ds = dataset('table', { schema: 'public', table: 't' });
    const a = await resolvePostgresDatasetAddress(addressArgs(ds, primary.factory));
    const b = await resolvePostgresDatasetAddress(addressArgs(ds, standby.factory));
    expect(a.storeIdentity).not.toBe(b.storeIdentity);
  });

  it('separates two databases in ONE cluster, which share a system_identifier', async () => {
    const one = addressClient({ identity: { sysid: '1', dboid: '16384' } });
    const two = addressClient({ identity: { sysid: '1', dboid: '16385' } });
    const ds = dataset('table', { schema: 'public', table: 't' });
    const a = await resolvePostgresDatasetAddress(addressArgs(ds, one.factory));
    const b = await resolvePostgresDatasetAddress(addressArgs(ds, two.factory));
    expect(a.storeIdentity).not.toBe(b.storeIdentity);
  });

  it('never puts the password in the address, which travels to the run log', async () => {
    const { factory } = addressClient();
    const address = await resolvePostgresDatasetAddress(
      addressArgs(dataset('table', { schema: 'public', table: 't' }), factory, {
        secret: 'hunter2',
      }),
    );
    expect(JSON.stringify(address)).not.toContain('hunter2');
  });

  it('asks to_regclass about the QUOTED name, so postgres case-sensitivity survives', async () => {
    // Measured on postgres:17 — `to_regclass('People')` folds to `people` while
    // `to_regclass('"People"')` finds `People`, a DIFFERENT relation. Handing
    // over the raw spelling would report two distinct tables as one address.
    const { rec, factory } = addressClient({ relation: 'Reporting.Users' });
    const address = await resolvePostgresDatasetAddress(
      addressArgs(dataset('table', { schema: 'Reporting', table: 'Users' }), factory),
    );
    expect(rec.values[rec.queries.findIndex((q) => q.includes('to_regclass'))]).toEqual([
      '"Reporting"."Users"',
    ]);
    expect(address.object).toBe('Reporting.Users');
  });

  it('resolves an UNQUALIFIED table through the session search_path', async () => {
    // The whole reason the seam needed a session: `schema` is optional, so a
    // bare `t` is the DEFAULT spelling, and only postgres can say which schema
    // it lands in. Before #1193 this recorded `null` and the gate stayed silent.
    const { rec, factory } = addressClient({ relation: 'reporting.t' });
    const address = await resolvePostgresDatasetAddress(
      addressArgs(dataset('table', { table: 't' }), factory),
    );
    expect(rec.values[rec.queries.findIndex((q) => q.includes('to_regclass'))]).toEqual(['"t"']);
    expect(address.object).toBe('reporting.t');
  });

  it('leaves the object null when the relation does not exist', async () => {
    const { factory } = addressClient({ relation: null });
    const address = await resolvePostgresDatasetAddress(
      addressArgs(dataset('table', { schema: 'public', table: 'gone' }), factory),
    );
    expect(address.object).toBeNull();
  });

  it('leaves the object null for a query, but still records the identity', async () => {
    // #1196 settled the query self-copy residual deliberately — deciding it means
    // parsing the operator's SQL. §2.1's dispatch record still wants the store.
    const { rec, factory } = addressClient();
    const address = await resolvePostgresDatasetAddress(
      addressArgs(dataset('query', { sql: 'select 1' }), factory),
    );
    expect(address.object).toBeNull();
    expect(address.storeIdentity).toBe('76763954965725102:16384:primary');
    expect(rec.queries.some((q) => q.includes('to_regclass'))).toBe(false);
  });

  it('degrades to a null identity when pg_control_system is REVOKED, rather than refusing', async () => {
    // The finding this whole asymmetry exists for. `pg_control_system()`'s
    // execute privilege is a revocable ACL (public on a vanilla 17, measured),
    // and `42501` is not transient — propagating would classify `permanent` and
    // refuse EVERY copy against such a server, forever, though the role can
    // SELECT and INSERT perfectly well. sqlite's opposite choice does not carry:
    // there, every way `stat` fails leaves the copy unable to proceed anyway.
    const { rec, factory } = addressClient({
      failOn: {
        match: 'pg_control_system',
        error: Object.assign(new Error('permission denied for function pg_control_system'), {
          code: '42501',
        }),
      },
    });
    const address = await resolvePostgresDatasetAddress(
      addressArgs(dataset('table', { schema: 'public', table: 't' }), factory),
    );
    expect(address.storeIdentity).toBeNull();
    expect(address.object).toBe('public.t');
    expect(rec.ended).toBe(1);
  });

  it('degrades to a null object when to_regclass RAISES, rather than refusing', async () => {
    // Measured — a role without `USAGE` on a named schema gets `42501` from
    // `to_regclass` rather than a NULL. Same direction: a null object can only
    // widen what the gate lets through, never narrow it.
    const { rec, factory } = addressClient({
      failOn: {
        match: 'to_regclass',
        error: Object.assign(new Error('permission denied for schema rv1'), { code: '42501' }),
      },
    });
    const address = await resolvePostgresDatasetAddress(
      addressArgs(dataset('table', { schema: 'rv1', table: 't' }), factory),
    );
    expect(address.object).toBeNull();
    expect(address.storeIdentity).toBe('76763954965725102:16384:primary');
    expect(rec.ended).toBe(1);
  });

  it('records a null identity when the identity row comes back empty rather than inventing one', async () => {
    const { factory } = addressClient({ identity: { sysid: null, dboid: null } });
    const address = await resolvePostgresDatasetAddress(
      addressArgs(dataset('table', { schema: 'public', table: 't' }), factory),
    );
    expect(address.storeIdentity).toBeNull();
  });

  it('PROPAGATES a connect failure, which dooms the copy either way', async () => {
    const { factory } = addressClient({
      failConnect: Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
    });
    await expect(
      resolvePostgresDatasetAddress(
        addressArgs(dataset('table', { schema: 'public', table: 't' }), factory),
      ),
    ).rejects.toThrow(
      expect.objectContaining({
        kind: 'transient',
        message: expect.stringContaining('cannot reach the postgres server'),
      }) as unknown as Error,
    );
  });

  it('refuses a connection with no secret rather than letting pg read PGPASSWORD', async () => {
    const { factory } = addressClient();
    await expect(
      resolvePostgresDatasetAddress(
        addressArgs(dataset('table', { schema: 'public', table: 't' }), factory, { secret: null }),
      ),
    ).rejects.toThrow(expect.objectContaining({ kind: 'permanent' }) as unknown as Error);
  });

  it('defaults the port in the store string when the config omits it', async () => {
    const noPort: Record<string, unknown> = { ...CONFIG };
    delete noPort.port;
    const { factory } = addressClient();
    const address = await resolvePostgresDatasetAddress(
      addressArgs(dataset('query', { sql: 'select 1' }), factory, { connectionConfig: noPort }),
    );
    expect(address.store).toBe(`db.example.test:${String(DEFAULT_POSTGRES_PORT)}/app`);
  });

  it('classifies a malformed table config as permanent WITHOUT spending a session', async () => {
    // The address seam is reached with operator-authored config like every other
    // seam in this module, so it owes the same failure contract: a config that
    // does not validate is a `permanent` `DatasetIoError` carrying the issues,
    // never a `ZodError` escaping unclassified. #1193 adds the second half —
    // config is parsed BEFORE the connect, so a typo costs no connection.
    const { rec, factory } = addressClient();
    await expect(
      resolvePostgresDatasetAddress(addressArgs(dataset('table', { schema: 'public' }), factory)),
    ).rejects.toThrow(
      expect.objectContaining({
        kind: 'permanent',
        message: expect.stringContaining('invalid table dataset config'),
      }) as unknown as Error,
    );
    expect(rec.created).toBe(0);
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
// #1196 — the predicate MOVED to `live-postgres.ts` when the sink suite became
// its second consumer: importing it from this file re-registered every suite
// here inside the importer, and one timing-sensitive case then failed there
// while passing in isolation. Its tests stay put; only its home changed.
describe('liveSuiteMustRun (#1190 M10)', () => {
  it('lets a developer machine skip', () => {
    expect(liveSuiteMustRun({})).toBe(false);
  });
  it('REQUIRES the live half under CI, so a missing service container is red', () => {
    expect(liveSuiteMustRun({ CI: 'true' })).toBe(true);
  });
  it('treats an explicit CI=false as not-CI', () => {
    expect(liveSuiteMustRun({ CI: 'false' })).toBe(false);
    expect(liveSuiteMustRun({ CI: '' })).toBe(false);
  });
});

const LIVE_HOST = process.env.STUDIO_TEST_POSTGRES_HOST;

describe('the live postgres service (#1190 M10)', () => {
  it('is present whenever CI claims to provide one', () => {
    // The guard itself. Under CI this FAILS if `.github/workflows/studio-ci.yml`
    // has no postgres service (or stops setting the variables), which is the
    // only thing standing between "the live half ran" and "the live half was
    // silently absent".
    if (!liveSuiteMustRun(process.env)) return;
    expect(
      LIVE_HOST,
      'CI must provide a postgres service container and set STUDIO_TEST_POSTGRES_HOST — see .github/workflows/studio-ci.yml',
    ).toBeDefined();
  });
});

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

  /** The real driver, through the same seam the adapter uses. */
  const realClientFactory: PostgresClientFactory = (options) =>
    new pg.Client(options) as unknown as PostgresClient;

  /** A direct session for fixture DDL — deliberately NOT the module under test. */
  async function withAdminClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({
      host: live.host,
      port: live.port,
      database: live.database,
      user: live.user,
      password,
      ssl: false as const,
    });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function tableExists(table: string): Promise<boolean> {
    return withAdminClient(async (c) => {
      const r = await c.query('select to_regclass($1) as reg', [`public.${table}`]);
      return r.rows[0].reg !== null;
    });
  }

  /**
   * A fixture table, dropped afterwards. Named per test run so two tests cannot
   * collide, and created through an ADMIN session so a failure here is never
   * mistaken for a failure of the reader.
   */
  let fixtureSeq = 0;
  async function withLiveTable(fn: (table: string) => Promise<void>): Promise<void> {
    fixtureSeq += 1;
    const table = `studio_m10_fixture_${String(fixtureSeq)}`;
    await withAdminClient(async (c) => {
      await c.query(`drop table if exists "${table}"`);
      await c.query(
        `create table "${table}" (id int4 primary key, label text, big int8, ts timestamp, day date)`,
      );
      await c.query(
        `insert into "${table}" values
           (1,'a',9223372036854775807,'2026-07-15 13:45:00','2026-07-15'),
           (2,'b',2,'2026-07-15 13:45:00','2026-07-15'),
           (3,'c',3,'2026-07-15 13:45:00','2026-07-15')`,
      );
    });
    try {
      await fn(table);
    } finally {
      await withAdminClient(async (c) => {
        await c.query(`drop table if exists "${table}"`);
      });
    }
  }

  // -------------------------------------------------------------------------
  // #1190 M10 slice 2 — the READER, against a real server. These assert the
  // things a fake cannot: that `pg` and postgres behave as measured.
  // -------------------------------------------------------------------------

  async function drainLive(iterable: AsyncIterable<readonly Record<string, unknown>[]>) {
    const rows: Record<string, unknown>[] = [];
    for await (const batch of iterable) rows.push(...batch);
    return rows;
  }

  /** A read bound to the live server, through the real driver. */
  const realRead = (datasetKind: DatasetKind, datasetConfig: Record<string, unknown>) => ({
    connectionConfig: live,
    secret: password,
    datasetKind,
    datasetConfig,
    createClient: realClientFactory,
  });

  it('describes a real table without reading a row', async () => {
    await withLiveTable(async (table) => {
      expect(await describePostgresDatasetColumns(realRead('table', { table }))).toEqual([
        'id',
        'label',
        'big',
        'ts',
        'day',
      ]);
    });
  });

  it('reads a real table in bounded batches', async () => {
    await withLiveTable(async (table) => {
      const rows = await drainLive(
        readPostgresDatasetBatches({ ...realRead('table', { table }), batchRows: 2 }),
      );
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.label)).toEqual(['a', 'b', 'c']);
    });
  });

  it('carries an int8 boundary value EXACTLY, as text pg can round-trip', async () => {
    // Measured: pg returns `int8` and `numeric` as JS strings, and
    // `coerce.ts` routes a string integer through `BigInt(text)`, which is
    // exact. A `number` here would silently corrupt at 2^53.
    await withLiveTable(async (table) => {
      const rows = await drainLive(readPostgresDatasetBatches(realRead('table', { table })));
      expect(rows[0]?.big).toBe('9223372036854775807');
    });
  });

  it('reads a naive timestamp and date TZ-INVARIANTLY', async () => {
    // The corruption pin, end to end: pg's own parser would make these a
    // function of the server process's TZ.
    await withLiveTable(async (table) => {
      const rows = await drainLive(readPostgresDatasetBatches(realRead('table', { table })));
      expect((rows[0]?.ts as Date).toISOString()).toBe('2026-07-15T13:45:00.000Z');
      expect((rows[0]?.day as Date).toISOString()).toBe('2026-07-15T00:00:00.000Z');
    });
  });

  it('REFUSES a smuggled statement at describe, before any cursor exists', async () => {
    // Measured: the subquery wrap turns `select 1; drop table x` into a syntax
    // error, and `copy.ts` calls describeSource first.
    await withLiveTable(async (table) => {
      await expect(
        describePostgresDatasetColumns(
          realRead('query', { sql: `select 1 as a; drop table "${table}"` }),
        ),
      ).rejects.toMatchObject({ kind: 'permanent' });
    });
  });

  it('cannot WRITE through a smuggled statement — the read-only transaction refuses it', async () => {
    // The security pin. MEASURED: `DECLARE ... CURSOR FOR select 1; drop table
    // victim` raises NO error on its own — the `;` terminates the DECLARE and
    // the second statement EXECUTES. Under `BEGIN READ ONLY` it fails with
    // SQLSTATE 25006. The table surviving is what proves the defence.
    await withLiveTable(async (table) => {
      await expect(
        drainLive(
          readPostgresDatasetBatches(
            realRead('query', { sql: `select 1 as a; drop table "${table}"` }),
          ),
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining('read-only transaction') });
      expect(await tableExists(table)).toBe(true);
    });
  });

  it('describes a query source by its projected names', async () => {
    await withLiveTable(async (table) => {
      expect(
        await describePostgresDatasetColumns(
          realRead('query', { sql: `select label as name from "${table}" order by id` }),
        ),
      ).toEqual(['name']);
    });
  });

  it('connects and answers', async () => {
    expect(await postgresAdapter.testConnection(live, password)).toEqual({ ok: true, probed: 'liveness' });
  });

  it('reports a wrong password as a refused password', async () => {
    const result = await postgresAdapter.testConnection(live, `${password}-wrong`);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed probe');
    expect(result.error).toMatch(/refused the password/);
  });

  it('reports an unknown database as one', async () => {
    const result = await postgresAdapter.testConnection(
      { ...live, database: 'no_such_database_1189' },
      password,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed probe');
    expect(result.error).toMatch(/no database of that name/);
  });

  it('reports a closed port as one, within the connect budget', async () => {
    const started = Date.now();
    const result = await postgresAdapter.testConnection(
      { ...live, port: 1, connectTimeoutMs: 3_000 },
      password,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed probe');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does NOT fall back to PGPASSWORD when the connection has no secret', async () => {
    // The measured hazard, proven end to end against a real server: with the
    // correct password in the environment, an unbound connection must still be
    // refused. If the guard were removed this would CONNECT.
    process.env.PGPASSWORD = password;
    const result = await postgresAdapter.testConnection(live, '');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed probe');
    expect(result.error).toMatch(/no secret/);
  });

  it('does NOT fall back to PGHOST for a config that names its host', async () => {
    process.env.PGHOST = '127.0.0.1';
    process.env.PGPORT = String(live.port);
    const result = await postgresAdapter.testConnection(
      { ...live, host: 'no-such-host-1189.invalid', connectTimeoutMs: 3_000 },
      password,
    );
    // THE CLAIM IS `ok: false` — a real server is listening on the PGHOST/PGPORT
    // this test exports, so a fallback would have CONNECTED and reported success.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed probe');
    // The refusal's WORDING is not the claim, and pinning it to `/does not
    // resolve/` alone made this test environment-dependent: the bogus host has
    // to lose a race between DNS failing and the 3s connect budget expiring, and
    // under full-suite contention the timeout wins (measured — it passes in
    // isolation and fails inside a loaded run, #1124's family). #1196 widened
    // it, because slice 3a's live tests make the live half heavier and would
    // otherwise have made a latent flake a frequent one. Both outcomes prove the
    // same thing: the connection went to the host the CONFIG named, not the one
    // the environment did.
    expect(result.error).toMatch(/does not resolve|timeout expired/);
  });

  // -------------------------------------------------------------------------
  // #1194 — NAMED PARAMETERS, bound for real. The fake proves the rewritten text
  // and its values reach the driver; only a live server proves postgres accepts
  // them through BOTH the describe wrap and the cursor, and returns the rows the
  // operator asked for rather than all of them.
  // -------------------------------------------------------------------------

  it('describes and READS a query dataset that binds named parameters', async () => {
    await withLiveTable(async (table) => {
      const config = {
        sql: `select id, label from "${table}" where id > :lo and id < :hi order by id`,
        parameters: { hi: 3, lo: 1 },
      };
      expect(await describePostgresDatasetColumns(realRead('query', config))).toEqual([
        'id',
        'label',
      ]);
      // The FILTERED row, not the fixture's three. A rewrite that dropped the
      // predicate would still describe cleanly and read every row — which is why
      // the count is the assertion and the column list is not enough.
      expect(await drainLive(readPostgresDatasetBatches(realRead('query', config)))).toEqual([
        { id: 2, label: 'b' },
      ]);
    });
  });

  it('binds a null and a string value, and reuses one name twice', async () => {
    await withLiveTable(async (table) => {
      const config = {
        sql:
          `select id from "${table}" ` +
          `where (:missing::text is null) and label = :want and label <= :want order by id`,
        parameters: { missing: null, want: 'c' },
      };
      expect(await drainLive(readPostgresDatasetBatches(realRead('query', config)))).toEqual([
        { id: 3 },
      ]);
    });
  });

  it('does not touch a colon inside a literal, measured against the server', async () => {
    await withLiveTable(async (table) => {
      // The scanner's central claim, asserted where it can actually be wrong: if
      // `:id` inside the literal were rewritten, this would bind two values to
      // one placeholder (`08P01`) or return `$1` as the text.
      const config = {
        sql: `select ':id' as tag, id from "${table}" where id = :id`,
        parameters: { id: 2 },
      };
      expect(await drainLive(readPostgresDatasetBatches(realRead('query', config)))).toEqual([
        { tag: ':id', id: 2 },
      ]);
    });
  });

  it('reads the SAME rows as sqlite from ONE dataset config — the point of #1194', async () => {
    // The portability claim, asserted rather than assumed. One `query` dataset
    // config, two stores, two parameter styles underneath, one answer.
    await withLiveTable(async (table) => {
      const dir = mkdtempSync(join(tmpdir(), 'studio-1194-'));
      const file = join(dir, 'parity.db');
      try {
        const db = new Database(file);
        db.exec('create table parity (id integer primary key, label text)');
        db.exec("insert into parity values (1,'a'),(2,'b'),(3,'c')");
        db.close();

        const where = 'where id > :lo and id < :hi order by id';
        const parameters = { hi: 3, lo: 1 };
        const fromPostgres = await drainLive(
          readPostgresDatasetBatches(
            realRead('query', { sql: `select id, label from "${table}" ${where}`, parameters }),
          ),
        );
        const fromSqlite: Record<string, unknown>[] = [];
        for await (const batch of readSqliteDatasetBatches({
          connectionConfig: { roots: [dir], path: file },
          datasetKind: 'query',
          datasetConfig: { sql: `select id, label from parity ${where}`, parameters },
        })) {
          fromSqlite.push(...batch);
        }
        expect(fromPostgres).toEqual([{ id: 2, label: 'b' }]);
        expect(fromSqlite).toEqual(fromPostgres);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
  /**
   * #1193 — THE HOLE, closed against a real server.
   *
   * Everything above this point is a fake answering scripted rows. What only a
   * live cluster can prove is that `pg_control_system()` and `to_regclass` say
   * what the fix assumes they say, and that two SPELLINGS of one host really do
   * land on one `system_identifier`.
   */
  describe('the physical address a live cluster reports (#1193)', () => {
    const address = (host: string, config: Record<string, unknown>, kind: DatasetKind = 'table') =>
      resolvePostgresDatasetAddress({
        connectionConfig: { ...live, host },
        dataset: dataset(kind, config),
        secret: password,
        createClient: realClientFactory,
      });

    it('gives two HOST SPELLINGS of one cluster the SAME identity — the self-copy hole', async () => {
      // The whole ticket in one assertion. `store` differs because it is built
      // from the operator's spelling; `storeIdentity` does not, because the
      // cluster answers for itself. Before #1193 the identity was `null` on both
      // ends, so `sameDatasetAddress` fell back to `store`, the two disagreed,
      // and a copy reading and overwriting ONE table was not refused.
      //
      // Both spellings must reach the same server. They do in CI (a service
      // container's port is mapped onto the runner's loopback) and locally; an
      // environment where they do not should go RED here rather than skip.
      await withLiveTable(async (table) => {
        const a = await address('127.0.0.1', { schema: 'public', table });
        const b = await address('localhost', { schema: 'public', table });
        expect(a.store).not.toBe(b.store);
        expect(a.storeIdentity).not.toBeNull();
        expect(a.storeIdentity).toBe(b.storeIdentity);
        expect(sameDatasetAddress(a, b)).toBe(true);
      });
    });

    it('reports a PRIMARY, and an identity shaped sysid:dboid:primary|standby', async () => {
      await withLiveTable(async (table) => {
        const a = await address(live.host, { schema: 'public', table });
        expect(a.storeIdentity).toMatch(/^\d+:\d+:primary$/);
      });
    });

    it('resolves an UNQUALIFIED table through search_path to its canonical name', async () => {
      // The default spelling — `schema` is optional. This recorded `null` before
      // #1193, which is why closing `storeIdentity` alone would have left the
      // gate silent for the majority of datasets.
      await withLiveTable(async (table) => {
        const a = await address(live.host, { table });
        expect(a.object).toBe(`public.${table}`);
        const qualified = await address(live.host, { schema: 'public', table });
        expect(sameDatasetAddress(a, qualified)).toBe(true);
      });
    });

    it('keeps a QUOTED mixed-case relation distinct from its folded twin', async () => {
      // Measured: `to_regclass('People')` folds to `people`; `to_regclass('"People"')`
      // finds `People`. Reporting them as one address would call two distinct
      // tables a self-copy.
      const upper = `Studio_M10_Mixed_${String(Date.now() % 100000)}`;
      const lower = upper.toLowerCase();
      await withAdminClient(async (c) => {
        await c.query(`create table "${upper}" (id int4)`);
        await c.query(`create table "${lower}" (id int4)`);
      });
      try {
        const a = await address(live.host, { schema: 'public', table: upper });
        const b = await address(live.host, { schema: 'public', table: lower });
        expect(a.object).toBe(`public.${upper}`);
        expect(b.object).toBe(`public.${lower}`);
        expect(sameDatasetAddress(a, b)).toBe(false);
      } finally {
        await withAdminClient(async (c) => {
          await c.query(`drop table if exists "${upper}"`);
          await c.query(`drop table if exists "${lower}"`);
        });
      }
    });

    it('records a null object for a relation that does not exist, never a refusal', async () => {
      const a = await address(live.host, { schema: 'public', table: 'studio_m10_no_such_table' });
      expect(a.object).toBeNull();
      expect(a.storeIdentity).not.toBeNull();
    });

    it('still records the identity for a QUERY dataset, which names no one relation', async () => {
      const a = await address(live.host, { sql: 'select 1' }, 'query');
      expect(a.object).toBeNull();
      expect(a.storeIdentity).toMatch(/^\d+:\d+:primary$/);
    });
  });
});
