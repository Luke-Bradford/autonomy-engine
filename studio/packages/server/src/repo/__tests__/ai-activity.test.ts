import { describe, expect, it } from 'vitest';
import {
  AI_ACTIVITY_BUCKET_MS,
  BUILTIN_PRICE_TABLE_VERSION,
  CATALOG_VERSION,
  RUN_SINCE_MS,
  RUN_SINCE_WINDOWS,
  maxBucketCount,
} from '@autonomy-studio/shared';
import { runEvents } from '../../db/schema.js';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import { aggregateAiActivity } from '../ai-activity.js';
import { createRun, updateRun } from '../runs.js';
import { freshDb } from './helpers.js';

type Db = ReturnType<typeof freshDb>['db'];

/**
 * `nowMs`/`bucketMs` are REQUIRED on the real filter (#967) — an absent bucket
 * width would divide by `undefined` — but almost every case here predates the
 * series and is indifferent to it. This supplies a default for those without
 * making the production signature optional, and the series cases override it.
 */
const DEFAULT_TEST_BUCKET_MS = 60_000;
function callAggregate(
  db: Db,
  filter: { sinceMs: number; ownerId?: string; nowMs?: number; bucketMs?: number },
) {
  const { nowMs = filter.sinceMs + DEFAULT_TEST_BUCKET_MS, bucketMs = DEFAULT_TEST_BUCKET_MS } =
    filter;
  return aggregateAiActivity(db, { ...filter, nowMs, bucketMs });
}

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

    const snapshot = callAggregate(db, { sinceMs: 0, ownerId: 'local' });

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

    const snapshot = callAggregate(db, { sinceMs: 5_000, ownerId: 'local' });

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

    const snapshot = callAggregate(db, { sinceMs: 0, ownerId: 'local' });

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

    const snapshot = callAggregate(db, { sinceMs: 0, ownerId: 'local' });

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

    const snapshot = callAggregate(db, { sinceMs: 0, ownerId: 'local' });

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

    const snapshot = callAggregate(db, { sinceMs: 0, ownerId: 'local' });

    const summed = snapshot.models.reduce((n, m) => n + m.cost.inputTokens, 0);
    expect(snapshot.totals.inputTokens).toBe(summed);
    expect(snapshot.totals.responseCount).toBe(2);
    expect(snapshot.totals.totalCostEstimate).toBeCloseTo(0.75);
  });

  it('orders groups by spend descending, breaking ties on provider then model', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    insertMetered(db, run.id, {
      ts: 1,
      model: 'b-model',
      inputTokens: 1,
      outputTokens: 1,
      cost: 1,
    });
    insertMetered(db, run.id, {
      ts: 2,
      model: 'a-model',
      inputTokens: 1,
      outputTokens: 1,
      cost: 1,
    });
    insertMetered(db, run.id, { ts: 3, model: 'big', inputTokens: 1, outputTokens: 1, cost: 5 });

    const snapshot = callAggregate(db, { sinceMs: 0, ownerId: 'local' });

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

    const snapshot = callAggregate(db, { sinceMs: 0, ownerId: 'local' });

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

    const snapshot = callAggregate(db, { sinceMs: 0, ownerId: 'local' });

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

    const snapshot = callAggregate(db, { sinceMs: 0, ownerId: 'local' });

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

    const snapshot = callAggregate(db, { sinceMs: 0, ownerId: 'local' });

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

    const snapshot = callAggregate(db, { sinceMs: 0, ownerId: 'local' });

    expect(snapshot.models).toHaveLength(0);
    expect(snapshot.agentCli.invocations).toBe(0);
    expect(snapshot.totals.responseCount).toBe(0);
  });
});

