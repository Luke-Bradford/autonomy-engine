import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, type Node, type Param } from '@autonomy-studio/shared';
import { pipelineVersions } from '../../db/schema.js';
import {
  archivePipelineRow,
  createPipeline,
  createPipelineVersion,
  updatePipeline,
} from '../../repo/index.js';
import { createRun, updateRun } from '../../repo/runs.js';
import { buildTestApp, buildTestAppWithContext } from '../../__tests__/build-test-app.js';

/**
 * #1395 OR4 slice 3 — `POST /api/pipelines/:id/debug-runs`, the editor's Debug:
 * the unsaved draft, minted as a hidden debug version and run.
 */
describe('POST /api/pipelines/:id/debug-runs', () => {
  let app: FastifyInstance;

  const countParam: Param = { name: 'count', type: 'number', required: true };

  function draft(params: Param[] = [], nodes: Node[] = []) {
    return { params, outputs: [], nodes, edges: [], catalogVersion: CATALOG_VERSION };
  }

  function newPipeline(ownerId = 'local') {
    return createPipeline(app.db, { ownerId, name: `Debug me ${ownerId}` }).id;
  }

  function debug(pipelineId: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: `/api/pipelines/${pipelineId}/debug-runs`, payload });
  }

  function debugRows(pipelineId: string) {
    return app.db
      .select({ id: pipelineVersions.id })
      .from(pipelineVersions)
      .where(and(eq(pipelineVersions.pipelineId, pipelineId), eq(pipelineVersions.debug, true)))
      .all();
  }

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('runs the draft to success as a debug version that no listing, head or save sees', async () => {
    const pipelineId = newPipeline();
    const saved = createPipelineVersion(app.db, { pipelineId, ...draft() });

    const res = await debug(pipelineId, { version: draft([countParam]), params: { count: 2 } });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ outcome: 'started', retentionDays: 7 });
    expect(body.pipelineVersion).toMatchObject({ pipelineId, version: 1, params: [countParam] });

    await app.runLauncher.whenIdle();
    const runRes = await app.inject({ method: 'GET', url: `/api/runs/${body.runId}` });
    expect(runRes.json()).toMatchObject({
      status: 'success',
      triggerId: null,
      pipelineVersionId: body.pipelineVersion.id,
      params: { count: 2 },
    });

    const list = await app.inject({ method: 'GET', url: `/api/pipelines/${pipelineId}/versions` });
    expect(list.json().map((v: { id: string }) => v.id)).toEqual([saved.id]);

    // The next save is based on the SAVED head and takes v2, not a number the
    // debug version used.
    const save = await app.inject({
      method: 'POST',
      url: `/api/pipelines/${pipelineId}/versions`,
      payload: { ...draft(), basedOnVersionId: saved.id },
    });
    expect(save.statusCode).toBe(201);
    expect(save.json().version).toBe(2);
  });

  it('works on a pipeline with no saved version yet, which still has none afterwards', async () => {
    const pipelineId = newPipeline();
    const res = await debug(pipelineId, { version: draft() });
    expect(res.json().outcome).toBe('started');
    await app.runLauncher.whenIdle();
    const list = await app.inject({ method: 'GET', url: `/api/pipelines/${pipelineId}/versions` });
    expect(list.json()).toEqual([]);
  });

  it('refuses a param the draft cannot take with a 400, writing no version', async () => {
    const pipelineId = newPipeline();
    const res = await debug(pipelineId, { version: draft([countParam]), params: { count: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('count');
    expect(debugRows(pipelineId)).toHaveLength(0);
  });

  it('refuses a draft the save gate would refuse with a 400, writing no version', async () => {
    const pipelineId = newPipeline();
    const res = await debug(pipelineId, {
      version: {
        ...draft(),
        nodes: [{ id: 'a', type: 'wait', config: { seconds: '${1}' }, position: { x: 0, y: 0 } }],
        edges: [{ id: 'e', from: 'a', to: 'ghost', condition: { kind: 'success' } }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(debugRows(pipelineId)).toHaveLength(0);
  });

  it('409s an archived pipeline, writing no version', async () => {
    const pipelineId = newPipeline();
    archivePipelineRow(app.db, pipelineId);
    const res = await debug(pipelineId, { version: draft() });
    expect(res.statusCode).toBe(409);
    expect(debugRows(pipelineId)).toHaveLength(0);
  });

  it('404s another owner’s pipeline', async () => {
    const pipelineId = newPipeline('someone-else');
    expect((await debug(pipelineId, { version: draft() })).statusCode).toBe(404);
    expect(debugRows(pipelineId)).toHaveLength(0);
  });

  it('answers skipped at the concurrency cap and deletes the version it minted', async () => {
    const pipelineId = newPipeline();
    const saved = createPipelineVersion(app.db, { pipelineId, ...draft() });
    updatePipeline(app.db, pipelineId, { concurrency: 1 });
    const occupier = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId: saved.id,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    updateRun(app.db, occupier.id, { status: 'running' });

    const res = await debug(pipelineId, { version: draft() });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      outcome: 'skipped',
      reason: 'the pipeline is already running its maximum of 1 at once',
      retentionDays: 7,
    });
    expect(debugRows(pipelineId)).toHaveLength(0);
    updateRun(app.db, occupier.id, { status: 'failure' });
  });

  it('deletes the version it minted when starting the run throws', async () => {
    const pipelineId = newPipeline();
    const runNow = app.runLauncher.runNow;
    app.runLauncher.runNow = () => {
      throw new Error('launcher exploded');
    };
    try {
      const res = await debug(pipelineId, { version: draft() });
      expect(res.statusCode).toBe(500);
    } finally {
      app.runLauncher.runNow = runNow;
    }
    expect(debugRows(pipelineId)).toHaveLength(0);
  });

  it('Run by id accepts a debug version, as a rerun of a debug run does', async () => {
    const pipelineId = newPipeline();
    const res = await debug(pipelineId, { version: draft() });
    const debugId: string = res.json().pipelineVersion.id;
    await app.runLauncher.whenIdle();
    const again = await app.inject({
      method: 'POST',
      url: `/api/pipelines/${pipelineId}/runs`,
      payload: { pipelineVersionId: debugId },
    });
    expect(again.statusCode).toBe(202);
    expect(again.json().outcome).toBe('started');
    await app.runLauncher.whenIdle();
  });

  it('a trigger cannot bind a debug version: 400 on create and on patch', async () => {
    const pipelineId = newPipeline();
    const saved = createPipelineVersion(app.db, { pipelineId, ...draft() });
    const res = await debug(pipelineId, { version: draft() });
    const debugId: string = res.json().pipelineVersion.id;
    await app.runLauncher.whenIdle();

    const trigger = (pipelineVersionId: string) => ({
      name: 'Nightly',
      pipelineVersionId,
      params: {},
      mode: 'schedule' as const,
      schedule: '0 2 * * *',
      webhook: null,
      concurrency: { policy: 'skip_if_running' as const },
      runWindows: null,
      enabled: false,
    });
    const create = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: trigger(debugId),
    });
    expect(create.statusCode).toBe(400);
    expect(create.json().message).toContain('debug version');

    const ok = await app.inject({
      method: 'POST',
      url: '/api/triggers',
      payload: trigger(saved.id),
    });
    expect(ok.statusCode).toBe(201);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/triggers/${ok.json().id}`,
      payload: { pipelineVersionId: debugId },
    });
    expect(patch.statusCode).toBe(400);
  });

  it('reports retentionDays null when debug runs are kept forever', async () => {
    const { app: keepApp } = await buildTestAppWithContext({ debugRetentionMs: 0 });
    try {
      const pipelineId = createPipeline(keepApp.db, { ownerId: 'local', name: 'Keep' }).id;
      const res = await keepApp.inject({
        method: 'POST',
        url: `/api/pipelines/${pipelineId}/debug-runs`,
        payload: { version: draft() },
      });
      expect(res.json()).toMatchObject({ outcome: 'started', retentionDays: null });
      await keepApp.runLauncher.whenIdle();
    } finally {
      await keepApp.close();
    }
  });
});
