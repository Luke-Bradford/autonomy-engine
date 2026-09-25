import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';

/**
 * #1312 — a node's run policy (retry, retry interval, secure flags) is editable
 * in the canvas. Before this it could be set only through the API or an import.
 */

function policySection(page: Page) {
  return page
    .getByRole('complementary', { name: 'Properties' })
    .getByRole('group', { name: 'Run policy' });
}

/** The stored policy of node `a`, read back from the LATEST version. */
async function persistedPolicy(page: Page, pipelineId: string): Promise<unknown> {
  const res = await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`);
  expect(res.status()).toBe(200);
  const items = (await res.json()) as {
    version: number;
    nodes: { id: string; policy?: unknown }[];
  }[];
  const latest = items.reduce((a, b) => (a.version > b.version ? a : b));
  return latest.nodes.find((n) => n.id === 'a')?.policy;
}

const seed = {
  nodes: [
    {
      id: 'a',
      type: 'http_request',
      position: { x: 0, y: 0 },
      config: { url: 'https://example.test' },
    },
  ],
};

test.describe('#1312 — node run policy editor', () => {
  test('retry, interval and secure output SURVIVE a save and reload', async ({ page }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'policy round trip', seed);
    await nodeById(page, 'a').click();

    const section = policySection(page);
    await section.getByLabel('Retries').fill('2');
    await section.getByLabel('Retries').blur();
    await section.getByLabel('Retry interval (seconds)').fill('60');
    await section.getByLabel('Retry interval (seconds)').blur();
    await section.getByLabel('Secure output').check();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');
    expect(await persistedPolicy(page, id)).toEqual({
      retry: 2,
      retryIntervalSeconds: 60,
      secureOutput: true,
    });

    // A reload re-fetches from the server, so what renders is what persisted.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
    await page.locator('.react-flow__renderer').waitFor();
    await nodeById(page, 'a').click();
    await expect(policySection(page).getByLabel('Retries')).toHaveValue('2');
    await expect(policySection(page).getByLabel('Retry interval (seconds)')).toHaveValue('60');
    await expect(policySection(page).getByLabel('Secure output')).toBeChecked();
    await expect(policySection(page).getByLabel('Secure input')).not.toBeChecked();

    await expectQuiet(page, problems);
  });

  test('a policy the write schema refuses blocks the save, named, until fixed', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'policy refused', seed);
    await nodeById(page, 'a').click();

    const section = policySection(page);
    const save = page.getByRole('button', { name: 'Save version' });
    // An interval with no retry: `StrictNodeSchema.policy` refuses it, which
    // `validatePipelineDoc` never checks — this is the gate #1312 adds.
    await section.getByLabel('Retry interval (seconds)').fill('60');
    await section.getByLabel('Retry interval (seconds)').blur();
    await expect(section.getByText(/has no effect without retry/)).toBeVisible();
    await expect(page.locator('.badge-list')).toContainText('has no effect without retry');
    await expect(save).toBeDisabled();

    await section.getByLabel('Retries').fill('1');
    await section.getByLabel('Retries').blur();
    await expect(section.getByText(/has no effect without retry/)).toHaveCount(0);
    await expect(save).toBeEnabled();

    await expectQuiet(page, problems);
  });
});
