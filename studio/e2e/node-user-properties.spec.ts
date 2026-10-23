import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { activityRowById, activityRuns, properties } from './support/panels';
import {
  fireAndSettle,
  nodeById,
  openSeededCanvas,
  seedVersion,
  waitForRunToSettle,
} from './support/seedDoc';
import { seedConnection } from './support/seedResources';
import { fluentRootReady } from './support/theme';

/**
 * #1600 OR41 C0d (catalogue spec §3; ADF "user properties") — user properties
 * authored on the General tab, resolved when the activity runs, and shown as
 * columns in the run's activity runs grid. One round trip: what the form
 * writes is what the run records and the monitor shows.
 *
 * `file_list` over a local `fs` connection: an execution activity (only those
 * record user properties) that needs no network.
 */
test('user properties: authored on the General tab, resolved at run time, shown as activity runs columns', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-c0d-')));
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const connectionId = await seedConnection(page, {
      name: 'C0d local files',
      kind: 'fs',
      config: { roots: [root] },
    });
    const id = await openSeededCanvas(page, 'user properties', {
      params: [{ name: 'dir', type: 'string' as const, required: false, default: root }],
      nodes: [
        {
          id: 'ls',
          type: 'file_list',
          connectionId,
          config: { path: '${params.dir}' },
          position: { x: 0, y: 0 },
        },
      ],
    });

    await nodeById(page, 'ls').click();
    await properties(page).getByRole('tab', { name: 'General' }).click();
    const section = properties(page).getByRole('group', { name: 'User properties', exact: true });
    const add = section.getByRole('button', { name: 'Add user property' });
    await add.click();
    await section.getByLabel('User property 1 name').fill('Folder');
    await section.getByLabel('User property 1 value').fill('in ${params.dir}');
    await add.click();
    await section.getByLabel('User property 2 name').fill('Kind');
    await section.getByLabel('User property 2 value').fill('nightly');

    // UI STANDARD rule 5/7 at 1440x900: the name is a short field beside the
    // value, which takes the width, and the section is on screen in the dock.
    const [name, value] = await Promise.all([
      section.getByLabel('User property 1 name').boundingBox(),
      section.getByLabel('User property 1 value').boundingBox(),
    ]);
    expect(name && value).toBeTruthy();
    expect(Math.abs(name!.y - value!.y)).toBeLessThan(4);
    expect(name!.width).toBeLessThan(value!.width);
    expect(name!.height).toBeLessThanOrEqual(32);

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');
    const res = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
    const latest = (
      (await res.json()) as { id: string; version: number; nodes: unknown[] }[]
    ).reduce((a, b) => (a.version > b.version ? a : b));
    expect(latest.nodes[0]).toMatchObject({
      userProperties: [
        { name: 'Folder', value: 'in ${params.dir}' },
        { name: 'Kind', value: 'nightly' },
      ],
    });

    const runId = await fireAndSettle(page, latest.id, 'user properties');
    await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
    await fluentRootReady(page);
    const row = activityRowById(page, 'ls');
    await expect(row).toHaveCount(1);
    const headers = activityRuns(page).locator('thead th');
    await expect(headers.filter({ hasText: /^Folder$/ })).toHaveCount(1);
    await expect(headers.filter({ hasText: /^Kind$/ })).toHaveCount(1);
    // The cell sits under its header: read both by the header's index.
    const texts = await headers.allTextContents();
    const cells = row.locator('td');
    await expect(cells.nth(texts.indexOf('Folder'))).toHaveText(`in ${root}`);
    await expect(cells.nth(texts.indexOf('Kind'))).toHaveText('nightly');
    // Measured: the activity's row is on the first screen.
    const box = await row.boundingBox();
    expect(box && box.y + box.height).toBeLessThan(900);

    await expectQuiet(page, problems);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * #1673 — an attempt refused BEFORE dispatch (its connection is the wrong kind
 * for the activity) still shows its user properties: the row an operator most
 * wants them on, and the one that read blank before. The connection is named by
 * a LITERAL id: a `${}` one is a dynamic reference that may resolve to any
 * connection, so every later connection delete in this server would ask for
 * the typed name.
 */
test('user properties: an activity refused before dispatch still shows them in the activity runs grid', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const connectionId = await seedConnection(page, {
    name: '#1673 wrong kind',
    kind: 'http',
    config: {},
  });
  const { pipelineVersionId } = await seedVersion(page, 'user properties refused', {
    params: [{ name: 'label', type: 'string' as const, required: false, default: 'refused' }],
    nodes: [
      {
        id: 'ls',
        type: 'file_list',
        connectionId,
        config: { path: '/tmp' },
        userProperties: [{ name: 'Kind', value: 'nightly ${params.label}' }],
        position: { x: 0, y: 0 },
      },
    ],
  });
  const runId = await fireAndSettle(page, pipelineVersionId, 'user properties refused');
  const run = await page.request.get(`/api/runs/${encodeURIComponent(runId)}`);
  expect(((await run.json()) as { status: string }).status).toBe('failure');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  const row = activityRowById(page, 'ls');
  await expect(row).toHaveCount(1);
  const headers = activityRuns(page).locator('thead th');
  await expect(headers.filter({ hasText: /^Kind$/ })).toHaveCount(1);
  const texts = await headers.allTextContents();
  await expect(row.locator('td').nth(texts.indexOf('Kind'))).toHaveText('nightly refused');

  await expectQuiet(page, problems);
});

