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
 * `pipelineId` is STAMPED so a paste can refuse a clipboard from another
 * pipeline. Cross-pipeline paste is a later slice and it is not a matter of
 * copying more state: a pasted node's refs to nodes it did NOT bring with it
 * have no meaning in the target doc, and its incoming edges have no source
 * there, so the save gate refuses it with "does not name an upstream node".
 * Refusing loudly at the gesture is the honest form of that.
 */
export interface CanvasClipboard {
  pipelineId: string;
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
