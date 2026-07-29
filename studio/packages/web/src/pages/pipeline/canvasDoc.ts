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
 * Remove `nodeId` from every container's `children` (#746).
 *
 * COPY-ON-WRITE at both levels: a container that does not list the id comes back
 * BY REFERENCE, and so does the whole array when no container listed it. That is
 * not a micro-optimisation — `FlowCanvas` derives the container boxes through a
 * `useMemo` keyed on this array, and `PipelineCanvas` compares it by reference to
 * detect an edit made during an in-flight save. A fresh object per delete would
 * re-derive every box on screen and report a phantom concurrent edit.
 *
 * Shaped after the reducer's own children filter (`reduce.ts`, the #487
 * neutralisation) — same `kept.length === children.length ⇒ return c` idiom —
 * so the two places that narrow a children array narrow it the same way.
 *
 * Deliberately prunes ONE id, not "every child that is not a node". A general
 * normalise would also silently repair LEGACY phantoms in a doc the operator has
 * not touched, hiding `container 'X': child 'Y' is not a node in this pipeline`,
 * which is a real defect report about a doc that arrived broken. Confining the
 * prune to the id the operator just deleted keeps that error live.
 */
export function pruneContainerChild(containers: Container[], nodeId: string): Container[] {
  let changed = false;
  const next = containers.map((c) => {
    const kept = c.children.filter((ch) => ch !== nodeId);
    if (kept.length === c.children.length) return c;
    changed = true;
    return { ...c, children: kept };
  });
  return changed ? next : containers;
}

/**
 * Build the `POST .../versions` body for a canvas save. The graph (`nodes`,
 * `edges`, `containers`) is the current canvas; `params` and `outputs` are
 * CARRIED FORWARD from the version the canvas was opened on so a save from the
 * activity-node canvas never silently drops the typed param/output contract
 * authored elsewhere (this slice has no UI for it yet). `catalogVersion` is
 * deliberately omitted — the server defaults it to the current catalog,
 * re-stamping the doc on save.
 *
 * `containers` became a PARAMETER in #746. Reading `loaded?.containers` here was
 * the carry-forward that made the phantom-child bug: the canvas could delete an
 * enclosed activity, and the save body still listed it as a child, because the
 * membership came from the version the canvas was opened on rather than from the
 * graph on screen. Containers are working state now, like nodes and edges.
 */
export function toVersionBody(
  loaded: PipelineVersion | null,
  nodes: Node[],
  edges: Edge[],
  containers: Container[],
): PipelineVersionWrite {
  return {
    params: loaded?.params ?? [],
    outputs: loaded?.outputs ?? [],
    containers,
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
