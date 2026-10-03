import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
import {
  createPipeline,
  createPipelineVersion,
  createRun,
  getPipelineVersion,
  getRun,
  listConnections,
  listDatasets,
  listPendingWakeups,
  listPipelines,
  listRunEvents,
  listRuns,
  listTriggers,
} from '../../repo/index.js';
import { demoDirFor, demoStatus, removeDemo, resolveDemoRoot, seedDemo } from '../demo-etl.js';

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
    expect(first.created).toBe(28); // 23 resources + 5 versions
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

    // The orchestrator re-runs 2 then 3: empty every table, and it refills them.
    const wipe = new Database(warehouse);
    try {
      wipe.exec(
        'DELETE FROM stg_orders; DELETE FROM orders_clean; DELETE FROM rejects; DELETE FROM sales_by_country;',
      );
    } finally {
      wipe.close();
    }
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

  it('a re-load keeps an edited landing file and re-makes a deleted trigger only', async () => {
    const csv = join(first.demoDir, 'landing', 'orders_2026-09.csv');
    writeFileSync(csv, 'edited by the operator\n');
    const del = await app.inject({ method: 'DELETE', url: `/api/triggers/${trigger('5')}` });
    expect(del.statusCode).toBeLessThan(300);
    const again = await seed(app);
    expect(again.status).toBe(201);
    expect([again.body.created, again.body.reused]).toEqual([1, 22]);
    expect(readFileSync(csv, 'utf8')).toBe('edited by the operator\n');
    first = again.body;
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

describe('#1481 demo ETL pack — remove', () => {
  const remove = async (app: FastifyInstance) => {
    const res = await app.inject({ method: 'DELETE', url: '/api/demo' });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };
  const loaded = async (app: FastifyInstance): Promise<boolean> =>
    ((await app.inject({ method: 'GET', url: '/api/demo' })).json() as { loaded: boolean }).loaded;
  const demoRows = (app: FastifyInstance) => ({
    connections: listConnections(app.db, 'local').filter((c) =>
      c.resourceId.startsWith('demo-etl-'),
    ),
    datasets: listDatasets(app.db, 'local').filter((d) => d.resourceId.startsWith('demo-etl-')),
    pipelines: listPipelines(app.db, 'local').filter((p) => p.resourceId.startsWith('demo-etl-')),
    triggers: listTriggers(app.db, { ownerId: 'local' }).filter((t) =>
      t.resourceId.startsWith('demo-etl-'),
    ),
  });

  it("takes every demo row, its run history and its files, leaves the operator's own, and loads again fresh", async () => {
    const { app } = await buildTestAppWithContext({ demoRoot: newDemoRoot() });
    try {
      expect(await loaded(app)).toBe(false);
      const { body } = await seed(app);
      expect(await loaded(app)).toBe(true);
      const trig = (k: string) => body.pipelines.find((p) => p.key === k)?.triggerId ?? '';
      expect((await fire(app, trig('1'))).status).toBe('success');
      expect((await fire(app, trig('5'))).status).toBe('failure');
      // An archived demo pipeline is still the demo's, and still removed.
      const archive = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${body.pipelines[1]?.pipelineId}/archive`,
      });
      expect(archive.statusCode).toBeLessThan(300);
      const mine = createPipeline(app.db, { ownerId: 'local', name: 'mine' });
      const myConn = await app.inject({
        method: 'POST',
        url: '/api/connections',
        payload: { name: 'my files', kind: 'fs', config: { roots: [tmpdir()] } },
      });
      expect(myConn.statusCode).toBe(201);

      const res = await remove(app);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ removed: 23, runsRemoved: 2 });
      expect(await loaded(app)).toBe(false);
      expect(demoRows(app)).toEqual({ connections: [], datasets: [], pipelines: [], triggers: [] });
      expect(listRuns(app.db)).toEqual([]);
      expect(existsSync(body.demoDir)).toBe(false);
      expect(listPipelines(app.db, 'local').map((p) => p.id)).toEqual([mine.id]);
      expect(listConnections(app.db, 'local').map((c) => c.name)).toEqual(['my files']);

      const again = await seed(app);
      expect(again.status).toBe(201);
      expect(again.body.created).toBe(28);
      expect(existsSync(join(again.body.demoDir, 'landing', 'orders_2026-10.csv'))).toBe(true);
      expect(await remove(app)).toEqual({ status: 200, body: { removed: 23, runsRemoved: 0 } });
      // Nothing loaded is not an error.
      expect(await remove(app)).toEqual({ status: 200, body: { removed: 0, runsRemoved: 0 } });
    } finally {
      await app.close();
    }
  });

  it('refuses, deleting nothing, while a demo run has not finished', async () => {
    const { app } = await buildTestAppWithContext({ demoRoot: newDemoRoot() });
    try {
      const { body } = await seed(app);
      createRun(app.db, {
        pipelineVersionId: body.pipelines[0]?.versionId ?? '',
        ownerId: 'local',
        triggerId: null,
        parentRunId: null,
        params: {},
        status: 'running',
      });
      const res = await remove(app);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('let it finish or cancel it');
      expect(demoRows(app).pipelines).toHaveLength(5);
      expect(listRuns(app.db)).toHaveLength(1);
      expect(existsSync(body.demoDir)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("refuses when the operator's own trigger runs a demo pipeline", async () => {
    const { app } = await buildTestAppWithContext({ demoRoot: newDemoRoot() });
    try {
      const { body } = await seed(app);
      const t = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          name: 'my trigger',
          pipelineVersionId: body.pipelines[2]?.versionId,
          params: {},
          mode: 'manual',
          schedule: null,
          webhook: null,
          runWindows: null,
          concurrency: { policy: 'skip_if_running' },
          enabled: true,
        },
      });
      expect(t.statusCode).toBe(201);
      const res = await remove(app);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('my trigger');
      expect(demoRows(app).pipelines).toHaveLength(5);
      expect(listTriggers(app.db, { ownerId: 'local' }).map((x) => x.name)).toContain('my trigger');
    } finally {
      await app.close();
    }
  });

  it("refuses when the operator's own pipeline calls a demo pipeline", async () => {
    const { app } = await buildTestAppWithContext({ demoRoot: newDemoRoot() });
    try {
      const { body } = await seed(app);
      // The orchestrator's graph (it calls pipelines 2 and 3), saved as theirs.
      const orchestrator = getPipelineVersion(app.db, body.pipelines[3]?.versionId ?? '');
      if (orchestrator === null) throw new Error('no orchestrator version');
      const mine = createPipeline(app.db, { ownerId: 'local', name: 'my caller' });
      // The schema parse drops the source version's own id, number and stamps.
      createPipelineVersion(app.db, { ...orchestrator, pipelineId: mine.id });
      const res = await remove(app);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('my caller');
      expect(demoRows(app).pipelines).toHaveLength(5);
    } finally {
      await app.close();
    }
  });

  it("removes one owner's demo and leaves another's", async () => {
    const demoRoot = newDemoRoot();
    const { app } = await buildTestAppWithContext({ demoRoot });
    try {
      seedDemo({ db: app.db, ownerId: 'local', demoRoot });
      const other = seedDemo({ db: app.db, ownerId: 'other', demoRoot });
      expect(removeDemo({ db: app.db, ownerId: 'local', demoRoot }).removed).toBe(23);
      expect(demoStatus(app.db, 'local')).toEqual({ loaded: false });
      expect(demoStatus(app.db, 'other')).toEqual({ loaded: true });
      expect(listPipelines(app.db, 'other')).toHaveLength(5);
      expect(existsSync(other.demoDir)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('deletes only what the demo made in its directory', async () => {
    const { app } = await buildTestAppWithContext({ demoRoot: newDemoRoot() });
    try {
      const { body } = await seed(app);
      writeFileSync(join(body.demoDir, 'mine.txt'), 'not the demo\n');
      expect((await remove(app)).status).toBe(200);
      expect(existsSync(join(body.demoDir, 'landing'))).toBe(false);
      expect(existsSync(join(body.demoDir, 'warehouse.db'))).toBe(false);
      expect(readFileSync(join(body.demoDir, 'mine.txt'), 'utf8')).toBe('not the demo\n');
    } finally {
      await app.close();
    }
  });

  it("cancels a removed schedule's pending tick", async () => {
    const { app } = await buildTestAppWithContext({ demoRoot: newDemoRoot() });
    try {
      const { body } = await seed(app);
      const hourly = body.scheduleTriggerId;
      const on = await app.inject({
        method: 'PATCH',
        url: `/api/triggers/${hourly}`,
        payload: { enabled: true },
      });
      expect(on.statusCode).toBe(200);
      const pendingFor = () =>
        listPendingWakeups(app.db).filter((w) => JSON.stringify(w.ref).includes(hourly));
      expect(pendingFor()).not.toHaveLength(0);
      expect((await remove(app)).status).toBe(200);
      expect(pendingFor()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('refuses to delete through an owner dir that is a symlink, out of the root or across to another owner', async () => {
    const demoRoot = newDemoRoot();
    const outside = mkdtempSync(join(tmpdir(), 'studio-demo-outside-'));
    const otherOwner = join(demoRoot, 'other');
    try {
      for (const target of [outside, otherOwner]) {
        mkdirSync(join(target, 'landing'), { recursive: true });
        writeFileSync(join(target, 'landing', 'keep.csv'), "not this owner's\n");
        rmSync(join(demoRoot, 'local'), { force: true });
        symlinkSync(target, join(demoRoot, 'local'));
        const { app } = await buildTestAppWithContext({ demoRoot });
        try {
          const res = await app.inject({ method: 'DELETE', url: '/api/demo' });
          expect(res.statusCode).toBe(500);
          expect(existsSync(join(target, 'landing', 'keep.csv'))).toBe(true);
        } finally {
          await app.close();
        }
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

  it('refuses a partly removed demo rather than re-making a resource others pin by id', async () => {
    const { app } = await buildTestAppWithContext({ demoRoot: newDemoRoot() });
    try {
      await seed(app);
      const ds = (await app.inject({ method: 'GET', url: '/api/datasets' })).json().items as {
        id: string;
        name: string;
      }[];
      const gone = ds.find((d) => d.name === 'Demo — rejects table');
      expect(gone).toBeDefined();
      const del = await app.inject({ method: 'DELETE', url: `/api/datasets/${gone?.id}` });
      expect(del.statusCode).toBeLessThan(300);
      const res = await seed(app);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('partly removed');
      // The way out it names is the button that exists.
      expect(JSON.stringify(res.body)).toContain('Pipelines → Remove demo');
    } finally {
      await app.close();
    }
  });

  it('refuses when the demo connections are rooted somewhere else', async () => {
    const { app } = await buildTestAppWithContext({ demoRoot: newDemoRoot() });
    try {
      await seed(app);
      const fs = listConnections(app.db, 'local').find((c) => c.kind === 'fs');
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/connections/${fs?.id}`,
        payload: { config: { roots: [tmpdir()] } },
      });
      expect(patch.statusCode).toBe(200);
      const res = await seed(app);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('not rooted');
    } finally {
      await app.close();
    }
  });

  it('refuses an owner dir that is a symlink out of the demo root', async () => {
    const demoRoot = newDemoRoot();
    const outside = mkdtempSync(join(tmpdir(), 'studio-demo-outside-'));
    mkdirSync(demoRoot, { recursive: true });
    symlinkSync(outside, join(demoRoot, 'local'));
    const { app } = await buildTestAppWithContext({ demoRoot });
    try {
      const res = await seed(app);
      expect(res.status).toBe(500);
      expect(listConnections(app.db, 'local')).toEqual([]);
      expect(existsSync(join(outside, 'landing'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('keeps every owner inside the demo root', () => {
    expect(demoDirFor('/srv/demo', 'local')).toBe('/srv/demo/local');
    expect(() => demoDirFor('/srv/demo', '../etc')).toThrow(/escapes/);
    expect(() => demoDirFor('/srv/demo', '.')).toThrow(/escapes/);
  });

  it('resolves the demo root: option, then AUTONOMY_DEMO_ROOT, then the data dir, then beside the DB', () => {
    const env = { AUTONOMY_DEMO_ROOT: '/env/demo', AUTONOMY_DATA_DIR: '/data' };
    expect(resolveDemoRoot('/opt/demo', '/db/app.sqlite', env)).toBe('/opt/demo');
    expect(resolveDemoRoot(undefined, '/db/app.sqlite', env)).toBe('/env/demo');
    expect(resolveDemoRoot(undefined, '/db/app.sqlite', { AUTONOMY_DATA_DIR: '/data' })).toBe(
      '/data/demo',
    );
    expect(resolveDemoRoot(undefined, '/db/app.sqlite', { AUTONOMY_DEMO_ROOT: '' })).toBe(
      '/db/demo',
    );
  });
});
