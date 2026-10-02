import { expect, type Locator, type Page } from '@playwright/test';

/**
 * #1397 — a list row's `⋯` menu button (`lib/RowMoreMenu.tsx`). Named
 * `Actions for <row>`; anchored, so the author pane's own
 * `More actions for <row>` beside the Pipelines table never matches.
 * Without a name, `scope` must be the row itself.
 */
export function rowMenuButton(scope: Page | Locator, rowName?: string): Locator {
  return rowName === undefined
    ? scope.getByRole('button', { name: /^Actions for / })
    : scope.getByRole('button', { name: `Actions for ${rowName}`, exact: true });
}

/** Open a row's `⋯` menu with the mouse and choose `item`. */
export async function chooseRowAction(
  scope: Page | Locator,
  item: string,
  rowName?: string,
): Promise<void> {
  await rowMenuButton(scope, rowName).click();
  const page = 'page' in scope ? scope.page() : scope;
  const menuItem = page.getByRole('menuitem', { name: item, exact: true });
  await expect(menuItem).toBeVisible();
  await menuItem.click();
}

/** Arrow down an open menu until `item` holds focus; bounded, so a dead menu fails. */
export async function arrowToItem(page: Page, item: Locator): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    if (await item.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(item).toBeFocused();
}
