import {
  validatePipelineDoc,
  type Container,
  type Edge,
  type Node,
  type Param,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import type { PipelineVersionWrite } from '../../api/pipelines';

/**
 * Build the `POST .../versions` body for a canvas save. The graph (`nodes`,
 * `edges`) is the current canvas; `params`, `outputs`, and `containers` are
 * CARRIED FORWARD from the version the canvas was opened on so a save from the
 * activity-node canvas never silently drops loop/stage containers or the
 * typed param/output contract authored elsewhere (this slice has no UI for
 * them yet). `catalogVersion` is deliberately omitted — the server defaults it
 * to the current catalog, re-stamping the doc on save.
 */
export function toVersionBody(
  loaded: PipelineVersion | null,
  nodes: Node[],
  edges: Edge[],
): PipelineVersionWrite {
  return {
    params: loaded?.params ?? [],
    outputs: loaded?.outputs ?? [],
    containers: loaded?.containers ?? [],
    nodes,
    edges,
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
