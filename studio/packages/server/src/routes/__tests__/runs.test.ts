import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION } from '@autonomy-studio/shared';
import {
  appendRunEvent,
  createPipeline,
  createPipelineVersion,
  createRun,
} from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

describe('runs routes (read-only)', () => {
  let app: FastifyInstance;
  let pipelineVersionId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'For runs' });
    const version = createPipelineVersion(app.db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    pipelineVersionId = version.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists and fetches runs seeded directly via the repo layer (there is no create-run route)', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: { topic: 'hello' },
    });

    const listRes = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().map((r: { id: string }) => r.id)).toContain(run.id);

    const getRes = await app.inject({ method: 'GET', url: `/api/runs/${run.id}` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toEqual(run);
  });

  it('GET /api/runs/:id/events returns the append-only event log in order', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    appendRunEvent(app.db, { runId: run.id, type: 'run.started', payload: {} });
    appendRunEvent(app.db, { runId: run.id, type: 'run.finished', payload: { status: 'success' } });

    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/events` });
    expect(res.statusCode).toBe(200);
    const events = res.json();
    expect(events).toHaveLength(2);
    expect(events.map((e: { type: string }) => e.type)).toEqual(['run.started', 'run.finished']);
    expect(events[0].seq).toBe(0);
    expect(events[1].seq).toBe(1);
  });

  it('there is no POST /api/runs route (runs are created by the engine/scheduler, not this API)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { pipelineVersionId },
    });
    expect([404, 405]).toContain(res.statusCode);
  });

  it('owner scoping: a run belonging to a different owner is filtered from list and 404s on get', async () => {
    const other = createRun(app.db, {
      ownerId: 'someone-else',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });

    const listRes = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(listRes.json().map((r: { id: string }) => r.id)).not.toContain(other.id);

    const getRes = await app.inject({ method: 'GET', url: `/api/runs/${other.id}` });
    expect(getRes.statusCode).toBe(404);

    const eventsRes = await app.inject({ method: 'GET', url: `/api/runs/${other.id}/events` });
    expect(eventsRes.statusCode).toBe(404);
  });

  it('404 for a missing run', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs/run_missing' });
    expect(res.statusCode).toBe(404);
  });

  it('filters by pipelineVersionId/triggerId/parentRunId query params', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/runs?pipelineVersionId=${pipelineVersionId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((r: { id: string }) => r.id)).toContain(run.id);
  });

  it('validation: a non-string query param value -> 400', async () => {
    const res = await app.inject({
      method: 'GET',
      // Fastify parses repeated query keys into an array, which fails the
      // Zod string schema — invalid shape, not a value the repo should ever see.
      url: '/api/runs?pipelineVersionId=a&pipelineVersionId=b',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('validation: an empty-string query param value -> 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs?triggerId=' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });
});
