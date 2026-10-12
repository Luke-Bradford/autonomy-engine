import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { activityRowById, properties } from './support/panels';
import {
  fireAndSettle,
  nodeById,
  openSeededCanvas,
  seedVersion,
  waitForRunToSettle,
} from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #1600 OR41 C0c (catalogue spec §3; ADF "deactivate an activity") — an
 * activity switched off on the General tab: greyed on the canvas, never run, and
 * recorded with its Mark as outcome, which alone routes its edges.
 */

const fail = (extra: Record<string, unknown> = {}) => ({
  id: 'f',
  type: 'fail',
  config: { message: 'boom' },
  position: { x: 0, y: 0 },
  ...extra,
});
const wait = (id: string, x: number) => ({
  id,
  type: 'wait',
  config: { seconds: '${0}' },
  position: { x, y: 0 },
});

test('Activity state and Mark as on the General tab: the card greys, the doc stores only what differs', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await openSeededCanvas(page, 'inactive authoring', { nodes: [fail()] });
  const card = nodeById(page, 'f');
  await expect(card.locator('.flow-node')).not.toHaveClass(/flow-node--inactive/);

  await card.click();
  await properties(page).getByRole('tab', { name: 'General' }).click();
  const basics = properties(page).getByRole('group', { name: 'Basics' });
  const state = basics.getByLabel('Activity state', { exact: true });
  const markAs = basics.getByLabel('Mark as', { exact: true });
  await expect(state).toHaveValue('active');
  // Kept, but not in force, while the activity is active.
  await expect(markAs).toBeDisabled();

  await state.selectOption('inactive');
  await expect(card.locator('.flow-node')).toHaveClass(/flow-node--inactive/);
  const badge = card.locator('.flow-node-badge--inactive');
  await expect(badge).toHaveText('inactive · succeeded');
  await expect(markAs).toBeEnabled();
  await markAs.selectOption('failure');
  await expect(badge).toHaveText('inactive · failed');
  await expect(badge).toHaveAttribute('aria-label', 'Inactive: never runs, and records Failed');

  // UI STANDARD rule 5/7 — two short selects packed side by side, each sized to
  // its options rather than stretched, measured at 1440x900.
  const [s, m] = await Promise.all([state.boundingBox(), markAs.boundingBox()]);
  expect(s && m).toBeTruthy();
  expect(Math.abs(s!.y - m!.y)).toBeLessThan(2);
  expect(s!.width).toBeLessThan(200);
  expect(m!.width).toBeLessThan(200);
  // The card's face fades; the badge, which carries the words, keeps its contrast.
  const opacityOf = (sel: string) =>
    card.locator(sel).evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(await opacityOf('.flow-node-title')).toBeLessThan(1);
  expect(await opacityOf('.flow-node-badge--inactive')).toBe(1);

  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.locator('.notice')).toHaveText('Saved v2.');
  const versions = async () => {
    const res = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
    const items = (await res.json()) as { version: number; nodes: Record<string, unknown>[] }[];
    return items.reduce((a, b) => (a.version > b.version ? a : b)).nodes[0]!;
  };
  expect(await versions()).toMatchObject({ state: 'inactive', onInactiveMarkAs: 'failure' });

  // Back on: `state` is REMOVED (never `'active'`), and Mark as is kept, as ADF does.
  // A save reloads the version, which clears the selection, so re-open the node.
  await card.click();
  await properties(page).getByRole('tab', { name: 'General' }).click();
  await expect(state).toHaveValue('inactive');
  await expect(markAs).toHaveValue('failure');
  await state.selectOption('active');
  await expect(card.locator('.flow-node')).not.toHaveClass(/flow-node--inactive/);
  await expect(markAs).toBeDisabled();
  await expect(markAs).toHaveValue('failure');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.locator('.notice')).toHaveText('Saved v3.');
  const v3 = await versions();
  expect('state' in v3).toBe(false);
  expect(v3.onInactiveMarkAs).toBe('failure');

  await expectQuiet(page, problems);
});

