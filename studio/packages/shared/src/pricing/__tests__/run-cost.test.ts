import { describe, expect, it } from 'vitest';
import { computeRunCost, rollupPipelineCost } from '../run-cost.js';

/**
 * L6 — the run-cost projection SUMS `activity.metered` events deterministically.
 * The load-bearing invariant (the #473 / F13a fail-closed lesson): an absent
 * `costEstimate` is the run-cost INCOMPLETENESS signal and is NEVER summed as 0.
 */

/** A metered-event payload wrapped as a `{ payload }` row (what the projection folds). */
function metered(fields: Record<string, unknown>): { payload: unknown } {
  return {
    payload: {
      type: 'activity.metered',
      runId: 'run_1',
      nodeId: 'n1',
      attemptId: 'n1#1',
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      meteringStatus: 'metered',
      ...fields,
    },
  };
}

describe('computeRunCost', () => {
  it('sums costEstimate + tokens across metered responses (fully priced → complete)', () => {
    const cost = computeRunCost([
      metered({ inputTokens: 100, outputTokens: 200, costEstimate: 0.0055 }),
      metered({ inputTokens: 300, outputTokens: 50, costEstimate: 0.00275 }),
    ]);
    expect(cost.currency).toBe('USD');
    expect(cost.responseCount).toBe(2);
    expect(cost.pricedResponseCount).toBe(2);
    expect(cost.costUnknownResponseCount).toBe(0);
    expect(cost.inputTokens).toBe(400);
    expect(cost.outputTokens).toBe(250);
    expect(cost.totalCostEstimate).toBeCloseTo(0.00825, 10);
    expect(cost.complete).toBe(true);
  });

  it('FAIL-CLOSED: an absent costEstimate is never summed as 0 — it flips complete=false', () => {
    const cost = computeRunCost([
      metered({ inputTokens: 100, outputTokens: 200, costEstimate: 0.01 }),
      // unpriced model: price fields absent → no costEstimate (tokens still present)
      metered({ inputTokens: 999, outputTokens: 999 }),
    ]);
    expect(cost.responseCount).toBe(2);
    expect(cost.pricedResponseCount).toBe(1);
    expect(cost.costUnknownResponseCount).toBe(1);
    // total is the sum of KNOWN costs only — a LOWER BOUND, not manufactured-0-padded.
    expect(cost.totalCostEstimate).toBeCloseTo(0.01, 10);
    // tokens are still summed (a present count is real even when unpriced).
    expect(cost.inputTokens).toBe(1099);
    expect(cost.outputTokens).toBe(1199);
    expect(cost.complete).toBe(false);
  });

  it('counts a metered-status:unknown response (priced but no costEstimate) as cost-unknown', () => {
    // meteringStatus 'unknown' → the executor stamps unit prices but NO costEstimate
    // (a token count was missing). It is priced yet its cost is unknown — still counts
    // toward incompleteness, still summed for the tokens it DID report.
    const cost = computeRunCost([
      metered({
        meteringStatus: 'unknown',
        inputTokens: 100,
        inUnitPrice: 5,
        outUnitPrice: 25,
        priceTableVersion: 'builtin-2026-07-18',
      }),
    ]);
    expect(cost.responseCount).toBe(1);
    expect(cost.pricedResponseCount).toBe(0);
    expect(cost.costUnknownResponseCount).toBe(1);
    expect(cost.totalCostEstimate).toBe(0);
    expect(cost.inputTokens).toBe(100);
    expect(cost.outputTokens).toBe(0);
    expect(cost.complete).toBe(false);
  });

  it('a run with zero metered responses is complete with a $0 total (nothing to price)', () => {
    const cost = computeRunCost([]);
    expect(cost.responseCount).toBe(0);
    expect(cost.totalCostEstimate).toBe(0);
    expect(cost.complete).toBe(true);
  });

  it('sums BOTH metered events sharing one attemptId (L4c repair / failed-but-billed) — no dedup', () => {
    // A repair sub-call and a failed-but-billed response each bill under the SAME
    // attemptId. Both are real charges; the projection must sum both, never dedup.
    const cost = computeRunCost([
      metered({ attemptId: 'n1#1', inputTokens: 100, outputTokens: 100, costEstimate: 0.005 }),
      metered({ attemptId: 'n1#1', inputTokens: 120, outputTokens: 80, costEstimate: 0.004 }),
    ]);
    expect(cost.responseCount).toBe(2);
    expect(cost.pricedResponseCount).toBe(2);
    expect(cost.totalCostEstimate).toBeCloseTo(0.009, 10);
  });

  it('is TOTAL — folds only activity.metered, skipping other events and unparseable rows', () => {
    const cost = computeRunCost([
      { payload: { type: 'node.output', runId: 'run_1', nodeId: 'n1', name: 'x', value: 1 } },
      { payload: { type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv', startedAt: 1 } },
      { payload: { not: 'a valid engine event' } },
      { payload: null },
      { payload: 'garbage' },
      metered({ inputTokens: 10, outputTokens: 20, costEstimate: 0.001 }),
    ]);
    expect(cost.responseCount).toBe(1);
    expect(cost.pricedResponseCount).toBe(1);
    expect(cost.totalCostEstimate).toBeCloseTo(0.001, 10);
  });

  it('invariant: pricedResponseCount + costUnknownResponseCount === responseCount', () => {
    const cost = computeRunCost([
      metered({ inputTokens: 1, outputTokens: 1, costEstimate: 0.001 }),
      metered({ inputTokens: 1, outputTokens: 1 }),
      metered({ meteringStatus: 'unknown', inputTokens: 1 }),
    ]);
    expect(cost.pricedResponseCount + cost.costUnknownResponseCount).toBe(cost.responseCount);
    expect(cost.responseCount).toBe(3);
  });
});

describe('rollupPipelineCost', () => {
  it('sums run costs across runs + counts runs and incomplete runs', () => {
    const runA = computeRunCost([
      metered({ inputTokens: 100, outputTokens: 100, costEstimate: 0.01 }),
    ]);
    const runB = computeRunCost([
      metered({ inputTokens: 50, outputTokens: 50, costEstimate: 0.005 }),
      metered({ inputTokens: 10, outputTokens: 10 }), // unpriced → runB incomplete
    ]);
    const runC = computeRunCost([]); // zero-response run, complete, $0

    const rollup = rollupPipelineCost([runA, runB, runC]);
    expect(rollup.currency).toBe('USD');
    expect(rollup.runCount).toBe(3);
    expect(rollup.responseCount).toBe(3);
    expect(rollup.pricedResponseCount).toBe(2);
    expect(rollup.costUnknownResponseCount).toBe(1);
    expect(rollup.inputTokens).toBe(160);
    expect(rollup.outputTokens).toBe(160);
    expect(rollup.totalCostEstimate).toBeCloseTo(0.015, 10);
    expect(rollup.incompleteRunCount).toBe(1);
    expect(rollup.complete).toBe(false);
  });

  it('an empty pipeline (no runs) rolls up to a complete $0', () => {
    const rollup = rollupPipelineCost([]);
    expect(rollup.runCount).toBe(0);
    expect(rollup.responseCount).toBe(0);
    expect(rollup.totalCostEstimate).toBe(0);
    expect(rollup.incompleteRunCount).toBe(0);
    expect(rollup.complete).toBe(true);
  });

  it('all runs fully priced → complete rollup', () => {
    const runA = computeRunCost([
      metered({ inputTokens: 1, outputTokens: 1, costEstimate: 0.002 }),
    ]);
    const runB = computeRunCost([
      metered({ inputTokens: 1, outputTokens: 1, costEstimate: 0.003 }),
    ]);
    const rollup = rollupPipelineCost([runA, runB]);
    expect(rollup.incompleteRunCount).toBe(0);
    expect(rollup.complete).toBe(true);
    expect(rollup.totalCostEstimate).toBeCloseTo(0.005, 10);
  });
});
