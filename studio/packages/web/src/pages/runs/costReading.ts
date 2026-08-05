import { AGENT_CLI_CONNECTION_KIND, formatTokenCount, formatUsd } from '@autonomy-studio/shared';
import type { NodeCost } from '@autonomy-studio/shared';

/**
 * #866 — HOW a folded cost figure must be read, as a pure function of the fold.
 * #930 — and how it must be WORDED, for a node or for a whole run.
 *
 * Split out of the panel for the same reason `containerRules`/`paramRules` were
 * split out of the canvas: every decision here is a pure function of the data, so
 * it can be tested — and mutation-proven — without mounting a page.
 *
 * The whole point is that a money figure is NOT self-explanatory, and the ways it
 * can mislead are specific:
 *
 *  - A run of exchanges nobody could price sums to `0`, and `$0.00` reads as
 *    FREE. `computeRunCost` is careful never to sum an absent `costEstimate` as
 *    zero; that care is wasted if the display then prints the resulting zero as
 *    a settled total.
 *  - A subscription/CLI call has NO unit price BY DESIGN (L14 `unpriced`). Its
 *    zero is a real, known zero-marginal — the opposite of a measurement gap —
 *    and reading it as "cost unknown" would be just as wrong in the other
 *    direction.
 *
 * So the reading is classified once, here, rather than reconstructed from the
 * five raw counters at each call site.
 *
 * RENAMED from `nodeCost.ts` by #930, when U27 gave the same five readings a
 * SECOND consumer — the run-level surface — and the file kept its whole reason
 * for existing: one authority, so the two surfaces cannot tell an operator
 * different things about the same money. The phrasing helpers moved in here with
 * it, for the same reason: a copy of these sentences beside the run panel would
 * be a second wording, free to drift from this one.
 */

/** Whose spend is being described. The classification is identical for both;
 * three of the sentences name their subject, and one arm of `costSentence` is
 * only REACHABLE at run level. */
export type CostSubject = 'node' | 'run';

/** How the summed figure must be read. */
export type CostKind =
  /** Nothing billed under this scope at all — not a cost of zero, an absence of billing. */
  | 'none'
  /** Every exchange was a subscription/CLI call: a KNOWN zero marginal cost. */
  | 'covered'
  /** Exchanges happened and NONE of them could be priced — the cost is unknown. */
  | 'unknown'
  /** Some priced, some not: the figure is a floor, never the total. */
  | 'lower-bound'
  /** Every exchange's cost is known: the figure is the cost. */
  | 'exact';

export interface CostReading {
  kind: CostKind;
  /** The summed KNOWN cost. Meaningful only for `exact` and `lower-bound`. */
  amount: number;
  /** Exchanges whose cost could not be resolved (the incompleteness signal). */
  unknownCount: number;
  /** Exchanges that carry no unit price by design (subscription/CLI). */
  coveredCount: number;
  /** Total billed exchanges folded. */
  exchangeCount: number;
  /**
   * Whether the exchange count is a FLOOR rather than a census. True when an
   * `agent_cli` response is among them: that fact is minted per subprocess
   * INVOCATION, and the CLI reports none of the model calls it drives
   * internally (`RunCost.responseCount`, the #797 carve-out). On one
   * `agent_task` node it is the entire reading; at run level it is diluted
   * across many nodes but no less TRUE — one CLI exchange anywhere makes the
   * run's count a floor too.
   */
  exchangesAreFloor: boolean;
  /**
   * Whether any exchange reported an input / an output token count, answered
   * SEPARATELY per side.
   *
   * `false` means that side's sum is a zero nobody measured, and must render as
   * unreported rather than as `0`. Per side rather than combined because
   * `meterUsage` stamps whichever side a provider sent and leaves the other
   * absent: a response reporting 4,000 input tokens and no output count is
   * REPORTED on one side and UNMEASURED on the other, and a single flag would
   * have to call it one or the other — printing `4,000 in · 0 out` if it chose
   * "reported", which is the manufactured zero this whole reading exists to stop.
   */
  inputTokensReported: boolean;
  outputTokensReported: boolean;
  /** True when only SOME exchanges reported that side, so its sum is partial. */
  inputTokensPartial: boolean;
  outputTokensPartial: boolean;
  /** How many exchanges reported each side — for saying how partial. */
  inputReportedCount: number;
  outputReportedCount: number;
}

