import { isUnhandledEscape, type EscapeKeyEvent } from '../../lib/escape';
import { isModalDialogOpen } from './undoRedo';

/** The parts of a React keydown the rule reads, so it can be tested on plain DOM. */
export interface DockKeyEvent extends EscapeKeyEvent {
  readonly target: EventTarget;
  readonly currentTarget: Element;
}

/**
 * #1477 OR29 — whether an Escape pressed in the EXPANDED property dock is the
 * dock's, returning it to its place. Escape belongs to the innermost thing
 * that is open, so the dock takes it only when nothing nearer does:
 * - one `isUnhandledEscape` says is claimed;
 * - a key from OUTSIDE the dock's DOM. React bubbles a portalled popup's keys
 *   (Fluent's `Menu`, a dialog) through the dock, and that Escape is the
 *   popup's;
 * - an open combobox list. Fluent's `Combobox` keeps focus on its input in the
 *   dock and does not mark the Escape that closes the list. Its
 *   `aria-expanded` is still `true` while the key bubbles, because React has
 *   not re-rendered yet. The dock's own toggles also carry `aria-expanded`, so
 *   the role is part of the test;
 * - a modal dialog over the page, as the editor's document keys check.
 */
export function isDockDrawerEscape(e: DockKeyEvent): boolean {
  if (!isUnhandledEscape(e)) return false;
  if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return false;
  if (e.target instanceof Element && e.target.closest('[role="combobox"][aria-expanded="true"]')) {
    return false;
  }
  return !isModalDialogOpen(e.currentTarget.ownerDocument);
}
