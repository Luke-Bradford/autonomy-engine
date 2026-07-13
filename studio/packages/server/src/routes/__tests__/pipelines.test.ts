import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION } from '@autonomy-studio/shared';
import { createPipeline, createRun } from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

const emptyVersionBody = { params: [], outputs: [], nodes: [], edges: [] };

describe('pipelines routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('full CRUD round-trip for Pipeline, owner-scoped', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/pipelines',
      payload: { name: 'My pipeline' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.ownerId).toBe('local');

    const getRes = await app.inject({ method: 'GET', url: `/api/pipelines/${created.id}` });
    expect(getRes.json()).toEqual(created);

    const listRes = await app.inject({ method: 'GET', url: '/api/pipelines' });
    expect(listRes.json().map((p: { id: string }) => p.id)).toContain(created.id);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/pipelines/${created.id}`,
      payload: { name: 'Renamed' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().name).toBe('Renamed');

    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/pipelines/${created.id}` });
    expect(deleteRes.statusCode).toBe(204);

    const missing = await app.inject({ method: 'GET', url: `/api/pipelines/${created.id}` });
    expect(missing.statusCode).toBe(404);
  });

  it('PipelineVersion: create + immutability (no update/delete route), version increments', async () => {
    const pipelineRes = await app.inject({
      method: 'POST',
      url: '/api/pipelines',
      payload: { name: 'Versioned' },
    });
    const pipeline = pipelineRes.json();

    const v1Res = await app.inject({
      method: 'POST',
      url: `/api/pipelines/${pipeline.id}/versions`,
      payload: {
        params: [{ name: 'topic', type: 'string', required: true }],
        outputs: [],
        nodes: [],
        edges: [],
      },
    });
    expect(v1Res.statusCode).toBe(201);
    const v1 = v1Res.json();
    expect(v1.version).toBe(1);
    expect(v1.catalogVersion).toBe(CATALOG_VERSION);

    const v2Res = await app.inject({
      method: 'POST',
      url: `/api/pipelines/${pipeline.id}/versions`,
      payload: emptyVersionBody,
    });
    const v2 = v2Res.json();
    expect(v2.version).toBe(2);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/pipelines/${pipeline.id}/versions`,
    });
    expect(listRes.json().map((v: { id: string }) => v.id)).toEqual([v1.id, v2.id]);

    const getV1 = await app.inject({
      method: 'GET',
      url: `/api/pipelines/${pipeline.id}/versions/1`,
    });
    expect(getV1.statusCode).toBe(200);
    expect(getV1.json()).toEqual(v1);

    // No update/delete route exists for a specific version at all — Fastify
    // has no matching route for these methods on this path.
    const patchAttempt = await app.inject({
      method: 'PATCH',
      url: `/api/pipelines/${pipeline.id}/versions/1`,
      payload: {},
    });
    expect([404, 405]).toContain(patchAttempt.statusCode);
    const deleteAttempt = await app.inject({
      method: 'DELETE',
      url: `/api/pipelines/${pipeline.id}/versions/1`,
    });
    expect([404, 405]).toContain(deleteAttempt.statusCode);
  });

  it('deleting a pipeline that has run history is a 409 conflict', async () => {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'HasRuns' });
    const versionRes = await app.inject({
      method: 'POST',
      url: `/api/pipelines/${pipeline.id}/versions`,
      payload: emptyVersionBody,
    });
    const version = versionRes.json();
    createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId: version.id,
      triggerId: null,
      parentRunId: null,
      params: {},
    });

    const deleteRes = await app.inject({ method: 'DELETE', url: `/api/pipelines/${pipeline.id}` });
    expect(deleteRes.statusCode).toBe(409);
    expect(deleteRes.json().error).toBe('conflict');
  });

  it('owner scoping: a pipeline belonging to a different owner is not visible', async () => {
    const other = createPipeline(app.db, { ownerId: 'someone-else', name: 'Not mine' });
    const listRes = await app.inject({ method: 'GET', url: '/api/pipelines' });
    expect(listRes.json().map((p: { id: string }) => p.id)).not.toContain(other.id);
    const getRes = await app.inject({ method: 'GET', url: `/api/pipelines/${other.id}` });
    expect(getRes.statusCode).toBe(404);
  });

  it('validation: bad body -> 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pipelines',
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('404 for a missing pipeline / pipeline version', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pipelines/pipe_missing' });
    expect(res.statusCode).toBe(404);

    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'X' });
    const versionRes = await app.inject({
      method: 'GET',
      url: `/api/pipelines/${pipeline.id}/versions/999`,
    });
    expect(versionRes.statusCode).toBe(404);
  });

  it('constraint violation: creating a version for a nonexistent pipeline 404s (owner-scoped lookup fails first)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/pipelines/pipe_does_not_exist/versions',
      payload: emptyVersionBody,
    });
    expect(res.statusCode).toBe(404);
  });
});
