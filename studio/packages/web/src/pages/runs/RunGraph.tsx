import type { PipelineVersion } from '@autonomy-studio/shared';
import { RunCanvas } from './RunCanvas';
import type { Overlay } from './useRunProjection';

/**
 * U11 — the run's graph: the authored version drawn with the engine's own node
 * state over it, plus the reason when there is no state to draw.
 *
 * Split from `RunDetailPage` so ONE lazy boundary covers React Flow (#698).
 * Folded into the page, it landed in the entry chunk that split exists to keep
 * it out of.
 *
 * The PROJECTION used to be computed here too, and U25 moved it up to the page
 * (`useRunProjection`): the node table reconciles against the same state, and
 * this component being lazy is precisely why it could not own a value the
 * eagerly-rendered table needs. The lazy boundary still does its job —
 * `@xyflow/react` is reachable only through `RunCanvas` below, and the reducer
 * was already in the entry chunk either way (`vite.config.ts` has the
 * measurement).
 */
export function RunGraph({ doc, overlay }: { doc: PipelineVersion; overlay: Overlay }) {
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
