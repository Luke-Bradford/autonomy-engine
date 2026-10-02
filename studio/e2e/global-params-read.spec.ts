import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { answerConfirm } from './support/confirmDialog';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, openSeededCanvas, seedVersion, type SeedDoc } from './support/seedDoc';
import { fluentRootReady } from './support/theme';
import { chooseRowAction } from './support/rowMenu';

/**
 * #844 GL3 (global-params spec GL-D2/D3/D4/D8) — a pipeline reads a workspace
 * global as `${global.<name>}`, end to end.
 *
 * Egress-free: a Set variable node writes the global's value into a variable,
 * and the run page's Variables section shows it, so a real run settles with
 * nothing but the doc. The server and web unit suites pin the gate, the start
 * check and the validator; what only a browser shows is that the three meet: a
 * run logs the value it read and keeps it after an edit, the canvas re-reads
 * the globals when the window regains focus, and the Manage page's delete
 * confirmation names the pipeline that reads one.
 *
 * The suite shares ONE SQLite file per RUN, so every name here is unique to
 * this spec, and its globals are cleared through the API before each test.
 */
const ENV = 'e2e_844_gl3_env';
const GONE = 'e2e_844_gl3_gone';
const USED = 'e2e_844_gl3_used';

test.beforeEach(async ({ request }) => {
  const res = await request.get('/api/global-params?limit=100');
  expect(res.ok()).toBe(true);
  const { items } = (await res.json()) as { items: { id: string; name: string }[] };
  const mine = new Set([ENV, GONE, USED].map((n) => n.toLowerCase()));
  for (const g of items.filter((i) => mine.has(i.name.toLowerCase()))) {
    expect((await request.delete(`/api/global-params/${g.id}`)).ok()).toBe(true);
  }
});

async function createGlobal(request: APIRequestContext, name: string, value: string) {
  const res = await request.post('/api/global-params', {
    data: { name, type: 'string', value },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string };
}

/** A pipeline whose one node copies `${global.<name>}` into the variable `label`. */
function readerDoc(name: string): SeedDoc {
  return {
    nodes: [
      {
        id: 's',
        type: 'set_variable',
        config: { variable: 'label', value: `\${global.${name}}` },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
    variables: [{ name: 'label', type: 'string', default: '' }],
  };
}

async function variableRows(page: Page): Promise<string[][]> {
  const section = page.getByRole('region', { name: 'Variables' });
  await expect(section.getByText('Final values.')).toBeVisible();
  return section
    .locator('tbody tr')
    .evaluateAll((trs) =>
      trs.map((tr) => [...tr.querySelectorAll('th, td')].map((c) => c.textContent ?? '')),
    );
}

test('#844 GL3/GL5 — a run reads a global, logs the value, and shows it after an edit', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const g = await createGlobal(page.request, ENV, 'prod');

  const { pipelineVersionId } = await seedVersion(page, '#844 GL3 reader', readerDoc(ENV));
  const runId = await fireAndSettle(page, pipelineVersionId, '#844 GL3 run');

  /* The premise: the run succeeded and its start logged exactly the read. */
  const run = (await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
    status: string;
  };
  expect(run.status).toBe('success');
  const events = (await (
    await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
  ).json()) as { type: string; payload: { globals?: unknown } }[];
  expect(events.find((e) => e.type === 'run.started')?.payload.globals).toEqual({
    [ENV]: 'prod',
  });

  /* An edit after the start changes later runs, never this one. */
  const patched = await page.request.patch(`/api/global-params/${g.id}`, {
    data: { value: 'dev' },
  });
  expect(patched.ok()).toBe(true);

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  expect(await variableRows(page)).toEqual([['label', 'String', '"prod"']]);

  /* #844 GL5 — the run page's Global parameters section shows the SNAPSHOT,
     not the live store: the global now holds "dev". */
  const globals = page.getByRole('region', { name: 'Global parameters' });
  await expect(
    globals.getByText('A later edit to a global does not change them.', { exact: false }),
  ).toBeVisible();
  expect(
    await globals
      .locator('tbody tr')
      .evaluateAll((trs) =>
        trs.map((tr) => [...tr.querySelectorAll('th, td')].map((c) => c.textContent ?? '')),
      ),
  ).toEqual([[ENV, '"prod"']]);

  await expectQuiet(page, problems);
});

test('#844 GL3 — the canvas re-reads the globals when the window regains focus', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const g = await createGlobal(page.request, GONE, 'x');
  await openSeededCanvas(page, '#844 GL3 canvas', readerDoc(GONE));

  const save = page.getByRole('button', { name: 'Save version' });
  const refusal = page.getByText(/is not a global parameter of this workspace/).first();
  /* Known to the canvas: no badge for the read. */
  await expect(refusal).toHaveCount(0);
  await expect(save).toBeVisible();

  /* Deleted in another tab; the canvas learns of it when it regains focus. */
  expect((await page.request.delete(`/api/global-params/${g.id}`)).ok()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(refusal).toBeVisible();
  await expect(save).toBeDisabled();

  await expectQuiet(page, problems);
});

test('#844 GL3 — deleting a global names the pipeline that reads it', async ({ page }) => {
  const problems = collectPageProblems(page);
  await createGlobal(page.request, USED, 'v');
  const name = '#844 GL3 used by';
  await seedVersion(page, name, readerDoc(USED));

  await page.goto('/#/manage/global-params');
  await page.getByRole('heading', { name: 'Global parameters' }).waitFor();
  await fluentRootReady(page);

  await chooseRowAction(page, 'Delete', USED);
  const confirmText = await answerConfirm(page, 'cancel');
  expect(confirmText).toContain('Read by the latest version of:');
  expect(confirmText).toContain(`${name} (v1)`);
  /* Dismissed: the global is still there. */
  await expect(page.getByRole('cell', { name: USED, exact: true })).toBeVisible();

  await expectQuiet(page, problems);
});
