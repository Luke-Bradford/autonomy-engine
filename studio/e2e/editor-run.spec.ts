import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { triggerMenuItem } from './support/canvas';
import { nodeById, openSeededCanvas } from './support/seedDoc';

/**
 * #1395 OR4 slice 1 — Run from the editor. The operator presses Run in the
 * pipeline's header, sets a param, and starts the latest saved version with NO
 * trigger: nothing is created or fired on the Triggers page, and the run that
 * lands carries `triggerId: null`.
 *
 * Slice 2 adds the live overlay: the run's node states on THIS canvas, and the
 * selected node's part in the run in the dock, without leaving the editor.
 *
 * #1476 OR28 moved Run into the header's Trigger ▾ menu, as ADF's Trigger now.
 */

/** The run page's header pill, scoped off the activity runs' own status words. */
const headerStatus = '.run-header .run-status';

test('#1395 — Run in the editor starts the saved version with the params typed, and no trigger', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const triggerCalls: string[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'GET' && req.url().includes('/api/triggers')) triggerCalls.push(req.url());
  });

  await openSeededCanvas(page, 'or4 run from editor', {
    params: [
      { name: 'city', type: 'string', required: false, default: 'Leeds' },
      { name: 'secs', type: 'number', required: false, default: 0 },
    ],
    nodes: [
      { id: 'hold', type: 'wait', config: { seconds: '${params.secs}' }, position: { x: 0, y: 0 } },
    ],
  });

  // Opening the form moves nothing on the page (#1393): it is drawn OVER the canvas.
  const canvas = page.locator('.react-flow');
  const before = await canvas.boundingBox();
  const run = await triggerMenuItem(page, /^Trigger now/);
  await expect(run).toContainText('Run v1, the latest saved version.');
  await run.click();
  const form = page.getByRole('dialog', { name: 'Run v1' });
  await expect(form).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(before);
  // The menu closing does not take focus back from the form it opened.
  await expect(form.getByLabel('city')).toBeFocused();

  // Prefilled from the defaults; the operator overrides one.
  await expect(form.getByLabel('city')).toHaveValue('Leeds');
  await expect(form.getByLabel('secs')).toHaveValue('0');

  // A value the type cannot take is refused in the form, before any request.
  await form.getByLabel('secs').fill('soon');
  await form.getByRole('button', { name: 'Start run' }).click();
  await expect(form.getByRole('alert')).toHaveText('secs: expected a number');

  await form.getByLabel('secs').fill('0');
  await form.getByLabel('city').fill('York');
  await form.getByRole('button', { name: 'Start run' }).click();
  await expect(form).toBeHidden();

  const strip = page.getByTestId('editor-status-strip');
  await expect(strip).toContainText('Run started from v1.');
  const open = strip.getByRole('link', { name: 'Open run' });
  const href = await open.getAttribute('href');
  const runId = decodeURIComponent((href ?? '').split('/').pop() ?? '');
  expect(runId).not.toBe('');

  await open.click();
  await expect(page).toHaveURL(new RegExp(`/monitor/runs/${runId}$`));
  await expect(page.locator(headerStatus)).toHaveText('success', { timeout: 20_000 });

  // The run is the saved version, with the typed params, and came from no trigger.
  const res = await page.request.get(`/api/runs/${encodeURIComponent(runId)}`);
  expect(await res.json()).toMatchObject({
    triggerId: null,
    params: { city: 'York', secs: 0 },
  });
  expect(triggerCalls).toEqual([]);

  await expectQuiet(page, problems);
});

test('#1395 — Run is refused, with the reason, before the pipeline has a saved version', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const created = await page.request.post('/api/pipelines', { data: { name: 'or4 unsaved' } });
  const { id } = (await created.json()) as { id: string };
  await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);

  const run = await triggerMenuItem(page, /^Trigger now/);
  await expect(run).toBeDisabled();
  await expect(run).toContainText('Save a version first: Run starts the latest saved version.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  await expectQuiet(page, problems);
});

