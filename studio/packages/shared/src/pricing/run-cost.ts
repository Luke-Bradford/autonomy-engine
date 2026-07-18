import { EngineEventSchema } from '../engine/types.js';

/**
 * #2 L6 — the run-cost PROJECTION. A pure, deterministic fold over a run's event
 * log that SUMS the `costEstimate` L5 stamped onto each `activity.metered` event.
 * It does NOT re-price — the cost is an immutable fact captured at run-time
 * (`pricing/price-table.ts` owns resolution; this only sums what was stamped), so
 * a later price change never alters a past run's recorded cost (spec #2's replay
 * invariant).
 *
 * FAIL-CLOSED (the #473 / F13a lesson): an absent `costEstimate` — an unpriced
 * model, OR a response with incomplete usage (`meteringStatus:'unknown'`) — is the
 * run-cost INCOMPLETENESS signal. It is NEVER summed as `0` (a manufactured zero
 * would silently understate spend, the exact fail-open shape the merge-gate and
 * F13a forbid). Instead it flips `complete` to `false` and increments
 * `costUnknownResponseCount`, so `totalCostEstimate` is honestly a LOWER BOUND
 * whenever `complete` is false.
 *
 * TOTAL / never-throws (the prevention-log #12 lesson): every payload is
 * re-validated through `EngineEventSchema.safeParse`, and a row that does not
 * parse is SKIPPED, not thrown — mirroring `deriveNodeActivity`. A monitor/route
 * folding this must never crash on one odd frame.
 *
 * Input is `{ payload }[]` (not the full `RunEvent` envelope) deliberately: the
 * projection only reads the payload, so it stays decoupled from the run-event
 * envelope and folds identically over a `listRunEvents` result OR a server-side
 * join query that returns only `{ runId, payload }` rows.
 */

/**
 * A per-run cost total. Money is USD; `totalCostEstimate` is RAW/unrounded (L6
 * leaves display rounding to the consumer, matching how L5 stamps it raw).
 */
export interface RunCost {
  readonly currency: 'USD';
  /**
   * SUM of the `costEstimate` on metered responses that carry one. A LOWER BOUND
   * when `complete` is false — responses WITHOUT a `costEstimate` are counted in
   * `costUnknownResponseCount`, never summed as 0.
   */
  totalCostEstimate: number;
  /** Total `activity.metered` events (billed provider responses) folded. */
  responseCount: number;
  /** Responses carrying a `costEstimate` (price resolved AND both token counts present). */
  pricedResponseCount: number;
  /**
   * Responses WITHOUT a `costEstimate` — an unpriced model, OR incomplete usage
   * (`meteringStatus:'unknown'`). Cause-neutral: what they share is that their
   * cost is UNKNOWN, which is why the total is a lower bound. Always
   * `pricedResponseCount + costUnknownResponseCount === responseCount`.
   */
  costUnknownResponseCount: number;
  /** Sum of the PRESENT `inputTokens` / `outputTokens` counts. A partial count
   * (one side missing) still contributes the side it reported. */
  inputTokens: number;
  outputTokens: number;
  /**
   * `true` iff every counted response had a resolvable cost
   * (`costUnknownResponseCount === 0`). A run with zero responses is complete
   * ($0 — nothing to price). NOTE: this is a completeness-of-PRICING flag, NOT a
   * run-finished flag — an in-flight run whose metered-so-far responses all
   * priced reports `complete:true`.
   */
  complete: boolean;
}

/** A per-pipeline rollup: the same money/count fields summed across the
 * pipeline's runs, plus run-level counts. */
export interface PipelineCostRollup extends RunCost {
  /** Number of runs contributing to the rollup (incl. zero-cost runs). */
  runCount: number;
  /** Runs with at least one cost-unknown response — the runs across which
   * `totalCostEstimate` is a lower bound. `complete === (incompleteRunCount === 0)`. */
  incompleteRunCount: number;
}

/** Fold one run's events into a `RunCost`. Pure, deterministic, order-independent,
 * never throws. */
export function computeRunCost(events: readonly { payload: unknown }[]): RunCost {
  let totalCostEstimate = 0;
  let responseCount = 0;
  let pricedResponseCount = 0;
  let costUnknownResponseCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const row of events) {
    const parsed = EngineEventSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    const e = parsed.data;
    if (e.type !== 'activity.metered') continue;

    responseCount += 1;
    if (e.inputTokens !== undefined) inputTokens += e.inputTokens;
    if (e.outputTokens !== undefined) outputTokens += e.outputTokens;

    if (e.costEstimate !== undefined) {
      totalCostEstimate += e.costEstimate;
      pricedResponseCount += 1;
    } else {
      // FAIL-CLOSED: no manufactured 0 — the absence is recorded, not padded.
      costUnknownResponseCount += 1;
    }
  }

  return {
    currency: 'USD',
    totalCostEstimate,
    responseCount,
    pricedResponseCount,
    costUnknownResponseCount,
    inputTokens,
    outputTokens,
    complete: costUnknownResponseCount === 0,
  };
}

/** Roll up per-run costs into a per-pipeline total. Pure; sums the money/count
 * fields and derives the run-level counts. */
export function rollupPipelineCost(runCosts: readonly RunCost[]): PipelineCostRollup {
  const rollup: PipelineCostRollup = {
    currency: 'USD',
    totalCostEstimate: 0,
    responseCount: 0,
    pricedResponseCount: 0,
    costUnknownResponseCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    complete: true,
    runCount: runCosts.length,
    incompleteRunCount: 0,
  };

  for (const rc of runCosts) {
    rollup.totalCostEstimate += rc.totalCostEstimate;
    rollup.responseCount += rc.responseCount;
    rollup.pricedResponseCount += rc.pricedResponseCount;
    rollup.costUnknownResponseCount += rc.costUnknownResponseCount;
    rollup.inputTokens += rc.inputTokens;
    rollup.outputTokens += rc.outputTokens;
    if (!rc.complete) rollup.incompleteRunCount += 1;
  }

  // Equivalent to `incompleteRunCount === 0`, derived from the summed responses
  // as the single source (a run is incomplete IFF it has a cost-unknown response).
  rollup.complete = rollup.costUnknownResponseCount === 0;
  return rollup;
}
