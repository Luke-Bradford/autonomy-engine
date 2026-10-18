import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #1312 — a node's run policy (retry, retry interval, secure flags) is editable
 * in the canvas. Before this it could be set only through the API or an import.
 * #1600 C0a — and the timeout, now that the executor enforces it, on the
 * activities it can be enforced on.
 */

/** #852 — run policy is the property dock's General tab (ADF's). */
async function openGeneralTab(page: Page): Promise<void> {
  await properties(page).getByRole('tab', { name: 'General' }).click();
}

function policySection(page: Page) {
  return properties(page).getByRole('group', { name: 'Run policy' });
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
  test('timeout, retry, interval and secure output SURVIVE a save and reload', async ({ page }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'policy round trip', seed);
    await nodeById(page, 'a').click();
    await openGeneralTab(page);

    const section = policySection(page);
    // #1694 OR42 — no `?` on the heading in the properties pane; each secure
    // flag's effect is its own `?` note, still the box's description.
    await expect(section.getByLabel('About Run policy', { exact: true })).toHaveCount(0);
    await expect(
      section.getByRole('checkbox', { name: 'Secure output' }),
    ).toHaveAccessibleDescription(/Redacts the outputs before the run log/);
    await section.getByLabel('Timeout (seconds)', { exact: true }).fill('300');
    await section.getByLabel('Timeout (seconds)', { exact: true }).blur();
    await section.getByLabel('Retries', { exact: true }).fill('2');
    await section.getByLabel('Retries', { exact: true }).blur();
    await section.getByLabel('Retry interval (seconds)', { exact: true }).fill('60');
    await section.getByLabel('Retry interval (seconds)', { exact: true }).blur();
    await section.getByRole('checkbox', { name: 'Secure output' }).check();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');
    expect(await persistedPolicy(page, id)).toEqual({
      timeoutSeconds: 300,
      retry: 2,
      retryIntervalSeconds: 60,
      secureOutput: true,
    });

    // A reload re-fetches from the server, so what renders is what persisted.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
    await page.locator('.react-flow__renderer').waitFor();
    await nodeById(page, 'a').click();
    await openGeneralTab(page);
    await expect(policySection(page).getByLabel('Timeout (seconds)', { exact: true })).toHaveValue(
      '300',
    );
    await expect(policySection(page).getByLabel('Retries', { exact: true })).toHaveValue('2');
    await expect(
      policySection(page).getByLabel('Retry interval (seconds)', { exact: true }),
    ).toHaveValue('60');
    await expect(
      policySection(page).getByRole('checkbox', { name: 'Secure output' }),
    ).toBeChecked();
    await expect(
      policySection(page).getByRole('checkbox', { name: 'Secure input' }),
    ).not.toBeChecked();

    await expectQuiet(page, problems);
  });

  test('a policy the write schema refuses blocks the save, named, until fixed', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'policy refused', seed);
    await nodeById(page, 'a').click();
    await openGeneralTab(page);

    const section = policySection(page);
    const save = page.getByRole('button', { name: 'Save version' });
    // An interval with no retry: `StrictNodeSchema.policy` refuses it, which
    // `validatePipelineDoc` never checks — this is the gate #1312 adds.
    await section.getByLabel('Retry interval (seconds)', { exact: true }).fill('60');
    await section.getByLabel('Retry interval (seconds)', { exact: true }).blur();
    await expect(section.getByText(/has no effect without retry/)).toBeVisible();
    await expect(page.locator('.badge-list')).toContainText('has no effect without retry');
    await expect(save).toBeDisabled();

    await section.getByLabel('Retries', { exact: true }).fill('1');
    await section.getByLabel('Retries', { exact: true }).blur();
    await expect(section.getByText(/has no effect without retry/)).toHaveCount(0);
    await expect(save).toBeEnabled();

    await expectQuiet(page, problems);
  });

  test('#1600 C0a — at 1440x900 the timeout is a short control on its own row, above the retries', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'policy timeout layout', seed);
    await nodeById(page, 'a').click();
    await openGeneralTab(page);
    const section = policySection(page);
    const box = async (label: string) => {
      const b = await section.getByLabel(label, { exact: true }).boundingBox();
      if (b === null) throw new Error(`${label} is not rendered`);
      return b;
    };
    const timeout = await box('Timeout (seconds)');
    const retries = await box('Retries');
    const interval = await box('Retry interval (seconds)');
    // A number like the others: one control height, one width, one left edge.
    expect(timeout.height).toBe(retries.height);
    expect(timeout.width).toBe(retries.width);
    expect(timeout.x).toBe(retries.x);
    // Its own row, so the retry pair still shares one.
    expect(timeout.y + timeout.height).toBeLessThan(retries.y);
    expect(interval.y).toBe(retries.y);
    await expectQuiet(page, problems);
  });

  test('#1600 C0a — no timeout field where nothing would enforce it (a webhook)', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'policy webhook', {
      nodes: [
        {
          id: 'a',
          type: 'webhook',
          position: { x: 0, y: 0 },
          // #1600 C11c-2 — a declared output keeps it a Webhook on load.
          config: { timeoutSeconds: '${600}', outputs: [{ name: 'decision', type: 'string' }] },
        },
      ],
    });
    await nodeById(page, 'a').click();
    await openGeneralTab(page);
    const section = policySection(page);
    await expect(section.getByLabel('Retries', { exact: true })).toBeVisible();
    await expect(section.getByLabel('Timeout (seconds)', { exact: true })).toHaveCount(0);
    await expectQuiet(page, problems);
  });
});
