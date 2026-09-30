import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, type Param } from '@autonomy-studio/shared';
import { archivePipelineRow, createPipeline, createPipelineVersion } from '../../repo/index.js';
import { listRuns } from '../../repo/runs.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/**
 * #1395 OR4 — `POST /api/pipelines/:id/runs`, the editor's Run: one saved
 * version, started now, with no trigger.
 */
describe('POST /api/pipelines/:id/runs', () => {
  let app: FastifyInstance;

  function seed(ownerId: string, params: Param[] = []) {
    const pipeline = createPipeline(app.db, { ownerId, name: `Run me ${ownerId}` });
    const version = createPipelineVersion(app.db, {
      pipelineId: pipeline.id,
      params,
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    return { pipelineId: pipeline.id, versionId: version.id };
  }

  function run(pipelineId: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: `/api/pipelines/${pipelineId}/runs`, payload });
  }

  const countParam: Param = { name: 'count', type: 'number', required: true };

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('starts a trigger-less run of that version, which runs to success with the params given', async () => {
    const { pipelineId, versionId } = seed('local', [countParam]);
    const res = await run(pipelineId, { pipelineVersionId: versionId, params: { count: 3 } });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.outcome).toBe('started');

    await app.runLauncher.whenIdle();
    const runRes = await app.inject({ method: 'GET', url: `/api/runs/${body.runId}` });
    expect(runRes.json()).toMatchObject({
      status: 'success',
      triggerId: null,
      pipelineVersionId: versionId,
      params: { count: 3 },
    });
  });

  it('refuses a param the version cannot take with a 400 naming it, BEFORE any run exists', async () => {
    const { pipelineId, versionId } = seed('local', [countParam]);
    const wrongType = await run(pipelineId, {
      pipelineVersionId: versionId,
      params: { count: 'three' },
    });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.json().message).toContain('count');

    const missing = await run(pipelineId, { pipelineVersionId: versionId });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toContain("required param 'count'");

    const undeclared = await run(pipelineId, {
      pipelineVersionId: versionId,
      params: { count: 1, nope: 2 },
    });
    expect(undeclared.statusCode).toBe(400);
    expect(undeclared.json().message).toContain("'nope'");

    expect(listRuns(app.db, { pipelineVersionId: versionId })).toHaveLength(0);
  });

  it('refuses a body with no version: 400', async () => {
    const { pipelineId } = seed('local');
    expect((await run(pipelineId, {})).statusCode).toBe(400);
  });

  it('404s a version of ANOTHER pipeline, a missing version, and another owner’s pipeline alike', async () => {
    const mine = seed('local');
    const other = seed('local');
    const foreign = seed('someone-else');

    const crossed = await run(mine.pipelineId, { pipelineVersionId: other.versionId });
    expect(crossed.statusCode).toBe(404);
    const missing = await run(mine.pipelineId, { pipelineVersionId: 'pv_nope' });
    expect(missing.statusCode).toBe(404);
    const notMine = await run(foreign.pipelineId, { pipelineVersionId: foreign.versionId });
    expect(notMine.statusCode).toBe(404);

    for (const v of [other.versionId, foreign.versionId]) {
      expect(listRuns(app.db, { pipelineVersionId: v })).toHaveLength(0);
    }
  });

  it('409s an archived pipeline and creates no run', async () => {
    const { pipelineId, versionId } = seed('local');
    archivePipelineRow(app.db, pipelineId);
    const res = await run(pipelineId, { pipelineVersionId: versionId });
    expect(res.statusCode).toBe(409);
    expect(listRuns(app.db, { pipelineVersionId: versionId })).toHaveLength(0);
  });
});
