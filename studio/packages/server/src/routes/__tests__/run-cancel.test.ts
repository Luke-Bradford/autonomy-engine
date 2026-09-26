import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import {
  ApiErrorBodySchema,
  CATALOG_VERSION,
  RunCancelAcceptedSchema,
} from '@autonomy-studio/shared';
import {
  admitQueuedRun,
  appendRunEvent,
  cancelQueuedRun,
  createPipeline,
  createPipelineVersion,
  createRun,
  getRun,
} from '../../repo/index.js';
import { runs } from '../../db/schema.js';
import { loadEngineEvents } from '../../run/events.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';
import { until } from '../../__tests__/poll-until.js';

/**
 * CX2 (#1320) — `POST /api/runs/:id/cancel` against the REAL app: the canceller,
 * the drive lock and the driver are the production wiring (spec D5/D6).
 */
describe('POST /api/runs/:id/cancel', () => {
  let app: FastifyInstance;
  let pipelineVersionId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'For cancel' });
    pipelineVersionId = createPipelineVersion(app.db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    }).id;
  });

  afterAll(async () => {
    await app.close();
  });

  const seed = (ownerId = 'local') =>
    createRun(app.db, {
      ownerId,
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
  const cancel = (id: string) => app.inject({ method: 'POST', url: `/api/runs/${id}/cancel` });
  const eventCount = (id: string) => loadEngineEvents(app.db, id).length;
  const started = (runId: string) =>
    appendRunEvent(app.db, {
      runId,
      type: 'run.started',
      payload: { type: 'run.started', runId, pipelineVersionId, params: {} },
    });

  it('202 requested for a run that has not started, which then finishes cancelled with no run.started', async () => {
    const run = seed();

    const res = await cancel(run.id);

    expect(res.statusCode).toBe(202);
    expect(RunCancelAcceptedSchema.parse(res.json())).toEqual({
      runId: run.id,
      state: 'requested',
    });
    await until(
      () => getRun(app.db, run.id)?.status === 'cancelled',
      'the run to finish cancelled',
    );
    expect(loadEngineEvents(app.db, run.id).map((e) => e.type)).toEqual([
      'run.cancelRequested',
      'run.finished',
    ]);
  });

  it('202 cancelled for a QUEUED run, by row patch: no log is written, and admission can never start it', async () => {
    const run = seed();
    app.db.update(runs).set({ status: 'queued', queuedAt: 1 }).where(eq(runs.id, run.id)).run();

    const res = await cancel(run.id);

    expect(res.statusCode).toBe(202);
    expect(RunCancelAcceptedSchema.parse(res.json())).toEqual({
      runId: run.id,
      state: 'cancelled',
    });
    const row = getRun(app.db, run.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.finishedAt).not.toBeNull();
    expect(eventCount(run.id)).toBe(0);
    expect(admitQueuedRun(app.db, run.id)).toBeNull();
    expect(getRun(app.db, run.id)?.status).toBe('cancelled');
  });

  it('the queued row patch never touches a row admission already took (the race D5 relies on)', () => {
    const run = seed(); // `pending`: as if admission flipped it first

    expect(cancelQueuedRun(app.db, run.id)).toBe(false);
    expect(getRun(app.db, run.id)?.status).toBe('pending');
  });

  it('a repeated cancel is 202 and records nothing more', async () => {
    const run = seed();
    started(run.id);
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.cancelRequested',
      payload: { type: 'run.cancelRequested', runId: run.id, source: { kind: 'operator' } },
    });
    app.db.update(runs).set({ status: 'running' }).where(eq(runs.id, run.id)).run();

    const res = await cancel(run.id);

    expect(res.statusCode).toBe(202);
    expect(RunCancelAcceptedSchema.parse(res.json()).state).toBe('requested');
    expect(eventCount(run.id)).toBe(2);
  });

  it('409 conflict for a run whose LOG has ended, even while its row lags, and appends nothing', async () => {
    const run = seed();
    started(run.id);
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.finished',
      payload: { type: 'run.finished', runId: run.id, outcome: 'success', reason: 'done' },
    });
    app.db.update(runs).set({ status: 'running' }).where(eq(runs.id, run.id)).run();

    const res = await cancel(run.id);

    expect(res.statusCode).toBe(409);
    const body = ApiErrorBodySchema.parse(res.json());
    expect(body.error).toBe('conflict');
    expect(body.message).toContain('success');
    expect(eventCount(run.id)).toBe(2);
  });

  it('409 conflict for a run whose ROW is terminal', async () => {
    const run = seed();
    app.db.update(runs).set({ status: 'failure' }).where(eq(runs.id, run.id)).run();

    const res = await cancel(run.id);

    expect(res.statusCode).toBe(409);
    expect(ApiErrorBodySchema.parse(res.json()).error).toBe('conflict');
  });

  it('409 log_unreadable for a run whose log cannot be parsed, and appends nothing', async () => {
    const run = seed();
    started(run.id);
    app.db.update(runs).set({ status: 'running' }).where(eq(runs.id, run.id)).run();
    app.db.run(
      sql`INSERT INTO run_events (id, run_id, seq, type, payload, ts)
          VALUES (${`evt_bad_${run.id}`}, ${run.id}, 2, 'node.bogus', '{"type":"node.bogus"}', 1)`,
    );

    const res = await cancel(run.id);

    expect(res.statusCode).toBe(409);
    expect(ApiErrorBodySchema.parse(res.json()).error).toBe('log_unreadable');
    const rows = app.db.all(sql`SELECT count(*) AS n FROM run_events WHERE run_id = ${run.id}`);
    expect(rows).toEqual([{ n: 2 }]);
  });

  it("404 for another owner's run and for a missing run", async () => {
    const other = seed('someone-else');

    expect((await cancel(other.id)).statusCode).toBe(404);
    expect((await cancel('run_does_not_exist')).statusCode).toBe(404);
    expect(getRun(app.db, other.id)?.status).toBe('pending');
    expect(eventCount(other.id)).toBe(0);
  });
});
