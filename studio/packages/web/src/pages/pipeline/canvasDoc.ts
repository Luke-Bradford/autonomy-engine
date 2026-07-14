import {
  validateDoc,
  validateRefs,
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
 * The save-time validation badges: the UNION of the two PURE shared validators,
 * reused verbatim (never reimplemented) so a badge the canvas shows is exactly
 * an error the run would hit. `validateDoc` checks the P2c structural
 * constructs (containers, back-edges, forward-DAG, id uniqueness); `validateRefs`
 * checks the `${}` parameter language. No `validateDoc` options are passed:
 * this slice authors no `call_pipeline` nodes, so there is no call graph to
 * resolve.
 */
export function validateCanvas(
  nodes: Node[],
  edges: Edge[],
  containers: Container[],
  params: Param[],
): string[] {
  return [
    ...validateDoc({ params, nodes, edges, containers }),
    ...validateRefs({ params, nodes, edges }),
  ];
}
