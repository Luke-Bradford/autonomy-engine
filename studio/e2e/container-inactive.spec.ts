import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { activityRowById, properties } from './support/panels';
import { fireAndSettle, openSeededCanvas, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #1600 OR41 C0e (catalogue spec §3: "Containers get Name, Description,
 * State") — a ForEach switched off (#1694 OR42: by its panel's Deactivate
 * container): greyed on the canvas, never entered, and recorded with its Mark as
 * outcome, which alone routes its edges. Its body is left out of validation, so an unfinished one saves.
 */

const wait = (id: string, x: number, y = 0) => ({
  id,
  type: 'wait',
  config: { seconds: '${0}' },
  position: { x, y },
});
const FOREACH = {
  id: 'fe',
  kind: 'foreach' as const,
  children: ['w'],
  items: '${createArray(1, 2)}',
};

test("#1694 OR42 — a container's Deactivate button, then Description and Mark as on General, written through and saved", async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await openSeededCanvas(page, 'container general', {
    nodes: [wait('w', 40, 60)],
    containers: [FOREACH],
  });
  const box = page.locator('.react-flow__node[data-id="fe"] .flow-container');
  await expect(box).not.toHaveClass(/flow-container--inactive/);

  await page.getByRole('button', { name: 'Configure ForEach 1' }).click();
  await expect(properties(page).getByRole('tab', { name: 'General' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const basics = properties(page).getByRole('group', { name: 'Basics' });
  const markAs = basics.getByLabel('Mark as', { exact: true });
  await expect(basics.getByLabel('Activity state', { exact: true })).toHaveCount(0);
  await expect(markAs).toHaveCount(0);

  await properties(page).getByRole('button', { name: 'Deactivate container' }).click();
  await expect(box).toHaveClass(/flow-container--inactive/);
  await expect(properties(page).getByRole('button', { name: 'Activate container' })).toBeVisible();
  const words = box.locator('.flow-container-inactive');
  await expect(words).toHaveText(' · inactive · succeeded');
  await markAs.selectOption('failure');
  await expect(words).toHaveText(' · inactive · failed');
  await basics.getByRole('textbox', { name: 'Container description' }).fill('Each export file');
  await expect(box.locator('.flow-container-label')).toHaveAttribute(
    'aria-description',
    'Each export file',
  );

  // UI STANDARD rule 5 — a short select, sized to its options; the box's name
  // fades, its inactive words do not.
  expect((await markAs.boundingBox())!.width).toBeLessThan(200);
  const opacityOf = (sel: string) =>
    box.locator(sel).evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(await opacityOf('.flow-container-name')).toBeLessThan(1);
  expect(await opacityOf('.flow-container-inactive')).toBe(1);

  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.locator('.notice')).toHaveText('Saved v2.');
  const res = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
  const items = (await res.json()) as { version: number; containers: Record<string, unknown>[] }[];
  const latest = items.reduce((a, b) => (a.version > b.version ? a : b));
  expect(latest.containers[0]).toMatchObject({
    state: 'inactive',
    onInactiveMarkAs: 'failure',
    description: 'Each export file',
  });

  await expectQuiet(page, problems);
});

test('an inactive ForEach never runs its body: the run routes on its Mark as, and the monitor says inactive', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  // The body is a Fail with no message — refused at save while the ForEach is
  // active. Switched off and marked Failed, the ForEach routes to `onF` only.
  const { pipelineVersionId } = await seedVersion(page, 'container inactive monitor', {
    nodes: [
      { id: 'w', type: 'fail', config: {}, position: { x: 40, y: 60 } },
      wait('onS', 600),
      wait('onF', 600, 200),
    ],
    containers: [{ ...FOREACH, state: 'inactive', onInactiveMarkAs: 'failure' }],
    edges: [
      { id: 'e1', from: 'fe', to: 'onS', on: 'success' },
      { id: 'e2', from: 'fe', to: 'onF', on: 'failure' },
    ],
  });
  const runId = await fireAndSettle(page, pipelineVersionId, 'container inactive monitor');
  const run = (await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
    status: string;
  };
  // ADF's do-if-else: the skipped `onS` leaf is judged by its failed parent, so
  // the run fails, as a real container failure in this graph does (the unit
  // suite pins that parity). `onF` still ran: the mark routed the edges.
  expect(run.status).toBe('failure');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  const group = page.locator('tr.activity-runs__group[data-container-id="fe"]');
  await expect(group.locator('.node-status')).toHaveText('inactive · failed');
  await expect(activityRowById(page, 'onF')).toHaveCount(1);
  await expect(activityRowById(page, 'w')).toHaveCount(0);

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}?rdTab=graph`);
  await fluentRootReady(page);
  await expect(page.locator('.react-flow__node[data-id="fe"] .flow-container-label')).toContainText(
    'inactive · failed',
  );

  await expectQuiet(page, problems);
});
