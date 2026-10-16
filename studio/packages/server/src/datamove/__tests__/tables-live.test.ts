import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_POSTGRES_PORT, type ConnectionKind } from '@autonomy-studio/shared';
import { postgresAdapter } from '../../connectors/postgres.js';
import type { ConnectorRegistry } from '../../connectors/registry.js';
import { liveSuiteMustRun } from '../../connectors/__tests__/live-postgres.js';
import { listConnectionTables } from '../preview.js';

/**
 * #1600 C1q-c — Table `[▾ from the connection]` against a REAL postgres, through
 * the real adapter's Lookup read. Under CI the service is required
 * (`postgres.test.ts` fails the job when it is absent); locally it skips unless
 * `STUDIO_TEST_POSTGRES_HOST` is set.
 */
const LIVE_HOST = process.env.STUDIO_TEST_POSTGRES_HOST;

describe('the live postgres service for the table list', () => {
  it('is present whenever CI claims to provide one', () => {
    if (!liveSuiteMustRun(process.env)) return;
    expect(LIVE_HOST).toBeDefined();
  });
});

describe.skipIf(LIVE_HOST === undefined)('listConnectionTables against a live postgres', () => {
  const live = {
    host: LIVE_HOST ?? '',
    port: Number(process.env.STUDIO_TEST_POSTGRES_PORT ?? DEFAULT_POSTGRES_PORT),
    database: process.env.STUDIO_TEST_POSTGRES_DATABASE ?? 'postgres',
    user: process.env.STUDIO_TEST_POSTGRES_USER ?? 'postgres',
    sslmode: 'disable' as const,
    connectTimeoutMs: 5_000,
  };
  const password = process.env.STUDIO_TEST_POSTGRES_PASSWORD ?? '';
  // Per run, so two runs against one server cannot collide.
  const schema = `studio_tables_${process.pid}_${Date.now()}`;
  const registry: ConnectorRegistry = new Map([['postgres' as ConnectionKind, postgresAdapter]]);

  /** Fixture DDL through a direct session, deliberately NOT the code under test. */
  async function admin(sql: string) {
    const c = new pg.Client({ ...live, password, ssl: false });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    await admin(
      `CREATE SCHEMA ${schema};` +
        `CREATE TABLE ${schema}.orders (id int);` +
        `CREATE VIEW ${schema}.big_orders AS SELECT * FROM ${schema}.orders;` +
        `CREATE MATERIALIZED VIEW ${schema}.order_counts AS SELECT count(*) AS n FROM ${schema}.orders;` +
        `CREATE TABLE ${schema}.events (at date) PARTITION BY RANGE (at);` +
        `CREATE TABLE ${schema}.events_2026 PARTITION OF ${schema}.events ` +
        `FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');`,
    );
  });
  afterAll(async () => {
    await admin(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });

  it('lists tables, views and materialized views by schema, a partitioned table without its partitions, and no system schema', async () => {
    const result = await listConnectionTables({
      registry,
      connection: { kind: 'postgres' as ConnectionKind, config: live },
      secret: password,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.tables.filter((t) => t.schema === schema)).toEqual([
      { schema, name: 'big_orders' },
      { schema, name: 'events' },
      { schema, name: 'order_counts' },
      { schema, name: 'orders' },
    ]);
    expect(
      result.tables.filter((t) => t.schema === 'information_schema' || /^pg_/.test(t.schema ?? '')),
    ).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