/** Classify a folded cost into the one reading that is true of it. */
export function readCost(cost: NodeCost): CostReading {
  const base = {
    amount: cost.totalCostEstimate,
    unknownCount: cost.costUnknownResponseCount,
    coveredCount: cost.unpricedResponseCount,
    exchangeCount: cost.responseCount,
    exchangesAreFloor: cost.providers.includes(AGENT_CLI_CONNECTION_KIND),
    inputTokensReported: cost.inputReportedResponseCount > 0,
    outputTokensReported: cost.outputReportedResponseCount > 0,
    inputTokensPartial:
      cost.inputReportedResponseCount > 0 && cost.inputReportedResponseCount < cost.responseCount,
    outputTokensPartial:
      cost.outputReportedResponseCount > 0 && cost.outputReportedResponseCount < cost.responseCount,
    inputReportedCount: cost.inputReportedResponseCount,
    outputReportedCount: cost.outputReportedResponseCount,
  };

  if (cost.responseCount === 0) return { ...base, kind: 'none' };
  /* NOTHING priced, but gaps exist — the figure is 0 and saying "at least
     $0.00" is worse than saying nothing, because it presents a total that was
     never measured. Ordered BEFORE `lower-bound` for exactly that reason. */
  if (cost.costUnknownResponseCount > 0 && cost.pricedResponseCount === 0) {
    return { ...base, kind: 'unknown' };
  }
  if (cost.costUnknownResponseCount > 0) return { ...base, kind: 'lower-bound' };
  /* No gaps and nothing priced ⇒ every exchange was `unpriced`. A KNOWN zero. */
  if (cost.pricedResponseCount === 0) return { ...base, kind: 'covered' };
  return { ...base, kind: 'exact' };
}

/**
 * The token line. Each side answers for itself, so one measured side never lends
 * its credibility to an unmeasured one.
 */
export function tokenSummary(reading: CostReading, cost: NodeCost): string {
  if (!reading.inputTokensReported && !reading.outputTokensReported) return 'not reported';
  const input = reading.inputTokensReported
    ? `${formatTokenCount(cost.inputTokens)} in`
    : 'input not reported';
  const output = reading.outputTokensReported
    ? `${formatTokenCount(cost.outputTokens)} out`
    : 'output not reported';
  return `${input} · ${output}`;
}

/**
 * Whether a `lower-bound` reading's priced part is worth stating — the ONE place
 * that threshold is decided, because the headline and the sentence below it must
 * agree or the surface contradicts itself.
 *
 * `formatUsd` renders a sub-threshold amount as its own bound (`< $0.000001`), so
 * "At least < $0.000001" is a contradiction on its face; a genuine
 * `costEstimate: 0` (a free model in the price table) hits the same wall from the
 * other side, where "At least $0.00" is the very reading this surface exists to
 * prevent. Both collapse to one true statement: the priced part tells us nothing,
 * and there is more we could not price.
 */
export function statesAnAmount(reading: CostReading): boolean {
  return reading.amount >= 0.000001;
}

/**
 * Whether the HEADLINE is a money figure at all.
 *
 * Three of the five readings deliberately render words instead of an amount
 * (`No billed exchange` · `No marginal cost` · `Cost unknown`), as does a
 * `lower-bound` too small to state. Anything hanging a caveat off "the figure"
 * has to ask this first, or it qualifies a number that is not on screen.
 */
export function showsAnAmount(reading: CostReading): boolean {
  return reading.kind === 'exact' || (reading.kind === 'lower-bound' && statesAnAmount(reading));
}

/** The headline, which for three readings is deliberately not a money amount. */
export function costFigure(reading: CostReading): string {
  switch (reading.kind) {
    case 'none':
      return 'No billed exchange';
    case 'covered':
      return 'No marginal cost';
    case 'unknown':
      return 'Cost unknown';
    case 'lower-bound':
      return statesAnAmount(reading) ? `At least ${formatUsd(reading.amount)}` : 'Cost unknown';
    case 'exact':
      return formatUsd(reading.amount);
  }
}

