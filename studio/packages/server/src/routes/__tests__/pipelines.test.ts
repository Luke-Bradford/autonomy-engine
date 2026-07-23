import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION } from '@autonomy-studio/shared';
import {
  appendRunEvent,
  createPipeline,
  createPipelineVersion,
  createRun,
  createTrigger,
  getPipeline,
  getTrigger,
} from '../../repo/index.js';
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
    expect(listRes.json().items.map((p: { id: string }) => p.id)).toContain(created.id);

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

  it('#5 S6b — concurrency cap: create with a cap, PATCH it, clear it with an explicit null, reject invalid caps', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/pipelines',
      payload: { name: 'Capped', concurrency: 2 },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.concurrency).toBe(2);

    // Absent from a PATCH → preserved (partial semantics).
    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/pipelines/${created.id}`,
      payload: { name: 'Still capped' },
    });
    expect(rename.json().concurrency).toBe(2);

    // PATCH to a new cap.
    const raise = await app.inject({
      method: 'PATCH',
      url: `/api/pipelines/${created.id}`,
      payload: { concurrency: 5 },
    });
    expect(raise.statusCode).toBe(200);
    expect(raise.json().concurrency).toBe(5);

    // Explicit null CLEARS the cap (uncapped) — distinct from absent.
    const clear = await app.inject({
      method: 'PATCH',
      url: `/api/pipelines/${created.id}`,
      payload: { concurrency: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().concurrency).toBeNull();

    // The WRITE boundary refuses a non-positive-integer cap.
    for (const bad of [0, -1, 1.5]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/pipelines/${created.id}`,
        payload: { concurrency: bad },
      });
      expect(res.statusCode).toBe(400);
    }

    // A default create is uncapped.
    const plain = await app.inject({
      method: 'POST',
      url: '/api/pipelines',
      payload: { name: 'Uncapped' },
    });
    expect(plain.json().concurrency).toBeNull();
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

  it('GET /api/pipelines/:id/cost rolls up cost across ALL versions of the pipeline, fail-closed', async () => {
    const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'CostPipe' });
    const mkVersion = async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/versions`,
        payload: emptyVersionBody,
      });
      return res.json().id as string;
    };
    const v1 = await mkVersion();
    const v2 = await mkVersion();

    const mkRun = (pipelineVersionId: string) =>
      createRun(app.db, {
        ownerId: 'local',
        pipelineVersionId,
        triggerId: null,
        parentRunId: null,
        params: {},
      });
    const runV1 = mkRun(v1);
    const runV2 = mkRun(v2);
    mkRun(v1); // a zero-cost run (no metered events) — counts toward runCount only

    const metered = (runId: string, fields: Record<string, unknown>) => ({
      type: 'activity.metered',
      runId,
      nodeId: 'n1',
      attemptId: 'n1#1',
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      meteringStatus: 'metered',
      ...fields,
    });
    appendRunEvent(app.db, {
      runId: runV1.id,
      type: 'activity.metered',
      payload: metered(runV1.id, { inputTokens: 100, outputTokens: 100, costEstimate: 0.01 }),
    });
    // runV2 has an unpriced response → runV2 incomplete, rollup incomplete
    appendRunEvent(app.db, {
      runId: runV2.id,
      type: 'activity.metered',
      payload: metered(runV2.id, { inputTokens: 50, outputTokens: 50, costEstimate: 0.005 }),
    });
    appendRunEvent(app.db, {
      runId: runV2.id,
      type: 'activity.metered',
      payload: metered(runV2.id, { inputTokens: 10, outputTokens: 10 }),
    });

    const res = await app.inject({ method: 'GET', url: `/api/pipelines/${pipeline.id}/cost` });
    expect(res.statusCode).toBe(200);
    const rollup = res.json();
    expect(rollup.runCount).toBe(3);
    expect(rollup.responseCount).toBe(3);
    expect(rollup.pricedResponseCount).toBe(2);
    expect(rollup.costUnknownResponseCount).toBe(1);
    expect(rollup.totalCostEstimate).toBeCloseTo(0.015, 10);
    expect(rollup.incompleteRunCount).toBe(1);
    expect(rollup.complete).toBe(false);
  });

  it('GET /api/pipelines/:id/cost 404s for a pipeline owned by someone else', async () => {
    const other = createPipeline(app.db, { ownerId: 'someone-else', name: 'NotMineCost' });
    const res = await app.inject({ method: 'GET', url: `/api/pipelines/${other.id}/cost` });
    expect(res.statusCode).toBe(404);
  });

  it('owner scoping: a pipeline belonging to a different owner is not visible', async () => {
    const other = createPipeline(app.db, { ownerId: 'someone-else', name: 'Not mine' });
    const listRes = await app.inject({ method: 'GET', url: '/api/pipelines' });
    expect(listRes.json().items.map((p: { id: string }) => p.id)).not.toContain(other.id);
    const getRes = await app.inject({ method: 'GET', url: `/api/pipelines/${other.id}` });
    expect(getRes.statusCode).toBe(404);
  });

  describe('#3 G5a — POST /api/pipelines/:id/archive', () => {
    function seedBoundEnabledTrigger(pipelineId: string) {
      const version = createPipelineVersion(app.db, {
        pipelineId,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
      return createTrigger(app.db, {
        ownerId: 'local',
        name: 'Nightly',
        pipelineVersionId: version.id,
        params: {},
        mode: 'schedule',
        schedule: '0 2 * * *',
        webhook: null,
        concurrency: { policy: 'skip_if_running' },
        runWindows: null,
        enabled: true,
      });
    }

    it('archives the pipeline, disables its dependent triggers, and drops it off the list', async () => {
      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'ToArchive' });
      const trigger = seedBoundEnabledTrigger(pipeline.id);

      const res = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/archive`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().archived).toBe(true);
      expect(getTrigger(app.db, trigger.id)!.enabled).toBe(false);

      // Dropped from the default list, still reachable by id.
      const listRes = await app.inject({ method: 'GET', url: '/api/pipelines' });
      expect(listRes.json().items.map((p: { id: string }) => p.id)).not.toContain(pipeline.id);
      const getRes = await app.inject({ method: 'GET', url: `/api/pipelines/${pipeline.id}` });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().archived).toBe(true);
    });

    it('is idempotent (a second archive still 200s)', async () => {
      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'ArchiveTwice' });
      const first = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/archive`,
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/archive`,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().archived).toBe(true);
    });

    it('404s for a missing pipeline and for one owned by someone else (authz)', async () => {
      const missing = await app.inject({
        method: 'POST',
        url: '/api/pipelines/pipe_missing/archive',
      });
      expect(missing.statusCode).toBe(404);

      const other = createPipeline(app.db, { ownerId: 'someone-else', name: 'NotMineArchive' });
      const notMine = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${other.id}/archive`,
      });
      expect(notMine.statusCode).toBe(404);
      // Untouched — authz refused before any write (still un-archived).
      expect(getPipeline(app.db, other.id)!.archived).toBe(false);
    });
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

  // #444 — the write gate over HTTP. The repo tests own the RULES; these own
  // the wire contract: the status, the code, and the body shape the canvas
  // actually renders.
  describe('POST /versions refuses an invalid doc (#444)', () => {
    async function postDoc(payload: Record<string, unknown>) {
      const pipelineRes = await app.inject({
        method: 'POST',
        url: '/api/pipelines',
        payload: { name: 'Gated' },
      });
      const pipeline = pipelineRes.json();
      const res = await app.inject({
        method: 'POST',
        url: `/api/pipelines/${pipeline.id}/versions`,
        payload,
      });
      return { pipeline, res };
    }

    it('400 invalid_pipeline_doc for a forward cycle, and stores NOTHING', async () => {
      const { pipeline, res } = await postDoc({
        ...emptyVersionBody,
        nodes: [
          { id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } },
          { id: 'b', type: 'agent_task', config: {}, position: { x: 0, y: 0 } },
        ],
        edges: [
          { id: 'e1', from: 'a', to: 'b', on: 'success' },
          { id: 'e2', from: 'b', to: 'a', on: 'success' },
        ],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_pipeline_doc');

      const list = await app.inject({
        method: 'GET',
        url: `/api/pipelines/${pipeline.id}/versions`,
      });
      expect(list.json()).toEqual([]);
    });

    it('carries a `message` AND object-shaped `issues` — the shape the client renders', async () => {
      const { res } = await postDoc({
        ...emptyVersionBody,
        nodes: [
          {
            id: 'a',
            type: 'agent_task',
            config: { prompt: '${params.nope}' },
            position: { x: 0, y: 0 },
          },
        ],
      });
      const body = res.json();

      // REGRESSION PIN on the client contract (`@autonomy-studio/shared`'s
      // `ApiErrorBody`). `messageFromBody` returns `message` when present, and
      // otherwise joins `issues` READ AS OBJECTS (`issue.path`/`issue.message`).
      // So `message` is what the canvas renders today, and the object shape is
      // what keeps `issues` renderable rather than joining to `; ` if `message`
      // were ever dropped. Both halves pinned.
      expect(typeof body.message).toBe('string');
      expect(body.message.length).toBeGreaterThan(0);
      expect(body.issues).toEqual([
        { message: 'nodes.a.config.prompt: ${params.nope} is not a declared param' },
      ]);
    });

    it('still accepts a VALID doc (201) — the gate refuses invalid docs, not all docs', async () => {
      const { res } = await postDoc({
        ...emptyVersionBody,
        nodes: [{ id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } }],
      });
      expect(res.statusCode).toBe(201);
    });
  });
});
