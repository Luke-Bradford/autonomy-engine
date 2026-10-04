import type { FocusEvent, KeyboardEvent } from 'react';

/**
 * #1484 M2 — a `?` help `<details>` that floats over the page (`.run-header__help`)
 * must be dismissable the way a popover is: native `<details>` closes neither on
 * Escape nor when focus leaves it, so an opened one would keep covering the rows
 * under it.
 */
export function closeOnEscape(e: KeyboardEvent<HTMLDetailsElement>): void {
  if (e.key !== 'Escape' || !e.currentTarget.open) return;
  e.currentTarget.open = false;
  e.currentTarget.querySelector('summary')?.focus();
}

/** Its content must be focusable (`tabIndex={-1}`): a click on plain text moves
 * focus to nothing, so `relatedTarget` is null and the help would close under the
 * pointer, leaving its text impossible to select. */
export function closeOnLeave(e: FocusEvent<HTMLDetailsElement>): void {
  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) e.currentTarget.open = false;
}
