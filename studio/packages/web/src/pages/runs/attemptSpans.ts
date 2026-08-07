import type { NodeActivity, AttemptSpan } from './runSummary';
import { isMeasurableSpan } from './format';

/**
 * U12a (#1007) — the pure arithmetic and classification behind `AttemptTimeline`.
 *
 * Split out of the component file rather than exported from it: `react-refresh`
 * (correctly) refuses a module that exports both components and plain functions,
 * and these are the parts worth testing on their own anyway — a percentage, a
 * window, and a sentence are all checkable without rendering anything.
 *
 * Named for the SPANS rather than the timeline, because `attemptTimeline.ts`
 * beside `AttemptTimeline.tsx` differs only in casing: this filesystem is
 * case-insensitive, so TypeScript refuses the pair outright (TS1149/TS1261).
 */

/**
 * Whether the span states a length. `format.ts` owns the rule — it is the same
 * question `formatNodeDuration` answers for the row scalars, and a second copy
 * here is how the table and the chart would come to disagree about what a
 * corrupt clock looks like. A span that fails it is drawn as a start marker with
 * its length withheld.
 */
export const isMeasurable = (span: AttemptSpan): span is AttemptSpan & { endedAtMs: number } =>
  isMeasurableSpan(span);

/**
 * The instants the log actually stated. An OPEN span contributes its start and
 * NOT an end — the whole point of rule 1 above: were the open span allowed to
 * stretch the axis to some assumed present, every closed bar beside it would be
 * squeezed by a number nobody measured.
 *
 * Folded in ONE PASS rather than collected into an array and spread through
 * `Math.min`/`Math.max`. The spread is the bug: it passes one ARGUMENT per
 * instant, and V8 overflows the call stack somewhere above 100k of them
 * (measured on this Node: 100,000 fine, 125,000 `RangeError`). A run is not
 * remotely bounded below that — a `foreach` over a few thousand items, each
 * body node retried, reaches it — and the throw would land in render, blanking
 * the whole run-detail page rather than degrading to a rough axis. The fold has
 * no such ceiling and allocates nothing.
 */
export function timelineWindow(nodes: NodeActivity[]): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  for (const node of nodes) {
    for (const span of node.spans) {
      if (span.startedAtMs < from) from = span.startedAtMs;
      // A start can set `to` on its own: an open span that begins after every
      // recorded end is the right-hand edge, as the corrupt-clock case shows.
      if (span.startedAtMs > to) to = span.startedAtMs;
      // Only the end needs testing against `to` — `isMeasurable` has already
      // established `endedAtMs >= startedAtMs`, and the start is folded above,
      // so a measurable end can never move `from`.
      if (isMeasurable(span) && span.endedAtMs > to) to = span.endedAtMs;
    }
  }
  if (from === Infinity) return null;
  return { from, to };
}

/**
 * Why this node has no bar. Derived from the row alone, because the row is all
 * this view has — it never sees the doc, so it cannot ask what KIND a node is.
 *
 * Ordered most-specific first, and each answer is one the row can actually
 * support. The last is deliberately a description of the LOG rather than a guess
 * at the activity: `fail`, `filter`, `call_pipeline`, `if` and `switch` all
 * reach it, as does a parallel `foreach` body node whose start and terminal came
 * from different items, and naming one of them would be inventing the reason.
 *
 * NOT the same question `NodeActivityPanel` answers with its own similar-looking
 * chain, and they are kept apart deliberately rather than merged: the panel asks
 * why the LATEST ATTEMPT has no duration (keyed on the row scalars, so an open
 * attempt and a corrupt one each get their own sentence), while this asks why the
 * node contributed NO SPAN AT ALL to the chart (keyed on `spans.length === 0`).
 * A node can have several measured spans and still have no current duration, and
 * vice versa.
 *
 * They no longer disagree on the one shared case where they did (#1008): the
 * panel had no `skipped` branch and called a routed-around node "has not
 * started", which was a defect in the panel rather than in the split. It now
 * carries its own `skipped` arm. The two chains share the FACT and never the
 * string — this returns a fragment (`name — reason`), the panel's arms are
 * standalone sentences — so there is nothing to extract, only a reason to keep
 * both in step when either changes.
 */
export function untimedReason(node: NodeActivity): string {
  if (node.copiedFromRunId !== undefined) {
    return 'copied from an earlier run — it did not run again here';
  }
  /* `attempts === 0` is part of the test, not an implied consequence of the
     status. `skipped` is NOT only the routed-around case: `abandonLiveChildren`
     flips a LIVE child (dispatched, parked, retry-pending) straight to `skipped`
     when its container times out — "abandoned mid-flight, not failed", as the
     reducer puts it — and leaves `attempts` alone. Such a node did run, so
     "the engine appends no event for it" is false about it, and it falls
     through to the final answer below, which describes the LOG and is true of
     it. Naming the abandonment as the cause is what this chain deliberately
     will not do: the row carries no container, so that would be inventing a
     reason (see the docblock above). */
  if (node.status === 'skipped' && node.attempts === 0) {
    return 'skipped — the engine appends no event for a node it routes around';
  }
  if (node.attempts === 0) return 'has not started';
  return 'ran, but the log holds no start-and-terminal pair to measure it by';
}

interface PlacedBase {
  span: AttemptSpan;
  /** Percent from the window's origin. */
  left: number;
}

/**
 * A span's geometry, as a DISCRIMINATED UNION on the measurable/not split.
 *
 * `width` and `durationMs` are the same fact in two units — a percentage for the
 * bar, milliseconds for the label beside it — and the union is what stops them
 * disagreeing. The caller already branches on `width === null` to decide between
 * a hatched bar and a measured one; that same check now narrows `durationMs`, so
 * the label reads a proven `number` instead of re-deriving the subtraction
 * behind a `!`. Carrying the duration at all (rather than letting the component
 * recompute `endedAtMs - startedAtMs`) keeps ONE place deciding what a
 * measurable span is.
 */
export type Placed =
  | (PlacedBase & { width: number; durationMs: number })
  | (PlacedBase & { width: null; durationMs: null });

/**
 * Place one node's spans on the axis.
 *
 * `extent` is floored at 1ms so a window with no duration at all (one
 * instantaneous span, or a single open one) divides by a real number instead of
 * producing `NaN%` — which CSS drops silently, collapsing every bar to the left
 * edge with no error anywhere.
 */
export function placeSpans(spans: AttemptSpan[], from: number, to: number): Placed[] {
  const extent = Math.max(1, to - from);
  return spans.map((span) => {
    const left = ((span.startedAtMs - from) / extent) * 100;
    if (!isMeasurable(span)) return { span, left, width: null, durationMs: null };
    const durationMs = span.endedAtMs - span.startedAtMs;
    return { span, left, width: (durationMs / extent) * 100, durationMs };
  });
}
