import { z } from 'zod';
import { EngineEventSchema, type EngineEvent } from '../engine/types.js';

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
  /**
   * Total `activity.metered` events folded — BILLED EXCHANGES, not successful
   * responses. Since #725 a FAILURE that discarded a billed exchange mints one too:
   * a 2xx that parsed with no usable completion (a truncated response — full real
   * counts, so the run stays cost-`complete`), and an unparseable 2xx (`unknown`,
   * which flips `complete:false`). Both are retry-eligible or fail permanently, and
   * where the engine retries, EACH attempt adds another response here — the
   * intended reading, since the money was spent each time.
   *
   * A timed-out HTTP call is deliberately NOT counted, even though it may well have
   * been billed: a timeout cannot distinguish a long generation from a request that
   * never reached the provider, so counting it would invent spend. See `llmPost`
   * and #725.
   *
   * `agent_cli` is the deliberate CARVE-OUT (#797): a subprocess that RAN is counted
   * whether or not it produced a completion — its fact is `unpriced`, which can
   * never flip `complete`, so an over-count is cheap where losing a subscription
   * CLI's only spend signal is not (`cliSpendFact` in `agent.ts` argues it in full).
   * That count is per INVOCATION, not per provider response: one `agent_task` may
   * drive many model calls internally and the CLI reports none of them, so for
   * those nodes this number is a floor, not a census.
   */
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

/**
 * #931 — the Zod twin of {@link RunCost}, because the run LIST now carries a
 * cost per row (`RunSummarySchema.cost`) and a wire shape needs a parser.
 *
 * It lives HERE, beside the money model, rather than in `schemas/run.ts` beside
 * its one consumer — the same argument `pricing/price-table.ts` already settles
 * for `ModelUnitPriceSchema`/`ConnectionPriceTableSchema`, and the same one
 * `pricing/display.ts` makes for `formatUsd`: the rule about the money belongs
 * with the money, or the second consumer re-decides it differently.
 *
 * `satisfies z.ZodType<RunCost>` pins the schema to the interface in one
 * direction (a missing or mistyped field is a compile error). The other direction
 * — an EXTRA field the interface does not declare — is not expressible that way
 * (an intersection is still assignable), so it is pinned by an exact key-set
 * assertion in the tests.
 *
 * Every count is a non-negative integer and `totalCostEstimate` a non-negative
 * number, matching `activity.metered.costEstimate`'s own `z.number().nonnegative()`
 * — a negative cost is not a thing the fold or the SQL can produce, so admitting
 * one here would only let a corrupt row through wearing a valid shape.
 */
export const RunCostSchema = z.object({
  currency: z.literal('USD'),
  totalCostEstimate: z.number().nonnegative(),
  responseCount: z.number().int().nonnegative(),
  pricedResponseCount: z.number().int().nonnegative(),
  unpricedResponseCount: z.number().int().nonnegative(),
  costUnknownResponseCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  complete: z.boolean(),
}) satisfies z.ZodType<RunCost>;

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
 * #599 — the scalar aggregates for ONE SCOPE's metered responses: the shape a
 * BOUNDED SQL aggregation produces as well as what the in-memory array fold sums
 * to. Deliberately carries neither `costUnknownResponseCount` NOR `complete`:
 * both are DERIVED by {@link runCostFromAggregates} (the single fail-closed
 * derivation site), so no caller can hand in an inconsistent
 * priced/unknown/complete triple.
 *
 * SPLIT OUT of `PipelineCostAggregates` by #931, when the run LIST needed the
 * same bounded aggregation grouped per run. `runCount`/`incompleteRunCount` have
 * no per-run analogue — a single run's incompleteness is just `complete === false`
 * — so the run-level shape is exactly this run-count-free half, and both SQL
 * paths derive through one function rather than two.
 */
