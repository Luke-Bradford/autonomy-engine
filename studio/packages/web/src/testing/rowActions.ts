import { expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/**
 * #1253 — a list row's inline Edit button, on the pages where Edit is the one
 * inline action (#1397: Connections, Datasets, Global parameters). It names its row
 * (`Edit <name>`), so a bare `'Edit'` matches nothing; this matches any row's
 * Edit and never a form's own "Edit as JSON" / "Edit as fields" toggle —
 * excluded by their WHOLE name, so a row named "as …" still matches.
 */
export const ROW_EDIT = /^Edit (?!as (?:JSON|fields)$)/;

/**
 * #1397 — choose an action from a row's `⋯` menu (`lib/RowMoreMenu.tsx`):
 * open the menu named for the row, then click the item. Returns the item, so a
 * test can assert it was enabled or disabled before choosing it. A disabled
 * item is returned without clicking it.
 */
export async function chooseRowAction(
  user: Pick<UserEvent, 'click'>,
  rowName: string,
  item: string,
): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: `Actions for ${rowName}` }));
  const menuItem = await screen.findByRole('menuitem', { name: item });
  if (menuItem.getAttribute('aria-disabled') !== 'true') await user.click(menuItem);
  return menuItem;
}

/** Close an open row menu without choosing anything, as Escape does. */
export async function closeRowMenu(user: Pick<UserEvent, 'keyboard'>): Promise<void> {
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
}
