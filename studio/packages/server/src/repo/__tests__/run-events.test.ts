import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  computeRunCost,
  rollupFromAggregates,
  rollupPipelineCost,
  type NewPipelineVersion,
} from '@autonomy-studio/shared';
import { runEvents } from '../../db/schema.js';
import { createPipelineVersion } from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import {
  aggregatePipelineCost,
  appendRunEvent,
  getRunEvent,
  listRunEvents,
} from '../run-events.js';
import * as runEventsRepo from '../run-events.js';
import { createRun } from '../runs.js';
import { freshDb } from './helpers.js';

function setupRun(db: ReturnType<typeof freshDb>['db']) {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const versionInput: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  const version = createPipelineVersion(db, versionInput);
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId: version.id,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
}

describe('run-events repo', () => {
  it('appends the first event at seq 0', () => {
    const { db } = freshDb();
    const run = setupRun(db);
    const evt = appendRunEvent(db, { runId: run.id, type: 'run.started', payload: {} });
    expect(evt.seq).toBe(0);
    expect(getRunEvent(db, evt.id)).toEqual(evt);
  });

  it('assigns a strictly monotonic seq per run, independent of other runs', () => {
    const { db } = freshDb();
    const runA = setupRun(db);
    const runB = setupRun(db);

    const a0 = appendRunEvent(db, { runId: runA.id, type: 'run.started', payload: {} });
    const b0 = appendRunEvent(db, { runId: runB.id, type: 'run.started', payload: {} });
    const a1 = appendRunEvent(db, {
      runId: runA.id,
      type: 'node.started',
      payload: { node: 'n1' },
    });
    const a2 = appendRunEvent(db, {
      runId: runA.id,
      type: 'node.succeeded',
      payload: { node: 'n1' },
    });

    expect([a0.seq, a1.seq, a2.seq]).toEqual([0, 1, 2]);
    expect(b0.seq).toBe(0);
    expect(listRunEvents(db, runA.id).map((e) => e.id)).toEqual([a0.id, a1.id, a2.id]);
  });

  it('rejects appending an event for a nonexistent run (FK enforced)', () => {
    const { db } = freshDb();
    expect(() =>
      appendRunEvent(db, { runId: 'run_does_not_exist', type: 'run.started', payload: {} }),
    ).toThrow();
  });

  it('rejects a duplicate (runId, seq) pair at the DB layer (unique index enforced)', () => {
    const { db } = freshDb();
    const run = setupRun(db);
    const row = {
      id: 'evt_dup_1',
      runId: run.id,
      seq: 0,
      type: 'run.started',
      payload: {},
      ts: Date.now(),
    };
    db.insert(runEvents).values(row).run();

    expect(() =>
      db
        .insert(runEvents)
        .values({ ...row, id: 'evt_dup_2' })
        .run(),
    ).toThrow();
  });

  it('has no update/delete path — the module exports neither (append-only invariant)', () => {
    const mod = runEventsRepo as unknown as Record<string, unknown>;
    expect(mod['updateRunEvent']).toBeUndefined();
    expect(mod['deleteRunEvent']).toBeUndefined();
  });

  describe('aggregatePipelineCost (#599 — bounded SQL rollup, fail-closed)', () => {
    // Well-formed metered payload (A1: the SQL path trusts the stored type +
    // payload, sound only because `appendEngineEvent` validates before insert —
    // so every fixture row here is a VALID metered event, `cost` present only
    // when priced). An ABSENT costEstimate is the cost-unknown signal.
    function metered(
      runId: string,
      fields: {
        inputTokens: number;
        outputTokens: number;
        cost?: number;
        meteringStatus?: 'metered' | 'unknown' | 'unpriced';
      },
    ): Record<string, unknown> {
      const base: Record<string, unknown> = {
        type: 'activity.metered',
        runId,
        nodeId: 'n1',
        attemptId: 'n1#1',
        provider: 'anthropic_api',
        model: 'claude-opus-4-8',
        meteringStatus: fields.meteringStatus ?? 'metered',
        inputTokens: fields.inputTokens,
        outputTokens: fields.outputTokens,
      };
      if (fields.cost !== undefined) {
        base['inUnitPrice'] = 5;
        base['outUnitPrice'] = 25;
        base['costEstimate'] = fields.cost;
        base['priceTableVersion'] = 'builtin-2026-07-18';
      }
      return base;
    }

    function mkVersion(db: ReturnType<typeof freshDb>['db'], pipelineId: string) {
      return createPipelineVersion(db, {
        pipelineId,
        params: [],
        outputs: [],
        nodes: [],
        edges: [],
        catalogVersion: CATALOG_VERSION,
      });
    }
    function mkRun(db: ReturnType<typeof freshDb>['db'], versionId: string, ownerId = 'local') {
      return createRun(db, {
        ownerId,
        pipelineVersionId: versionId,
        triggerId: null,
        parentRunId: null,
        params: {},
      });
    }

    it('aggregates cost across ALL versions, fail-closed, owner-scoped, metered-only', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
      const v1 = mkVersion(db, pipeline.id);
      const v2 = mkVersion(db, pipeline.id);
      const other = createPipeline(db, { ownerId: 'local', name: 'Other' });
      const ov = mkVersion(db, other.id);

      const runV1 = mkRun(db, v1.id);
      const runV2 = mkRun(db, v2.id);
      mkRun(db, v1.id); // a zero-event run → counts toward runCount only
      const runV3 = mkRun(db, v1.id); // a genuine $0-cost priced run
      const runOtherOwner = mkRun(db, v1.id, 'someone-else'); // excluded by owner scope
      const runOtherPipeline = mkRun(db, ov.id); // excluded by pipeline scope

      // runV1: one priced metered response + a non-metered event (must be ignored).
      appendRunEvent(db, {
        runId: runV1.id,
        type: 'activity.metered',
        payload: metered(runV1.id, { inputTokens: 100, outputTokens: 200, cost: 0.01 }),
      });
      appendRunEvent(db, {
        runId: runV1.id,
        type: 'node.output',
        payload: { type: 'node.output' },
      });
      // runV2: one priced + one UNPRICED (no costEstimate) → runV2 incomplete.
      appendRunEvent(db, {
        runId: runV2.id,
        type: 'activity.metered',
        payload: metered(runV2.id, { inputTokens: 50, outputTokens: 60, cost: 0.005 }),
      });
      appendRunEvent(db, {
        runId: runV2.id,
        type: 'activity.metered',
        payload: metered(runV2.id, { inputTokens: 10, outputTokens: 20 }), // unpriced
      });
      // runV3: a genuine costEstimate:0 → PRICED, not unknown.
      appendRunEvent(db, {
        runId: runV3.id,
        type: 'activity.metered',
        payload: metered(runV3.id, { inputTokens: 5, outputTokens: 7, cost: 0 }),
      });
      // Out-of-scope runs — must not contribute.
      appendRunEvent(db, {
        runId: runOtherOwner.id,
        type: 'activity.metered',
        payload: metered(runOtherOwner.id, { inputTokens: 999, outputTokens: 999, cost: 9.99 }),
      });
      appendRunEvent(db, {
        runId: runOtherPipeline.id,
        type: 'activity.metered',
        payload: metered(runOtherPipeline.id, { inputTokens: 999, outputTokens: 999, cost: 9.99 }),
      });

      const agg = aggregatePipelineCost(db, pipeline.id, 'local');
      expect(agg.runCount).toBe(4); // runV1, runV2, runZero, runV3 (not other-owner, not other-pipeline)
      expect(agg.responseCount).toBe(4); // 1 + 2 + 1 metered (non-metered ignored)
      expect(agg.pricedResponseCount).toBe(3); // the cost:0 counts priced; the absent-cost does not
      expect(agg.totalCostEstimate).toBeCloseTo(0.015, 10); // 0.01 + 0.005 + 0 (lower bound)
      expect(agg.inputTokens).toBe(165); // 100 + 50 + 10 + 5
      expect(agg.outputTokens).toBe(287); // 200 + 60 + 20 + 7
      expect(agg.incompleteRunCount).toBe(1); // only runV2 has an unknown response

      // The derived rollup: costUnknownResponseCount = 4 - 3 = 1, complete=false,
      // and the documented invariant complete === (incompleteRunCount === 0) holds.
      const rollup = rollupFromAggregates(agg);
      expect(rollup.costUnknownResponseCount).toBe(1);
      expect(rollup.complete).toBe(false);
      expect(rollup.complete).toBe(agg.incompleteRunCount === 0);

      // Unscoped sees the other-owner run too (owner filter dropped): runCount 5,
      // and that run's 9.99 is now summed.
      const unscoped = aggregatePipelineCost(db, pipeline.id);
      expect(unscoped.runCount).toBe(5);
      expect(unscoped.responseCount).toBe(5);
      expect(unscoped.totalCostEstimate).toBeCloseTo(0.015 + 9.99, 10);
    });

    it('a run with only unpriced responses is incomplete; a genuine $0 run stays complete', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
      const v = mkVersion(db, pipeline.id);
      const unpricedRun = mkRun(db, v.id);
      const zeroCostRun = mkRun(db, v.id);
      appendRunEvent(db, {
        runId: unpricedRun.id,
        type: 'activity.metered',
        payload: metered(unpricedRun.id, { inputTokens: 1, outputTokens: 1 }), // no cost
      });
      appendRunEvent(db, {
        runId: zeroCostRun.id,
        type: 'activity.metered',
        payload: metered(zeroCostRun.id, { inputTokens: 1, outputTokens: 1, cost: 0 }),
      });
      const agg = aggregatePipelineCost(db, pipeline.id, 'local');
      expect(agg.responseCount).toBe(2);
      expect(agg.pricedResponseCount).toBe(1); // only the $0 run
      expect(agg.incompleteRunCount).toBe(1); // only the unpriced run
      expect(rollupFromAggregates(agg).complete).toBe(false);
    });

    it('L14: a subscription (meteringStatus=unpriced) response is its own category, NOT a cost gap', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
      const v = mkVersion(db, pipeline.id);
      const subRun = mkRun(db, v.id); // two subscription calls — no dollar cost, no gap
      const pricedRun = mkRun(db, v.id);
      const gapRun = mkRun(db, v.id); // a genuine cost-unknown response
      appendRunEvent(db, {
        runId: subRun.id,
        type: 'activity.metered',
        payload: metered(subRun.id, {
          inputTokens: 10,
          outputTokens: 20,
          meteringStatus: 'unpriced',
        }),
      });
      appendRunEvent(db, {
        runId: subRun.id,
        type: 'activity.metered',
        payload: metered(subRun.id, {
          inputTokens: 5,
          outputTokens: 5,
          meteringStatus: 'unpriced',
        }),
      });
      appendRunEvent(db, {
        runId: pricedRun.id,
        type: 'activity.metered',
        payload: metered(pricedRun.id, { inputTokens: 1, outputTokens: 1, cost: 0.02 }),
      });
      appendRunEvent(db, {
        runId: gapRun.id,
        type: 'activity.metered',
        payload: metered(gapRun.id, { inputTokens: 9, outputTokens: 9 }), // unpriced MODEL → gap
      });

      const agg = aggregatePipelineCost(db, pipeline.id, 'local');
      expect(agg.responseCount).toBe(4);
      expect(agg.pricedResponseCount).toBe(1);
      expect(agg.unpricedResponseCount).toBe(2); // the two subscription calls
      // ONLY gapRun is incomplete — the subscription run is NOT (its cost is known: none).
      expect(agg.incompleteRunCount).toBe(1);
      expect(agg.totalCostEstimate).toBeCloseTo(0.02, 10); // subscription adds no dollars

      const rollup = rollupFromAggregates(agg);
      // costUnknown = 4 - 1 priced - 2 unpriced = 1 genuine gap.
      expect(rollup.costUnknownResponseCount).toBe(1);
      expect(rollup.unpricedResponseCount).toBe(2);
      expect(rollup.complete).toBe(false);
      expect(rollup.complete).toBe(agg.incompleteRunCount === 0);
    });

    it('L14: a pipeline of ONLY subscription responses is COMPLETE (no measurement gap)', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
      const v = mkVersion(db, pipeline.id);
      const subRun = mkRun(db, v.id);
      appendRunEvent(db, {
        runId: subRun.id,
        type: 'activity.metered',
        payload: metered(subRun.id, {
          inputTokens: 3,
          outputTokens: 4,
          meteringStatus: 'unpriced',
        }),
      });
      const agg = aggregatePipelineCost(db, pipeline.id, 'local');
      expect(agg.responseCount).toBe(1);
      expect(agg.pricedResponseCount).toBe(0);
      expect(agg.unpricedResponseCount).toBe(1);
      expect(agg.incompleteRunCount).toBe(0); // subscription-only run is complete
      const rollup = rollupFromAggregates(agg);
      expect(rollup.costUnknownResponseCount).toBe(0);
      expect(rollup.complete).toBe(true);
    });

    it('L14: SQL rollup === in-memory fold over the SAME rows (incl. unpriced) — the paths cannot drift', () => {
      // The strongest anti-drift guard: run one mixed event set (priced, subscription
      // unpriced, genuine gap, $0-priced, zero-metered run) through BOTH the bounded
      // SQL path (aggregatePipelineCost→rollupFromAggregates) AND the in-memory fold
      // (computeRunCost per run→rollupPipelineCost), and assert identical rollups.
      const { db } = freshDb();
      const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
      const v = mkVersion(db, pipeline.id);
      const rPriced = mkRun(db, v.id);
      const rSub = mkRun(db, v.id);
      const rGap = mkRun(db, v.id);
      mkRun(db, v.id); // a zero-metered run — counts toward runCount only
      const rows: { runId: string; payload: Record<string, unknown> }[] = [
        {
          runId: rPriced.id,
          payload: metered(rPriced.id, { inputTokens: 10, outputTokens: 20, cost: 0.03 }),
        },
        {
          runId: rPriced.id,
          payload: metered(rPriced.id, { inputTokens: 1, outputTokens: 1, cost: 0 }),
        },
        {
          runId: rSub.id,
          payload: metered(rSub.id, {
            inputTokens: 5,
            outputTokens: 6,
            meteringStatus: 'unpriced',
          }),
        },
        {
          runId: rSub.id,
          payload: metered(rSub.id, {
            inputTokens: 7,
            outputTokens: 8,
            meteringStatus: 'unpriced',
          }),
        },
        { runId: rGap.id, payload: metered(rGap.id, { inputTokens: 9, outputTokens: 9 }) }, // unpriced MODEL → gap
        {
          runId: rGap.id,
          payload: metered(rGap.id, { inputTokens: 2, outputTokens: 3, meteringStatus: 'unknown' }),
        },
      ];
      for (const r of rows) {
        appendRunEvent(db, { runId: r.runId, type: 'activity.metered', payload: r.payload });
      }

      const sqlRollup = rollupFromAggregates(aggregatePipelineCost(db, pipeline.id, 'local'));
      const foldRollup = rollupPipelineCost(
        [rPriced, rSub, rGap].map((run) => computeRunCost(listRunEvents(db, run.id))),
      );
      // The zero-metered run contributes only to runCount; fold it in so both agree.
      expect(sqlRollup).toEqual({ ...foldRollup, runCount: 4 });
    });

    it('an empty pipeline (runs but no metered events) → complete $0, runCount counts the runs', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
      const v = mkVersion(db, pipeline.id);
      mkRun(db, v.id);
      mkRun(db, v.id);
      const agg = aggregatePipelineCost(db, pipeline.id, 'local');
      expect(agg).toEqual({
        runCount: 2,
        incompleteRunCount: 0,
        responseCount: 0,
        pricedResponseCount: 0,
        unpricedResponseCount: 0,
        totalCostEstimate: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(rollupFromAggregates(agg).complete).toBe(true);
    });

    it('a missing pipeline → all-zero aggregates (never throws)', () => {
      const { db } = freshDb();
      expect(aggregatePipelineCost(db, 'pipe_missing', 'local')).toEqual({
        runCount: 0,
        incompleteRunCount: 0,
        responseCount: 0,
        pricedResponseCount: 0,
        unpricedResponseCount: 0,
        totalCostEstimate: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
    });
  });
});
