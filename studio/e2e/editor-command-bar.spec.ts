import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { triggerMenuItem } from './support/canvas';
import { dragNodeBy } from './support/canvasGraph';
import { openSeededCanvas, seedVersion, type SeedDoc } from './support/seedDoc';

/**
 * #1476 OR28 slice 2 — the editor's command bar: Validate, and Trigger ▾ →
 * View triggers. (Trigger now is `editor-run.spec.ts`, which it always was.)
 */

const DOC: SeedDoc = {
  nodes: [{ id: 'hold', type: 'wait', config: { seconds: '${1}' }, position: { x: 0, y: 0 } }],
};

/** The status strip's transient notice, where Validate reports. */
function notice(page: Page) {
  return page.getByTestId('editor-status-strip');
}

function problemsList(page: Page) {
  return page.getByRole('complementary', { name: 'Problems' });
}

test('Validate runs the save check, opens Problems and says what it found', async ({ page }) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, `e2e 1476 validate ${String(Date.now())}`, DOC);

  // Folded first, so opening it is Validate's doing.
  await page.getByRole('button', { name: 'Hide properties' }).click();
  await expect(problemsList(page)).toBeHidden();

  const checked = page.waitForResponse(
    (r) => r.url().endsWith('/validate') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  expect((await checked).status()).toBe(200);
  await expect(notice(page)).toContainText('Validation: no problems found.');
  await expect(problemsList(page)).toBeVisible();
  await expect(problemsList(page)).toContainText('No problems.');

  await expectQuiet(page, problems);
});

test('what only the server can see is listed in Problems, refuses Save, and goes with the next edit', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, `e2e 1476 server issue ${String(Date.now())}`, DOC);

  // The editor cannot author a call to a debug version (its picker never
  // offers one), so the server's answer is stood in for here. The route
  // itself is covered by `pipelines-validate.test.ts`.
  const issue =
    "a call_pipeline node cannot call debug version 'pv_gone': debug versions are deleted after a while — call a saved version";
  await page.route('**/api/pipelines/*/validate', (route) =>
    route.fulfill({ json: { issues: [issue], totalIssues: 1 } }),
  );

  // A move makes the draft savable, so the refusal below is Validate's.
  await dragNodeBy(page, 0, 0, 60);
  const save = page.getByRole('button', { name: 'Save version' });
  await expect(save).toBeEnabled();

  await page.getByRole('button', { name: 'Validate', exact: true }).click();
  await expect(notice(page)).toContainText('Validation: 1 problem — see Problems.');
  await expect(problemsList(page)).toContainText(issue);
  await expect(page.getByRole('button', { name: /^Problems/ })).toContainText('1');
  await expect(save).toBeDisabled();

  // The finding was about THAT draft: any edit retires it.
  await dragNodeBy(page, 0, 0, 60);
  await expect(problemsList(page)).not.toContainText(issue);
  await expect(problemsList(page)).toContainText('No problems.');
  await expect(save).toBeEnabled();

  await expectQuiet(page, problems);
});

test('Trigger ▾ → View triggers lists this pipeline’s triggers, and Show all lists every one', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const stamp = String(Date.now());
  const other = await seedVersion(page, `e2e 1476 other ${stamp}`, DOC);
  const mine = `e2e 1476 mine ${stamp}`;
  const { pipelineId, pipelineVersionId } = await seedVersion(page, mine, DOC);
  for (const [name, versionId] of [
    [`mine-${stamp}`, pipelineVersionId],
    [`theirs-${stamp}`, other.pipelineVersionId],
  ] as const) {
    const created = await page.request.post('/api/triggers', {
      data: {
        name,
        pipelineVersionId: versionId,
        params: {},
        mode: 'manual',
        schedule: null,
        webhook: null,
        concurrency: { policy: 'skip_if_running' },
        runWindows: null,
        enabled: false,
      },
    });
    expect(created.status()).toBe(201);
  }
  await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);

  await (await triggerMenuItem(page, /^View triggers/)).click();
  await expect(page).toHaveURL(
    new RegExp(`#/manage/triggers\\?pipeline=${encodeURIComponent(pipelineId)}$`),
  );
  await expect(page.getByTestId('trigger-pipeline-filter')).toContainText(
    `Showing the triggers of ${mine}.`,
  );
  await expect(page.getByRole('row', { name: new RegExp(`mine-${stamp}`) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`theirs-${stamp}`) })).toHaveCount(0);

  await page.getByRole('link', { name: 'Show all triggers' }).click();
  await expect(page).toHaveURL(/#\/manage\/triggers$/);
  await expect(page.getByRole('row', { name: new RegExp(`theirs-${stamp}`) })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`mine-${stamp}`) })).toBeVisible();

  await expectQuiet(page, problems);
});

test('Trigger ▾ → New trigger… creates and edits this pipeline’s triggers without leaving the editor', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const stamp = String(Date.now());
  const { pipelineId, pipelineVersionId } = await seedVersion(page, `e2e 1476 s3 ${stamp}`, DOC);
  await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
  const editorUrl = page.url();
  const canvas = page.locator('.react-flow').first();
  await expect(canvas).toBeVisible();
  const canvasTop = (await canvas.boundingBox())!.y;

  const newItem = await triggerMenuItem(page, /^New trigger…/);
  // DB-only workspace: bind-to-active resolves to the latest saved version.
  await expect(newItem).toContainText('Fires the latest saved version (v1 now).');
  await newItem.click();
  const column = page.getByTestId('pipeline-triggers');
  const form = column.getByRole('form', { name: 'Trigger form' });
  await expect(form).toBeVisible();
  // The form has the keyboard once it opens, and its Save is in view without
  // scrolling: the column scrolls, the footer sticks to it.
  await expect(form.getByLabel('Name')).toBeFocused();
  await expect(form.getByRole('button', { name: 'Create trigger' })).toBeInViewport();
  // A column beside the canvas: it takes width, never the canvas's top (#1393).
  expect((await canvas.boundingBox())!.y).toBe(canvasTop);

  const name = `made-in-editor-${stamp}`;
  await form.getByLabel('Name').fill(name);
  await form.getByRole('button', { name: 'Create trigger' }).click();
  await expect(form).toBeHidden();
  const row = column.getByRole('listitem').filter({ hasText: name });
  await expect(row).toContainText('v1 · disabled');
  expect(page.url()).toBe(editorUrl);
  const stored = (await (await page.request.get('/api/triggers')).json()) as {
    name: string;
    pipelineVersionId: string | null;
  }[];
  expect(stored.find((t) => t.name === name)?.pipelineVersionId).toBe(pipelineVersionId);

  // Edit, in the same column.
  await row.getByRole('button', { name: `Edit: ${name}` }).click();
  await form.getByLabel('Name').fill(`${name}-renamed`);
  await form.getByRole('button', { name: 'Save changes' }).click();
  await expect(column.getByRole('listitem').filter({ hasText: `${name}-renamed` })).toBeVisible();
  // Focus went back to the Edit button that opened the form.
  await expect(column.getByRole('button', { name: `Edit: ${name}-renamed` })).toBeFocused();

  // An unsaved trigger form holds leaving the editor at the editor's ONE prompt.
  await column.getByRole('button', { name: 'New trigger' }).click();
  await form.getByLabel('Name').fill('unsaved');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  const prompts = page.getByRole('alertdialog');
  await expect(prompts).toHaveCount(1);
  await prompts.getByRole('button', { name: 'Keep editing' }).click();
  expect(page.url()).toBe(editorUrl);
  await expect(form.getByLabel('Name')).toHaveValue('unsaved');

  await expectQuiet(page, problems);
});