describe('aggregateAiActivity — the token-flow series (#967)', () => {
  const BUCKET = 300_000; // 5 minutes, the `1h` window's width.

  it('groups events into aligned buckets even when no timestamp is a multiple of the width', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    /*
     * EVERY `ts` HERE IS DELIBERATELY NOT A MULTIPLE OF `BUCKET`, and that is the
     * whole point of the case. SQLite's `/` is integer division only when both
     * operands are INTEGERs, and better-sqlite3 binds a JS number as REAL — so
     * the natural `ts / bucketMs` divides in floating point and gives a distinct
     * quotient per event, silently turning the GROUP BY into one group per ROW.
     * Round timestamps hide that completely: they divide exactly, so the float
     * and the integer quotient agree and a test built on them passes against the
     * broken query. These do not.
     */
    insertMetered(db, run.id, { ts: 1_200_000 + 137, inputTokens: 10, outputTokens: 1, cost: 1 });
    insertMetered(db, run.id, { ts: 1_200_000 + 299_999, inputTokens: 5, outputTokens: 2, cost: 1 });
    insertMetered(db, run.id, { ts: 1_500_000 + 4, inputTokens: 7, outputTokens: 3, cost: 1 });

    const snapshot = callAggregate(db, {
      sinceMs: 1_200_000,
      nowMs: 1_800_000,
      bucketMs: BUCKET,
      ownerId: 'local',
    });

    const nonEmpty = snapshot.series.buckets.filter((b) => b.cost.responseCount > 0);
    expect(nonEmpty).toHaveLength(2);
    expect(nonEmpty[0]).toMatchObject({ bucketStart: 1_200_000 });
    expect(nonEmpty[0]?.cost.responseCount).toBe(2);
    expect(nonEmpty[0]?.cost.inputTokens).toBe(15);
    expect(nonEmpty[1]).toMatchObject({ bucketStart: 1_500_000 });
    expect(nonEmpty[1]?.cost.responseCount).toBe(1);
  });

  it('zero-fills the gaps so the series is contiguous and oldest-first', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    insertMetered(db, run.id, { ts: 1_200_050, inputTokens: 4, outputTokens: 1, cost: 1 });
    insertMetered(db, run.id, { ts: 2_100_050, inputTokens: 4, outputTokens: 1, cost: 1 });

    const { series } = callAggregate(db, {
      sinceMs: 1_200_000,
      nowMs: 2_400_000,
      bucketMs: BUCKET,
      ownerId: 'local',
    });

    expect(series.bucketMs).toBe(BUCKET);
    const starts = series.buckets.map((b) => b.bucketStart);
    expect(starts).toEqual([1_200_000, 1_500_000, 1_800_000, 2_100_000, 2_400_000]);
    // An empty bucket is a MEASURED zero — no billed exchange happened in those
    // five minutes — so it is present with zeroes rather than absent.
    expect(series.buckets[1]?.cost.responseCount).toBe(0);
    expect(series.buckets[1]?.cost.inputTokens).toBe(0);
  });

  it('keeps the series summing to the totals when the window starts mid-bucket', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    // `sinceMs` lands 100s into the 1_200_000 bucket. The event before it is out
    // of the window entirely; the one after is in. If the fill began at the next
    // aligned boundary instead of the one CONTAINING `sinceMs`, this event would
    // be counted in `totals` and drawn in no bar.
    insertMetered(db, run.id, { ts: 1_350_000, inputTokens: 9, outputTokens: 4, cost: 2 });
    insertMetered(db, run.id, { ts: 1_100_000, inputTokens: 999, outputTokens: 999, cost: 9 });

    const snapshot = callAggregate(db, {
      sinceMs: 1_200_000 + 100_000,
      nowMs: 1_600_000,
      bucketMs: BUCKET,
      ownerId: 'local',
    });

    expect(snapshot.series.buckets[0]?.bucketStart).toBe(1_200_000);
    const summedIn = snapshot.series.buckets.reduce((n, b) => n + b.cost.inputTokens, 0);
    const summedOut = snapshot.series.buckets.reduce((n, b) => n + b.cost.outputTokens, 0);
    const summedResponses = snapshot.series.buckets.reduce((n, b) => n + b.cost.responseCount, 0);
    expect(summedIn).toBe(snapshot.totals.inputTokens);
    expect(summedOut).toBe(snapshot.totals.outputTokens);
    expect(summedResponses).toBe(snapshot.totals.responseCount);
    // and the out-of-window event is in neither
    expect(summedIn).toBe(9);
  });

  it('marks the clipped leading bucket and the in-progress trailing bucket partial', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    insertMetered(db, run.id, { ts: 1_350_000, inputTokens: 1, outputTokens: 1, cost: 1 });

    const { series } = callAggregate(db, {
      sinceMs: 1_200_000 + 100_000,
      nowMs: 1_800_000 + 60_000,
      bucketMs: BUCKET,
      ownerId: 'local',
    });

    const first = series.buckets[0];
    const middle = series.buckets[1];
    const last = series.buckets[series.buckets.length - 1];
    expect(first).toMatchObject({ bucketStart: 1_200_000, partial: true });
    // Clamped to the window, not to a full bucket width.
    expect(first?.bucketEnd).toBe(1_500_000);
    expect(middle).toMatchObject({ partial: false, bucketEnd: 1_800_000 });
    expect(last).toMatchObject({ bucketStart: 1_800_000, partial: true });
    // The in-progress bucket reports the span actually collected — 60s of 300s.
    // A renderer sizing it by `bucketMs` would draw a full-width bar and make
    // every poll look like AI use had collapsed.
    expect(last?.bucketEnd).toBe(1_860_000);
  });

  it('reports tokens as UNMEASURED rather than zero when the provider omitted usage', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    // The `cliSpendFact()` shape: a real billed exchange carrying no token counts
    // at all. `coalesce(sum(...), 0)` renders it as 0 tokens, which on a chart is
    // indistinguishable from "this agent did no work".
    insertMetered(db, run.id, { ts: 1_200_100, meteringStatus: 'unpriced' });
    insertMetered(db, run.id, { ts: 1_200_200, inputTokens: 12, cost: 1 });

    const { series } = callAggregate(db, {
      sinceMs: 1_200_000,
      nowMs: 1_400_000,
      bucketMs: BUCKET,
      ownerId: 'local',
    });

    const bucket = series.buckets[0];
    expect(bucket?.cost.responseCount).toBe(2);
    // Two exchanges, but only one reported an input count and NONE an output —
    // so a 0 in `outputTokens` means "nobody counted", not "no output".
    expect(bucket?.inputReportedResponseCount).toBe(1);
    expect(bucket?.outputReportedResponseCount).toBe(0);
    expect(bucket?.cost.outputTokens).toBe(0);
  });

  it('scopes the series to the owner', () => {
    const { db } = freshDb();
    const mine = mkRun(db, 'local');
    const theirs = mkRun(db, 'someone-else');
    insertMetered(db, mine.id, { ts: 1_200_100, inputTokens: 3, outputTokens: 1, cost: 1 });
    insertMetered(db, theirs.id, { ts: 1_200_100, inputTokens: 500, outputTokens: 500, cost: 9 });

    const { series } = callAggregate(db, {
      sinceMs: 1_200_000,
      nowMs: 1_400_000,
      bucketMs: BUCKET,
      ownerId: 'local',
    });

    expect(series.buckets[0]?.cost.inputTokens).toBe(3);
  });

  it('stays bounded at windowMs/bucketMs + 1 buckets for every window', () => {
    const { db } = freshDb();
    const run = mkRun(db);
    const now = 1_000_000_000_000 + 12_345;
    // Enough events to prove the bound is the WINDOW's doing, not the data's.
    for (let i = 0; i < 200; i += 1) {
      insertMetered(db, run.id, { ts: now - i * 60_000 - 7, inputTokens: 1, cost: 1 });
    }

    for (const since of RUN_SINCE_WINDOWS) {
      const bucketMs = AI_ACTIVITY_BUCKET_MS[since];
      const { series } = callAggregate(db, {
        sinceMs: now - RUN_SINCE_MS[since],
        nowMs: now,
        bucketMs,
        ownerId: 'local',
      });
      expect(series.buckets.length).toBeLessThanOrEqual(maxBucketCount(since));
    }
  });
});
