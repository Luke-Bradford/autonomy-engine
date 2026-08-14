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

/**
 * #988 — `POST /api/monitor/external-activity`, the ingest seam.
 *
 * The repo suite owns the merge/window/retention arithmetic; these own the
 * ROUTE's decisions: what it refuses, what status it answers, and that a report
 * reaches the read surface without being folded into studio's own figures.
 */
describe('POST /api/monitor/external-activity', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    source: 'studio-build-loop',
    externalId: 'fire-77',
    agent: 'claude',
    startedAt: Date.now() - 60_000,
    ...over,
  });

  const post = async (app: FastifyInstance, payload: Record<string, unknown>) =>
    await app.inject({ method: 'POST', url: '/api/monitor/external-activity', payload });

  it('answers 201 on first sight and 200 on a re-report of the same invocation', async () => {
    const { app } = await makeApp();

    const first = await post(app, body());
    const second = await post(app, body({ endedAt: Date.now(), outcome: 'completed' }));

    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(true);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    // One row, not two — the id is the proof, not merely the count.
    expect(second.json().id).toBe(first.json().id);
  });

  it('reaches the read surface without being summed into studio’s own figures', async () => {
    const { app } = await makeApp();
    await post(app, body({ inputTokens: 11, outputTokens: 22 }));

    const res = await app.inject({ method: 'GET', url: '/api/monitor/ai-activity' });
    const snapshot = AiActivitySnapshotSchema.parse(res.json());

    expect(snapshot.external.invocations).toBe(1);
    expect(snapshot.external.inFlight).toBe(1);
    expect(snapshot.external.tokens.inputTokens).toBe(11);
    // THE separation this ticket turns on: reported tokens are not studio spend.
    expect(snapshot.totals.inputTokens).toBe(0);
    expect(snapshot.totals.responseCount).toBe(0);
    expect(snapshot.models).toEqual([]);
    expect(snapshot.agentCli.invocations).toBe(0);
  });

  it('refuses a source or agent that is not a slug', async () => {
    const { app } = await makeApp();

    // A newline would break the row it renders into; a leading dot is not a name.
    expect((await post(app, body({ source: 'build\nloop' }))).statusCode).toBe(400);
    expect((await post(app, body({ agent: '.claude' }))).statusCode).toBe(400);
    expect((await post(app, body({ source: 'studio-build-loop.2_a' }))).statusCode).toBe(201);
  });

  it('refuses an invocation that ended before it started', async () => {
    const { app } = await makeApp();
    const startedAt = Date.now();

    const res = await post(app, body({ startedAt, endedAt: startedAt - 1, outcome: 'completed' }));

    expect(res.statusCode).toBe(400);
  });

  /**
   * A settled outcome with no end stamp is a contradiction, and refusing it is
   * what lets `endedAt === null` be the single trustworthy in-flight signal.
   */
  it('refuses a settled outcome with no end stamp', async () => {
    const { app } = await makeApp();

    expect((await post(app, body({ outcome: 'completed' }))).statusCode).toBe(400);
    expect((await post(app, body({ outcome: 'unknown' }))).statusCode).toBe(201);
  });

  it('refuses an unknown field rather than silently dropping it', async () => {
    const { app } = await makeApp();

    // `.strict()` — a reporter sending `cost` must be told studio does not take
    // it, not have it quietly discarded.
    expect((await post(app, body({ costUsd: 1.23 }))).statusCode).toBe(400);
  });

  /**
   * An unbounded future start stamp is a row that is INVISIBLE (the window
   * excludes anything starting after now) yet occupies the table — and one that
   * keeps being re-reported never expires either.
   */
  it('refuses a start stamp far in the future, while tolerating real clock skew', async () => {
    const { app } = await makeApp();

    const skewed = await post(app, body({ externalId: 'skewed', startedAt: Date.now() + 60_000 }));
    const absurd = await post(app, body({ externalId: 'absurd', startedAt: Date.now() + 864e5 }));

    expect(skewed.statusCode).toBe(201);
    expect(absurd.statusCode).toBe(400);
  });

  it('refuses a negative token count', async () => {
    const { app } = await makeApp();

    expect((await post(app, body({ inputTokens: -1 }))).statusCode).toBe(400);
  });
});
