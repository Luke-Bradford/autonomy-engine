import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openSeededCanvas } from './support/seedDoc';

/**
 * #1395 OR4 slice 1 — Run from the editor. The operator presses Run in the
 * pipeline's header, sets a param, and starts the latest saved version with NO
 * trigger: nothing is created or fired on the Triggers page, and the run that
 * lands carries `triggerId: null`.
 *
 * Slice 2 (the live overlay on this canvas) extends this spec; until then the
 * run's outcome is read on the run page the notice links to.
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
