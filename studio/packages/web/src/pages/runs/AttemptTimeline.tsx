import type { NodeActivity, AttemptSpan } from './runSummary';
import { nodeStatusLabel, nodeStatusTone, type StatusTone } from './nodeStatus';
import { formatClock, formatElapsed } from './format';
import { placeSpans, timelineWindow, untimedReason } from './attemptSpans';

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

const toneOf = (span: AttemptSpan): StatusTone => nodeStatusTone(span.endedAs ?? span.startedAs);

/**
 * What the span's own bar says it was, which is the LOG's word — see `AttemptSpan`.
 *
 * #1010 — an open span used to append `, still open` here, which said the same
 * thing the sentence beside it already says: an open span ALWAYS renders
 * `unmeasuredNote`'s "no end on record", because `endedAs` and `endedAtMs` are
 * written and cleared together (`AttemptSpan`), so an absent `endedAs` means an
 * absent `endedAtMs` means `width === null`. A park said it a third time, since
 * its own status word is already "waiting (…)" — `waiting (timer), still open …
 * no end on record`. The note owns un-endedness; this owns the status word only.
 *
 * That the word is the START's rather than the END's is therefore read off the
 * note, which is the same fact stated once instead of twice.
 */
const spanLabel = (span: AttemptSpan): string => nodeStatusLabel(span.endedAs ?? span.startedAs);

/**
 * Why a bar states no length. THREE cases share the hatched rendering and must
 * NOT share the sentence: a span that is genuinely open has no end yet, while a
 * span whose recorded end PRECEDES its start has one that cannot be believed.
 * Calling the second "no end on record" produced "success, no end on record" —
 * a self-contradiction, in the `title` and in the screen-reader text both.
 * `NodeActivityPanel` already gives the corrupt case its own sentence; this is
 * that distinction, kept.
 */
const unmeasuredNote = (span: AttemptSpan): string =>
  span.endedAtMs === undefined
    ? 'no end on record'
    : 'the recorded end precedes the start, so no length can be stated';

export function AttemptTimeline({ nodes, nameOf }: AttemptTimelineProps): React.ReactElement {
  const timed = nodes.filter((n) => n.spans.length > 0);
  const untimed = nodes.filter((n) => n.spans.length === 0);
  const window = timelineWindow(nodes);

  if (window === null) {
    return (
      <section aria-labelledby="timeline-heading" className="attempt-timeline">
        <h3 id="timeline-heading">Timeline</h3>
        <p>
          Nothing measurable yet — no node has both started and finished. Every node is listed below
          with the reason it has no span.
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
                      ...(placed.width === null ? { right: '0' } : { width: `${placed.width}%` }),
                    }}
                    title={`${name ?? node.nodeId} · ${spanLabel(placed.span)} · started ${formatClock(
                      placed.span.startedAtMs,
                    )}${
                      placed.width === null
                        ? ` · ${unmeasuredNote(placed.span)}`
                        : ` · ${formatElapsed(placed.durationMs)}`
                    }`}
                  >
                    <span className="visually-hidden">
                      {spanLabel(placed.span)}
                      {placed.width === null
                        ? `, ${unmeasuredNote(placed.span)}`
                        : `, ${formatElapsed(placed.durationMs)}`}
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
            {/* The id on `title`, exactly as the timeline row label carries it,
                rather than as a visible `<code>`. `activityLabels` numbers by
                kind ("Wait 1"), so the name alone does not identify the authored
                node and the id has to be reachable — but rendering it here puts
                a SECOND copy of every node id on a page whose Nodes table
                already shows one, which makes `getByText(nodeId)` ambiguous for
                every existing test of that table. One convention, one copy. */}
            <span className="timeline-untimed-name" title={node.nodeId}>
              {nameOf(node.nodeId) ?? node.nodeId}
            </span>{' '}
            — {untimedReason(node)}
          </li>
        ))}
      </ul>
    </div>
  );
}
