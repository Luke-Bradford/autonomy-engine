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
import type { DatasetKind } from '@autonomy-studio/shared';
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
    expect(await createPostgresAdapter(factory).testConnection(CONFIG, 'pw')).toEqual({ ok: true });
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
  const rec = { queries: [] as string[], ended: 0, options: [] as PostgresClientOptions[] };
  let fetchIndex = 0;
  const factory: PostgresClientFactory = (options) => {
    rec.options.push(options);
    return {
      connect: async () => undefined,
      query: async (sql: string) => {
        rec.queries.push(sql);
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

  it('refuses a query dataset that declares named parameters', async () => {
    // Measured: `where a = :id` reaches postgres as SQLSTATE 42601, a syntax
    // error naming a colon. pg binds positionally and has no named parameters.
    const { factory } = readerFactory({ fields: [] });
    await expect(
      describePostgresDatasetColumns({
        ...READ_BASE,
        datasetKind: 'query',
        datasetConfig: { sql: 'select a from t where a = :id', parameters: { id: 1 } },
        createClient: factory,
      }),
    ).rejects.toMatchObject({ kind: 'permanent', message: expect.stringContaining('parameters') });
  });

  it('accepts a query dataset whose parameters are absent or empty', async () => {
    // The refusal above must not be over-broad: an empty record is not a
    // declaration.
    const { factory } = readerFactory({ fields: ['a'] });
    expect(
      await describePostgresDatasetColumns({
        ...READ_BASE,
        datasetKind: 'query',
        datasetConfig: { sql: 'select a from t', parameters: {} },
        createClient: factory,
      }),
    ).toEqual(['a']);
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

describe('resolvePostgresDatasetAddress (#1190 M10)', () => {
  it('records a non-secret store string', async () => {
    const address = await resolvePostgresDatasetAddress({
      connectionConfig: CONFIG,
      dataset: dataset('table', { schema: 'public', table: 't' }),
    });
    expect(address).toEqual({
      kind: 'postgres',
      store: 'db.example.test:6543/app',
      storeIdentity: null,
      object: 'public.t',
    });
  });

  it('never puts the password in the address, which travels to the run log', async () => {
    const address = await resolvePostgresDatasetAddress({
      connectionConfig: CONFIG,
      dataset: dataset('table', { schema: 'public', table: 't' }),
    });
    expect(JSON.stringify(address)).not.toContain('pw');
  });

  it('does NOT case-fold the object, because postgres quoting is case-sensitive', async () => {
    const address = await resolvePostgresDatasetAddress({
      connectionConfig: CONFIG,
      dataset: dataset('table', { schema: 'Reporting', table: 'Users' }),
    });
    expect(address.object).toBe('Reporting.Users');
  });

  it('leaves the object null when the schema is not declared', async () => {
    // Resolving an unqualified name needs `search_path`, which needs a session
    // this seam cannot open — it receives no secret.
    const address = await resolvePostgresDatasetAddress({
      connectionConfig: CONFIG,
      dataset: dataset('table', { table: 't' }),
    });
    expect(address.object).toBeNull();
  });

  it('leaves the object null for a query, which names no single relation', async () => {
    const address = await resolvePostgresDatasetAddress({
      connectionConfig: CONFIG,
      dataset: dataset('query', { sql: 'select 1' }),
    });
    expect(address.object).toBeNull();
  });

  it('defaults the port in the store string when the config omits it', async () => {
    const noPort: Record<string, unknown> = { ...CONFIG };
    delete noPort.port;
    const address = await resolvePostgresDatasetAddress({
      connectionConfig: noPort,
      dataset: dataset('query', { sql: 'select 1' }),
    });
    expect(address.store).toBe(`db.example.test:${String(DEFAULT_POSTGRES_PORT)}/app`);
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
/**
 * #1190 — WHETHER THE LIVE HALF IS ALLOWED TO SKIP, as a named predicate.
 *
 * It is a function rather than an inline `describe.skipIf` condition because a
 * suite cannot assert its own skipping: "these tests go red when the service is
 * missing" is not writable as a test of the expression that decides it. Extracted,
 * it is ordinary code with ordinary tests.
 *
 * THE RULE: skipping is a DEVELOPER convenience and never a CI outcome. Slice 2
 * moves real data, so CI stands up a `postgres:17` service container; if that
 * container is missing the live half must go RED, because a suite CI quietly
 * stops running certifies nothing while reading as coverage.
 *
 * Keyed on `CI`, which was MEASURED rather than assumed: vitest does NOT set it
 * (`process.env.CI` is `undefined` under a local `vitest run`) — it passes the
 * ambient value through, and GitHub Actions exports `CI=true` for every job.
 */
export function liveSuiteMustRun(env: Record<string, string | undefined>): boolean {
  return env.CI !== undefined && env.CI !== '' && env.CI !== 'false';
}

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
