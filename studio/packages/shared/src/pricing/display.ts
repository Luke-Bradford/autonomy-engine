/**
 * #866 — how a cost figure is WRITTEN DOWN.
 *
 * Shared rather than page-local, and the honest reason is FORWARD-looking rather
 * than current: the per-node drill-in is the only consumer today (the cost ROUTES
 * return JSON numbers and render nothing). But U27 is a cost COLUMN plus a
 * per-run/rollup consumption surface, and the rule below is exactly the kind that
 * gets re-decided differently the second time someone needs it. It sits beside the
 * money model it is about, rather than inside one page that reads it.
 *
 * The directly analogous formatter — `formatNodeDuration`, carrying the same
 * never-manufacture-a-zero rule for time — lives page-local in
 * `pages/runs/format.ts`. If U27 lands and this is still the only caller, the two
 * should probably be together; that is a deliberate open question, not an
 * oversight.
 *
 * ANSWERED (#931, U27 slice 2). U27 has now landed in full and the condition DID
 * hold — `costReading.ts` is still the only file that calls this, because the run
 * list's new cost cell routes through `costFigure` rather than formatting money
 * itself. The answer is nonetheless to LEAVE IT HERE. Moving it beside
 * `formatNodeDuration` would put the money-rendering rule inside one page while
 * the money MODEL stays in shared, which is the split this file's own opening
 * paragraph argues against; and `RunCostSchema` now sits in `pricing/` for the
 * same reason. The count of callers was the wrong test — the right one is which
 * fact the rule is about.
 *
 * THE RULE: money that was spent is never rendered as `$0.00`.
 *
 * L5 stamps `costEstimate` RAW and unrounded, and a single cheap exchange is
 * routinely a few millionths of a dollar. Two decimals would round every one of
 * them to `$0.00` — a figure an operator reads as FREE. That is the same
 * manufactured-fact shape the rest of this module refuses (an absent
 * `costEstimate` is never summed as `0`; `formatNodeDuration` renders an
 * unmeasured span as an em-dash rather than `0ms`), applied to display: the
 * rounding must not invent a fact the number does not carry.
 */

/**
 * A USD amount. Only a genuine ZERO renders as `$0.00`; anything smaller than the
 * smallest figure this can state renders as `< $0.000001`, so a real charge is
 * never flattened into "free".
 *
 * TOTAL — a non-finite or negative input renders as an em-dash rather than
 * throwing or printing `$NaN`. Neither is reachable through
 * `activity.metered.costEstimate` (`z.number().nonnegative()`), but a formatter
 * that a monitor calls on every frame must not be the thing that crashes it.
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) return '—';
  if (amount === 0) return '$0.00';
  if (amount < 0.000001) return '< $0.000001';
  if (amount < 0.01) return `$${trimTrailingZeros(amount.toFixed(6))}`;
  /* Grouped, and the locale PINNED for the same reason `formatTokenCount` pins
     it: an unpinned `toLocaleString()` renders differently per machine. */
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Drop trailing zeros from a `toFixed(6)` string (`0.009900` → `0.0099`).
 *
 * Called from ONE branch only — `0.000001 <= amount < 0.01` — which is what makes
 * this total: every such amount has a significant digit in the first six decimal
 * places, so trimming can never strip the whole fraction and leave a dangling
 * `.`, and never needs a minimum-decimals pad.
 */
function trimTrailingZeros(fixed: string): string {
  return fixed.replace(/0+$/, '');
}

/**
 * A token COUNT. Grouped for legibility, with the locale PINNED — an unpinned
 * `toLocaleString()` renders differently per machine, which would make any
 * assertion on it a test that passes in one place and fails in another.
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '—';
  return tokens.toLocaleString('en-US');
}