export interface MeteredAggregates {
  /**
   * Total `activity.metered` events folded — BILLED EXCHANGES, not completions.
   * The SQL twin of `RunCost.responseCount`; see its doc for why #725 makes a
   * discarded-but-billed exchange count too.
   */
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
 * #599 — {@link MeteredAggregates} PLUS the two run-level counts a per-pipeline
 * rollup adds. The shape `aggregatePipelineCost` produces.
 */
export interface PipelineCostAggregates extends MeteredAggregates {
  /** All runs of the pipeline, INCLUDING zero-metered ones (each a complete $0). */
  runCount: number;
  /** Runs with at least one cost-unknown metered response. */
  incompleteRunCount: number;
}

/**
 * The SINGLE fail-closed derivation of a {@link RunCost} from scalar aggregates.
 * EVERY aggregate-shaped path funnels through here — the in-memory array fold
 * ({@link rollupPipelineCost}), the bounded per-PIPELINE SQL rollup (#599,
 * `aggregatePipelineCost`) via {@link rollupFromAggregates}, and the bounded
 * per-RUN SQL aggregation the run list uses (#931, `aggregateRunCosts`) — so the
 * fail-closed rule lives in ONE place and no path can drift from another:
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
 * The caller is responsible for computing every count over the SAME row set
 * (same join, filter, owner scope); the derivation is only as honest as that.
 *
 * NOT to be confused with {@link runCostFromTotals}, which projects the SAME
 * shape from the in-memory accumulator: that one CARRIES `costUnknownResponseCount`
 * (the fold categorised each response as it went), this one DERIVES it (SQL can
 * count what is present, so the gap is what is left over). Two inputs, one
 * fail-closed rule, and it is written once — here for the aggregate path and in
 * {@link accumulateMetered} for the fold path, which is exactly the pairing
 * `run-events.test.ts`'s SQL-vs-fold equivalence test pins.
 */
export function runCostFromAggregates(agg: MeteredAggregates): RunCost {
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
  };
}

/**
 * The per-PIPELINE rollup: {@link runCostFromAggregates} plus the two run-level
 * counts, passed through as measured.
 *
 * The caller is responsible for computing all counts over the SAME row set (same
 * join, filter, owner scope) so the documented invariant
 * `complete === (incompleteRunCount === 0)` holds — a run counts as incomplete IFF
 * it has a genuine cost-unknown response (NOT merely an `unpriced` one).
 */
export function rollupFromAggregates(agg: PipelineCostAggregates): PipelineCostRollup {
  return {
    ...runCostFromAggregates(agg),
    runCount: agg.runCount,
    incompleteRunCount: agg.incompleteRunCount,
  };
}

/** The `activity.metered` member of the engine event union — what the fold reads. */
type MeteredEvent = Extract<EngineEvent, { type: 'activity.metered' }>;

/**
 * #866 — the MUTABLE scalars a metered fold accumulates, and the single place the
 * fail-closed three-way categorisation is written.
 *
 * It exists because per-NODE cost (the run monitor's drill-in) needs the same
 * categorisation as per-RUN cost, folded inside a walk that is already happening
 * (the web `deriveNodeActivity` — see #849, the run detail page already folds its
 * log three times per frame, so a fourth walk is a known cost). Copying the rule
 * into that fold would make it a second, drifting authority. `rollupFromAggregates`
 * set the precedent: ONE derivation site, so the paths cannot diverge.
 *
 * It carries MORE than {@link RunCost} projects, deliberately. The extra fields are
 * per-node facts that are meaningless diluted across a whole run but are the entire
 * reading of a single node; {@link runCostFromTotals} simply drops them, so the
 * run-level shape (and the #599 SQL aggregate path that mirrors it) is untouched.
 */