export function costSentence(reading: CostReading, subject: CostSubject): string {
  const exchanges = `${reading.exchangeCount} billed exchange${reading.exchangeCount === 1 ? '' : 's'}`;
  switch (reading.kind) {
    case 'none':
      return `Nothing was billed under this ${subject}. A provider call that TIMED OUT records no exchange either — a timeout cannot tell a long generation from a request that never arrived, so counting it would invent spend.`;
    case 'covered':
      return `${exchanges}, every one a subscription or CLI call. Those carry no unit price by design, so this zero is a known covered cost — not a figure nobody could work out.`;
    case 'unknown':
      return `${exchanges}, and none of them could be priced (an unpriced model, or usage the provider did not report). A number is deliberately not shown: the sum would be $0.00, which reads as free.`;
    case 'lower-bound':
      /* Gated on the SAME predicate as the headline. Without that, the sentence
         promises "the figure" in exactly the case the headline withheld one. */
      return statesAnAmount(reading)
        ? `${exchanges}, of which ${reading.unknownCount} could not be priced. The figure is what the rest cost, so the real total is higher.`
        : `${exchanges}, of which ${reading.unknownCount} could not be priced — and what did price came to less than a millionth of a dollar. No figure is shown, because the priced part says nothing about the total.`;
    case 'exact':
      /* #930 — the MIXED arm, and why it now exists.
         `meteringStatus:'unpriced'` is minted at exactly one site (`cliSpendFact`,
         `agent_cli`), and a NODE binds one connection for the whole immutable run,
         so a node can never hold both a priced and an unpriced response. #866
         recorded that, said a mixed sentence would contradict itself, and left the
         note that "if a second producer of `unpriced` ever lands, this arm is where
         it has to be re-read."

         Lifting this surface to RUN level is that moment — and it is a SECOND
         SCOPE rather than a second producer, which is why the note nearly missed
         it. A run trivially mixes an `anthropic_api` node with an `agent_cli` one,
         and the old wording then claimed "N billed exchanges, all priced" over
         exchanges that were never priced at all. The HEADLINE stays right either
         way (a covered exchange contributes a KNOWN zero, so the total really is
         complete) — it is the sentence that has to name what the total is made of. */
      return reading.coveredCount > 0
        ? `${exchanges}: ${reading.exchangeCount - reading.coveredCount} priced, and ${reading.coveredCount} a subscription or CLI call carrying no unit price by design. The total is complete. Retries are included — each attempt was billed.`
        : `${exchanges}, all priced. Retries are included — each attempt was billed.`;
  }
}

/**
 * The caveat on a figure that is still moving.
 *
 * On a live tail an in-flight scope's spend-so-far otherwise reads with exactly
 * the confidence of a settled one. Two wordings, because the headline is not
 * always a number: saying "this is what it has spent so far" directly under "No
 * billed exchange" would qualify a figure that is not on screen — the same
 * contradiction the `lower-bound` sentence already answers.
 */
export function unsettledSentence(reading: CostReading, subject: CostSubject): string {
  return showsAnAmount(reading)
    ? `This ${subject} has not settled, so this is what it has spent SO FAR — not a final figure.`
    : `This ${subject} has not settled, so more exchanges may still be billed to it.`;
}

/**
 * #930 — what a RERUN copied rather than re-executed, and therefore what its
 * money figure does NOT include.
 *
 * A rerun-from-failed (RS6) reseeds by COPYING its frontier: the reducer writes
 * those nodes `{status:'success'}` and the new run's log carries no
 * `activity.metered` event for any of them (the `run.reseeded` branch in
 * `runSummary.ts` is explicit that it does not touch `costByNode`). So a rerun's
 * total is honestly the spend of what it RE-EXECUTED — an INCREMENTAL figure —
 * and rendered bare it makes the rerun look cheap while the reused work is
 * invisible.
 *
 * The understatement is the SAFE direction (nothing is double-counted; the source
 * run keeps its own spend), but it is only safe once it is legible. That is what
 * this answers.
 *
 * Keyed on the FOLD rather than the run row's `rerunOf`, matching the precedent
 * `RunDetailPage` states for the copied-vs-executed render: the fold renders in
 * cases where the REST read does not. Structurally typed on the one field it
 * reads, so it needs no import from the fold module and can be tested with plain
 * object literals.
 */
export interface ReusedSpend {
  /** How many nodes were copied rather than re-executed. Always > 0. */
  reusedNodeCount: number;
  /** The run those nodes were copied FROM. */
  sourceRunId: string;
}

export function reusedSpend(
  nodes: readonly { copiedFromRunId?: string | undefined }[],
): ReusedSpend | null {
  let reusedNodeCount = 0;
  let sourceRunId: string | undefined;
  for (const n of nodes) {
    if (n.copiedFromRunId === undefined) continue;
    reusedNodeCount += 1;
    /* First wins. A reseed copies from ONE source run, so a second value cannot
       occur; taking the first rather than the last makes the tie deterministic
       instead of order-dependent were that ever to stop being true. */
    sourceRunId ??= n.copiedFromRunId;
  }
  if (sourceRunId === undefined) return null;
  return { reusedNodeCount, sourceRunId };
}
