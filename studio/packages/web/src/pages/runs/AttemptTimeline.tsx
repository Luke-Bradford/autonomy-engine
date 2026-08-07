import type { NodeActivity, AttemptSpan } from './runSummary';
import { nodeStatusLabel, nodeStatusTone, type StatusTone } from './nodeStatus';
import { formatClock, formatElapsed } from './format';

/**
 * U12a (#1007) — the run's spans drawn against one shared time axis, so an
 * operator can see WHEN each node ran and how the run's wall clock was actually
 * spent, rather than reading a column of unrelated durations.
 *
 * It renders from the `NodeActivity[]` the page already folded — no fetch, no
 * hook, no fourth walk of the log (#849 counts those). Everything below is a
 * function of that array.
 *
 * THREE properties this view refuses to give up, because each is a way a chart
 * can lie more convincingly than a table:
 *
 *  1. **No clock.** An open span has no length and is drawn claiming none: a
 *     hatched bar running to the right edge, labelled with its start only. This
 *     page has no ticking clock BY DESIGN (#867's finding, and the live counter
 *     it deferred is #890) — and here the cost of pretending would be worse than
 *     in a cell, because a frozen `now` would rescale EVERY bar, not just the
 *     stale one.
 *  2. **The axis is the measured window, not the run's.** `run.startedAt` is an
 *     enqueue placeholder for a queued run (U10), so the origin is the earliest
 *     instant the log actually recorded and the end is the latest one.
 *  3. **A node with no span is NAMED, not dropped.** Silently omitting the
 *     untimed rows would make the timeline read as the whole run when it is a
 *     subset of it — and the untimed set is large and structural, not an edge
 *     case (a skipped node, a control activity, a copied frontier node). The
 *     list beneath the chart is the ticket's "documented limits", on screen.
 */
export interface AttemptTimelineProps {
  /** The reconciled rows, in the same order the Nodes table renders them. */
  nodes: NodeActivity[];
  /** The node's authored name, when the doc resolved. */
  nameOf: (nodeId: string) => string | null;
}

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

const toneOf = (span: AttemptSpan): StatusTone => nodeStatusTone(span.endedAs ?? span.startedAs);

/** What the span's own bar says it was, which is the LOG's word — see `AttemptSpan`. */
const spanLabel = (span: AttemptSpan): string =>
  span.endedAs === undefined
    ? `${nodeStatusLabel(span.startedAs)}, still open`
    : nodeStatusLabel(span.endedAs);

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

export function AttemptTimeline({ nodes, nameOf }: AttemptTimelineProps): React.ReactElement {
  const timed = nodes.filter((n) => n.spans.length > 0);
  const untimed = nodes.filter((n) => n.spans.length === 0);
  const window = timelineWindow(nodes);

  if (window === null) {
    return (
      <section aria-labelledby="timeline-heading" className="attempt-timeline">
        <h3 id="timeline-heading">Timeline</h3>
        <p>
          Nothing measurable yet — no node has both started and finished. Every node is listed
          below with the reason it has no span.
        </p>
        <UntimedList nodes={untimed} nameOf={nameOf} />
      </section>
    );
  }

  return (
    <section aria-labelledby="timeline-heading" className="attempt-timeline">
      <h3 id="timeline-heading">Timeline</h3>
      <p className="timeline-axis-note">
        {formatClock(window.from)} → {formatClock(window.to)} ·{' '}
        {formatElapsed(Math.max(0, window.to - window.from))} of measured wall clock. A node that
        ran more than once has one bar per run, and the gap between two bars is time the node was
        not running — a retry hold, or simply waiting its turn.
      </p>
      <ol className="timeline-rows">
        {timed.map((node) => {
          const name = nameOf(node.nodeId);
          return (
            <li key={node.nodeId} className="timeline-row">
              <span className="timeline-row-label" title={node.nodeId}>
                {name ?? node.nodeId}
              </span>
              <span className="timeline-track">
                {placeSpans(node.spans, window.from, window.to).map((placed, i) => (
                  <span
                    key={`${node.nodeId}-${placed.span.startedAtMs}-${i}`}
                    /* `data-tone` rather than a `node-status-*` class: those are
                       PILL rules (colour + border, no background), so reusing
                       them here would paint a transparent bar. The tone is the
                       graph surface's vocabulary and the one already defined for
                       "what colour is this state". */
                    data-tone={toneOf(placed.span)}
                    data-open={placed.width === null ? 'true' : undefined}
                    className="timeline-span"
                    style={{
                      left: `${placed.left}%`,
                      /* An open or unmeasurable span runs to the right edge
                         hatched, which is a DIFFERENT claim from a long bar: it
                         says "started here, no end on record". The visibility
                         floor for a sub-millisecond measured span is `min-width`
                         in the stylesheet rather than a `max()` here — a bar
                         that really happened must not be invisible, since that
                         reads as a missing node rather than a fast one, but
                         expressing it inline made the inline style unparseable
                         to jsdom and quietly voided the test asserting it. */
                      ...(placed.width === null
                        ? { right: '0' }
                        : { width: `${placed.width}%` }),
                    }}
                    title={`${name ?? node.nodeId} · ${spanLabel(placed.span)} · started ${formatClock(
                      placed.span.startedAtMs,
                    )}${
                      placed.width === null
                        ? ' · no end on record'
                        : ` · ${formatElapsed(placed.span.endedAtMs! - placed.span.startedAtMs)}`
                    }`}
                  >
                    <span className="visually-hidden">
                      {spanLabel(placed.span)}
                      {placed.width === null
                        ? ', no end on record'
                        : `, ${formatElapsed(placed.span.endedAtMs! - placed.span.startedAtMs)}`}
                    </span>
                  </span>
                ))}
              </span>
            </li>
          );
        })}
      </ol>
      <UntimedList nodes={untimed} nameOf={nameOf} />
    </section>
  );
}

function UntimedList({
  nodes,
  nameOf,
}: {
  nodes: NodeActivity[];
  nameOf: (nodeId: string) => string | null;
}): React.ReactElement | null {
  if (nodes.length === 0) return null;
  return (
    <div className="timeline-untimed">
      <h4>Not on the timeline</h4>
      <ul>
        {nodes.map((node) => (
          <li key={node.nodeId}>
            <span className="timeline-untimed-name">{nameOf(node.nodeId) ?? node.nodeId}</span> —{' '}
            {untimedReason(node)}
          </li>
        ))}
      </ul>
    </div>
  );
}
