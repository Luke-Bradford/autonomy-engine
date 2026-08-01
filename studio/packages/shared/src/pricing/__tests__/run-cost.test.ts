import { describe, expect, it } from 'vitest';
import {
  accumulateMetered,
  computeRunCost,
  emptyMeteredTotals,
  nodeCostFromTotals,
  rollupFromAggregates,
  rollupPipelineCost,
  runCostFromTotals,
} from '../run-cost.js';
import { BUILTIN_PRICE_TABLE_VERSION } from '../price-table.js';
import { EngineEventSchema } from '../../engine/types.js';

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
        // Inert here — `computeRunCost` never reads it. Imported rather than
        // pinned so a table bump needs no edit in this file.
        priceTableVersion: BUILTIN_PRICE_TABLE_VERSION,
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

  it('L14: an unpriced (subscription/CLI) response is its OWN category — NOT a cost gap, stays complete', () => {
    // meteringStatus 'unpriced' → a CLI/subscription call that is metered (we know
    // provider/model, maybe tokens) but has NO per-response dollar price BY DESIGN
    // (flat/covered). The executor guarantees it carries no costEstimate. It is
    // NOT a measurement gap, so it does NOT flip complete=false — it lands in its
    // own `unpricedResponseCount`, distinct from the genuine `costUnknownResponseCount`.
    const cost = computeRunCost([
      metered({ inputTokens: 100, outputTokens: 200, costEstimate: 0.01 }),
      metered({ meteringStatus: 'unpriced', inputTokens: 50, outputTokens: 60 }),
    ]);
    expect(cost.responseCount).toBe(2);
    expect(cost.pricedResponseCount).toBe(1);
    expect(cost.unpricedResponseCount).toBe(1);
    expect(cost.costUnknownResponseCount).toBe(0);
    // total is the ONE priced response — the unpriced one adds no dollars (there are none).
    expect(cost.totalCostEstimate).toBeCloseTo(0.01, 10);
    // tokens are still summed (usage is a fact even when there is no price).
    expect(cost.inputTokens).toBe(150);
    expect(cost.outputTokens).toBe(260);
    // a subscription call is not a measurement gap → the run is COMPLETE.
    expect(cost.complete).toBe(true);
  });

  it('L14: an unpriced response alongside a genuine cost-unknown one → still incomplete (the gap remains)', () => {
    const cost = computeRunCost([
      metered({ meteringStatus: 'unpriced', inputTokens: 1, outputTokens: 1 }),
      // genuine gap: metered model with no costEstimate (unpriced MODEL, not subscription)
      metered({ inputTokens: 999, outputTokens: 999 }),
    ]);
    expect(cost.responseCount).toBe(2);
    expect(cost.unpricedResponseCount).toBe(1);
    expect(cost.costUnknownResponseCount).toBe(1);
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

  it('invariant: priced + unpriced + costUnknown === responseCount (L14: three disjoint categories)', () => {
    const cost = computeRunCost([
      metered({ inputTokens: 1, outputTokens: 1, costEstimate: 0.001 }), // priced
      metered({ inputTokens: 1, outputTokens: 1 }), // unpriced MODEL → cost-unknown
      metered({ meteringStatus: 'unknown', inputTokens: 1 }), // partial usage → cost-unknown
      metered({ meteringStatus: 'unpriced', inputTokens: 1, outputTokens: 1 }), // subscription
    ]);
    expect(
      cost.pricedResponseCount + cost.unpricedResponseCount + cost.costUnknownResponseCount,
    ).toBe(cost.responseCount);
    expect(cost.responseCount).toBe(4);
    expect(cost.pricedResponseCount).toBe(1);
    expect(cost.unpricedResponseCount).toBe(1);
    expect(cost.costUnknownResponseCount).toBe(2);
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

  it('L14: a pipeline of priced + subscription(unpriced) runs (no gaps) rolls up COMPLETE', () => {
    const priced = computeRunCost([
      metered({ inputTokens: 1, outputTokens: 1, costEstimate: 0.004 }),
    ]);
    const subscription = computeRunCost([
      metered({ meteringStatus: 'unpriced', inputTokens: 10, outputTokens: 20 }),
      metered({ meteringStatus: 'unpriced', inputTokens: 5, outputTokens: 5 }),
    ]);
    const rollup = rollupPipelineCost([priced, subscription]);
    expect(rollup.responseCount).toBe(3);
    expect(rollup.pricedResponseCount).toBe(1);
    expect(rollup.unpricedResponseCount).toBe(2);
    expect(rollup.costUnknownResponseCount).toBe(0);
    // no measurement gap anywhere → complete, and no run counts as incomplete.
    expect(rollup.incompleteRunCount).toBe(0);
    expect(rollup.complete).toBe(true);
    expect(rollup.totalCostEstimate).toBeCloseTo(0.004, 10);
  });

  it('rollupPipelineCost delegates to rollupFromAggregates (identical output for equivalent aggregates)', () => {
    // #599 — the array fold and the SQL rollup MUST agree. This pins that
    // `rollupPipelineCost` produces exactly what `rollupFromAggregates` would for
    // the same summed aggregates, so the two paths cannot drift.
    const runA = computeRunCost([
      metered({ inputTokens: 100, outputTokens: 100, costEstimate: 0.01 }),
    ]);
    const runB = computeRunCost([
      metered({ inputTokens: 50, outputTokens: 50, costEstimate: 0.005 }),
      metered({ inputTokens: 10, outputTokens: 10 }),
    ]);
    const runC = computeRunCost([]);
    expect(rollupPipelineCost([runA, runB, runC])).toEqual(
      rollupFromAggregates({
        runCount: 3,
        incompleteRunCount: 1,
        responseCount: 3,
        pricedResponseCount: 2,
        unpricedResponseCount: 0,
        totalCostEstimate: 0.015,
        inputTokens: 160,
        outputTokens: 160,
      }),
    );
  });
});

describe('rollupFromAggregates (#599 — the single fail-closed derivation site)', () => {
  it('DERIVES costUnknownResponseCount = responseCount - pricedResponseCount (never summed as 0)', () => {
    const rollup = rollupFromAggregates({
      runCount: 4,
      incompleteRunCount: 2,
      responseCount: 10,
      pricedResponseCount: 7,
      unpricedResponseCount: 0,
      totalCostEstimate: 1.25,
      inputTokens: 500,
      outputTokens: 900,
    });
    expect(rollup.currency).toBe('USD');
    expect(rollup.responseCount).toBe(10);
    expect(rollup.pricedResponseCount).toBe(7);
    expect(rollup.costUnknownResponseCount).toBe(3);
    expect(rollup.totalCostEstimate).toBeCloseTo(1.25, 10);
    expect(rollup.inputTokens).toBe(500);
    expect(rollup.outputTokens).toBe(900);
    expect(rollup.runCount).toBe(4);
    expect(rollup.incompleteRunCount).toBe(2);
    expect(rollup.complete).toBe(false);
  });

  it('complete=true iff every response priced (costUnknownResponseCount === 0)', () => {
    const rollup = rollupFromAggregates({
      runCount: 2,
      incompleteRunCount: 0,
      responseCount: 5,
      pricedResponseCount: 5,
      unpricedResponseCount: 0,
      totalCostEstimate: 0.5,
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(rollup.costUnknownResponseCount).toBe(0);
    expect(rollup.complete).toBe(true);
  });

  it('zero responses → complete $0 (nothing to price)', () => {
    const rollup = rollupFromAggregates({
      runCount: 3, // runs exist but none metered — each a complete $0
      incompleteRunCount: 0,
      responseCount: 0,
      pricedResponseCount: 0,
      unpricedResponseCount: 0,
      totalCostEstimate: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(rollup.runCount).toBe(3);
    expect(rollup.responseCount).toBe(0);
    expect(rollup.costUnknownResponseCount).toBe(0);
    expect(rollup.complete).toBe(true);
  });

  it('L14: DERIVES costUnknown = responseCount - priced - unpriced; unpriced does NOT flip complete', () => {
    const rollup = rollupFromAggregates({
      runCount: 3,
      incompleteRunCount: 0,
      responseCount: 8,
      pricedResponseCount: 5,
      unpricedResponseCount: 3, // subscription calls — no dollar price, but not a gap
      totalCostEstimate: 2,
      inputTokens: 100,
      outputTokens: 200,
    });
    // 8 - 5 - 3 = 0 genuine gaps → complete, even though only 5 carry a dollar cost.
    expect(rollup.costUnknownResponseCount).toBe(0);
    expect(rollup.unpricedResponseCount).toBe(3);
    expect(rollup.complete).toBe(true);
  });

  it('L14: a genuine gap alongside unpriced responses still derives a non-zero costUnknown', () => {
    const rollup = rollupFromAggregates({
      runCount: 2,
      incompleteRunCount: 1,
      responseCount: 6,
      pricedResponseCount: 3,
      unpricedResponseCount: 2,
      totalCostEstimate: 0.9,
      inputTokens: 10,
      outputTokens: 10,
    });
    // 6 - 3 - 2 = 1 genuine cost-unknown response → incomplete.
    expect(rollup.costUnknownResponseCount).toBe(1);
    expect(rollup.complete).toBe(false);
  });
});

/**
 * #866 — the accumulator `computeRunCost` was refactored onto, so a PER-NODE
 * fold can reuse the fail-closed three-way categorisation instead of copying it.
 * `rollupFromAggregates` set the precedent: one derivation site, so the two
 * paths cannot drift.
 */
/** Parse a `metered()` row into the discriminated `activity.metered` member. */
function meteredEvent(fields: Record<string, unknown>) {
  const parsed = EngineEventSchema.parse(metered(fields).payload);
  if (parsed.type !== 'activity.metered') throw new Error('fixture is not activity.metered');
  return parsed;
}

describe('the metered accumulator (#866)', () => {
  it('starts empty, and an empty fold is a complete $0', () => {
    const totals = emptyMeteredTotals();
    const cost = runCostFromTotals(totals);
    expect(cost.responseCount).toBe(0);
    expect(cost.totalCostEstimate).toBe(0);
    expect(cost.complete).toBe(true);
  });

  it('reproduces computeRunCost exactly, so the two paths cannot drift', () => {
    const rows = [
      metered({ inputTokens: 100, outputTokens: 200, costEstimate: 0.0055 }),
      metered({ meteringStatus: 'unpriced', provider: 'agent_cli' }),
      metered({ inputTokens: 10, meteringStatus: 'unknown' }),
    ];
    const totals = emptyMeteredTotals();
    for (const row of rows) {
      const parsed = EngineEventSchema.parse(row.payload);
      if (parsed.type === 'activity.metered') accumulateMetered(totals, parsed);
    }
    expect(runCostFromTotals(totals)).toEqual(computeRunCost(rows));
  });

  it('counts responses that REPORTED a token count, so an absent count is not a zero', () => {
    const totals = emptyMeteredTotals();
    // An `agent_cli` spend fact carries NO token counts at all (`cliSpendFact`).
    accumulateMetered(totals, meteredEvent({ meteringStatus: 'unpriced', provider: 'agent_cli' }));
    expect(totals.responseCount).toBe(1);
    expect(totals.inputTokens).toBe(0);
    expect(totals.tokenReportedResponseCount).toBe(0);

    // A PARTIAL count still counts as reported — it reported the side it had.
    accumulateMetered(totals, meteredEvent({ inputTokens: 7, meteringStatus: 'unknown' }));
    expect(totals.tokenReportedResponseCount).toBe(1);
    expect(totals.inputTokens).toBe(7);
  });

  it('records the distinct providers and models a fold saw, in first-seen order', () => {
    const totals = emptyMeteredTotals();
    accumulateMetered(totals, meteredEvent({ model: 'claude-opus-4-8', costEstimate: 0.1 }));
    accumulateMetered(totals, meteredEvent({ model: 'claude-opus-4-8', costEstimate: 0.1 }));
    accumulateMetered(
      totals,
      meteredEvent({ provider: 'agent_cli', model: 'cli', meteringStatus: 'unpriced' }),
    );
    const node = nodeCostFromTotals(totals);
    expect(node.providers).toEqual(['anthropic_api', 'agent_cli']);
    expect(node.models).toEqual(['claude-opus-4-8', 'cli']);
  });

  it('projects a node cost that is a RunCost plus the per-node facts', () => {
    const totals = emptyMeteredTotals();
    accumulateMetered(totals, meteredEvent({ inputTokens: 1, outputTokens: 2, costEstimate: 0.5 }));
    const node = nodeCostFromTotals(totals);
    // Every `RunCost` field is present and agrees with the run-level projection.
    expect(node).toMatchObject(runCostFromTotals(totals));
    expect(node.tokenReportedResponseCount).toBe(1);
  });

  it('never mutates a caller through a shared totals object', () => {
    const a = emptyMeteredTotals();
    const b = emptyMeteredTotals();
    accumulateMetered(a, meteredEvent({ costEstimate: 1 }));
    expect(b.responseCount).toBe(0);
    expect(b.providers.size).toBe(0);
  });
});