test('an inactive Fail never runs: the run succeeds, the monitor says inactive, and Mark as routes the edges', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  // f is a Fail that WOULD fail the run. Switched off and marked Skipped, it
  // routes to `onSkip` only; `onSuccess` is skipped.
  const { pipelineVersionId } = await seedVersion(page, 'inactive monitor', {
    nodes: [
      fail({ state: 'inactive', onInactiveMarkAs: 'skipped' }),
      wait('onSuccess', 300),
      wait('onSkip', 600),
    ],
    edges: [
      { id: 'e1', from: 'f', to: 'onSuccess', on: 'success' },
      { id: 'e2', from: 'f', to: 'onSkip', on: 'skipped' },
    ],
  });
  const runId = await fireAndSettle(page, pipelineVersionId, 'inactive monitor');
  const run = (await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
    status: string;
  };
  expect(run.status).toBe('success');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  await expect(activityRowById(page, 'f')).toHaveCount(1);
  await expect(activityRowById(page, 'f').locator('.node-status')).toHaveText('inactive · skipped');
  await expect(activityRowById(page, 'onSkip').locator('.node-status')).toHaveText('success');
  await expect(activityRowById(page, 'onSuccess').locator('.node-status')).toHaveText('skipped');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}?rdTab=graph`);
  await fluentRootReady(page);
  await expect(page.locator('.react-flow__node[data-id="f"] .run-node-status')).toHaveText(
    'inactive · skipped',
  );
  // The run graph draws the doc's card, so the switched-off mark is there too.
  await expect(
    page.locator('.react-flow__node[data-id="f"] .flow-node-badge--inactive'),
  ).toHaveText('inactive · skipped');

  await expectQuiet(page, problems);
});

test('#1669 — a rerun keeps a copied inactive activity inactive, and the grid filters to Inactive', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  // `w` is switched off and marked Succeeded; the Fail after it fails R1, so
  // the rerun copies `w` (its reseed frontier) and runs the Fail again.
  const { pipelineVersionId } = await seedVersion(page, 'inactive rerun', {
    nodes: [{ ...wait('w', 0), state: 'inactive' }, fail({ position: { x: 300, y: 0 } })],
    edges: [{ id: 'e1', from: 'w', to: 'f', on: 'success' }],
  });
  const source = await fireAndSettle(page, pipelineVersionId, 'inactive rerun');
  const res = await page.request.post(`/api/runs/${encodeURIComponent(source)}/rerun-from-failed`);
  expect(res.status()).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  await waitForRunToSettle(page, runId);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  await expect(activityRowById(page, 'w').locator('.node-status')).toHaveText(
    'inactive · succeeded',
  );
  await expect(activityRowById(page, 'f')).toHaveCount(1);

  await page.getByRole('combobox', { name: 'Status' }).selectOption('inactive');
  await expect(activityRowById(page, 'w')).toHaveCount(1);
  await expect(activityRowById(page, 'f')).toHaveCount(0);

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}?rdTab=graph`);
  await fluentRootReady(page);
  await expect(page.locator('.react-flow__node[data-id="w"] .run-node-status')).toHaveText(
    'inactive · succeeded',
  );

  await expectQuiet(page, problems);
});

test('#1669 — Problems warns about a read of an inactive output and an inactive If, without refusing the save', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, 'inactive warnings', {
    nodes: [
      {
        id: 'src',
        type: 'agent_task',
        config: { task: 't', outputs: [{ name: 'v', type: 'string' }] },
        position: { x: 0, y: 0 },
        state: 'inactive',
      },
      {
        id: 'r',
        type: 'agent_task',
        config: { task: '${nodes.src.output.v}' },
        position: { x: 300, y: 0 },
      },
      {
        id: 'c',
        type: 'if',
        config: { condition: '${true}' },
        position: { x: 600, y: 0 },
        state: 'inactive',
      },
      wait('w', 900),
    ],
    edges: [
      { id: 'e1', from: 'src', to: 'r', on: 'success' },
      { id: 'e2', from: 'r', to: 'c', on: 'success' },
      { id: 'e3', from: 'c', to: 'w', on: 'branch', branch: 'true' },
    ],
  });

  const panel = page.getByRole('region', { name: 'Problems', exact: true });
  const warnings = panel.locator('.badge-list--warning');
  await expect(warnings.locator('strong')).toHaveText('2 warning(s)');
  await expect(warnings.locator('li')).toHaveCount(2);
  await expect(warnings.locator('li').nth(0)).toContainText(
    "is inactive, so it has no outputs and this read fails when it runs; make it default()'s first argument",
  );
  await expect(warnings.locator('li').nth(1)).toContainText(
    'inactive, so it records no branch and every activity on its branch edges is skipped',
  );
  // Warnings never join the errors: no error list, and the toggle's error count stays 0.
  await expect(panel.locator('.badge-list:not(.badge-list--warning)')).toHaveCount(0);
  const toggle = page.getByRole('button', { name: /^Problems/ });
  await expect(toggle.locator('.count-badge').first()).toHaveText('0');
  await expect(toggle.locator('.count-badge--warning')).toHaveText('2');
  // UI STANDARD rule 7 — the list is on screen at 1440x900 without scrolling.
  const box = await warnings.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);

  await expectQuiet(page, problems);
});