export interface MeteredTotals {
  totalCostEstimate: number;
  responseCount: number;
  pricedResponseCount: number;
  unpricedResponseCount: number;
  costUnknownResponseCount: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Responses that reported an input / an output token count, counted SEPARATELY.
   *
   * Without them, `inputTokens: 0` is ambiguous between "this really used no
   * tokens" and "nobody counted" — and the second is the COMMON case per node: an
   * `agent_cli` spend fact (`cliSpendFact`) carries no token counts at all, so an
   * `agent_task` node would render `0 in / 0 out` for a subprocess that may have
   * driven dozens of model calls internally. That is a measurement nobody took,
   * printed as a measurement — the same manufactured-zero shape `formatNodeDuration`
   * refuses when it renders an unmeasured span as an em-dash rather than `0ms`.
   *
   * TWO counters, not one, and that is the load-bearing part. `meterUsage` stamps
   * whichever side a provider reported and leaves the other absent (an
   * OpenAI-compatible gateway sending `prompt_eval_count` and no `eval_count` is
   * the documented case), so a SINGLE "reported at least one side" counter would
   * call that response reported and render `4,000 in · 0 out` — the manufactured
   * zero, on the very side nobody counted. The absent side has to be visible as
   * absent, which means each side answers for itself.
   */
  inputReportedResponseCount: number;
  outputReportedResponseCount: number;
  /** Distinct `provider` values seen, in first-seen order. */
  providers: Set<string>;
  /** Distinct `model` values seen, in first-seen order. */
  models: Set<string>;
}

/** A fresh, zeroed accumulator. */
export function emptyMeteredTotals(): MeteredTotals {
  return {
    totalCostEstimate: 0,
    responseCount: 0,
    pricedResponseCount: 0,
    unpricedResponseCount: 0,
    costUnknownResponseCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    inputReportedResponseCount: 0,
    outputReportedResponseCount: 0,
    providers: new Set(),
    models: new Set(),
  };
}

/**
 * Fold ONE metered response into `totals`. The fail-closed categorisation lives
 * here and nowhere else.
 */
export function accumulateMetered(totals: MeteredTotals, e: MeteredEvent): void {
  totals.responseCount += 1;
  totals.providers.add(e.provider);
  totals.models.add(e.model);
  if (e.inputTokens !== undefined) {
    totals.inputTokens += e.inputTokens;
    totals.inputReportedResponseCount += 1;
  }
  if (e.outputTokens !== undefined) {
    totals.outputTokens += e.outputTokens;
    totals.outputReportedResponseCount += 1;
  }

  // Three disjoint, exhaustive categories. `costEstimate` presence wins first —
  // it is stamped ONLY when a price resolved AND both tokens were present, so its
  // presence means a fully-known cost regardless of status.
  if (e.costEstimate !== undefined) {
    totals.totalCostEstimate += e.costEstimate;
    totals.pricedResponseCount += 1;
  } else if (e.meteringStatus === 'unpriced') {
    // L14: a subscription/CLI call — cost is a known flat/covered zero-marginal,
    // NOT a measurement gap, so it does not flip `complete`.
    totals.unpricedResponseCount += 1;
  } else {
    // FAIL-CLOSED: a genuine gap (unpriced model / unknown usage). No manufactured
    // 0 — the absence is recorded, not padded, and flips `complete`.
    totals.costUnknownResponseCount += 1;
  }
}

/** Project accumulated totals into the run-level {@link RunCost} shape. */
export function runCostFromTotals(totals: MeteredTotals): RunCost {
  return {
    currency: 'USD',
    totalCostEstimate: totals.totalCostEstimate,
    responseCount: totals.responseCount,
    pricedResponseCount: totals.pricedResponseCount,
    unpricedResponseCount: totals.unpricedResponseCount,
    costUnknownResponseCount: totals.costUnknownResponseCount,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    complete: totals.costUnknownResponseCount === 0,
  };
}

