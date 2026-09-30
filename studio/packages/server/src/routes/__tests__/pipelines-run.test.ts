import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, type Node, type Param } from '@autonomy-studio/shared';
import {
  archivePipelineRow,
  createPipeline,
  createPipelineVersion,
  updatePipeline,
} from '../../repo/index.js';
import { createGlobalParam, deleteGlobalParam } from '../../repo/global-params.js';
import { createRun, listRuns, updateRun } from '../../repo/runs.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/**
 * #1395 OR4 — `POST /api/pipelines/:id/runs`, the editor's Run: one saved
 * version, started now, with no trigger.
 */
describe('POST /api/pipelines/:id/runs', () => {
  let app: FastifyInstance;

  function seed(ownerId: string, params: Param[] = [], nodes: Node[] = []) {
    const pipeline = createPipeline(app.db, { ownerId, name: `Run me ${ownerId}` });
    const version = createPipelineVersion(app.db, {
      pipelineId: pipeline.id,
      params,
      outputs: [],
      nodes,
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

  it('409s an archived pipeline even when the params are ALSO bad — the refusal the operator can act on', async () => {
    const { pipelineId, versionId } = seed('local', [countParam]);
    archivePipelineRow(app.db, pipelineId);
    const res = await run(pipelineId, { pipelineVersionId: versionId, params: { count: 'x' } });
    expect(res.statusCode).toBe(409);
  });

  it('answers 202 skipped, naming the cap, when the pipeline is already running its maximum', async () => {
    const { pipelineId, versionId } = seed('local');
    updatePipeline(app.db, pipelineId, { concurrency: 1 });
    const occupier = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId: versionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    updateRun(app.db, occupier.id, { status: 'running' });

    const res = await run(pipelineId, { pipelineVersionId: versionId });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      outcome: 'skipped',
      reason: 'the pipeline is already running its maximum of 1 at once',
    });
    expect(listRuns(app.db, { pipelineVersionId: versionId })).toHaveLength(1);
    // Release the slot so the shared app's later tests are not held by it.
    updateRun(app.db, occupier.id, { status: 'failure' });
  });

  it('400s a version that reads a global which has since been deleted, naming it, before any run', async () => {
    const g = createGlobalParam(app.db, {
      ownerId: 'local',
      name: 'runRegion',
      type: 'string',
      value: 'eu',
      description: '',
    });
    const { pipelineId, versionId } = seed(
      'local',
      [],
      [
        {
          id: 'a',
          type: 'wait',
          config: { seconds: '${length(global.runRegion)}' },
          position: { x: 0, y: 0 },
        },
      ],
    );
    deleteGlobalParam(app.db, g.id);
    const res = await run(pipelineId, { pipelineVersionId: versionId });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('runRegion');
    expect(listRuns(app.db, { pipelineVersionId: versionId })).toHaveLength(0);
  });
});
