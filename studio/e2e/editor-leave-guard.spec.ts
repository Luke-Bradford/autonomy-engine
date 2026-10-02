import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas, seedVersion } from './support/seedDoc';
import { properties } from './support/panels';
import { tree } from './support/authorPane';

/**
 * #1396 — the pipeline editor holds an unsaved draft at the same prompt a
 * resource drawer does.
 *
 * The draft lives in the editor's own store, so leaving its path throws the
 * edits away: the Pipelines crumb, another pipeline in the tree, Open run. Before
 * this, every one of those left silently. Asking must not move the canvas
 * (#1393), and while it asks no shortcut may edit the graph behind it.
 */

const prompt = (page: Page) => page.getByRole('alertdialog', { name: 'Unsaved changes' });
/* #1397 — the editor's own "Back to pipelines" is gone; the breadcrumb's
   Pipelines crumb is the same anchor, so it is the way back this guards. */
const back = (page: Page) =>
  page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Pipelines' });

async function editRetries(page: Page) {
  await nodeById(page, 'a').click();
  await properties(page).getByRole('tab', { name: 'General' }).click();
  const retries = properties(page).getByRole('textbox', { name: 'Retries' });
  await retries.fill('2');
  await retries.blur();
  await expect(page.locator('.dirty-dot')).toHaveCSS('visibility', 'visible');
}

test.describe('#1396 the pipeline editor holds an unsaved draft', () => {
  test('Back asks, Keep stays with the draft, and the canvas does not move', async ({ page }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, `e2e 1396 leave keep ${Date.now()}`, {
      nodes: [{ id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} }],
    });
    await editRetries(page);
    const before = await page.locator('.canvas-wrap').boundingBox();

    await back(page).click();
    await expect(prompt(page)).toBeVisible();
    expect(page.url()).toContain(encodeURIComponent(id));
    await expect(page.getByRole('button', { name: 'Keep editing' })).toBeFocused();
    expect(await page.locator('.canvas-wrap').boundingBox()).toEqual(before);

    // The node is still selected. Delete must not reach the graph while the
    // prompt asks — focus is on a button, which the editor's text-entry guard
    // does not exempt.
    await page.keyboard.press('Delete');
    await expect(nodeById(page, 'a')).toBeVisible();

    // Escape keeps editing, as it does in a drawer, and focus goes back to the
    // link that asked. The node survived the Delete above.
    await page.keyboard.press('Escape');
    await expect(prompt(page)).toBeHidden();
    await expect(back(page)).toBeFocused();
    await expect(nodeById(page, 'a')).toBeVisible();
    expect(page.url()).toContain(encodeURIComponent(id));
    await expect(page.locator('.dirty-dot')).toHaveCSS('visibility', 'visible');
    await expect(properties(page).getByRole('textbox', { name: 'Retries' })).toHaveValue('2');
    await expectQuiet(page, problems);
  });

  test('another pipeline in the tree asks, and Discard goes there', async ({ page }) => {
    const problems = collectPageProblems(page);
    const other = `e2e 1396 leave other ${Date.now()}`;
    await seedVersion(page, other, { nodes: [{ id: 'b', position: { x: 0, y: 0 } }] });
    await openSeededCanvas(page, `e2e 1396 leave discard ${Date.now()}`, {
      nodes: [{ id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} }],
    });
    await editRetries(page);

    await tree(page).getByRole('link', { name: other, exact: true }).click();
    await expect(prompt(page)).toBeVisible();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await expect(page.getByRole('heading', { name: other })).toBeVisible();
    await expect(prompt(page)).toBeHidden();
    await expect(page.locator('.dirty-dot')).toHaveCSS('visibility', 'hidden');

    // A clean editor leaves without asking.
    await back(page).click();
    await expect(page.getByRole('heading', { name: 'Pipelines' })).toBeVisible();
    await expect(prompt(page)).toBeHidden();
    await expectQuiet(page, problems);
  });
});
