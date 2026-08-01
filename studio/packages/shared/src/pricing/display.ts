/**
 * #866 — how a cost figure is WRITTEN DOWN. Shared rather than page-local because
 * cost has more than one surface already (`GET /api/runs/:id/cost`, the per-node
 * drill-in, and the pipeline rollup `rollupFromAggregates` serves), and the one
 * rule below must not be re-decided per surface.
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
  return `$${amount.toFixed(2)}`;
}

/**
 * Drop trailing zeros from a fixed-point string, keeping at least two decimals so
 * every figure still reads as money (`0.009900` → `0.0099`, `0.001000` → `0.001`).
 */
function trimTrailingZeros(fixed: string): string {
  const trimmed = fixed.replace(/0+$/, '');
  const [whole, fraction = ''] = trimmed.split('.');
  return fraction.length >= 2 ? trimmed : `${whole}.${fraction.padEnd(2, '0')}`;
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
