import { EngineEventSchema } from '../engine/types.js';

/**
 * #2 L6 — the run-cost PROJECTION. A pure, deterministic fold over a run's event
 * log that SUMS the `costEstimate` L5 stamped onto each `activity.metered` event.
 * It does NOT re-price — the cost is an immutable fact captured at run-time
 * (`pricing/price-table.ts` owns resolution; this only sums what was stamped), so
 * a later price change never alters a past run's recorded cost (spec #2's replay
 * invariant).
 *
 * FAIL-CLOSED (the #473 / F13a lesson): an absent `costEstimate` on a response
 * whose cost we EXPECTED to know — an unpriced model, OR incomplete usage
 * (`meteringStatus:'unknown'`) — is the run-cost INCOMPLETENESS signal. It is
 * NEVER summed as `0` (a manufactured zero would silently understate spend, the
 * exact fail-open shape the merge-gate and F13a forbid). Instead it flips
 * `complete` to `false` and increments `costUnknownResponseCount`, so
 * `totalCostEstimate` is honestly a LOWER BOUND whenever `complete` is false.
 *
 * L14 carves out a THIRD category: a `meteringStatus:'unpriced'` response — a
 * CLI/subscription call whose cost is a known FLAT/covered zero-marginal, not a
 * measurement gap — also lacks a `costEstimate` but must NOT flip `complete`. It
 * is counted in its own `unpricedResponseCount` so the run stays complete while
 * the Monitor can still surface "N subscription calls." The three counts partition
 * every response: `priced + unpriced + costUnknown === responseCount`.
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
   * L14: responses with `meteringStatus:'unpriced'` — a CLI/subscription call whose
   * cost is a KNOWN flat/covered zero-marginal (no unit price by design), NOT a
   * measurement gap. They carry no `costEstimate` but do NOT flip `complete`; they
   * are surfaced separately so a run of subscription calls reads as complete-but-
   * uncosted rather than incomplete.
   */
  unpricedResponseCount: number;
  /**
   * Responses whose cost is genuinely UNKNOWN — an unpriced MODEL, OR incomplete
   * usage (`meteringStatus:'unknown'`): a response we expected to price but could
   * not. This is the incompleteness signal (it flips `complete`); an `unpriced`
   * subscription call is EXCLUDED (see `unpricedResponseCount`). Always
   * `pricedResponseCount + unpricedResponseCount + costUnknownResponseCount === responseCount`.
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

/**
 * #599 — the scalar aggregates a per-pipeline rollup is built from, the shape a
 * BOUNDED SQL aggregation produces (`aggregatePipelineCost`) as well as what the
 * in-memory array fold sums to. Deliberately carries neither
 * `costUnknownResponseCount` NOR `complete`: both are DERIVED by
 * {@link rollupFromAggregates} (the single fail-closed derivation site), so no
 * caller can hand in an inconsistent priced/unknown/complete triple.
 */
export interface PipelineCostAggregates {
  /** All runs of the pipeline, INCLUDING zero-metered ones (each a complete $0). */
  runCount: number;
  /** Runs with at least one cost-unknown metered response. */
  incompleteRunCount: number;
  /** Total `activity.metered` responses folded. */
  responseCount: number;
  /** Responses carrying a `costEstimate` (present — a genuine `0` counts, an absent key does not). */
  pricedResponseCount: number;
  /** L14: responses with `meteringStatus:'unpriced'` (subscription/CLI, no unit
   * price by design). Disjoint from `pricedResponseCount` — the executor never
   * stamps a `costEstimate` on an `unpriced` response — so `costUnknownResponseCount`
   * is derived as `responseCount - pricedResponseCount - unpricedResponseCount`. */
  unpricedResponseCount: number;
  /** SUM of the PRESENT `costEstimate`s — a LOWER BOUND; absent ones contribute
   * nothing, never a manufactured 0 (the fail-closed rule). */
  totalCostEstimate: number;
  /** Sum of the PRESENT `inputTokens` / `outputTokens` counts. */
  inputTokens: number;
  outputTokens: number;
}

/**
 * The SINGLE fail-closed derivation of a {@link PipelineCostRollup} from scalar
 * aggregates. BOTH the in-memory array fold ({@link rollupPipelineCost}) and the
 * bounded SQL rollup (#599, `aggregatePipelineCost`) funnel through here, so the
 * fail-closed rule lives in ONE place and the two paths cannot drift:
 *
 *   - `costUnknownResponseCount` is DERIVED as
 *     `responseCount - pricedResponseCount - unpricedResponseCount`, NEVER summed
 *     as a manufactured 0 — a genuine gap (absent `costEstimate` on a response we
 *     expected to price) is excluded from BOTH `pricedResponseCount` and
 *     `unpricedResponseCount`, so the difference is exactly the unknown count (the
 *     #473 / F13a lesson). L14: a subscription `unpriced` response is carved OUT of
 *     the gap so it does not flip `complete`.
 *   - `complete` is `costUnknownResponseCount === 0`, matching `computeRunCost`.
 *
 * `runCount`/`incompleteRunCount` are passed through as measured. The caller is
 * responsible for computing all counts over the SAME row set (same join, filter,
 * owner scope) so the documented invariant `complete === (incompleteRunCount === 0)`
 * holds — a run counts as incomplete IFF it has a genuine cost-unknown response
 * (NOT merely an `unpriced` one).
 */
