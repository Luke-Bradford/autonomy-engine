/** The gap between a note and its anchor, and the least room kept to the viewport's edge. */
const NOTE_GAP = 4;
const NOTE_EDGE = 8;

/**
 * #1695 OR43 — place an open note (in the top layer, so `position: fixed`)
 * where the stylesheet anchored it before: under the `?`, its right edge on the
 * `?`'s, or `inline`, under the enclosing positioned row at the row's width.
 * Above the anchor instead when the room below is too short and the room above
 * is not, and held inside the viewport sideways.
 */
export function placeNote(details: HTMLElement, note: HTMLElement, inline: boolean): void {
  const win = details.ownerDocument.defaultView;
  if (win === null) return;
  const q = details.getBoundingClientRect();
  // `inline` was anchored to its containing block: the nearest positioned row.
  const anchor =
    inline && details.offsetParent instanceof HTMLElement ? details.offsetParent : details;
  const a = anchor.getBoundingClientRect();
  if (inline) note.style.setProperty('--help-anchor-width', `${a.width}px`);
  const n = note.getBoundingClientRect();
  const wanted = inline ? a.left : q.right - n.width;
  const left = Math.max(NOTE_EDGE, Math.min(wanted, win.innerWidth - NOTE_EDGE - n.width));
  const below = a.bottom + NOTE_GAP;
  const above = a.top - NOTE_GAP - n.height;
  const top = below + n.height > win.innerHeight - NOTE_EDGE && above >= NOTE_EDGE ? above : below;
  note.style.left = `${left}px`;
  note.style.top = `${top}px`;
}
