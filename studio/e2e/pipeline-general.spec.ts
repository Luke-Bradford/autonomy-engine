import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openSeededCanvas } from './support/seedDoc';

/**
 * #1 F8a — a pipeline's description and annotations, authored on the dock's
 * General tab.
 *
 * The unit suites pin the store actions, the save body and the schema's rules.
 * What only an e2e can prove is that what the author types REACHES THE SERVER:
 * a round trip through the write gate and an immutable version mint, then back
 * out on reload. The #473 shape — a field accepted, validated, returned and
 * never persisted — is invisible to anything short of that.
 */

async function openGeneral(page: Page) {
  await page.getByRole('tab', { name: 'General' }).click();
}

async function latestVersion(page: Page, id: string) {
  const versions = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
  expect(versions.status()).toBe(200);
  const items = (await versions.json()) as {
    version: number;
    description: string;
    annotations: string[];
  }[];
  return items.reduce((a, b) => (a.version > b.version ? a : b));
}

test.describe('#1 F8a — pipeline description + annotations', () => {
  test('a description and annotations authored on the canvas SURVIVE a save and reload', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'f8a round trip', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
    });

    await openGeneral(page);
    await page.getByLabel('pipeline description').fill('Loads the nightly batch');
    await page.getByRole('button', { name: 'Add annotation' }).click();
    await page.getByLabel('annotation 1', { exact: true }).fill('prod');
    await page.getByRole('button', { name: 'Add annotation' }).click();
    await page.getByLabel('annotation 2', { exact: true }).fill('finance');

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // A reload re-fetches the latest version, so this is what was persisted.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
    await page.locator('.react-flow__renderer').waitFor();
    await openGeneral(page);
    await expect(page.getByLabel('pipeline description')).toHaveValue('Loads the nightly batch');
    await expect(page.getByLabel('annotation 1', { exact: true })).toHaveValue('prod');
    await expect(page.getByLabel('annotation 2', { exact: true })).toHaveValue('finance');

    const latest = await latestVersion(page, id);
    expect(latest.description).toBe('Loads the nightly batch');
    expect(latest.annotations).toEqual(['prod', 'finance']);

    await expectQuiet(page, problems);
  });

  test('a duplicate annotation blocks Save, in the write schema’s own words', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'f8a duplicate', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      annotations: ['prod'],
    });

    await openGeneral(page);
    await page.getByRole('button', { name: 'Add annotation' }).click();
    await page.getByLabel('annotation 2', { exact: true }).fill('Prod');

    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();
    await expect(page.locator('.badge-list li')).toContainText([
      "annotation 2: duplicate annotation 'Prod' (annotations must be unique, ignoring case)",
    ]);

    // Removing the duplicate clears the refusal — the gate follows the doc.
    await page.getByRole('button', { name: 'remove annotation 2' }).click();
    await expect(page.locator('.badge-list li')).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('a stored description and annotations are NOT dropped by a save that edits something else', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'f8a preserve', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
      description: 'Seeded through the API',
      annotations: ['kept'],
    });

    await page.getByRole('button', { name: 'Add param' }).click();
    await page.getByLabel('param 1 name').fill('topic');
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    const latest = await latestVersion(page, id);
    expect(latest.description).toBe('Seeded through the API');
    expect(latest.annotations).toEqual(['kept']);

    await expectQuiet(page, problems);
  });
});
