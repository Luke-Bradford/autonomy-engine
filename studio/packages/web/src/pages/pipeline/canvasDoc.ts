import {
  validatePipelineDoc,
  type Container,
  type Edge,
  type Node,
  type Output,
  type Param,
} from '@autonomy-studio/shared';
import type { PipelineVersionWrite } from '../../api/pipelines';

/**
 * Build the `POST .../versions` body for a canvas save — entirely from WORKING
 * state. `catalogVersion` is deliberately omitted: the server defaults it to the
 * current catalog, re-stamping the doc on save.
 *
 * Every field here was once read off `loaded` (the version the canvas was opened
 * on) because no UI could edit it, and each in turn became a PARAMETER as its
 * editor landed — `containers` in #746, `params`/`outputs` in U16. That
 * migration is the whole point of this function's shape, and the failure it
 * fixes is the same each time: a carry-forward that outlives its "no UI yet"
 * premise silently DISCARDS the operator's edits. In #746 the canvas could
 * delete an enclosed activity and the save body still listed it as a container
 * child, because membership came from the opened version rather than the graph
 * on screen. A param edited on screen would have been dropped identically.
 *
 * With `params`/`outputs` moved, NOTHING is carried forward any more, so the
 * `loaded` parameter is gone: every field of the body now comes from the store.
 * `loaded` keeps its other jobs in the store (the rebase basis for Save, and the
 * un-lowered record of what the server stored) — it is just no longer a source
 * of doc content.
 */
export function toVersionBody(
  nodes: Node[],
  edges: Edge[],
  containers: Container[],
  params: Param[],
  outputs: Output[],
  // #904 — the version this write is based on (`canvasStore.loaded`), or `null`
  // for "this pipeline has no versions yet". A REQUIRED parameter, deliberately
  // not an optional one defaulting to `null`: a caller that forgets it must
  // fail to compile rather than silently send the one value that is a real
  // assertion about the server's state. The server refuses a write whose basis
  // is not the current head (`StaleWriteError`), which is what stops a second
  // author's save from orphaning the first's off the head.
  basedOnVersionId: string | null,
): PipelineVersionWrite {
  return {
    params,
    outputs,
    containers,
    nodes,
    edges,
    basedOnVersionId,
  };
}

/**
 * The save-time validation badges. Delegates to `validatePipelineDoc`, the
 * shared SSOT — which is the SAME function the server's write gate calls
 * (#444), so a badge the canvas shows is exactly what a save would be refused
 * for, by construction rather than by two call sites staying in step.
 */
export function validateCanvas(
  nodes: Node[],
  edges: Edge[],
  containers: Container[],
  params: Param[],
): string[] {
  return validatePipelineDoc({ params, nodes, edges, containers });
}

/**
 * Whether the Save button is enabled. Gated on `issues` as of #444: the server
 * now REFUSES an invalid doc, so an enabled Save would just round-trip to a
 * 400. The server remains the real gate — this only spares the author a
 * pointless request, and is deliberately a pure predicate so it can be tested
 * without mounting the canvas.
 */
export function canSave(args: { saving: boolean; ready: boolean; issues: string[] }): boolean {
  return !args.saving && args.ready && args.issues.length === 0;
}
