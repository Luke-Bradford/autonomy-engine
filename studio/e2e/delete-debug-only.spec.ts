import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { chooseRowAction, rowMenuButton } from './support/rowMenu';

/**
 * #1433 — a pipeline whose only runs are Debug runs cannot be deleted until the
 * debug window clears them, and the refusal says THAT, with the window the
 * server reports, rather than the run-history "archive it" a saved run gets.
 * End to end: the dependents read's `debugRunsOnly` + `debugRetentionDays` are
 * what the list's refusal is built from.
 */
const NAME = 'e2e 1433 debug only';

test('#1433 — deleting a pipeline with only Debug runs names them and their window', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const created = await page.request.post('/api/pipelines', { data: { name: NAME } });
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  const debug = await page.request.post(`/api/pipelines/${encodeURIComponent(id)}/debug-runs`, {
    data: {
      version: {
        params: [],
        outputs: [],
        nodes: [{ id: 'a', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 0 } }],
        edges: [],
      },
    },
  });
  expect(debug.status(), `debug run: ${await debug.text()}`).toBe(202);
  expect(((await debug.json()) as { outcome: string }).outcome).toBe('started');

  await page.goto('/#/author/pipelines');
  await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
  await fluentRootReady(page);
  await expect(rowMenuButton(page, NAME)).toBeVisible();

  await chooseRowAction(page, 'Delete', NAME);
  const alert = page.getByRole('alert').filter({ hasText: NAME });
  await expect(alert).toContainText(
    `Cannot delete “${NAME}”: its only runs are Debug runs, kept for 7 days after each Debug starts`,
  );
  await expect(alert).not.toContainText('it has run history');
  // Refused up front: no question was asked, and the pipeline is still listed.
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(rowMenuButton(page, NAME)).toBeVisible();

  await expectQuiet(page, problems);
});
