import { describe, expect, it } from 'vitest';
import {
  accumulateMetered,
  computeRunCost,
  computeRunUsage,
  emptyMeteredTotals,
  nodeCostFromTotals,
  PipelineCostRollupSchema,
  rollupFromAggregates,
  rollupPipelineCost,
  RunCostSchema,
  runCostFromAggregates,
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
        inputReportedResponseCount: 3,
        outputReportedResponseCount: 3,
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
      inputReportedResponseCount: 10,
      outputReportedResponseCount: 10,
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
      inputReportedResponseCount: 5,
      outputReportedResponseCount: 5,
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
      inputReportedResponseCount: 0,
      outputReportedResponseCount: 0,
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
      inputReportedResponseCount: 8,
      outputReportedResponseCount: 8,
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
      inputReportedResponseCount: 6,
      outputReportedResponseCount: 6,
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
    expect(totals.inputReportedResponseCount).toBe(0);
    expect(totals.outputReportedResponseCount).toBe(0);

    // A PARTIAL count still counts as reported — it reported the side it had.
    accumulateMetered(totals, meteredEvent({ inputTokens: 7, meteringStatus: 'unknown' }));
    expect(totals.inputReportedResponseCount).toBe(1);
    // The side the provider did NOT send stays uncounted — the whole point.
    expect(totals.outputReportedResponseCount).toBe(0);
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
    expect(node.inputReportedResponseCount).toBe(1);
    expect(node.outputReportedResponseCount).toBe(1);
  });

  it('never mutates a caller through a shared totals object', () => {
    const a = emptyMeteredTotals();
    const b = emptyMeteredTotals();
    accumulateMetered(a, meteredEvent({ costEstimate: 1 }));
    expect(b.responseCount).toBe(0);
    expect(b.providers.size).toBe(0);
  });
});

/**
 * #930 — the run-level USAGE projection: the same fold, projected wider.
 *
 * The point of these is that `computeRunUsage` must be the SAME walk as
 * `computeRunCost` (so the run-level surface and `GET /api/runs/:id/cost` can
 * never disagree about what a run spent) while carrying the two facts a rendered
 * figure cannot be honest without — the per-side reported counts and `providers`.
 */
describe('computeRunUsage (#930 — the run-level usage projection)', () => {
  it('agrees with computeRunCost on every shared field, so the two cannot drift', () => {
    const rows = [
      metered({ inputTokens: 100, outputTokens: 200, costEstimate: 0.0055 }),
      metered({ meteringStatus: 'unpriced', provider: 'agent_cli' }),
      metered({ inputTokens: 10, meteringStatus: 'unknown' }),
      { payload: { type: 'not.an.event', nonsense: true } },
    ];
    const usage = computeRunUsage(rows);
    const cost = computeRunCost(rows);
    /* Projected onto RunCost's OWN key set rather than compared with
       `toMatchObject`, so a field added to RunCost later is compared too — the
       drift this test exists to catch is a new field one path forgets. */
    const narrowed = Object.fromEntries(
      Object.keys(cost).map((k) => [k, (usage as unknown as Record<string, unknown>)[k]]),
    );
    expect(narrowed).toEqual({ ...cost });
  });

  it('carries the per-side reported counts, so an unmeasured side is not a zero', () => {
    /* An `agent_cli` spend fact reports NO token counts; the second response
       reports only the INPUT side (the documented OpenAI-compatible-gateway
       case). A run-level reading built on RunCost alone would print `4,000 in ·
       0 out` — a measurement nobody took. */
    const usage = computeRunUsage([
      metered({ meteringStatus: 'unpriced', provider: 'agent_cli' }),
      metered({ inputTokens: 4000, meteringStatus: 'unknown' }),
    ]);
    expect(usage.responseCount).toBe(2);
    expect(usage.inputReportedResponseCount).toBe(1);
    expect(usage.outputReportedResponseCount).toBe(0);
    expect(usage.inputTokens).toBe(4000);
    expect(usage.outputTokens).toBe(0);
  });

  it('carries providers/models across the whole run, so one CLI exchange is visible', () => {
    const usage = computeRunUsage([
      metered({ provider: 'anthropic_api', model: 'claude-opus-4-8', costEstimate: 0.01 }),
      metered({ provider: 'agent_cli', model: 'claude-cli', meteringStatus: 'unpriced' }),
    ]);
    expect(usage.providers).toEqual(['anthropic_api', 'agent_cli']);
    expect(usage.models).toEqual(['claude-opus-4-8', 'claude-cli']);
  });

  it('is a complete $0 over an empty log', () => {
    const usage = computeRunUsage([]);
    expect(usage.responseCount).toBe(0);
    expect(usage.complete).toBe(true);
    expect(usage.providers).toEqual([]);
  });

  it('sees a MIXED run: priced and subscription exchanges together', () => {
    /* Unreachable per NODE — a node binds one connection for the whole immutable
       run — but ordinary per RUN, and it is the case the reading has to get
       right (see `costReading.ts`). */
    const usage = computeRunUsage([
      metered({ inputTokens: 10, outputTokens: 20, costEstimate: 0.5 }),
      metered({ provider: 'agent_cli', meteringStatus: 'unpriced' }),
    ]);
    expect(usage.pricedResponseCount).toBe(1);
    expect(usage.unpricedResponseCount).toBe(1);
    expect(usage.costUnknownResponseCount).toBe(0);
    expect(usage.complete).toBe(true);
    expect(usage.totalCostEstimate).toBe(0.5);
  });
});

