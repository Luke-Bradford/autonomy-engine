import type { Container, Edge, Node } from '@autonomy-studio/shared';

/**
 * #935 — what a CUT took away around its nodes, so a paste can put it back.
 *
 * A copy's in-edges and container membership are re-derived from the LIVE
 * graph at paste time (see `CanvasClipboard`), and after a cut there is nothing
 * live to derive them from: the cut deleted them. Without this, a node cut and
 * pasted in the same pipeline came back with no upstream while its `${}` still
 * read one — a paste that reported success into a doc the save gate refuses.
 *
 * These are only ever a FALLBACK for a node whose original is gone: a paste
 * still refuses to restore an edge whose source, or a membership whose
 * container, has since been deleted, and an original brought back by undo is
 * re-derived from the live graph like any copy. Never used across pipelines.
 */
export interface CutContext {
  /** The edges INTO the cut nodes from outside the cut set, as they were. */
  inEdges: Edge[];
  /** Cut node id → the container it was in, for the nodes that had one. */
  owners: Record<string, string>;
}

/**
 * U21 — what a canvas COPY holds.
 *
 * `edges` is the INTERNAL edges only (both endpoints inside `nodes`, or between
 * a copied container and its body). The edges that come from OUTSIDE the copied
 * set are deliberately not here: they are re-derived from the live graph at
 * paste time, so ⌘V and ⌘D behave identically and a stale endpoint cannot be
 * resurrected from a clipboard written minutes ago. Same reasoning for container
 * membership, which is likewise re-derived — except for a node copied WITH its
 * container, which belongs to the container's copy. `cut` is the one exception
 * to both, and only for an original a cut deleted.
 *
 * `containers` is empty for a copy of activities, and holds the one container a
 * container copy is of; `nodes` is then that container's whole body.
 *
 * `pipelineId` is STAMPED so a paste can tell a copy from ANOTHER pipeline, and
 * `sourceNodeIds` is every node AND container id that pipeline had at copy time
 * (both are addressed as `${nodes.<id>}`), so such a paste can tell which of a
 * copy's reads name something it did not bring (#935, `uncopiedReads` in the
 * canvas store). The ids, not the nodes: nothing but membership is asked of them.
 * The edge and membership re-derivation above is within ONE pipeline only.
 */
export interface CanvasClipboard {
  pipelineId: string;
  sourceNodeIds: string[];
  nodes: Node[];
  edges: Edge[];
  containers: Container[];
  cut?: CutContext;
}

/**
 * MODULE-level, not store state, and that is the point: `createCanvasStore()`
 * runs per canvas mount, so a clipboard living in the store would be silently
 * emptied by navigating between two pipelines — the one journey a clipboard
 * exists to survive.
 */
let held: CanvasClipboard | null = null;

/** Take a copy in, detached from the caller's arrays. */
export function writeClipboard(next: CanvasClipboard): void {
  held = structuredClone(next);
}

/** The held copy, detached — a paste must never alias what a later paste reads. */
export function readClipboard(): CanvasClipboard | null {
  return held === null ? null : structuredClone(held);
}

/** Empty it. Exists for tests; nothing in the app clears a clipboard. */
export function clearClipboard(): void {
  held = null;
}
