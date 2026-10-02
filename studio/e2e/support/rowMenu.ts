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

/**
 * #1470 — a confirmed Delete removes its row, and focus moves to the next row's
 * `⋯`, else the previous row's, else the page's create control (`fallback`).
 * Accepts the Delete from `row`'s menu and asserts focus lands on the one this
 * page should pick, read from the table BEFORE the row goes.
 */
export async function deleteRowAndExpectFocus(
  page: Page,
  row: Locator,
  fallback: Locator,
  answer: (page: Page) => Promise<unknown>,
): Promise<void> {
  // By element id, not by name: the shared e2e database can hold two rows of
  // one name (an import spec leaves copies), and the row's DOM node, so its id,
  // survives the refresh.
  const neighbour = await row.evaluate((tr) => {
    const next = tr.nextElementSibling ?? tr.previousElementSibling;
    return next?.querySelector('.row-menu__trigger')?.id || null;
  });
  await rowMenuButton(row).click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await answer(page);
  await expect(row).toHaveCount(0);
  const target = neighbour === null ? fallback : page.locator(`[id="${neighbour}"]`);
  await expect(target).toBeFocused();
}
