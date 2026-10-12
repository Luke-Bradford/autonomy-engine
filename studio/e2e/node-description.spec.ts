import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { activityRowById, properties } from './support/panels';
import { fireAndSettle, nodeById, openSeededCanvas, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #1600 OR41 C0b (catalogue spec §3) — an activity's Description: authored on
 * the dock's General tab, shown on hover on the canvas, and in the monitor.
 */

const TEXT = 'Waits for the upstream export to land';
const doc = (description?: string) => ({
  nodes: [
    {
      id: 'w',
      type: 'wait',
      config: { seconds: '${0}' },
      position: { x: 0, y: 0 },
      ...(description === undefined ? {} : { description }),
    },
  ],
});

test('a description typed on the General tab survives a save and reload, and is the card hover', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await openSeededCanvas(page, 'description round trip', doc());
  const title = nodeById(page, 'w').locator('.flow-node-title');
  // No description: the hover is the bare name, and nothing describes it.
  await expect(title).toHaveAttribute('title', 'Wait 1');
  await expect(title).not.toHaveAttribute('aria-description');

  await nodeById(page, 'w').click();
  await properties(page).getByRole('tab', { name: 'General' }).click();
  const section = properties(page).getByRole('group', { name: 'Basics' });
  await expect(section).toHaveAccessibleDescription(
    'What this activity is for, and whether it runs.',
  );
  const field = section.getByLabel('Activity description');
  await expect(field).toHaveAttribute('maxlength', '4000');
  await field.fill(TEXT);

  // The card follows as it is typed — the store is the one authority.
  await expect(title).toHaveAttribute('title', `Wait 1\n\n${TEXT}`);
  await expect(title).toHaveAttribute('aria-description', TEXT);

  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.locator('.notice')).toHaveText('Saved v2.');
  const res = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
  const items = (await res.json()) as { version: number; nodes: { description?: string }[] }[];
  const latest = items.reduce((a, b) => (a.version > b.version ? a : b));
  expect(latest.nodes[0]?.description).toBe(TEXT);

  // A reload re-fetches, so what renders is what persisted.
  await page.reload();
  await page.locator('.react-flow__renderer').waitFor();
  await expect(title).toHaveAttribute('title', `Wait 1\n\n${TEXT}`);
  await nodeById(page, 'w').click();
  await properties(page).getByRole('tab', { name: 'General' }).click();
  await expect(properties(page).getByLabel('Activity description')).toHaveValue(TEXT);

  // Clearing it removes the key: the next version carries no description.
  await properties(page).getByLabel('Activity description').fill('');
  await expect(title).toHaveAttribute('title', 'Wait 1');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.locator('.notice')).toHaveText('Saved v3.');
  const after = (await (
    await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`)
  ).json()) as { version: number; nodes: Record<string, unknown>[] }[];
  const v3 = after.reduce((a, b) => (a.version > b.version ? a : b));
  expect('description' in v3.nodes[0]!).toBe(false);

  await expectQuiet(page, problems);
});

test("the monitor shows the run version's description: the graph card's hover and the drawer", async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const { pipelineVersionId } = await seedVersion(page, 'description monitor', doc(TEXT));
  const runId = await fireAndSettle(page, pipelineVersionId, 'description monitor');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  await activityRowById(page, 'w').getByRole('button', { name: 'Wait 1', exact: true }).click();
  const drawer = page.locator('#run-detail-drawer').getByRole('region', { name: 'Node Wait 1' });
  await expect(drawer.getByText(TEXT, { exact: true })).toBeVisible();

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}?rdTab=graph`);
  await fluentRootReady(page);
  const card = page.locator('.react-flow__node[data-id="w"] .flow-node-title');
  await expect(card).toHaveAttribute('title', `Wait 1\n\n${TEXT}`);
  await expect(card).toHaveAttribute('aria-description', TEXT);

  await expectQuiet(page, problems);
});
