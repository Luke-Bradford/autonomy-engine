import { useMemo } from 'react';
import type { PipelineVersion, RunState } from '@autonomy-studio/shared';
import { projectRun } from './runProjection';
import type { RunStreamState } from './useRunStream';

/**
 * The ENGINE's node state for this run, or the reason there is none.
 *
 * U25 moved this out of `RunGraph`, which is behind a lazy boundary, because
 * the graph is no longer the only consumer: the node table reconciles against
 * the same projection (`reconcileNodeActivity`), and two callers folding the
 * log separately is how the page grew two answers in the first place. The page
 * now projects ONCE and hands the result to both.
 *
 * Moving it costs no bundle. #698's boundary exists for `@xyflow/react`, which
 * is reachable only from `RunCanvas`; the reducer this module reaches is
 * already placed in the ENTRY chunk regardless, because eager code imports the
 * engine barrel for `EngineEventSchema` — `vite.config.ts` records the
 * measurement and the reasoning. Nothing here imports React Flow.
 */
export type Overlay = { ready: true; state: RunState } | { ready: false; reason: string };

/**
 * Gated on `replayComplete`, which is load-bearing rather than cosmetic. The
 * engine's seed holds NO nodes until `run.started` folds, and `useRunStream`
 * starts from an empty log, so projecting mid-replay would draw a finished run
 * as a graph on which nothing has a status — and, a frame later, as one where
 * only the first node does. A monitor that says "nothing ran" about a run that
 * did is worse than one that says "not yet".
 *
 * Since U25 that gate protects the TABLE too, and there it is the difference
 * between a fix and a new defect: the table has the doc-free fold to fall back
 * on, and a half-replayed projection that "wins" over it would overwrite live
 * rows with `pending` — the same lie the ticket is closing, arriving from the
 * other side.
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
export function useRunProjection(doc: PipelineVersion | null, stream: RunStreamState): Overlay {
  return useMemo(() => {
    /* No doc, no projection — and this is a REAL state, not a defensive
       branch: R1 resolves the run's bound version, and a run whose version no
       longer resolves still has a full event log to render. The page already
       says so above the graph; the table falls back to the doc-free fold. */
    if (doc === null) {
      return {
        ready: false,
        reason: 'The pipeline graph is unavailable, so node state cannot be projected.',
      };
    }

    /* `replayComplete` is asked FIRST among the stream conditions, and the
       order is the point. A socket error AFTER a complete replay leaves
       `events` untouched — `useRunStream` spreads the previous state on its
       error path — so the log in hand is still the whole run as of the last
       frame, and throwing the overlay away for it would lose a valid picture
       over a connection that has merely stopped delivering NEW frames. The
       stream error is surfaced separately by the page, as its own alert and
       phase pill. */
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
