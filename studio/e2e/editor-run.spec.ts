import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';

/**
 * #1395 OR4 slice 1 — Run from the editor. The operator presses Run in the
 * pipeline's header, sets a param, and starts the latest saved version with NO
 * trigger: nothing is created or fired on the Triggers page, and the run that
 * lands carries `triggerId: null`.
 *
 * Slice 2 adds the live overlay: the run's node states on THIS canvas, and the
 * selected node's part in the run in the dock, without leaving the editor.
 */

/** The run page's header pill, scoped off the node table's own status words. */
const headerStatus = '.page-hint .run-status';

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

  const run = page.getByRole('button', { name: 'Run', exact: true });
  await expect(run).toHaveAttribute('title', 'Run v1, the latest saved version.');

  // Opening the form moves nothing on the page (#1393): it is drawn OVER the canvas.
  const canvas = page.locator('.react-flow');
  const before = await canvas.boundingBox();
  await run.click();
  const form = page.getByRole('dialog', { name: 'Run v1' });
  await expect(form).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(before);

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

  const run = page.getByRole('button', { name: 'Run', exact: true });
  await expect(run).toBeDisabled();
  await expect(run).toHaveAttribute(
    'title',
    'Save a version first: Run starts the latest saved version.',
  );

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
      { name: 'secs', type: 'number', required: false, default: 2 },
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

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Run v1' })
    .getByRole('button', { name: 'Start run' })
    .click();

  // Live first — the wait is parked on its timer, and the filter has not run —
  // then settled, on the cards of the canvas being edited.
  await expect(holdStatus).toContainText('waiting', { timeout: 10_000 });
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
