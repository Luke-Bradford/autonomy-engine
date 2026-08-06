/**
 * U17 — the decidable parts of the canvas's undo/redo controls.
 *
 * Here rather than inline in `PipelineCanvas` for the reason `versionHistory.ts`
 * states about that component: it has no unit test, so any rule left inside it
 * is a rule nothing checks. The store owns WHAT undo does; these own when the
 * controls are live and when a keystroke is ours to take.
 */

/** What the canvas can be doing that takes the undo controls away. */
export interface HistoryControlContext {
  /** Is there anything on the corresponding stack? */
  available: boolean;
  /** The version number being previewed from the history list, or `null`. */
  previewing: number | null;
  /**
   * Is a save or a restore in flight (`previewLocked`)?
   *
   * The FOURTH route into the working graph that has to respect that lock, and
   * the one this ticket added. A save snapshots the graph BEFORE its POST and
   * compares it against the live graph afterwards to decide whether the operator
   * kept editing. An undo landing inside that window makes the comparison say
   * "kept editing" and take the `rebaseLoaded` branch, which re-points the CAS
   * basis at the new version WITHOUT touching `dirty` — leaving a canvas that
   * shows the PRE-edit graph, reports itself clean, and holds a basis containing
   * the edit. The next save then reverts it, with no conflict and no warning.
   */
  busy: boolean;
}

/**
 * Why the Undo control is dead, or `null` when it is live.
 *
 * Every disabled control gets a reason — an unexplained dead button is what a
 * `title` exists to prevent, and the Version-history button beside this one
 * already follows the rule.
 *
 * The PREVIEW case is not cosmetic. While a version is previewed the canvas
 * shows that version, not the working graph, but the working graph is still what
 * the store holds — so an undo would silently edit a document the operator
 * cannot see, and worse, move `dirty`, which is the flag the preview's own
 * Restore button reads to decide whether it is about to discard work.
 */
export function undoDisabledReason({
  available,
  previewing,
  busy,
}: HistoryControlContext): string | null {
  if (busy) return 'Wait for the save or restore to finish.';
  if (previewing !== null) return 'Leave the preview to undo your working graph.';
  if (!available) return 'Nothing to undo.';
  return null;
}

/** Why the Redo control is dead, or `null` when it is live — `undoDisabledReason`'s mirror. */
export function redoDisabledReason({
  available,
  previewing,
  busy,
}: HistoryControlContext): string | null {
  if (busy) return 'Wait for the save or restore to finish.';
  if (previewing !== null) return 'Leave the preview to redo your working graph.';
  if (!available) return 'Nothing to redo.';
  return null;
}

/**
 * Is this event target a text-entry control, whose own undo the browser owns?
 *
 * The canvas's ⌘Z must not reach into a field the operator is typing in: the
 * property panel is full of them, a native text undo is what ⌘Z means inside
 * one, and taking the key there would revert a graph edit the operator never
 * asked about while their caret sat in a name field.
 *
 * Fails CLOSED — a target that is not an element is treated AS text entry, so an
 * unrecognised target leaves the keystroke alone rather than claiming it. The
 * canvas losing a shortcut is recoverable; a swallowed keystroke inside a field
 * is not.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}

/** Which history command a keystroke asks for, or `null` for one that is not ours. */
export type HistoryCommand = 'undo' | 'redo';

/**
 * Read a keydown as a history command.
 *
 * Both platform conventions, because the app runs in a browser on either:
 * ⌘Z / Ctrl+Z undoes, ⇧⌘Z / Ctrl+Shift+Z redoes (the mac and modern-web form),
 * and Ctrl+Y redoes (the Windows form). `metaKey` and `ctrlKey` are accepted
 * interchangeably rather than switched on a sniffed platform — a sniff can be
 * wrong, and neither combination means anything else on the canvas.
 *
 * A keystroke inside a text-entry control is never ours (`isTextEntryTarget`),
 * and neither is a bare Z.
 */
export function historyCommandFor(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}): HistoryCommand | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  if (e.altKey) return null;
  if (isTextEntryTarget(e.target)) return null;
  const key = e.key.toLowerCase();
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
  // Ctrl+Y is redo on Windows; ⇧Ctrl+Y is not a convention anywhere, so it is
  // left alone rather than folded in.
  if (key === 'y' && !e.shiftKey) return 'redo';
  return null;
}

/**
 * U21 — does this keydown ask to delete the canvas selection?
 *
 * Lives beside `historyCommandFor` because it is the same concern: a keystroke
 * read on the DOCUMENT, where the canvas cannot rely on what has focus, made
 * safe by the same `isTextEntryTarget` guard. The canvas reads it instead of
 * letting React Flow's `deleteKeyCode` fire, because RF's delete path emits the
 * edge removals and the node removals as two separate callbacks and so two undo
 * entries (see `deleteSelection`).
 *
 * A MODIFIED Backspace is left alone: ⌘⌫ deletes to the start of a line (and is
 * history-back in some browsers), ⌥⌫ deletes a word. Claiming them would break
 * both while adding nothing — the bare key already says it.
 */
export function isDeleteKeystroke(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (isTextEntryTarget(e.target)) return false;
  return e.key === 'Backspace' || e.key === 'Delete';
}