/**
 * A cost slice for ONE SCOPE — a node, or (since #930) a whole run: every
 * {@link RunCost} field, plus the facts a rendered reading needs and the
 * SQL-aggregate path cannot supply.
 *
 * `providers`/`models` are the answer to "which model did this actually run",
 * which is answerable nowhere else in the UI — and `providers` is also what lets a
 * reader tell an `agent_cli` exchange apart, whose `responseCount` means something
 * DIFFERENT (see {@link RunCost.responseCount}: per invocation, a floor rather than
 * a census, because the CLI reports none of the model calls it drives internally).
 *
 * AMENDED (#930). This shape was introduced by #866 as per-NODE only, and said so:
 * "the facts a per-node reading needs and a whole-run reading CANNOT use". That was
 * wrong, and U27's run-level surface is the counter-example:
 *
 *  - the per-side reported counts are what stop `inputTokens: 0` rendering as a
 *    measurement nobody took. That failure is identical at run level — a run of
 *    `agent_cli` nodes reports no token counts at all — so a run-level reading
 *    built on plain {@link RunCost} would print the exact manufactured zero this
 *    field exists to prevent;
 *  - `providers` still decides the floor-not-census caveat: ONE `agent_cli`
 *    exchange anywhere in the run makes the run's `responseCount` a floor too.
 *
 * What IS node-only is the *weight* of the caveats, not their truth. So the shape
 * is shared and {@link computeRunUsage} is the run-level producer; only the
 * bounded-SQL aggregate path ({@link PipelineCostAggregates}) stays on the
 * narrower {@link RunCost}, because it genuinely cannot count these in SQL today.
 */
export interface NodeCost extends RunCost {
  inputReportedResponseCount: number;
  outputReportedResponseCount: number;
  providers: string[];
  models: string[];
}

/** Project accumulated totals into the per-node {@link NodeCost} shape. */
export function nodeCostFromTotals(totals: MeteredTotals): NodeCost {
  return {
    ...runCostFromTotals(totals),
    inputReportedResponseCount: totals.inputReportedResponseCount,
    outputReportedResponseCount: totals.outputReportedResponseCount,
    providers: [...totals.providers],
    models: [...totals.models],
  };
}

/**
 * The shared fold: every `activity.metered` payload in a log, accumulated once.
 *
 * Extracted (#930) so the run-level projection and the richer run-level USAGE
 * projection walk the log through the SAME code rather than two copies that can
 * drift on which rows they skip. Not exported: callers want one of the two
 * projections below, and handing out the mutable accumulator would invite a third
 * categorisation site — the thing {@link accumulateMetered}'s docblock exists to
 * prevent.
 */
function meteredTotalsOf(events: readonly { payload: unknown }[]): MeteredTotals {
  const totals = emptyMeteredTotals();
  for (const row of events) {
    const parsed = EngineEventSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    const e = parsed.data;
    if (e.type !== 'activity.metered') continue;
    accumulateMetered(totals, e);
  }
  return totals;
}

/** Fold one run's events into a `RunCost`. Pure, deterministic, order-independent,
 * never throws. */
export function computeRunCost(events: readonly { payload: unknown }[]): RunCost {
  return runCostFromTotals(meteredTotalsOf(events));
}

/**
 * #930 — fold one run's events into the RICHER {@link NodeCost} slice: everything
 * {@link computeRunCost} projects, plus the per-side reported counts and the
 * provider/model sets.
 *
 * A rendered run-level figure needs those extras for the same reason the per-node
 * panel does (see {@link NodeCost}) — without them a run that measured no tokens
 * is indistinguishable from one that used none. `computeRunCost` keeps its narrower
 * shape because it is the twin of the bounded-SQL aggregate path
 * ({@link runCostFromAggregates}), and widening THAT would mean counting these in
 * SQL. #931 made that twinning real for the run LIST — `aggregateRunCosts` produces
 * exactly this shape per run — while `GET /api/runs/:id/cost` still folds
 * `listRunEvents` in memory (`routes/runs.ts`), which the earlier wording named as
 * though the aggregate already backed it. That route COULD be moved onto the
 * bounded aggregate and retire the last unbounded cost loader; it is deliberately
 * left alone here, because a single-run route is not the scaling hazard a list is
 * and swapping it would change what happens to a row the fold would skip.
 *
 * The two agree by construction on every shared field: one fold, two projections.
 */
export function computeRunUsage(events: readonly { payload: unknown }[]): NodeCost {
  return nodeCostFromTotals(meteredTotalsOf(events));
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
