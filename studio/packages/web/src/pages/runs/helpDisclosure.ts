import type { FocusEvent, KeyboardEvent, SyntheticEvent } from 'react';

/**
 * #1484 M2 — a `?` help `<details>` that floats over the page (`.run-header__help`)
 * must be dismissable the way a popover is: native `<details>` closes neither on
 * Escape, nor when focus moves elsewhere, nor on a click outside it, so an opened
 * one would keep covering the rows under it. Wire all three:
 * `onKeyDown={closeOnEscape} onBlur={closeOnLeave} onToggle={closeOnOutsidePointer}`.
 */
export function closeOnEscape(e: KeyboardEvent<HTMLDetailsElement>): void {
  if (e.key !== 'Escape' || !e.currentTarget.open) return;
  e.currentTarget.open = false;
  e.currentTarget.querySelector('summary')?.focus();
}

/**
 * Closes when focus moves to an element OUTSIDE the help. A blur to nothing
 * (`relatedTarget` null) is ignored: the window losing focus, a click on text,
 * or Safari, which does not focus a `<summary>` on click. A click outside on
 * something that takes no focus is `closeOnOutsidePointer`'s.
 */
export function closeOnLeave(e: FocusEvent<HTMLDetailsElement>): void {
  const to = e.relatedTarget as Node | null;
  if (to !== null && !e.currentTarget.contains(to)) e.currentTarget.open = false;
}

/** While open, a pointer press outside the help closes it; the listener goes
 * with the close. */
export function closeOnOutsidePointer(e: SyntheticEvent<HTMLDetailsElement>): void {
  const details = e.currentTarget;
  if (!details.open) return;
  const doc = details.ownerDocument;
  const onDown = (ev: PointerEvent) => {
    if (details.contains(ev.target as Node | null)) return;
    details.open = false;
  };
  const onToggle = () => {
    if (details.open) return;
    doc.removeEventListener('pointerdown', onDown, true);
    details.removeEventListener('toggle', onToggle);
  };
  doc.addEventListener('pointerdown', onDown, true);
  details.addEventListener('toggle', onToggle);
}
