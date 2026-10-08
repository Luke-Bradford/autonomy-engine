import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The two form surfaces an authoring spec fills, located ONE way.
 *
 * Each of these used to be a private one-liner copied into every spec that
 * needed it: `properties` in thirteen files (under two names), `triggerForm` in
 * six. The locator itself never differed. That changes the day the dock's or
 * the form's accessible name changes, and at that point the fix belongs in one
 * file, not nineteen. The run page's surfaces (its activity runs, its views)
 * live here for the same reason.
 */

/** The canvas's right-hand Properties dock: the selected node's inspector,
 *  or the pipeline's own tabs when nothing is selected. */
export function properties(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Properties' });
}

/**
 * #1477 OR29 slice 5c — bind the dock's connection picker labelled `label`.
 * The picker is a searchable combobox whose list is portalled, so it is opened
 * and the option clicked in the one open listbox. `{ id }` targets the row
 * exactly (each option carries `data-connection-id`), `{ name }` the option
 * whose name starts with it, and `null` picks None.
 */
export async function pickConnection(
  page: Page,
  label: string,
  target: { id: string } | { name: string } | null,
): Promise<void> {
  await properties(page).getByRole('combobox', { name: label, exact: true }).click();
  const list = page.getByRole('listbox');
  const option =
    target === null
      ? list.getByRole('option', { name: 'None', exact: true })
      : 'id' in target
        ? list.locator(`[data-connection-id="${target.id}"]`)
        : list.getByRole('option').filter({ hasText: target.name });
  await option.click();
  await expect(list).toHaveCount(0);
}

/** #1477 OR29 — the dock header's Paste (U21), shown whatever is selected. */
export function dockPaste(page: Page): Locator {
  return page.locator('.property-dock__header').getByRole('button', { name: 'Paste', exact: true });
}

/**
 * #1477 OR29 — a selected node's Duplicate node / Delete node, from the `⋯`
 * menu in its pinned header.
 */
export async function nodeMenuAction(
  page: Page,
  action: 'Duplicate node' | 'Delete node',
): Promise<void> {
  await properties(page).getByRole('button', { name: 'More node actions', exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

/**
 * #1477 — a tab strip's tabs, by accessible name and in order. Not `toHaveText`:
 * Fluent draws each label twice (one copy reserves the selected tab's bold
 * width), so a tab's text reads "GeneralGeneral".
 */
export async function expectTabNames(tablist: Locator, names: readonly string[]): Promise<void> {
  const tabs = tablist.getByRole('tab');
  await expect(tabs).toHaveCount(names.length);
  for (const [i, name] of names.entries()) {
    await expect(tabs.nth(i)).toHaveAccessibleName(name);
  }
}

/** Manage → Triggers' create/edit form. */
export function triggerForm(page: Page): Locator {
  return page.getByRole('form', { name: 'Trigger form' });
}

/**
 * The run page's activity runs (#1484 OR35 M2): one row per attempt of each
 * activity, per ForEach item or Until round, plus its skipped and reused rows.
 * It replaced the Nodes table, so there is no node-wide "latest" row any more,
 * and a node that never started has no row at all.
 */
export function activityRuns(page: Page): Locator {
  return page.locator('.activity-runs__table');
}

/**
 * A row's cell under the column headed `column`, found by the header rather
 * than by position, so a column added before it moves nothing.
 */
export async function activityCell(page: Page, row: Locator, column: string): Promise<Locator> {
  const col = await activityRuns(page).evaluate(
    (table, name) =>
      [...table.querySelectorAll('thead th')].findIndex((th) => th.textContent?.trim() === name),
    column,
  );
  if (col === -1) throw new Error(`the activity runs have no "${column}" column`);
  return row.locator('td').nth(col);
}

/**
 * An activity's row, found by its accessible name (`HTTP Request 1`), the
 * button that opens it. `nth` picks among its attempts and items in table
 * order; `-1` is the last. Without it the locator matches every row of that
 * activity, so a strict action on a retried or iterated one fails loudly
 * rather than picking one.
 */
export function activityRow(page: Page, name: string, nth?: number): Locator {
  const rows = activityRuns(page)
    .locator('tbody tr')
    .filter({ has: page.getByRole('button', { name, exact: true }) });
  if (nth === undefined) return rows;
  return nth === -1 ? rows.last() : rows.nth(nth);
}

/** An activity's rows by its RAW doc node id (`data-activity-id`), for a doc
 *  whose nodes the spec names by id rather than by label. */
export function activityRowById(page: Page, id: string): Locator {
  return activityRuns(page).locator(`tbody tr[data-activity-id="${id}"]`);
}

/**
 * Opens an activity run in the run drawer and returns what it shows: the
 * `complementary` named `Node <name>`, holding that ONE attempt or item (ADF
 * parity), not the node's latest across items. `nth` as `activityRow`.
 */
export async function openActivity(
  page: Page,
  name: string,
  { nth }: { nth?: number } = {},
): Promise<Locator> {
  await activityRow(page, name, nth).getByRole('button', { name, exact: true }).click();
  return drawerPanel(page, name);
}

/** The run drawer's record, named as the row that opened it. */
export function drawerPanel(page: Page, name: string): Locator {
  return page.locator('.run-drawer').getByRole('complementary', { name: `Node ${name}` });
}

/**
 * Opens one of the run page's views below its activity runs (#1484 OR35 M2),
 * by its tab. A spec that loads a run straight onto a view can instead name it
 * in the URL (`?rdTab=graph`), which is what a shared link does.
 */
export async function openRunView(
  page: Page,
  name: 'Gantt' | 'Graph' | 'Events' | 'Variables' | 'Cost',
): Promise<void> {
  const tab = page
    .getByRole('tablist', { name: 'Run views' })
    .getByRole('tab', { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}
