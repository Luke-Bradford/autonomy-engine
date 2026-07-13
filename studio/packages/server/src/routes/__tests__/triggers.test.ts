import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, type NewTrigger } from '@autonomy-studio/shared';
import { createPipeline, createPipelineVersion, createTrigger } from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

function triggerBody(pipelineVersionId: string) {
  return {
    name: 'Nightly',
    pipelineVersionId,
    params: {},
    mode: 'schedule' as const,
    schedule: '0 2 * * *',
    webhook: null,
    concurrency: { policy: 'skip_if_running' as const },
    runWindows: null,
    enabled: true,
  };
}

function newTriggerInput(pipelineVersionId: string, ownerId: string): NewTrigger {
  return { ownerId, ...triggerBody(pipelineVersionId) };
}

describe('triggers routes', () => {
  let app: FastifyInstance;
  let pipelineVersionId: string;

  beforeAll(async () => {
    app = await buildTestApp();
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'For triggers' });
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

  it('full CRUD round-trip, owner-scoped', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: triggerBody(pipelineVersionId),
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.ownerId).toBe('local');
    expect(created.mode).toBe('schedule');

    const getRes = await app.inject({ method: 'GET', url: `/api/triggers/${created.id}` });
    expect(getRes.json()).toEqual(created);

    const listRes = await app.inject({ method: 'GET', url: '/api/triggers' });
    expect(listRes.json().map((t: { id: string }) => t.id)).toContain(created.id);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/triggers/${created.id}`,
      payload: { enabled: false },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().enabled).toBe(false);

    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/triggers/${created.id}` });
    expect(deleteRes.statusCode).toBe(204);

    const missing = await app.inject({ method: 'GET', url: `/api/triggers/${created.id}` });
    expect(missing.statusCode).toBe(404);
  });

  it('owner scoping: a trigger belonging to a different owner is not visible', async () => {
    const other = createTrigger(app.db, newTriggerInput(pipelineVersionId, 'someone-else'));

    const listRes = await app.inject({ method: 'GET', url: '/api/triggers' });
    expect(listRes.json().map((t: { id: string }) => t.id)).not.toContain(other.id);

    const getRes = await app.inject({ method: 'GET', url: `/api/triggers/${other.id}` });
    expect(getRes.statusCode).toBe(404);
  });

  it('validation: bad body -> 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: { name: 'Bad', pipelineVersionId, mode: 'not_a_real_mode' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('constraint violation: creating a trigger for a nonexistent pipeline version is a 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: triggerBody('pv_does_not_exist'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflict');
  });

  it('404 for a missing trigger', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/triggers/trig_missing' });
    expect(res.statusCode).toBe(404);
  });
});
