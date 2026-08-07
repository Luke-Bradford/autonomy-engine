import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AiActivitySnapshotSchema, CATALOG_VERSION } from '@autonomy-studio/shared';
import { buildTestAppWithContext } from '../../__tests__/build-test-app.js';
import { runEvents } from '../../db/schema.js';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun } from '../../repo/runs.js';
import type { Db } from '../../repo/types.js';

/**
 * #917 — `GET /api/monitor/ai-activity`, the cross-run AI-activity surface.
 *
 * The repo suite (`repo/__tests__/ai-activity.test.ts`) owns the aggregation
 * arithmetic; these tests own the ROUTE's own decisions — the window vocabulary,
 * that the lower bound is resolved server-side, the wire shape, and the owner
 * scope. Deliberately not a second copy of the aggregate's assertions.
 */

const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

let seq = 0;

function seedMetered(
  db: Db,
  opts: { ownerId?: string; ageMs: number; model?: string; cost?: number },
): void {
  const ownerId = opts.ownerId ?? 'local';
  const pipeline = createPipeline(db, { ownerId, name: `P-${seq}` });
  const version = createPipelineVersion(db, {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  });
  const run = createRun(db, {
    ownerId,
    pipelineVersionId: version.id,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
  db.insert(runEvents)
    .values({
      id: `evt-${seq}`,
      runId: run.id,
      seq: seq++,
      type: 'activity.metered',
      payload: {
        type: 'activity.metered',
        runId: run.id,
        nodeId: 'n1',
        attemptId: 'n1#1',
        provider: 'anthropic_api',
        model: opts.model ?? 'claude-opus-4-8',
        meteringStatus: 'metered',
        inputTokens: 100,
        outputTokens: 10,
        ...(opts.cost === undefined
          ? {}
          : {
              inUnitPrice: 5,
              outUnitPrice: 25,
              costEstimate: opts.cost,
              priceTableVersion: 'test',
            }),
      },
      ts: Date.now() - opts.ageMs,
    })
    .run();
}

async function makeApp(): Promise<{ app: FastifyInstance; db: Db }> {
  const { app } = await buildTestAppWithContext();
  apps.push(app);
  return { app, db: app.db };
}

const HOUR = 60 * 60 * 1000;

describe('GET /api/monitor/ai-activity', () => {
  it('answers the documented wire shape', async () => {
    const { app, db } = await makeApp();
    seedMetered(db, { ageMs: 60_000, cost: 1.5 });

    const res = await app.inject({ method: 'GET', url: '/api/monitor/ai-activity' });

    expect(res.statusCode).toBe(200);
    // Parsed through the shared schema rather than spot-checked: `.strict()`
    // then also catches a field the route invents that no consumer expects.
    const body = AiActivitySnapshotSchema.parse(res.json());
    expect(body.since).toBe('1h');
    expect(body.models).toHaveLength(1);
    expect(body.models[0]?.model).toBe('claude-opus-4-8');
    expect(body.totals.totalCostEstimate).toBeCloseTo(1.5);
  });

  it('defaults to the last hour, excluding older exchanges', async () => {
    const { app, db } = await makeApp();
    seedMetered(db, { ageMs: 5 * 60_000, cost: 1 });
    seedMetered(db, { ageMs: 5 * HOUR, model: 'old-model', cost: 99 });

    const body = AiActivitySnapshotSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/monitor/ai-activity' })).json(),
    );

    expect(body.models.map((m) => m.model)).toEqual(['claude-opus-4-8']);
    expect(body.totals.totalCostEstimate).toBeCloseTo(1);
  });

  it('widens the window on request', async () => {
    const { app, db } = await makeApp();
    seedMetered(db, { ageMs: 5 * 60_000, cost: 1 });
    seedMetered(db, { ageMs: 5 * HOUR, model: 'old-model', cost: 99 });

    const body = AiActivitySnapshotSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/monitor/ai-activity?since=24h' })).json(),
    );

    expect(body.since).toBe('24h');
    expect(body.models).toHaveLength(2);
  });

  /**
   * The window bound is the SERVER's arithmetic, from the same clock that stamps
   * `run_events.ts`. Asserting it here is what stops a later refactor moving the
   * subtraction to the client, where its skew would silently resize the window.
   */
  it('resolves the window lower bound server-side, against its own clock', async () => {
    const { app } = await makeApp();
    const before = Date.now();

    const body = AiActivitySnapshotSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/monitor/ai-activity?since=24h' })).json(),
    );

    expect(body.generatedAt).toBeGreaterThanOrEqual(before);
    expect(body.windowStart).toBe(body.generatedAt - 24 * HOUR);
  });

  it('rejects a window outside the shared vocabulary rather than filtering by it', async () => {
    const { app } = await makeApp();

    const res = await app.inject({ method: 'GET', url: '/api/monitor/ai-activity?since=nonsense' });

    expect(res.statusCode).toBe(400);
  });

  /**
   * SECURITY — the owner scope reaches the SQL, so a second owner's spend is
   * never summed into the totals, not merely omitted from the table.
   */
  it('never sums another owner’s spend into the response', async () => {
    const { app, db } = await makeApp();
    seedMetered(db, { ageMs: 60_000, cost: 1 });
    seedMetered(db, { ownerId: 'someone-else', ageMs: 60_000, model: 'theirs', cost: 500 });

    const body = AiActivitySnapshotSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/monitor/ai-activity' })).json(),
    );

    expect(body.models).toHaveLength(1);
    expect(body.totals.totalCostEstimate).toBeCloseTo(1);
  });

  it('reports an empty window as real zeroes with a null agent-CLI instant', async () => {
    const { app } = await makeApp();

    const body = AiActivitySnapshotSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/monitor/ai-activity' })).json(),
    );

    expect(body.models).toEqual([]);
    expect(body.totals.responseCount).toBe(0);
    // No exchanges genuinely IS complete — there is nothing missing.
    expect(body.totals.complete).toBe(true);
    expect(body.agentCli.invocations).toBe(0);
    expect(body.agentCli.lastAt).toBeNull();
    expect(body.runs).toEqual({ pending: 0, queued: 0, running: 0, waiting: 0 });
  });
});
