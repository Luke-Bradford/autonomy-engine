import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DemoSeedResponseSchema,
  TERMINAL_RUN_ROW_STATUS,
  type DemoSeedResponse,
} from '@autonomy-studio/shared';
import { buildTestAppWithContext } from '../../__tests__/build-test-app.js';
import { until } from '../../__tests__/poll-until.js';
import { getRun, listConnections, listRunEvents } from '../../repo/index.js';
import { demoDirFor } from '../demo-etl.js';

/**
 * #1481 OR32 — the demo ETL pack, loaded and then RUN through the real app: the
 * counts are the ones the planted dirt was designed to produce (92 staged → 66
 * clean, 20 rejected with reasons, 6 countries), so a change to the data, the
 * SQL or any activity the demo uses that breaks the story turns this red.
 */

const newDemoRoot = (): string => mkdtempSync(join(tmpdir(), 'studio-demo-root-'));

async function seed(app: FastifyInstance): Promise<{ status: number; body: DemoSeedResponse }> {
  const res = await app.inject({ method: 'POST', url: '/api/demo/seed' });
  return {
    status: res.statusCode,
    body: res.statusCode < 300 ? DemoSeedResponseSchema.parse(res.json()) : res.json(),
  };
}

async function fire(app: FastifyInstance, triggerId: string): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'POST', url: `/api/triggers/${triggerId}/fire` });
  expect(res.statusCode).toBe(202);
  const runId = res.json().runId as string;
  // The copies stream on their own ticks, past the launcher going idle; wait for
  // the ROW to settle (a call node's children settle before their parent does).
  await until(
    () => {
      const status = getRun(app.db, runId)?.status;
      return status !== undefined && TERMINAL_RUN_ROW_STATUS.has(status);
    },
    `demo run ${runId} to finish`,
    { iterations: 1500 },
  );
  return (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json();
}

describe('#1481 demo ETL pack', () => {
  let app: FastifyInstance;
  let demoRoot: string;
  let first: DemoSeedResponse;
  let warehouse: string;

  const count = (table: string): number => {
    const db = new Database(warehouse, { readonly: true });
    try {
      return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    } finally {
      db.close();
    }
  };
  const trigger = (key: string): string => {
    const p = first.pipelines.find((x) => x.key === key);
    if (p === undefined) throw new Error(`no demo pipeline ${key}`);
    return p.triggerId;
  };

  beforeAll(async () => {
    demoRoot = newDemoRoot();
    ({ app } = await buildTestAppWithContext({ demoRoot }));
    const res = await seed(app);
    expect(res.status).toBe(201);
    first = res.body;
    warehouse = join(first.demoDir, 'warehouse.db');
  });
  afterAll(async () => {
    await app.close();
  });

  it('loads 2 connections, 10 datasets, 5 pipelines in folder Demo and 6 triggers, under the owner dir', async () => {
    expect(first.created).toBe(23);
    expect(first.reused).toBe(0);
    expect(first.demoDir).toBe(realpathSync(join(demoRoot, 'local')));
    expect(first.pipelines.map((p) => p.name)).toEqual([
      'Demo — 1 Load one CSV to staging',
      'Demo — 2 Ingest landing folder',
      'Demo — 3 Clean and aggregate',
      'Demo — 4 Nightly orchestrator',
      'Demo — 5 Broken on purpose',
    ]);
    const pipes = (await app.inject({ method: 'GET', url: '/api/pipelines' })).json().items as {
      name: string;
      folder: string | null;
    }[];
    expect(pipes.filter((p) => p.folder === 'Demo')).toHaveLength(5);
    // Granted the demo dir and nothing wider.
    for (const c of listConnections(app.db, 'local')) {
      expect((c.config as { roots: string[] }).roots).toEqual([first.demoDir]);
    }
    const hourly = (
      await app.inject({ method: 'GET', url: `/api/triggers/${first.scheduleTriggerId}` })
    ).json();
    expect(hourly.mode).toBe('schedule');
    expect(hourly.enabled).toBe(false);
    expect(existsSync(join(first.demoDir, 'landing', 'orders_2026-10.csv'))).toBe(true);
  });

  it('runs the story end to end: 49 → 92 staged → 66 clean, 20 rejects, 6 countries', async () => {
    expect((await fire(app, trigger('1'))).status).toBe('success');
    expect(count('stg_orders')).toBe(49);

    expect((await fire(app, trigger('2'))).status).toBe('success');
    expect(count('stg_orders')).toBe(92);

    expect((await fire(app, trigger('3'))).status).toBe('success');
    expect([count('orders_clean'), count('rejects'), count('sales_by_country')]).toEqual([
      66, 20, 6,
    ]);
    expect(readFileSync(join(first.demoDir, 'reports', 'rejects-summary.txt'), 'utf8')).toContain(
      'rejected rows: 20',
    );

    // The orchestrator re-runs 2 then 3; staging is reset first, so the counts hold.
    expect((await fire(app, trigger('4'))).status).toBe('success');
    expect([
      count('stg_orders'),
      count('orders_clean'),
      count('rejects'),
      count('sales_by_country'),
    ]).toEqual([92, 66, 20, 6]);
    expect(existsSync(join(first.demoDir, 'reports', 'nightly-summary.txt'))).toBe(true);
  });

  it('pipeline 5 fails on purpose, naming the missing file', async () => {
    const run = await fire(app, trigger('5'));
    expect(run.status).toBe('failure');
    const failed = listRunEvents(app.db, run.id as string).filter((e) => e.type === 'node.failed');
    expect(JSON.stringify(failed)).toContain('orders_2026-13.csv');
  });

  it('a second load creates nothing and keeps every id', async () => {
    const again = await seed(app);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(0);
    expect(again.body.reused).toBe(23);
    expect(again.body.pipelines).toEqual(first.pipelines);
    expect(again.body.scheduleTriggerId).toBe(first.scheduleTriggerId);
  });
});

describe('#1481 demo ETL pack — refusals', () => {
  it('refuses, writing nothing, when a non-demo pipeline already has a demo name', async () => {
    const demoRoot = newDemoRoot();
    const { app } = await buildTestAppWithContext({ demoRoot });
    try {
      const mine = await app.inject({
        method: 'POST',
        url: '/api/pipelines',
        payload: { name: 'Demo — 3 Clean and aggregate' },
      });
      expect(mine.statusCode).toBe(201);
      const res = await seed(app);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('Demo — 3 Clean and aggregate');
      expect(listConnections(app.db, 'local')).toEqual([]);
      expect(existsSync(join(demoRoot, 'local', 'landing'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('refuses when a demo pipeline is archived', async () => {
    const { app } = await buildTestAppWithContext({ demoRoot: newDemoRoot() });
    try {
      const { body } = await seed(app);
      const archive = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${body.pipelines[1]?.pipelineId}/archive`,
      });
      expect(archive.statusCode).toBeLessThan(300);
      const res = await seed(app);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('archived');
    } finally {
      await app.close();
    }
  });

  it('keeps every owner inside the demo root', () => {
    expect(demoDirFor('/srv/demo', 'local')).toBe('/srv/demo/local');
    expect(() => demoDirFor('/srv/demo', '../etc')).toThrow(/escapes/);
    expect(() => demoDirFor('/srv/demo', '.')).toThrow(/escapes/);
  });
});
