import type { Edge, Node } from '@autonomy-studio/shared';

/**
 * U21 — what a canvas COPY holds.
 *
 * `edges` is the INTERNAL edges only (both endpoints inside `nodes`). The edges
 * that come from OUTSIDE the copied set are deliberately not here: they are
 * re-derived from the live graph at paste time, so ⌘V and ⌘D behave identically
 * and a stale endpoint cannot be resurrected from a clipboard written minutes
 * ago. Same reasoning for container membership, which is likewise re-derived.
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