/**
 * #1673 part 2 — an activity the engine evaluates (an If here) never reaches
 * the executor. The General tab offers it user properties all the same, and
 * the run records them on the If's own event, so its row shows them too.
 */
test('user properties: an activity the engine evaluates takes them and shows them in the activity runs grid', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const gate = {
    id: 'gate',
    type: 'if',
    config: { condition: '${equals(1, 1)}' },
    position: { x: 0, y: 0 },
  };
  await openSeededCanvas(page, 'user properties on an If', { nodes: [gate] });
  await nodeById(page, 'gate').click();
  await properties(page).getByRole('tab', { name: 'General' }).click();
  const section = properties(page).getByRole('group', { name: 'User properties', exact: true });
  await expect(section.getByRole('button', { name: 'Add user property' })).toBeEnabled();

  const { pipelineVersionId } = await seedVersion(page, 'user properties on an If run', {
    params: [{ name: 'label', type: 'string' as const, required: false, default: 'nightly' }],
    nodes: [{ ...gate, userProperties: [{ name: 'Why', value: 'gate ${params.label}' }] }],
  });
  const runId = await fireAndSettle(page, pipelineVersionId, 'user properties on an If run');
  const run = await page.request.get(`/api/runs/${encodeURIComponent(runId)}`);
  expect(((await run.json()) as { status: string }).status).toBe('success');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  const row = activityRowById(page, 'gate');
  await expect(row).toHaveCount(1);
  const headers = activityRuns(page).locator('thead th');
  await expect(headers.filter({ hasText: /^Why$/ })).toHaveCount(1);
  const texts = await headers.allTextContents();
  await expect(row.locator('td').nth(texts.indexOf('Why'))).toHaveText('gate nightly');

  await expectQuiet(page, problems);
});

/**
 * #1673 part 3 — an inactive activity records its literal user properties and
 * evaluates none of its `${}`s, and a rerun's reused rows show what the source
 * run recorded for the work they copy. `off` (inactive, marked Succeeded) and
 * `gate` are copied; `stop` fails R1 and runs again in R2.
 */
test('user properties: a rerun’s reused rows show the source’s, and an inactive activity records only literals', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { pipelineVersionId } = await seedVersion(page, 'user properties on a rerun', {
    params: [{ name: 'label', type: 'string' as const, required: false, default: 'nightly' }],
    nodes: [
      {
        id: 'off',
        type: 'if',
        config: { condition: '${true}' },
        position: { x: 0, y: 0 },
        state: 'inactive',
        userProperties: [
          { name: 'Kind', value: 'batch' },
          { name: 'Why', value: 'off ${params.label}' },
        ],
      },
      {
        id: 'gate',
        type: 'if',
        config: { condition: '${equals(1, 1)}' },
        position: { x: 0, y: 160 },
        userProperties: [{ name: 'Why', value: 'gate ${params.label}' }],
      },
      { id: 'stop', type: 'fail', config: { message: 'planned' }, position: { x: 300, y: 160 } },
    ],
    edges: [{ id: 'e1', from: 'gate', to: 'stop', on: 'success' }],
  });
  const source = await fireAndSettle(page, pipelineVersionId, 'user properties on a rerun');
  // The inactive activity's own run records its literal and refuses its `${}`.
  await page.goto(`/#/monitor/runs/${encodeURIComponent(source)}`);
  await fluentRootReady(page);
  const sourceHeaders = await activityRuns(page).locator('thead th').allTextContents();
  await expect(
    activityRowById(page, 'off').locator('td').nth(sourceHeaders.indexOf('Why')),
  ).toHaveText('Not resolved: the activity is inactive');

  const res = await page.request.post(`/api/runs/${encodeURIComponent(source)}/rerun-from-failed`);
  expect(res.status()).toBe(202);
  const { runId } = (await res.json()) as { runId: string };
  await waitForRunToSettle(page, runId);

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  const headers = activityRuns(page).locator('thead th');
  await expect(headers.filter({ hasText: /^Why$/ })).toHaveCount(1);
  const texts = await headers.allTextContents();
  const cell = (id: string, name: string) =>
    activityRowById(page, id).locator('td').nth(texts.indexOf(name));
  await expect(activityRowById(page, 'gate')).toHaveCount(1);
  await expect(cell('gate', 'Why')).toHaveText('gate nightly');
  await expect(cell('off', 'Kind')).toHaveText('batch');
  await expect(cell('off', 'Why')).toHaveText('Not resolved: the activity is inactive');

  await expectQuiet(page, problems);
});