export function rollupFromAggregates(agg: PipelineCostAggregates): PipelineCostRollup {
  const costUnknownResponseCount =
    agg.responseCount - agg.pricedResponseCount - agg.unpricedResponseCount;
  return {
    currency: 'USD',
    totalCostEstimate: agg.totalCostEstimate,
    responseCount: agg.responseCount,
    pricedResponseCount: agg.pricedResponseCount,
    unpricedResponseCount: agg.unpricedResponseCount,
    costUnknownResponseCount,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    complete: costUnknownResponseCount === 0,
    runCount: agg.runCount,
    incompleteRunCount: agg.incompleteRunCount,
  };
}

/** Fold one run's events into a `RunCost`. Pure, deterministic, order-independent,
 * never throws. */
export function computeRunCost(events: readonly { payload: unknown }[]): RunCost {
  let totalCostEstimate = 0;
  let responseCount = 0;
  let pricedResponseCount = 0;
  let unpricedResponseCount = 0;
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

    // Three disjoint, exhaustive categories. `costEstimate` presence wins first —
    // it is stamped ONLY when a price resolved AND both tokens were present, so its
    // presence means a fully-known cost regardless of status.
    if (e.costEstimate !== undefined) {
      totalCostEstimate += e.costEstimate;
      pricedResponseCount += 1;
    } else if (e.meteringStatus === 'unpriced') {
      // L14: a subscription/CLI call — cost is a known flat/covered zero-marginal,
      // NOT a measurement gap, so it does not flip `complete`.
      unpricedResponseCount += 1;
    } else {
      // FAIL-CLOSED: a genuine gap (unpriced model / unknown usage). No manufactured
      // 0 — the absence is recorded, not padded, and flips `complete`.
      costUnknownResponseCount += 1;
    }
  }

  return {
    currency: 'USD',
    totalCostEstimate,
    responseCount,
    pricedResponseCount,
    unpricedResponseCount,
    costUnknownResponseCount,
    inputTokens,
    outputTokens,
    complete: costUnknownResponseCount === 0,
  };
}

/** Roll up an ARRAY of per-run costs into a per-pipeline total — the pure
 * fold-many counterpart to {@link computeRunCost}'s fold-one. Sums the
 * money/count fields and delegates the fail-closed derivation to
 * {@link rollupFromAggregates} (the single derivation site shared with the #599
 * SQL rollup). Summing each run's `pricedResponseCount` + `unpricedResponseCount`
 * and deriving unknown as `responseCount - priced - unpriced` is equivalent to
 * summing each run's `costUnknownResponseCount` directly, since `computeRunCost`
 * guarantees `priced + unpriced + unknown === responseCount` per run.
 *
 * NOTE (#599): the per-pipeline cost ROUTE no longer calls this — it aggregates
 * bounded-ly in SQL (`aggregatePipelineCost`) then derives via
 * `rollupFromAggregates`. This array fold is RETAINED as the SSOT's in-memory
 * `RunCost[]` reducer for any consumer already holding per-run costs (and as the
 * reference the SQL path's derivation is proven equivalent to); it is
 * deliberately not deleted alongside the unbounded LOADERS #599 removed, which
 * were the actual scaling hazard. */
export function rollupPipelineCost(runCosts: readonly RunCost[]): PipelineCostRollup {
  let totalCostEstimate = 0;
  let responseCount = 0;
  let pricedResponseCount = 0;
  let unpricedResponseCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let incompleteRunCount = 0;

  for (const rc of runCosts) {
    totalCostEstimate += rc.totalCostEstimate;
    responseCount += rc.responseCount;
    pricedResponseCount += rc.pricedResponseCount;
    unpricedResponseCount += rc.unpricedResponseCount;
    inputTokens += rc.inputTokens;
    outputTokens += rc.outputTokens;
    if (!rc.complete) incompleteRunCount += 1;
  }

  return rollupFromAggregates({
    runCount: runCosts.length,
    incompleteRunCount,
    responseCount,
    pricedResponseCount,
    unpricedResponseCount,
    totalCostEstimate,
    inputTokens,
    outputTokens,
  });
}
