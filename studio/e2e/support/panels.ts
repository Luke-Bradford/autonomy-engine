import type { Locator, Page } from '@playwright/test';

/**
 * The two form surfaces an authoring spec fills, located ONE way.
 *
 * Each of these used to be a private one-liner copied into every spec that
 * needed it: `properties` in thirteen files (under two names), `triggerForm` in
 * six. The locator itself never differed. That changes the day the dock's or
 * the form's accessible name changes, and at that point the fix belongs in one
 * file, not nineteen.
 */

/** The canvas's right-hand Properties dock: the selected node's inspector,
 *  or the pipeline's own tabs when nothing is selected. */
export function properties(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Properties' });
}

/** Manage → Triggers' create/edit form. */
export function triggerForm(page: Page): Locator {
  return page.getByRole('form', { name: 'Trigger form' });
}

/**
 * The run page's Nodes table: each node's latest record, and its inline
 * drill-in. The activity runs above it name the same activities with buttons of
 * their own, which open the run drawer instead (#1484 M2), so a node's drill-in
 * is found inside this table.
 */
export function nodesTable(page: Page): Locator {
  return page
    .locator('table')
    .filter({ has: page.getByRole('columnheader', { name: 'Node', exact: true }) });
}
