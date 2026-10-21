import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_PORT,
  PARTITION_NEEDS_TABLE,
  planPostgresPartitions,
  type PostgresClient,
  type PostgresClientFactory,
} from '../postgres.js';
import type { PartitionedRead } from '../source-io.js';

/**
 * #1600 OR41 C6f-3 — Dynamic range against a live postgres. Opt-in through
 * `STUDIO_TEST_POSTGRES_HOST` like `postgres.test.ts`'s live half, whose
 * `liveSuiteMustRun` gate makes a missing service container red under CI, so
 * this file cannot quietly skip there either.
 */
const LIVE_HOST = process.env.STUDIO_TEST_POSTGRES_HOST;

describe.skipIf(LIVE_HOST === undefined)('Dynamic range against a live postgres', () => {
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

  const TABLE = 'c6f3_orders';
  beforeAll(async () => {
    await admin(async (c) => {
      await c.query(`DROP TABLE IF EXISTS ${TABLE}, c6f3_empty, c6f3_small, c6f3_quoted`);
      await c.query(`CREATE TABLE ${TABLE} (id bigint, name text)`);
      // 1..100, three NULL ids, and two ids outside the bounds the tests author.
      await c.query(
        `INSERT INTO ${TABLE} SELECT g, 'r' || g FROM generate_series(1, 100) g
         UNION ALL SELECT NULL, 'null' || g FROM generate_series(1, 3) g
         UNION ALL VALUES (-50, 'low'), (500, 'high')`,
      );
      await c.query('CREATE TABLE c6f3_empty (id integer)');
      await c.query('CREATE TABLE c6f3_small (id smallint, name text)');
      await c.query(`INSERT INTO c6f3_small VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
      await c.query('CREATE TABLE c6f3_quoted ("OrderId" integer, name text)');
      await c.query(`INSERT INTO c6f3_quoted SELECT g, 'q' || g FROM generate_series(1, 9) g`);
    });
  });
  afterAll(async () => {
    await admin((c) =>
      c.query(`DROP TABLE IF EXISTS ${TABLE}, c6f3_empty, c6f3_small, c6f3_quoted`),
    );
  });

  const read = (table: string, over: Record<string, unknown> = {}) => ({
    connectionConfig: live,
    secret: password,
    datasetKind: 'table' as const,
    datasetConfig: { table },
    createClient: realClientFactory,
    batchRows: 7,
    ...over,
  });
  async function namesOf(
    table: string,
    partition: PartitionedRead,
    over: Record<string, unknown> = {},
  ): Promise<{ partitions: number; names: string[] }> {
    const plan = await planPostgresPartitions(read(table, over), partition);
    const names: string[] = [];
    try {
      for await (const batch of plan.batches) {
        for (const row of batch) names.push(String(row['name']));
      }
    } finally {
      await plan.close();
    }
    return { partitions: plan.partitions, names: names.sort() };
  }
  const everyName = async (table: string) =>
    admin(async (c) =>
      (await c.query(`SELECT name FROM ${table}`)).rows.map((r) => String(r.name)).sort(),
    );

  it('reads every row exactly once across the ranges: the bounds are a stride, NULLs included', async () => {
    const got = await namesOf(TABLE, { column: 'id', lower: 1, upper: 100, degree: 4 });
    expect(got.partitions).toBe(4);
    expect(got.names).toEqual(await everyName(TABLE));
    expect(got.names).toHaveLength(105);
  });

  it("takes the column's lowest and highest values for bounds left empty", async () => {
    const got = await namesOf(TABLE, { column: 'id', degree: 3 });
    expect(got.partitions).toBe(3);
    expect(got.names).toEqual(await everyName(TABLE));
  });

  it('reads ONE snapshot: a row committed after planning is in no range', async () => {
    const plan = await planPostgresPartitions(read(TABLE), { column: 'id', degree: 3 });
    try {
      // The readers open their sessions on the first pull, after this commits.
      await admin((c) => c.query(`INSERT INTO ${TABLE} VALUES (42, 'late')`));
      const names: string[] = [];
      for await (const batch of plan.batches) {
        for (const row of batch) names.push(String(row['name']));
      }
      expect(names).not.toContain('late');
      expect(names).toHaveLength(105);
    } finally {
      await plan.close();
      await admin((c) => c.query(`DELETE FROM ${TABLE} WHERE name = 'late'`));
    }
  });

  it('compares bounds past a smallint column as bigint, rather than failing out of range', async () => {
    const got = await namesOf('c6f3_small', { column: 'id', lower: 0, upper: 100_000, degree: 2 });
    expect(got.names).toEqual(['a', 'b', 'c']);
  });

  it('reads an empty table as one range', async () => {
    const plan = await planPostgresPartitions(read('c6f3_empty'), { column: 'id', degree: 4 });
    const batches: unknown[] = [];
    for await (const b of plan.batches) batches.push(b);
    await plan.close();
    expect(plan.partitions).toBe(1);
    expect(batches).toEqual([]);
  });

  it('refuses a column that is not an integer, a missing column and a Query, permanently', async () => {
    await expect(
      planPostgresPartitions(read(TABLE), { column: 'name', degree: 2 }),
    ).rejects.toMatchObject({
      kind: 'permanent',
      message:
        "the partition column 'name' is text; Dynamic range splits a smallint, integer or bigint column",
    });
    await expect(
      planPostgresPartitions(read(TABLE), { column: 'nope', degree: 2 }),
    ).rejects.toMatchObject({ kind: 'permanent' });
    await expect(
      planPostgresPartitions(
        read(TABLE, { datasetKind: 'query', datasetConfig: { sql: `select * from ${TABLE}` } }),
        { column: 'id', degree: 2 },
      ),
    ).rejects.toMatchObject({ kind: 'permanent', message: PARTITION_NEEDS_TABLE });
  });

  it('leaves no session behind when the consumer stops after one batch', async () => {
    const sessions = () =>
      admin(async (c) =>
        Number(
          (
            await c.query(
              `SELECT count(*) AS n FROM pg_stat_activity
               WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
            )
          ).rows[0].n,
        ),
      );
    const before = await sessions();
    const plan = await planPostgresPartitions(read(TABLE), { column: 'id', degree: 4 });
    for await (const _batch of plan.batches) {
      void _batch;
      break;
    }
    await plan.close();
    let after = await sessions();
    for (let i = 0; i < 20 && after > before; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      after = await sessions();
    }
    expect(after).toBe(before);
  });

  it('quotes the partition column, keeping its case, and refuses a name that is not bare', async () => {
    const got = await namesOf('c6f3_quoted', { column: 'OrderId', degree: 3 });
    expect(got.partitions).toBe(3);
    expect(got.names).toHaveLength(9);
    await expect(
      planPostgresPartitions(read('c6f3_quoted'), { column: 'Order Id', degree: 3 }),
    ).rejects.toMatchObject({ kind: 'permanent' });
  });

  it('a cancel mid-read fails cancelled and leaves no session behind', async () => {
    const sessions = () =>
      admin(async (c) =>
        Number(
          (
            await c.query(
              `SELECT count(*) AS n FROM pg_stat_activity
               WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
            )
          ).rows[0].n,
        ),
      );
    const before = await sessions();
    const cancel = new AbortController();
    const plan = await planPostgresPartitions(read(TABLE, { signal: cancel.signal }), {
      column: 'id',
      degree: 4,
    });
    await expect(
      (async () => {
        for await (const _batch of plan.batches) {
          void _batch;
          cancel.abort();
        }
      })(),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    await plan.close();
    let after = await sessions();
    for (let i = 0; i < 20 && after > before; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      after = await sessions();
    }
    expect(after).toBe(before);
  });
});
