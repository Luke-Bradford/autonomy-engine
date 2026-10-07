import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openRowMenu } from './support/authorPane';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { seedConnection, seedDataset } from './support/seedResources';
import { fluentRootReady } from './support/theme';

/**
 * #1392 (OR1) — the operator reads NAMES, not ids.
 *
 * Operator report: "the pipeline I created has a name but at the top I see its
 * guid style reference name". The breadcrumb, the tab title and the run page's
 * header all showed the raw id. Every case below asserts the name APPEARS first
 * (a retrying assertion, so the page has settled) and only then that the id
 * does NOT — asserting absence first would pass vacuously on a page still
 * loading.
 */

const trail = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });

async function expectNamed(page: Page, name: string, hub: string, id: string) {
  await expect(trail(page).getByRole('listitem').last()).toContainText(name);
  await expect(page).toHaveTitle(`${name} — ${hub} — autonomy studio`);
  await expect(trail(page)).not.toContainText(id);
  expect(await page.title()).not.toContain(id);
}

const DOC = {
  nodes: [{ id: 'hold', type: 'wait', config: { seconds: '${1}' }, position: { x: 0, y: 0 } }],
};

test('a pipeline is named in the breadcrumb and title, and a rename follows', async ({ page }) => {
  const problems = collectPageProblems(page);
  const name = `e2e or1 pipe ${Date.now()}`;
  const { pipelineId } = await seedVersion(page, name, DOC);

  await page.goto(`/#/author/pipelines/${pipelineId}`);
  await fluentRootReady(page);
  await expectNamed(page, name, 'Author', pipelineId);

  // Rename it from the Factory Resources pane, which stays mounted beside the
  // canvas: the crumb and title follow without a reload.
  const renamed = `${name} renamed`;
  await openRowMenu(page, name);
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByRole('textbox', { name: 'Pipeline name' }).fill(renamed);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expectNamed(page, renamed, 'Author', pipelineId);

  await expectQuiet(page, problems);
});

test('a run is named by its pipeline, with the run id short and copyable', async ({ page }) => {
  const problems = collectPageProblems(page);
  const name = `e2e or1 run pipe ${Date.now()}`;
  const trigger = `e2e or1 trigger ${Date.now()}`;
  const { pipelineId, pipelineVersionId } = await seedVersion(page, name, DOC);
  const runId = await fireAndSettle(page, pipelineVersionId, trigger);

  await page.goto(`/#/monitor/runs/${runId}`);
  await fluentRootReady(page);

  const short = runId.slice(-8);
  await expectNamed(page, `${name} · run ${short}`, 'Monitor', runId);
  await expect(page.locator('#run-heading')).toHaveText(`${name} v1`);

  // The header (#1484 M2) names by NAME, and holds the run id short with the
  // full one in its tooltip — never the pipeline-version or trigger ids.
  // #1566 — the name is plain text on the run's own page; the editor is the
  // labelled icon, at the version this run is bound to.
  const meta = page.locator('.run-header');
  await expect(meta.getByRole('link', { name, exact: true })).toHaveCount(0);
  await expect(meta.getByRole('link', { name: 'Open v1 in the editor' })).toHaveAttribute(
    'href',
    `#/author/pipelines/${pipelineId}?version=1`,
  );
  await expect(meta.getByRole('link', { name: trigger })).toBeVisible();
  await expect(meta.getByText(short, { exact: true })).toHaveAttribute('title', runId);
  await expect(meta).not.toContainText(pipelineVersionId);
  await expect(meta.getByRole('button', { name: 'Copy run id' })).toBeVisible();

  await expectQuiet(page, problems);
});

test('a dataset is named in the breadcrumb and title', async ({ page }) => {
  const problems = collectPageProblems(page);
  const stamp = Date.now();
  const store = await seedConnection(page, {
    name: `e2e-or1-store-${stamp}`,
    kind: 'sqlite',
    config: { path: `or1-${stamp}.db` },
  });
  const name = `e2e-or1-dataset-${stamp}`;
  const datasetId = await seedDataset(page, {
    name,
    kind: 'table',
    connectionId: store,
    config: { table: 'people' },
    columns: [{ name: 'id', type: 'integer', nullable: false }],
  });

  await page.goto(`/#/manage/datasets/${datasetId}`);
  await fluentRootReady(page);
  await expectNamed(page, name, 'Manage', datasetId);

  await expectQuiet(page, problems);
});

test('an unknown path says so instead of showing Home', async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto('/#/no/such/route');
  await fluentRootReady(page);

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('/no/such/route');
  await expect(page).toHaveTitle('Not found — autonomy studio');
  expect(new URL(page.url()).hash).toBe('#/no/such/route');

  await page.getByRole('link', { name: 'Go to Home' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

  await expectQuiet(page, problems);
});
