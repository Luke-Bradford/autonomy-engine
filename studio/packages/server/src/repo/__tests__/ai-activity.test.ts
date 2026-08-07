import { describe, expect, it } from 'vitest';
import { BUILTIN_PRICE_TABLE_VERSION, CATALOG_VERSION } from '@autonomy-studio/shared';
import { runEvents } from '../../db/schema.js';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import { aggregateAiActivity } from '../ai-activity.js';
import { createRun, updateRun } from '../runs.js';
import { freshDb } from './helpers.js';

type Db = ReturnType<typeof freshDb>['db'];

function mkRun(db: Db, ownerId = 'local') {
  const pipeline = createPipeline(db, { ownerId, name: `P-${ownerId}-${Math.random()}` });
  const version = createPipelineVersion(db, {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  });
  return createRun(db, {
    ownerId,
    pipelineVersionId: version.id,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
}

/**
 * Rows are inserted DIRECTLY rather than through `appendRunEvent`, because these
 * aggregates are windowed on `run_events.ts` and `appendRunEvent` stamps that
 * column from the wall clock — a window test needs to place events at chosen
 * instants. The payloads are WELL-FORMED (the same soundness condition
 * `aggregatePipelineCost` documents: the SQL trusts the stored type + payload
 * only because `appendEngineEvent` validates before insert, so a fixture that
 * hand-crafted a malformed one would be testing a state production cannot reach).
 */
let seq = 0;
function insertMetered(
  db: Db,
  runId: string,
  fields: {
    ts: number;
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    meteringStatus?: 'metered' | 'unknown' | 'unpriced';
  },
): void {
  const payload: Record<string, unknown> = {
    type: 'activity.metered',
    runId,
    nodeId: 'n1',
    attemptId: 'n1#1',
    provider: fields.provider ?? 'anthropic_api',
    model: fields.model ?? 'claude-opus-4-8',
    meteringStatus: fields.meteringStatus ?? 'metered',
  };
  if (fields.inputTokens !== undefined) payload['inputTokens'] = fields.inputTokens;
  if (fields.outputTokens !== undefined) payload['outputTokens'] = fields.outputTokens;
  if (fields.cost !== undefined) {
    payload['inUnitPrice'] = 5;
    payload['outUnitPrice'] = 25;
    payload['costEstimate'] = fields.cost;
    payload['priceTableVersion'] = BUILTIN_PRICE_TABLE_VERSION;
  }
  db.insert(runEvents)
    .values({
      id: `evt-${seq}`,
      runId,
      seq: seq++,
      type: 'activity.metered',
      payload,
      ts: fields.ts,
    })
    .run();
}

function insertAgentTelemetry(
  db: Db,
  runId: string,
  fields: {
    ts: number;
    summary?: 'completed' | 'timedOut' | 'aborted' | 'killed' | 'signalled' | 'spawnFailed';
  },
): void {
  const payload: Record<string, unknown> = {
    type: 'activity.agentTelemetry',
    runId,
    nodeId: 'n1',
    attemptId: 'n1#1',
    latencyMs: 1200,
    exitCode: 0,
    summary: fields.summary ?? 'completed',
    outputChars: 0,
  };
  db.insert(runEvents)
    .values({
      id: `evt-${seq}`,
      runId,
      seq: seq++,
      type: 'activity.agentTelemetry',
      payload,
      ts: fields.ts,
    })
    .run();
}

describe('aggregateAiActivity', () => {
  it('groups billed exchanges by provider and model', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    insertMetered(db, run.id, { ts: 1_000, inputTokens: 100, outputTokens: 10, cost: 0.5 });
    insertMetered(db, run.id, { ts: 2_000, inputTokens: 200, outputTokens: 20, cost: 1.5 });
    insertMetered(db, run.id, {
      ts: 3_000,
      model: 'claude-haiku-4-5',
      inputTokens: 7,
      outputTokens: 3,
      cost: 0.25,
    });

    const snapshot = aggregateAiActivity(db, { sinceMs: 0, ownerId: 'local' });

    expect(snapshot.models).toHaveLength(2);
    const opus = snapshot.models.find((m) => m.model === 'claude-opus-4-8');
    expect(opus?.provider).toBe('anthropic_api');
    expect(opus?.cost.responseCount).toBe(2);
    expect(opus?.cost.inputTokens).toBe(300);
    expect(opus?.cost.outputTokens).toBe(30);
    expect(opus?.cost.totalCostEstimate).toBeCloseTo(2);
    // The most recent billed exchange in THIS group, not across the table.
    expect(opus?.lastAt).toBe(2_000);
  });

  it('excludes exchanges older than the window lower bound', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    insertMetered(db, run.id, { ts: 1_000, inputTokens: 100, outputTokens: 10, cost: 0.5 });
    insertMetered(db, run.id, { ts: 9_000, inputTokens: 1, outputTokens: 1, cost: 0.25 });

    const snapshot = aggregateAiActivity(db, { sinceMs: 5_000, ownerId: 'local' });

    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.models[0]?.cost.responseCount).toBe(1);
    expect(snapshot.totals.inputTokens).toBe(1);
  });

  it('is owner-scoped — another owner’s spend is invisible', () => {
    const { db } = freshDb();
    const mine = mkRun(db, 'local');
    const theirs = mkRun(db, 'someone-else');
    insertMetered(db, mine.id, { ts: 1_000, inputTokens: 10, outputTokens: 1, cost: 0.5 });
    insertMetered(db, theirs.id, { ts: 1_000, inputTokens: 999, outputTokens: 999, cost: 99 });

    const snapshot = aggregateAiActivity(db, { sinceMs: 0, ownerId: 'local' });

    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.totals.inputTokens).toBe(10);
    expect(snapshot.totals.totalCostEstimate).toBeCloseTo(0.5);
  });

  /**
   * The fail-closed rule, at the cross-run scale: an exchange with no
   * `costEstimate` contributes NOTHING to the sum and flips `complete` to false,
   * so the total is an honest LOWER BOUND rather than a manufactured figure.
   */
  it('reports an unpriced-and-unknown exchange as incomplete, never as zero cost', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    insertMetered(db, run.id, { ts: 1_000, inputTokens: 100, outputTokens: 10, cost: 2 });
    insertMetered(db, run.id, { ts: 1_100, inputTokens: 50, outputTokens: 5 });

    const snapshot = aggregateAiActivity(db, { sinceMs: 0, ownerId: 'local' });

    expect(snapshot.totals.responseCount).toBe(2);
    expect(snapshot.totals.pricedResponseCount).toBe(1);
    expect(snapshot.totals.costUnknownResponseCount).toBe(1);
    expect(snapshot.totals.totalCostEstimate).toBeCloseTo(2);
    expect(snapshot.totals.complete).toBe(false);
  });

  it('keeps a subscription (unpriced) exchange complete rather than flagging a gap', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    insertMetered(db, run.id, {
      ts: 1_000,
      inputTokens: 100,
      outputTokens: 10,
      meteringStatus: 'unpriced',
    });

    const snapshot = aggregateAiActivity(db, { sinceMs: 0, ownerId: 'local' });

    expect(snapshot.totals.unpricedResponseCount).toBe(1);
    expect(snapshot.totals.costUnknownResponseCount).toBe(0);
    expect(snapshot.totals.complete).toBe(true);
  });

  it('totals are the sum of the groups, so the table and its total cannot disagree', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    insertMetered(db, run.id, { ts: 1_000, inputTokens: 100, outputTokens: 10, cost: 0.5 });
    insertMetered(db, run.id, {
      ts: 1_100,
      provider: 'openai_api',
      model: 'gpt-5',
      inputTokens: 40,
      outputTokens: 4,
      cost: 0.25,
    });

    const snapshot = aggregateAiActivity(db, { sinceMs: 0, ownerId: 'local' });

    const summed = snapshot.models.reduce((n, m) => n + m.cost.inputTokens, 0);
    expect(snapshot.totals.inputTokens).toBe(summed);
    expect(snapshot.totals.responseCount).toBe(2);
    expect(snapshot.totals.totalCostEstimate).toBeCloseTo(0.75);
  });

  it('orders groups by spend descending, breaking ties on provider then model', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    insertMetered(db, run.id, { ts: 1, model: 'b-model', inputTokens: 1, outputTokens: 1, cost: 1 });
    insertMetered(db, run.id, { ts: 2, model: 'a-model', inputTokens: 1, outputTokens: 1, cost: 1 });
    insertMetered(db, run.id, { ts: 3, model: 'big', inputTokens: 1, outputTokens: 1, cost: 5 });

    const snapshot = aggregateAiActivity(db, { sinceMs: 0, ownerId: 'local' });

    expect(snapshot.models.map((m) => m.model)).toEqual(['big', 'a-model', 'b-model']);
  });

  /**
   * Agent-CLI use is the half of "connected AI" that carries no tokens at all.
   * It must be counted, and counted apart from the token table.
   */
  it('counts agent-CLI invocations separately, splitting completed from not-completed', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    insertAgentTelemetry(db, run.id, { ts: 1_000 });
    insertAgentTelemetry(db, run.id, { ts: 2_000, summary: 'timedOut' });
    insertAgentTelemetry(db, run.id, { ts: 3_000, summary: 'completed' });

    const snapshot = aggregateAiActivity(db, { sinceMs: 0, ownerId: 'local' });

    expect(snapshot.agentCli.invocations).toBe(3);
    expect(snapshot.agentCli.completed).toBe(2);
    expect(snapshot.agentCli.notCompleted).toBe(1);
    expect(snapshot.agentCli.lastAt).toBe(3_000);
    // Untokened work must not appear in the token table as a row of zeros.
    expect(snapshot.models).toHaveLength(0);
  });

  it('reports no agent-CLI activity as a null instant, not epoch zero', () => {
    const { db } = freshDb();
    mkRun(db);

    const snapshot = aggregateAiActivity(db, { sinceMs: 0, ownerId: 'local' });

    expect(snapshot.agentCli.invocations).toBe(0);
    expect(snapshot.agentCli.lastAt).toBeNull();
  });

  /**
   * The correctness point the whole panel shape rests on: `running` is the only
   * status where work is executing. `queued` has not started and `waiting` has
   * released its slot, so presenting them as one "live" number would report
   * activity that is not happening.
   */
  it('counts non-terminal runs per status rather than as one live number', () => {
    const { db } = freshDb();
    const running = mkRun(db);
    const waiting = mkRun(db);
    const queued = mkRun(db);
    const done = mkRun(db);
    updateRun(db, running.id, { status: 'running' });
    updateRun(db, waiting.id, { status: 'waiting' });
    updateRun(db, queued.id, { status: 'queued' });
    updateRun(db, done.id, { status: 'success' });

    const snapshot = aggregateAiActivity(db, { sinceMs: 0, ownerId: 'local' });

    expect(snapshot.runs.running).toBe(1);
    expect(snapshot.runs.waiting).toBe(1);
    expect(snapshot.runs.queued).toBe(1);
    // `pending` is reported as a real zero: the status exists and none are in it.
    expect(snapshot.runs.pending).toBe(0);
  });

  it('does not count another owner’s running runs', () => {
    const { db } = freshDb();
    const theirs = mkRun(db, 'someone-else');
    updateRun(db, theirs.id, { status: 'running' });

    const snapshot = aggregateAiActivity(db, { sinceMs: 0, ownerId: 'local' });

    expect(snapshot.runs.running).toBe(0);
  });

  it('ignores event types that are not AI activity', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    db.insert(runEvents)
      .values({
        id: 'evt-other',
        runId: run.id,
        seq: 9_000,
        type: 'run.started',
        payload: { type: 'run.started', runId: run.id },
        ts: 1_000,
      })
      .run();

    const snapshot = aggregateAiActivity(db, { sinceMs: 0, ownerId: 'local' });

    expect(snapshot.models).toHaveLength(0);
    expect(snapshot.agentCli.invocations).toBe(0);
    expect(snapshot.totals.responseCount).toBe(0);
  });
});
