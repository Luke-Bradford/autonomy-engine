import { getActivity, isStructuralCallActivity } from '@autonomy-studio/shared';

/**
 * The drag-and-drop PROTOCOL between the activity toolbox (drag source) and the
 * canvas (drop target) — U5.
 *
 * Its own module, rather than living in `activityGroups.ts`, because it has two
 * consumers in DIFFERENT roles: `ActivityToolbox.tsx` writes the payload and
 * `FlowCanvas.tsx` reads it. Folding it into that module would make the canvas
 * import the toolbox's presentation concerns (group labels, filtering) to read
 * three fields off a `DataTransfer`.
 */

/**
 * The custom MIME type an activity drag carries.
 *
 * Custom rather than `text/plain`: `text/plain` is what a dragged text selection,
 * a link, and half the web carries, so keying off it would let any stray drag
 * over the canvas author a node.
 */
export const ACTIVITY_DND_MIME = 'application/x-autonomy-activity';

/** Arm a drag with the activity type it carries. Called from `dragstart`. */
export function setActivityDragType(dataTransfer: DataTransfer, type: string): void {
  dataTransfer.setData(ACTIVITY_DND_MIME, type);
  // COPY, not move: the toolbox entry stays where it is, and the cursor should
  // say so (`+` rather than the move arrow).
  dataTransfer.effectAllowed = 'copy';
}

/**
 * Is this drag one of ours? The gate for `dragover`.
 *
 * Reads `types` and NEVER `getData()`, which is not an optimisation but the only
 * thing that works: during `dragenter`/`dragover` the HTML drag-data store is in
 * PROTECTED mode, where `types` is readable but `getData()` returns `''`. A
 * `dragover` gate written against the payload would therefore reject every real
 * drag — while passing any test whose `DataTransfer` fake hands the data back.
 *
 * The consequence for the canvas is that `dragover` can only know the SHAPE of a
 * drag, not its contents, so `readActivityDragType` below re-validates at drop.
 */
export function hasActivityDragType(dataTransfer: DataTransfer | null): boolean {
  // `types` is a `DOMStringList`-like in some engines; `Array.from` handles both
  // it and the array modern browsers expose.
  return dataTransfer != null && Array.from(dataTransfer.types).includes(ACTIVITY_DND_MIME);
}

/**
 * The activity type this drop should author, or `null` if it should author
 * nothing. Called from `drop`, where the payload is readable.
 *
 * The MIME type alone is NOT authority — the payload is a string from outside
 * this document (another tab, an older or newer build, a hand-crafted drag), so
 * it is checked against the live catalog before it can mint a node:
 *  - an uncatalogued type would author a node no executor can dispatch;
 *  - a structural-call type (`execute_pipeline`) would author a call-less,
 *    un-saveable node — the #4 A9 / #425 exclusion the toolbox already applies
 *    to what it OFFERS, applied again to what it ACCEPTS.
 *
 * `canvasStore.addNode` refuses both a third time. That is deliberate: this
 * function decides whether a drop is ours to handle at all, and the store
 * defends its own invariants regardless of caller.
 */
export function readActivityDragType(dataTransfer: DataTransfer | null): string | null {
  if (!hasActivityDragType(dataTransfer)) return null;
  const type = dataTransfer!.getData(ACTIVITY_DND_MIME);
  if (type === '' || !getActivity(type) || isStructuralCallActivity(type)) return null;
  return type;
}