/**
 * #931 — the run-level half of the aggregate path, split out of
 * `rollupFromAggregates` when the run LIST needed the same bounded SQL
 * aggregation grouped per run.
 */
describe('runCostFromAggregates (#931 — the run-level aggregate derivation)', () => {
  const aggregates = {
    responseCount: 10,
    pricedResponseCount: 6,
    unpricedResponseCount: 1,
    totalCostEstimate: 1.25,
    inputTokens: 500,
    outputTokens: 900,
    inputReportedResponseCount: 10,
    outputReportedResponseCount: 10,
  };

  it('DERIVES the cost gap as responseCount - priced - unpriced, never as a summed 0', () => {
    const cost = runCostFromAggregates(aggregates);
    expect(cost.costUnknownResponseCount).toBe(3);
    expect(cost.complete).toBe(false);
    expect(cost.totalCostEstimate).toBeCloseTo(1.25, 10);
    expect(cost.currency).toBe('USD');
  });

  it('an `unpriced` subscription response is NOT a gap — it cannot flip complete', () => {
    const cost = runCostFromAggregates({
      responseCount: 4,
      pricedResponseCount: 0,
      unpricedResponseCount: 4,
      totalCostEstimate: 0,
      inputTokens: 0,
      outputTokens: 0,
      // the `agent_cli` shape: 4 billed exchanges, no token count on either side
      inputReportedResponseCount: 0,
      outputReportedResponseCount: 0,
    });
    expect(cost.costUnknownResponseCount).toBe(0);
    expect(cost.complete).toBe(true);
  });

  it('carries NO run-level counts — a single run has no runCount/incompleteRunCount', () => {
    /* The reason the shape was split at all: `incompleteRunCount` has no per-run
       analogue, because a run's incompleteness IS `complete === false`. */
    const cost = runCostFromAggregates(aggregates);
    expect(Object.keys(cost).sort()).toEqual([
      'complete',
      'costUnknownResponseCount',
      'currency',
      'inputReportedResponseCount',
      'inputTokens',
      'outputReportedResponseCount',
      'outputTokens',
      'pricedResponseCount',
      'responseCount',
      'totalCostEstimate',
      'unpricedResponseCount',
    ]);
  });

  it('rollupFromAggregates DELEGATES to it — identical on every shared field', () => {
    /* The pin on the split: the pipeline rollup must be exactly the run-level
       derivation plus two pass-through counts, or the two SQL paths can drift on
       the fail-closed rule the whole module exists to state once. */
    const rollup = rollupFromAggregates({ ...aggregates, runCount: 4, incompleteRunCount: 2 });
    expect(rollup).toEqual({
      ...runCostFromAggregates(aggregates),
      runCount: 4,
      incompleteRunCount: 2,
    });
  });
});

/**
 * #1025 — the per-side token PRESENCE counts, on `RunCost` itself.
 *
 * `inputTokens: 0` is ambiguous between "this really used no tokens" and "nobody
 * counted", and the second is the common case (`cliSpendFact` mints a metered
 * event with no token fields at all). The fold path has answered that question
 * since #866; until now it answered it only into `NodeCost`, so every surface
 * built on the SQL aggregate — the run list, the per-pipeline rollup, the
 * AI-activity model table — read a manufactured zero. These pin the pair onto
 * both projections, and pin them AGREEING.
 */
