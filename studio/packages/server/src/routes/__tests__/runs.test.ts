import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CATALOG_VERSION, RunDetailSchema } from '@autonomy-studio/shared';
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
    // RS6 — an original run surfaces `rerunOf: null` on the read API.
    expect(getRes.json().rerunOf).toBeNull();
  });

  it("GET /api/runs?rerunOf=<id> filters to a source run's reruns (RS6 grouping)", async () => {
    const source = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    const rerun = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
      rerunOf: source.id,
    });

    const res = await app.inject({ method: 'GET', url: `/api/runs?rerunOf=${source.id}` });
    expect(res.statusCode).toBe(200);
    const ids = res.json().map((r: { id: string }) => r.id);
    expect(ids).toEqual([rerun.id]);
    expect(res.json()[0].rerunOf).toBe(source.id);
  });

  it("GET /api/runs?rerunOf= is owner-scoped — never lists another owner's reruns (authz != authn)", async () => {
    // Authentication is not authorization: the `rerunOf` grouping filter is ANDed
    // with the principal's ownerId, so a caller cannot enumerate another owner's
    // rerun lineage even by supplying their source-run id.
    const source = createRun(app.db, {
      ownerId: 'someone-else',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    createRun(app.db, {
      ownerId: 'someone-else',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
      rerunOf: source.id,
    });

    const res = await app.inject({ method: 'GET', url: `/api/runs?rerunOf=${source.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]); // principal is `local`, not `someone-else`
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

  it('GET /api/runs/:id/cost SUMS the metered events, fail-closed on an absent costEstimate', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    const metered = (fields: Record<string, unknown>) => ({
      type: 'activity.metered',
      runId: run.id,
      nodeId: 'n1',
      attemptId: 'n1#1',
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      meteringStatus: 'metered',
      ...fields,
    });
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.started',
      payload: { type: 'run.started' },
    });
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'activity.metered',
      payload: metered({ inputTokens: 100, outputTokens: 200, costEstimate: 0.0055 }),
    });
    // unpriced response — no costEstimate → must not be summed as 0, flips complete
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'activity.metered',
      payload: metered({ inputTokens: 10, outputTokens: 20 }),
    });

    const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/cost` });
    expect(res.statusCode).toBe(200);
    const cost = res.json();
    expect(cost.currency).toBe('USD');
    expect(cost.responseCount).toBe(2);
    expect(cost.pricedResponseCount).toBe(1);
    expect(cost.costUnknownResponseCount).toBe(1);
    expect(cost.totalCostEstimate).toBeCloseTo(0.0055, 10);
    expect(cost.complete).toBe(false);
  });

  it('GET /api/runs/:id/cost 404s for a run owned by someone else', async () => {
    const other = createRun(app.db, {
      ownerId: 'someone-else',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    const res = await app.inject({ method: 'GET', url: `/api/runs/${other.id}/cost` });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/runs/:id/rerun-from-failed → 202 { runId } for an owned FAILED run', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId, // a ZERO-node version — reseed frontier is empty, R2 drives trivially
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    // A minimal valid failed log (parses through EngineEventSchema on load).
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.started',
      payload: { type: 'run.started', runId: run.id, pipelineVersionId, params: {} },
    });
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.finished',
      payload: { type: 'run.finished', runId: run.id, outcome: 'failure', reason: 'boom' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/rerun-from-failed`,
    });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();
    expect(typeof runId).toBe('string');
    expect(runId).not.toBe(run.id);
  });

  it('POST /api/runs/:id/rerun-from-failed → 409 for a SUCCESSFUL run (not eligible)', async () => {
    const run = createRun(app.db, {
      ownerId: 'local',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.started',
      payload: { type: 'run.started', runId: run.id, pipelineVersionId, params: {} },
    });
    appendRunEvent(app.db, {
      runId: run.id,
      type: 'run.finished',
      payload: { type: 'run.finished', runId: run.id, outcome: 'success' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/rerun-from-failed`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflict');
  });

  it('POST /api/runs/:id/rerun-from-failed → 404 for a missing OR other-owner run (no oracle)', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/runs/run_missing/rerun-from-failed',
    });
    expect(missing.statusCode).toBe(404);

    const other = createRun(app.db, {
      ownerId: 'someone-else',
      pipelineVersionId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    appendRunEvent(app.db, {
      runId: other.id,
      type: 'run.started',
      payload: { type: 'run.started', runId: other.id, pipelineVersionId, params: {} },
    });
    appendRunEvent(app.db, {
      runId: other.id,
      type: 'run.finished',
      payload: { type: 'run.finished', runId: other.id, outcome: 'failure' },
    });
    const otherRes = await app.inject({
      method: 'POST',
      url: `/api/runs/${other.id}/rerun-from-failed`,
    });
    expect(otherRes.statusCode).toBe(404);
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

  describe('R1 — GET /api/runs/:id/detail (the run-detail read-model)', () => {
    it('resolves the run AND its bound version doc in one call', async () => {
      const pipeline = createPipeline(app.db, { ownerId: 'local', name: 'R1 detail' });
      const version = createPipelineVersion(app.db, {
        pipelineId: pipeline.id,
        params: [],
        outputs: [],
        nodes: [
          { id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
          { id: 'b', type: 'http_request', position: { x: 200, y: 0 }, config: {} },
        ],
        edges: [{ id: 'e1', from: 'a', to: 'b', on: 'success' }],
        catalogVersion: CATALOG_VERSION,
      });
      const run = createRun(app.db, {
        ownerId: 'local',
        pipelineVersionId: version.id,
        triggerId: null,
        parentRunId: null,
        params: { topic: 'r1' },
      });

      const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/detail` });
      expect(res.statusCode).toBe(200);

      // Parsed through the SHARED schema, so this asserts the wire contract the
      // web client re-parses, not just "some JSON came back".
      const detail = RunDetailSchema.parse(res.json());
      expect(detail.run.id).toBe(run.id);
      expect(detail.pipelineVersion.id).toBe(version.id);
      // The DOC is the whole point — U11 cannot project node state without it.
      expect(detail.pipelineVersion.nodes.map((n) => n.id)).toEqual(['a', 'b']);
      expect(detail.pipelineVersion.edges).toHaveLength(1);
    });

    it("404s for a run belonging to a different owner — a run handle must not leak someone else's doc", async () => {
      // The version doc carries node config and param defaults, so this route
      // hands out strictly MORE than `GET /api/runs/:id`. The ownership proof is
      // the run's, and it has to actually run.
      const other = createRun(app.db, {
        ownerId: 'someone-else',
        pipelineVersionId,
        triggerId: null,
        parentRunId: null,
        params: {},
      });

      const res = await app.inject({ method: 'GET', url: `/api/runs/${other.id}/detail` });
      expect(res.statusCode).toBe(404);
    });

    it('404s for a missing run (same response as the other-owner case — no oracle)', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/runs/run_missing/detail' });
      expect(res.statusCode).toBe(404);
    });
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
