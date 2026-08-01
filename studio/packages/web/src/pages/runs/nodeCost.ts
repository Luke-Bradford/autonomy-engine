import { AGENT_CLI_CONNECTION_KIND, type NodeCost } from '@autonomy-studio/shared';

/**
 * #866 — HOW a node's cost figure must be read, as a pure function of the fold.
 *
 * Split out of the panel for the same reason `containerRules`/`paramRules` were
 * split out of the canvas: every decision here is a pure function of the data, so
 * it can be tested — and mutation-proven — without mounting a page.
 *
 * The whole point is that a per-node money figure is NOT self-explanatory, and
 * the ways it can mislead are specific:
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
 */

/** How the summed figure must be read. */
export type NodeCostKind =
  /** Nothing billed under this node at all — not a cost of zero, an absence of billing. */
  | 'none'
  /** Every exchange was a subscription/CLI call: a KNOWN zero marginal cost. */
  | 'covered'
  /** Exchanges happened and NONE of them could be priced — the cost is unknown. */
  | 'unknown'
  /** Some priced, some not: the figure is a floor, never the total. */
  | 'lower-bound'
  /** Every exchange priced: the figure is the cost. */
  | 'exact';

export interface NodeCostReading {
  kind: NodeCostKind;
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
   * internally (`RunCost.responseCount`, the #797 carve-out). At run level that
   * caveat is diluted across many nodes; on one `agent_task` node it is the
   * entire reading.
   */
  exchangesAreFloor: boolean;
  /**
   * Whether ANY exchange reported a token count. `false` means the token sums
   * are zeros nobody measured — an `agent_cli` spend fact carries no counts at
   * all — and must be rendered as unreported rather than as `0`.
   */
  tokensReported: boolean;
  /** True when only SOME exchanges reported tokens, so the sums are partial. */
  tokensPartial: boolean;
}

/** Classify a node's folded cost into the one reading that is true of it. */
export function readNodeCost(cost: NodeCost): NodeCostReading {
  const base = {
    amount: cost.totalCostEstimate,
    unknownCount: cost.costUnknownResponseCount,
    coveredCount: cost.unpricedResponseCount,
    exchangeCount: cost.responseCount,
    exchangesAreFloor: cost.providers.includes(AGENT_CLI_CONNECTION_KIND),
    tokensReported: cost.tokenReportedResponseCount > 0,
    tokensPartial:
      cost.tokenReportedResponseCount > 0 && cost.tokenReportedResponseCount < cost.responseCount,
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
