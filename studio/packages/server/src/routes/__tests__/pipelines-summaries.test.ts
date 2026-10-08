import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, type PipelineSummary, type RunStatus } from '@autonomy-studio/shared';
import { runs } from '../../db/schema.js';
import {
  archivePipelineRow,
  createPipeline,
  createPipelineVersion,
  newId,
} from '../../repo/index.js';
import { pendingTicks } from '../../scheduler/__tests__/pending-ticks.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

const DAY = 24 * 60 * 60 * 1000;

/**
 * #1569 OR37 — `GET /api/pipelines/summaries`: the pipelines grid's row facts,
 * one batched owner-scoped read.
 */
describe('GET /api/pipelines/summaries (#1569 OR37)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  const node = (id: string) => ({
    id,
    type: 'wait',
    config: { seconds: '${1}' },
    position: { x: 0, y: 0 },
  });
  const version = (
    pipelineId: string,
    opts: { nodes?: number; debug?: boolean; description?: string; annotations?: string[] } = {},
  ) =>
    createPipelineVersion(
      app.db,
      {
        pipelineId,
        params: [],
        outputs: [],
        nodes: Array.from({ length: opts.nodes ?? 0 }, (_, i) => node(`n${String(i)}`)),
        edges: [],
        catalogVersion: CATALOG_VERSION,
        ...(opts.description !== undefined ? { description: opts.description } : {}),
        ...(opts.annotations !== undefined ? { annotations: opts.annotations } : {}),
      } as never,
      { debug: opts.debug ?? false },
    );

  /** A run row with chosen times — the launcher stamps `Date.now()`, which a
   * window test cannot use. */
  function run(
    pipelineVersionId: string,
    status: RunStatus,
    startedAt: number,
    durationMs: number | null,
    ownerId = 'local',
  ): string {
    const id = newId('run');
    app.db
      .insert(runs)
      .values({
        id,
        ownerId,
        pipelineVersionId,
        triggerId: null,
        parentRunId: null,
        params: {},
        status,
        leaseUntil: null,
        heartbeatAt: null,
        queuedAt: null,
        triggerContext: null,
        rerunOf: null,
        startedAt,
        finishedAt: durationMs === null ? null : startedAt + durationMs,
      } as never)
      .run();
    return id;
  }

  async function summaries(): Promise<PipelineSummary[]> {
    const res = await app.inject({ method: 'GET', url: '/api/pipelines/summaries' });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { items: PipelineSummary[] }).items;
  }
  const summaryOf = async (id: string) => (await summaries()).find((s) => s.pipelineId === id);

  it('names the newest run by start time, never a Debug run', async () => {
    const p = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v1 = version(p.id);
    const debug = version(p.id, { debug: true });
    const now = Date.now();
    run(v1.id, 'success', now - 3 * DAY, 1000);
    const newest = run(v1.id, 'failure', now - DAY, 500);
    // Newer still, but bound to the editor's Debug version.
    run(debug.id, 'success', now - 1000, 10);

    expect((await summaryOf(p.id))?.lastRun).toEqual({
      runId: newest,
      status: 'failure',
      startedAt: now - DAY,
      finishedAt: now - DAY + 500,
    });
  });

  it('counts the window: rate over succeeded + failed, interrupted is a failure, cancelled is neither', async () => {
    const p = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v = version(p.id);
    const now = Date.now();
    run(v.id, 'success', now - DAY, 100);
    run(v.id, 'success', now - 2 * DAY, 300);
    run(v.id, 'success', now - 3 * DAY, 200);
    run(v.id, 'interrupted', now - 4 * DAY, 400);
    run(v.id, 'cancelled', now - 4 * DAY, 50);
    run(v.id, 'running', now - 1000, null);
    // Outside the 7-day window.
    run(v.id, 'failure', now - 8 * DAY, 9000);

    expect((await summaryOf(p.id))?.window).toEqual({
      days: 7,
      runs: 6,
      succeeded: 3,
      failed: 1,
      successRate: 0.75,
      // Durations of the succeeded runs: 100, 200, 300 (the interrupted run's
      // span is its sweep, not a duration). Nearest rank: p50 = 2nd, p95 = 3rd.
      p50Ms: 200,
      p95Ms: 300,
    });
  });

  it('a pipeline that never ran says so rather than zero percent', async () => {
    const p = createPipeline(app.db, { ownerId: 'local', name: 'Never' });
    expect(await summaryOf(p.id)).toMatchObject({
      lastRun: null,
      window: { runs: 0, successRate: null, p50Ms: null, p95Ms: null },
      triggers: { total: 0, enabled: 0, items: [] },
      nextFireAt: null,
      activities: null,
      description: '',
      annotations: [],
    });
  });

  it('carries the latest saved version’s description and annotations, not a Debug draft’s', async () => {
    const p = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    version(p.id, { description: 'old', annotations: ['stale'] });
    version(p.id, { description: 'Loads the orders feed', annotations: ['finance', 'nightly'] });
    // Debug versions number on their own, so three of them reach v3 — past the
    // saved head (v2) — which a join that forgot `debug = 0` would pick.
    for (let i = 0; i < 3; i++) {
      version(p.id, { description: 'draft', annotations: ['debug'], debug: true });
    }
    expect(await summaryOf(p.id)).toMatchObject({
      description: 'Loads the orders feed',
      annotations: ['finance', 'nightly'],
    });
  });

  it('counts the latest saved version’s activities, not a Debug draft’s', async () => {
    const p = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    version(p.id, { nodes: 1 });
    version(p.id, { nodes: 3 });
    version(p.id, { nodes: 7, debug: true });
    expect((await summaryOf(p.id))?.activities).toBe(3);
  });

  it('counts triggers across versions and takes the earliest armed fire', async () => {
    const p = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    const v1 = version(p.id);
    const v2 = version(p.id);
    const create = async (pipelineVersionId: string, over: Record<string, unknown>) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/triggers',
        payload: {
          name: 'T',
          pipelineVersionId,
          params: {},
          mode: 'schedule',
          // At :17, like the hourly below, so every nightly fire is ALSO an
          // hourly one. `0 2 * * *` fell before the next hourly :17 whenever
          // the suite ran between 01:17 and 02:00 UTC (#1586 found it).
          schedule: '17 2 * * *',
          webhook: null,
          concurrency: { policy: 'skip_if_running' },
          runWindows: null,
          enabled: true,
          ...over,
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { id: string }).id;
    };
    const hourly = await create(v1.id, { name: 'Hourly', schedule: '17 * * * *' });
    await create(v2.id, { name: 'Nightly' });
    await create(v2.id, { name: 'Off', enabled: false });
    await create(v2.id, { name: 'By hand', mode: 'manual', schedule: null });

    const s = await summaryOf(p.id);
    expect(s?.triggers.total).toBe(4);
    expect(s?.triggers.enabled).toBe(3);
    expect(s?.triggers.items.map((t) => [t.name, t.mode, t.enabled]).sort()).toEqual([
      ['By hand', 'manual', true],
      ['Hourly', 'schedule', true],
      ['Nightly', 'schedule', true],
      ['Off', 'schedule', false],
    ]);
    // The hourly tick is never later than the nightly one: every nightly
    // instant is an hourly instant too.
    expect(s?.nextFireAt).toBe(pendingTicks(app.db, hourly)[0]!.dueAt);
  });

  it('keeps each pipeline’s facts its own: runs, rate, durations and next fire', async () => {
    const a = createPipeline(app.db, { ownerId: 'local', name: 'A' });
    const b = createPipeline(app.db, { ownerId: 'local', name: 'B' });
    const va = version(a.id);
    const vb = version(b.id);
    const now = Date.now();
    const aLast = run(va.id, 'success', now - 2000, 100);
    run(vb.id, 'failure', now - 5000, 900);
    run(vb.id, 'failure', now - 6000, 700);
    const bLast = run(vb.id, 'success', now - 1000, 300);
    // An interrupted run fails the rate but has no real span (swept at boot).
    run(vb.id, 'interrupted', now - 7000, 99_000);
    const res = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: {
        name: 'Hourly B',
        pipelineVersionId: vb.id,
        params: {},
        mode: 'schedule',
        schedule: '17 * * * *',
        webhook: null,
        concurrency: { policy: 'skip_if_running' },
        runWindows: null,
        enabled: true,
      },
    });
    expect(res.statusCode, res.body).toBe(201);

    const sa = await summaryOf(a.id);
    const sb = await summaryOf(b.id);
    expect(sa?.lastRun?.runId).toBe(aLast);
    expect(sa?.window).toMatchObject({ runs: 1, succeeded: 1, failed: 0, p50Ms: 100, p95Ms: 100 });
    expect(sa?.nextFireAt).toBeNull();
    expect(sa?.triggers.total).toBe(0);
    expect(sb?.lastRun?.runId).toBe(bLast);
    // Durations 300, 700, 900: p50 = 2nd (700), p95 = 3rd (900); never 99s.
    expect(sb?.window).toMatchObject({ runs: 4, succeeded: 1, failed: 3, p50Ms: 700, p95Ms: 900 });
    expect(sb?.nextFireAt).not.toBeNull();
    expect(sb?.triggers).toMatchObject({ total: 1, enabled: 1 });
  });

  it('modified is the later of the pipeline row and its latest saved version', async () => {
    const p = createPipeline(app.db, { ownerId: 'local', name: 'P' });
    expect((await summaryOf(p.id))?.modifiedAt).toBe(p.updatedAt);
    const v = version(p.id);
    expect((await summaryOf(p.id))?.modifiedAt).toBe(Math.max(p.updatedAt, v.createdAt));
  });

  it('is owner-scoped and leaves archived pipelines out', async () => {
    const mine = createPipeline(app.db, { ownerId: 'local', name: 'Mine' });
    const theirs = createPipeline(app.db, { ownerId: 'other', name: 'Theirs' });
    const archived = createPipeline(app.db, { ownerId: 'local', name: 'Archived' });
    archivePipelineRow(app.db, archived.id);
    const v = version(mine.id);
    // A run on my version that another owner's row claims is not mine to count.
    run(v.id, 'success', Date.now() - 1000, 10, 'other');

    const ids = (await summaries()).map((s) => s.pipelineId);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(ids).not.toContain(archived.id);
    expect((await summaryOf(mine.id))?.lastRun).toBeNull();
  });
});