test('#1395 — the run started in the editor plays out on the authoring canvas, and a node’s output shows in the dock', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const triggerCalls: string[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'GET' && req.url().includes('/api/triggers')) triggerCalls.push(req.url());
  });

  await openSeededCanvas(page, 'or4 live overlay', {
    params: [
      // Long enough that the wait is SEEN live before it settles.
      { name: 'secs', type: 'number', required: false, default: 3 },
      { name: 'nums', type: 'json', required: false, default: [1, 2, 3] },
    ],
    nodes: [
      { id: 'hold', type: 'wait', config: { seconds: '${params.secs}' }, position: { x: 0, y: 0 } },
      {
        id: 'pick',
        type: 'filter',
        config: { items: '${params.nums}', predicate: '${greater(item, 1)}' },
        position: { x: 260, y: 0 },
      },
    ],
    edges: [{ id: 'e1', from: 'hold', to: 'pick', on: 'success' }],
  });
  const editorUrl = page.url();

  const holdStatus = nodeById(page, 'hold').getByTestId('node-run-status');
  const pickStatus = nodeById(page, 'pick').getByTestId('node-run-status');
  // No run, no overlay.
  await expect(holdStatus).toHaveCount(0);

  const canvas = page.locator('.react-flow');
  const canvasBefore = await canvas.boundingBox();
  const holdBefore = await nodeById(page, 'hold').boundingBox();

  await (await triggerMenuItem(page, /^Trigger now/)).click();
  await page
    .getByRole('dialog', { name: 'Run v1' })
    .getByRole('button', { name: 'Start run' })
    .click();

  // Live first — the wait is parked on its timer, and the filter has not run —
  // then settled, on the cards of the canvas being edited.
  await expect(holdStatus).toContainText('waiting', { timeout: 10_000 });
  // The filter's chip is THERE, saying it has not run — not merely absent.
  await expect(pickStatus).toHaveCount(1);
  await expect(pickStatus).not.toContainText('success');
  await expect(holdStatus).toContainText('success', { timeout: 20_000 });
  await expect(pickStatus).toContainText('success', { timeout: 20_000 });
  await expect(nodeById(page, 'pick').locator('.flow-node')).toHaveAttribute(
    'data-run-status',
    'success',
  );

  // The overlay is drawn OUTSIDE the boxes: nothing on the canvas moved (#1393).
  expect(await canvas.boundingBox()).toEqual(canvasBefore);
  expect(await nodeById(page, 'hold').boundingBox()).toEqual(holdBefore);
  const chip = await holdStatus.boundingBox();
  expect(chip!.y).toBeGreaterThanOrEqual(holdBefore!.y + holdBefore!.height);

  // Selecting a node shows its part in the run in the dock: its outputs included.
  await nodeById(page, 'pick').click();
  const drawer = page.getByRole('complementary', { name: 'Node Filter 1' });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('success');
  await expect(drawer.getByRole('heading', { name: 'Outputs' })).toBeVisible();
  await expect(drawer).toContainText('result');
  await expect(page.getByRole('link', { name: 'Open full run' })).toBeVisible();

  // All of it without leaving the editor, and without a trigger.
  expect(page.url()).toBe(editorUrl);
  expect(triggerCalls).toEqual([]);

  await expectQuiet(page, problems);
});

test('#1395 — Debug runs the UNSAVED draft on the canvas, as a hidden debug version the versions never list', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const triggerCalls: string[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'GET' && req.url().includes('/api/triggers')) triggerCalls.push(req.url());
  });

  const id = await openSeededCanvas(page, 'or4 debug draft', {
    nodes: [{ id: 'hold', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 0 } }],
  });
  const editorUrl = page.url();

  // An edit that is NOT saved: the run below must carry it.
  await page.getByRole('tab', { name: 'General' }).click();
  await page.getByLabel('pipeline description').fill('only in the draft');

  const debug = page.getByRole('button', { name: 'Debug', exact: true });
  await expect(debug).toHaveAttribute(
    'title',
    'Run what is on the canvas now, without saving it as a version.',
  );
  const canvas = page.locator('.react-flow');
  const before = await canvas.boundingBox();
  await debug.click();
  const form = page.getByRole('dialog', { name: 'Debug the draft' });
  await expect(form).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(before);
  await form.getByRole('button', { name: 'Start run' }).click();
  await expect(form).toBeHidden();

  const strip = page.getByTestId('editor-status-strip');
  await expect(strip).toContainText('Debug run started from the unsaved draft');
  await expect(strip).toContainText('kept for 7 days');
  await expect(nodeById(page, 'hold').getByTestId('node-run-status')).toContainText('success', {
    timeout: 20_000,
  });

  const href = await strip.getByRole('link', { name: 'Open run' }).getAttribute('href');
  const runId = decodeURIComponent((href ?? '').split('/').pop() ?? '');
  const detail = (await (
    await page.request.get(`/api/runs/${encodeURIComponent(runId)}/detail`)
  ).json()) as {
    debug: boolean;
    run: { triggerId: string | null };
    pipelineVersion: { description: string; version: number };
  };
  expect(detail).toMatchObject({
    debug: true,
    run: { triggerId: null },
    pipelineVersion: { description: 'only in the draft', version: 1 },
  });

  // The versions are exactly as they were: v1, and nothing a trigger could bind.
  const versions = (await (
    await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`)
  ).json()) as { version: number; description: string }[];
  expect(versions.map((v) => [v.version, v.description])).toEqual([[1, '']]);

  expect(page.url()).toBe(editorUrl);
  expect(triggerCalls).toEqual([]);

  // The runs list says it was a debug run, not v1. Debug saved nothing, so the
  // draft is still unsaved and leaving asks first (#1396). Through the app's own
  // link: a typed URL is a navigation the router cannot hold.
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Monitor' })
    .click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page.waitForURL(/#\/monitor\/runs$/);
  await expect(
    page.getByRole('row').filter({ hasText: 'or4 debug draft' }).locator('.run-version'),
  ).toHaveText('debug 1');

  await expectQuiet(page, problems);
});
