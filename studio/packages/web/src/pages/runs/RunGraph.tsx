import { useMemo } from 'react';
import type { PipelineVersion, RunState } from '@autonomy-studio/shared';
import { RunCanvas } from './RunCanvas';
import { projectRun } from './runProjection';
import type { RunStreamState } from './useRunStream';

/**
 * U11 — the run's graph: the authored version drawn with the engine's own node
 * state over it, plus the reason when there is no state to draw.
 *
 * Split from `RunDetailPage` so ONE lazy boundary covers everything the graph
 * needs — React Flow AND the engine reducer (#698). Folded into the page, both
 * landed in the entry chunk that split exists to keep them out of.
 */

/**
 * The overlay is either projected, or it explains why it is not. There is no
 * "draw it anyway" state — see `useRunProjection`.
 */
type Overlay = { ready: true; state: RunState } | { ready: false; reason: string };

/**
 * The ENGINE's node state for this run, or the reason there is none.
 *
 * Gated on `replayComplete`, which is load-bearing rather than cosmetic. The
 * engine's seed holds NO nodes until `run.started` folds, and `useRunStream`
 * starts from an empty log, so projecting mid-replay would draw a finished run
 * as a graph on which nothing has a status — and, a frame later, as one where
 * only the first node does. A monitor that says "nothing ran" about a run that
 * did is worse than one that says "not yet".
 *
 * On the MARKER, not on `phase`, in BOTH directions. `closed` is set by any
 * orderly close, including one arriving mid-replay, so gating on the phase would
 * present a truncated log as authoritative — the same lie in a subtler form. And
 * an `error` AFTER a complete replay does not invalidate the log already in
 * hand, so it must not blank an overlay that is still correct; a live run's
 * picture simply stops advancing, which the page's own stream alert reports.
 *
 * That gate is also where the deliberate absence of an `events` member on R1 is
 * paid for: the overlay is fed by the WebSocket alone, so a stream that never
 * connects has no fallback source. It says so, in place, and the doc-free table
 * on the page is unaffected.
 *
 * Folds the WHOLE log per render, matching the page's two existing folds —
 * `projectRun` says why an incremental carry is not the win it looks like here.
 */
function useRunProjection(doc: PipelineVersion, stream: RunStreamState): Overlay {
  return useMemo(() => {
    /* `replayComplete` is asked FIRST, and the order is the point. A socket
       error AFTER a complete replay leaves `events` untouched — `useRunStream`
       spreads the previous state on its error path — so the log in hand is
       still the whole run as of the last frame, and throwing the overlay away
       for it would lose a valid picture over a connection that has merely
       stopped delivering NEW frames. The stream error is surfaced separately by
       the page, as its own alert and phase pill. */
    if (!stream.replayComplete) {
      return {
        ready: false,
        reason:
          stream.phase === 'error'
            ? 'The event stream is unavailable, so node state cannot be projected.'
            : stream.phase === 'closed'
              ? 'The event stream ended before this run’s history finished loading, so node state cannot be projected.'
              : 'Loading this run’s history…',
      };
    }

    const projection = projectRun(doc, stream.events);
    return projection.ok
      ? { ready: true, state: projection.state }
      : { ready: false, reason: `Node state cannot be projected: ${projection.reason}.` };
  }, [doc, stream.events, stream.phase, stream.replayComplete]);
}

export function RunGraph({ doc, stream }: { doc: PipelineVersion; stream: RunStreamState }) {
  const overlay = useRunProjection(doc, stream);
  return (
    <>
      {/* The graph is drawn whether or not the run projects onto it — the
          authored shape is a fact of the version, and the run state is an
          overlay ON it. With no overlay the nodes say so, rather than being
          coloured as if nothing had run. */}
      <RunCanvas doc={doc} state={overlay.ready ? overlay.state : null} />
      {!overlay.ready && (
        <p className="page-hint" role="status">
          {overlay.reason}
        </p>
      )}
    </>
  );
}
