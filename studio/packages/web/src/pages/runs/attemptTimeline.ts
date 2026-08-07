import type { NodeActivity, AttemptSpan } from './runSummary';

/**
 * U12a (#1007) — the pure arithmetic and classification behind `AttemptTimeline`.
 *
 * Split out of the component file rather than exported from it: `react-refresh`
 * (correctly) refuses a module that exports both components and plain functions,
 * and these are the parts worth testing on their own anyway — a percentage, a
 * window, and a sentence are all checkable without rendering anything.
 */

/**
 * A span whose end precedes its start, which `format.ts` and the drill-in panel
 * both already refuse to turn into a duration (a corrupt clock is not a
 * measurement, and clamping it to zero would launder the corruption into a
 * plausible number). Drawn as a start marker with its length withheld.
 */
const isMeasurable = (span: AttemptSpan): boolean =>
  span.endedAtMs !== undefined && span.endedAtMs >= span.startedAtMs;

/**
 * The instants the log actually stated. An OPEN span contributes its start and
 * NOT an end — the whole point of rule 1 above: were the open span allowed to
 * stretch the axis to some assumed present, every closed bar beside it would be
 * squeezed by a number nobody measured.
 */
export function timelineWindow(nodes: NodeActivity[]): { from: number; to: number } | null {
  const instants: number[] = [];
  for (const node of nodes) {
    for (const span of node.spans) {
      instants.push(span.startedAtMs);
      if (isMeasurable(span)) instants.push(span.endedAtMs!);
    }
  }
  if (instants.length === 0) return null;
  return { from: Math.min(...instants), to: Math.max(...instants) };
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
 */
export function untimedReason(node: NodeActivity): string {
  if (node.copiedFromRunId !== undefined) {
    return 'copied from an earlier run — it did not run again here';
  }
  if (node.status === 'skipped') {
    return 'skipped — the engine appends no event for a node it routes around';
  }
  if (node.attempts === 0) return 'has not started';
  return 'ran, but the log holds no start-and-terminal pair to measure it by';
}

interface Placed {
  span: AttemptSpan;
  /** Percent from the window's origin. */
  left: number;
  /** Percent of the window, or `null` for a span with no stated length. */
  width: number | null;
}

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
  return spans.map((span) => ({
    span,
    left: ((span.startedAtMs - from) / extent) * 100,
    width: isMeasurable(span) ? ((span.endedAtMs! - span.startedAtMs) / extent) * 100 : null,
  }));
}