describe('per-side token presence (#1025 — absent is not a measured zero)', () => {
  it('the aggregate path carries the pair — a side nobody counted is 0 REPORTED, not 0 tokens', () => {
    const cost = runCostFromAggregates({
      responseCount: 3,
      pricedResponseCount: 0,
      unpricedResponseCount: 3,
      totalCostEstimate: 0,
      inputTokens: 400,
      outputTokens: 0,
      inputReportedResponseCount: 1,
      outputReportedResponseCount: 0,
    });
    expect(cost.inputReportedResponseCount).toBe(1);
    expect(cost.outputReportedResponseCount).toBe(0);
  });

  it('the FOLD path projects the same pair onto RunCost, not just NodeCost', () => {
    /* The `agent_cli` shape: a metered event carrying neither token field. Before
       #1025 `runCostFromTotals` dropped both counters, so `computeRunCost` said
       `0 in / 0 out` for a subprocess that may have driven dozens of model calls. */
    const cost = computeRunCost([
      metered({ inputTokens: 400, costEstimate: 0.01 }),
      metered({ meteringStatus: 'unpriced', provider: 'agent_cli' }),
    ]);
    expect(cost.inputTokens).toBe(400);
    expect(cost.outputTokens).toBe(0);
    expect(cost.inputReportedResponseCount).toBe(1);
    expect(cost.outputReportedResponseCount).toBe(0);
  });

  it('SQL and fold AGREE over the same rows — one shape, two producers', () => {
    const events = [
      metered({ inputTokens: 100, outputTokens: 50, costEstimate: 0.01 }),
      metered({ meteringStatus: 'unpriced', provider: 'agent_cli' }),
      metered({ inputTokens: 10 }),
    ];
    expect(computeRunCost(events)).toEqual(
      runCostFromAggregates({
        responseCount: 3,
        pricedResponseCount: 1,
        unpricedResponseCount: 1,
        totalCostEstimate: 0.01,
        inputTokens: 110,
        outputTokens: 50,
        inputReportedResponseCount: 2,
        outputReportedResponseCount: 1,
      }),
    );
  });

  it('the pipeline rollup SUMS the pair across runs, per side', () => {
    const runA = computeRunCost([
      metered({ inputTokens: 100, outputTokens: 50, costEstimate: 0.01 }),
    ]);
    const runB = computeRunCost([metered({ meteringStatus: 'unpriced', provider: 'agent_cli' })]);
    const rollup = rollupPipelineCost([runA, runB]);
    expect(rollup.inputReportedResponseCount).toBe(1);
    expect(rollup.outputReportedResponseCount).toBe(1);
    expect(rollup.responseCount).toBe(2);
  });
});

/**
 * #931 — `RunCostSchema` is the wire shape `RunSummary.cost` is parsed through,
 * so it has to stay EXACTLY the `RunCost` interface. `satisfies z.ZodType<RunCost>`
 * pins one direction at compile time; this pins the other (an extra key), plus the
 * value constraints, at runtime.
 */
describe('RunCostSchema (#931 — the Zod twin of RunCost)', () => {
  const cost = runCostFromAggregates({
    responseCount: 3,
    pricedResponseCount: 2,
    unpricedResponseCount: 0,
    totalCostEstimate: 0.75,
    inputTokens: 120,
    outputTokens: 340,
    inputReportedResponseCount: 3,
    outputReportedResponseCount: 2,
  });

  it('has EXACTLY the keys RunCost declares — no more, no fewer', () => {
    expect(Object.keys(RunCostSchema.shape).sort()).toEqual(Object.keys(cost).sort());
  });

  it('round-trips a real derived cost unchanged', () => {
    expect(RunCostSchema.parse(cost)).toEqual(cost);
  });

  it('REFUSES a negative amount and a fractional count', () => {
    /* Neither is producible by the fold or the SQL, which is the point: a shape
       that admits them lets a corrupt row through looking valid. */
    expect(RunCostSchema.safeParse({ ...cost, totalCostEstimate: -0.01 }).success).toBe(false);
    expect(RunCostSchema.safeParse({ ...cost, responseCount: 1.5 }).success).toBe(false);
    expect(RunCostSchema.safeParse({ ...cost, currency: 'GBP' }).success).toBe(false);
  });
});

/**
 * #931 — the same three obligations for the PIPELINE rollup's wire shape, which
 * exists because `GET /api/pipelines/:id/cost` finally has a web caller and its
 * response has to be parsed rather than trusted.
 *
 * Built by EXTENDING `RunCostSchema` rather than restating its ten fields, so the
 * two shapes cannot drift; the key-set assertion below is what proves the
 * extension stayed faithful to `PipelineCostRollup`.
 */
describe('PipelineCostRollupSchema (#931 — the Zod twin of PipelineCostRollup)', () => {
  const rollup = rollupFromAggregates({
    responseCount: 3,
    pricedResponseCount: 2,
    unpricedResponseCount: 0,
    totalCostEstimate: 0.75,
    inputTokens: 120,
    outputTokens: 340,
    inputReportedResponseCount: 3,
    outputReportedResponseCount: 2,
    runCount: 4,
    incompleteRunCount: 1,
  });

  it('has EXACTLY the keys PipelineCostRollup declares — no more, no fewer', () => {
    expect(Object.keys(PipelineCostRollupSchema.shape).sort()).toEqual(Object.keys(rollup).sort());
  });

  it('round-trips a real derived rollup unchanged', () => {
    expect(PipelineCostRollupSchema.parse(rollup)).toEqual(rollup);
  });

  it('REFUSES a fractional or negative run count, and still refuses what RunCost refuses', () => {
    expect(PipelineCostRollupSchema.safeParse({ ...rollup, runCount: 1.5 }).success).toBe(false);
    expect(PipelineCostRollupSchema.safeParse({ ...rollup, incompleteRunCount: -1 }).success).toBe(
      false,
    );
    expect(
      PipelineCostRollupSchema.safeParse({ ...rollup, totalCostEstimate: -0.01 }).success,
    ).toBe(false);
  });
});
