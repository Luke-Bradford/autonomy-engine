import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_PORT,
  planPostgresIncremental,
  type PostgresClient,
  type PostgresClientFactory,
} from '../postgres.js';
import type { IncrementalRead } from '../source-io.js';

/**
 * #1600 OR41 C5a — a Copy's Load Incremental against a REAL postgres: the new
 * watermark is the server's own text, bound back untyped so postgres reads it in
 * the column's type. Skipped unless `STUDIO_TEST_POSTGRES_HOST` names a server,
 * as the C6f-3 partition suite is.
 */
const LIVE_HOST = process.env.STUDIO_TEST_POSTGRES_HOST;

describe.skipIf(LIVE_HOST === undefined)('Load Incremental against a live postgres', () => {
  const live = {
    host: LIVE_HOST ?? '',
    port: Number(process.env.STUDIO_TEST_POSTGRES_PORT ?? DEFAULT_POSTGRES_PORT),
    database: process.env.STUDIO_TEST_POSTGRES_DATABASE ?? 'postgres',
    user: process.env.STUDIO_TEST_POSTGRES_USER ?? 'postgres',
    sslmode: 'disable' as const,
    connectTimeoutMs: 5_000,
  };
  const password = process.env.STUDIO_TEST_POSTGRES_PASSWORD ?? '';
  const realClientFactory: PostgresClientFactory = (options) =>
    new pg.Client(options) as unknown as PostgresClient;

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ ...live, password, ssl: false });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  const TABLES = 'c5a_events, c5a_ids, c5a_money, c5a_empty';
  beforeAll(async () => {
    await admin(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLES}`);
      await c.query('CREATE TABLE c5a_events (name text, at timestamptz, local_at timestamp)');
      // Microseconds the watermark must keep, and one NULL.
      await c.query(`INSERT INTO c5a_events VALUES
        ('a', '2026-10-01 10:00:00.000001+00', '2026-10-01 10:00:00.000001'),
        ('b', '2026-10-01 10:00:00.000002+00', '2026-10-01 10:00:00.000002'),
        ('n', NULL, NULL)`);
      await c.query('CREATE TABLE c5a_ids (id bigint, name text)');
      await c.query(`INSERT INTO c5a_ids SELECT g, 'r' || g FROM generate_series(1, 5) g`);
      await c.query('CREATE TABLE c5a_money (m money)');
      await c.query('CREATE TABLE c5a_empty (id integer)');
    });
  });
  afterAll(async () => {
    await admin((c) => c.query(`DROP TABLE IF EXISTS ${TABLES}`));
  });

  const read = (datasetKind: 'table' | 'query', datasetConfig: Record<string, unknown>) => ({
    connectionConfig: live,
    secret: password,
    datasetKind,
    datasetConfig,
    createClient: realClientFactory,
    batchRows: 2,
  });
  async function planned(
    kind: 'table' | 'query',
    config: Record<string, unknown>,
    watermark: IncrementalRead,
  ) {
    const plan = await planPostgresIncremental(read(kind, config), watermark);
    const names: string[] = [];
    for await (const batch of plan.batches) {
      for (const row of batch) names.push(String(row['name']));
    }
    return { next: plan.next, names: names.sort() };
  }

  it('keeps a timestamptz watermark to the microsecond: the next run reads nothing', async () => {
    const first = await planned('table', { table: 'c5a_events' }, { column: 'at', old: null });
    expect(first.names).toEqual(['a', 'b']);
    expect(first.next).toBe('2026-10-01 10:00:00.000002+00');
    const second = await planned('table', { table: 'c5a_events' }, { column: 'at', old: first.next });
    expect(second).toEqual({ next: first.next, names: [] });
    const fromA = await planned(
      'table',
      { table: 'c5a_events' },
      { column: 'at', old: '2026-10-01 10:00:00.000001+00' },
    );
    expect(fromA.names).toEqual(['b']);
  });

  it('reads a timestamp without time zone the same way', async () => {
    const got = await planned('table', { table: 'c5a_events' }, { column: 'local_at', old: null });
    expect(got).toEqual({ next: '2026-10-01 10:00:00.000002', names: ['a', 'b'] });
  });

  it('gives an integer watermark as a number, and binds a numeric old one', async () => {
    const got = await planned('table', { table: 'c5a_ids' }, { column: 'id', old: 3 });
    expect(got).toEqual({ next: 5, names: ['r4', 'r5'] });
  });

  it('wraps a query: its own :names bind first, the bounds after them', async () => {
    const got = await planned(
      'query',
      { sql: 'SELECT id, name FROM c5a_ids WHERE id <> :skip -- not 4', parameters: { skip: 4 } },
      { column: 'id', old: '2' },
    );
    expect(got).toEqual({ next: 5, names: ['r3', 'r5'] });
  });

  it('reads nothing from an empty table and keeps the old watermark', async () => {
    expect(await planned('table', { table: 'c5a_empty' }, { column: 'id', old: 7 })).toEqual({
      next: 7,
      names: [],
    });
  });

  it('refuses a column type whose text it cannot compare (money), and a missing column', async () => {
    await expect(
      planPostgresIncremental(read('table', { table: 'c5a_money' }), { column: 'm', old: null }),
    ).rejects.toMatchObject({ kind: 'permanent', message: expect.stringMatching(/is money/) });
    await expect(
      planPostgresIncremental(read('table', { table: 'c5a_ids' }), { column: 'nope', old: null }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/watermark column 'nope'/) });
  });
});
