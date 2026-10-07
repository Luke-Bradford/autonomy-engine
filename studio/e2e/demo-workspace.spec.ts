import { expect, test, type Page } from '@playwright/test';
import { answerConfirm } from './support/confirmDialog';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { fireTrigger, waitForRunToSettle } from './support/seedDoc';

/**
 * #1481 OR32 — the demo ETL pack, IN MOTION: loaded from the pipelines list,
 * every pipeline run through its own manual trigger, the story's counts read
 * off the run log (92 staged → 66 clean, 20 rejected, 6 countries), pipeline 5
 * failing on its missing file, the runs listed in Monitor, then removed again.
 * It keeps "the demo works" true on every PR.
 *
 * The suite is single-worker over one shared database, so the demo is removed
 * in `afterAll` too — a failure midway must not leave five pipelines, their
 * runs and two connections behind for the specs that follow.
 */

const NAMES = [
  'Demo — 1 Load one CSV to staging',
  'Demo — 2 Ingest landing folder',
  'Demo — 3 Clean and aggregate',
  'Demo — 4 Nightly orchestrator',
  'Demo — 5 Broken on purpose',
];

interface Seeded {
  pipelines: { key: string; triggerId: string }[];
}

interface LoggedEvent {
  payload: { type?: string; nodeId?: string; outputs?: { rowsWritten?: unknown } };
}

/**
 * Fires the demo's OWN manual trigger, not `fireAndSettle`'s: that one mints a
 * second trigger bound to the demo version, and Remove rightly refuses while a
 * trigger that is not the demo's runs a demo pipeline.
 */
async function runDemo(page: Page, seeded: Seeded, key: string): Promise<string> {
  const triggerId = seeded.pipelines.find((p) => p.key === key)?.triggerId ?? '';
  const runId = await fireTrigger(page, triggerId);
  // The orchestrator waits on two child pipelines; give it room.
  await waitForRunToSettle(page, runId, 60_000);
  return runId;
}

async function statusOf(page: Page, runId: string): Promise<string> {
  return ((await (await page.request.get(`/api/runs/${runId}`)).json()) as { status: string })
    .status;
}

async function eventsOf(page: Page, runId: string): Promise<LoggedEvent[]> {
  return (await (await page.request.get(`/api/runs/${runId}/events`)).json()) as LoggedEvent[];
}

const rowFor = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });

/**
 * #1566 — Demo 3's own run page, which is the ADF view the operator asked to
 * land on: its three copies write 66 / 6 / 20 rows, and an activity's row opens
 * that attempt's drawer with its Output.
 */
async function expectDemo3RunPage(page: Page, runId: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`#/monitor/runs/${runId}$`));
  const table = page.locator('.activity-runs__table');
  await expect(table.getByRole('columnheader', { name: /Rows written/ })).toBeVisible();
  const headers = (await table.getByRole('columnheader').allTextContents()).map((h) => h.trim());
  const rowsWrittenAt = headers.findIndex((h) => h.startsWith('Rows written'));
  expect(rowsWrittenAt).toBeGreaterThan(0);
  const row = (id: string) => table.locator(`tbody tr[data-activity-id="${id}"]`);
  for (const [id, rows] of [
    ['clean', '66'],
    ['aggregate', '6'],
    ['rejects', '20'],
  ] as const) {
    await expect(row(id).getByRole('cell').nth(rowsWrittenAt)).toHaveText(rows);
  }
  await row('clean').locator('button.activity-runs__open').click();
  const drawer = page.locator('#run-detail-drawer');
  await drawer.getByRole('tab', { name: 'Output' }).click();
  await expect(drawer.getByRole('tab', { name: 'Output' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(drawer).toContainText('66');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
}

test.describe('#1481 the demo workspace', () => {
  test.afterAll(async ({ request }) => {
    // Asserted, not fire-and-forget: a refused clean-up would leave the demo
    // behind for every spec after this one.
    const res = await request.delete('/api/demo');
    expect(res.status(), `removing the demo: ${await res.text()}`).toBe(200);
  });

  test('loads from the pipelines list, runs end to end, shows in Monitor, and removes', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const problems = collectPageProblems(page);

    await page.goto('/#/author/pipelines');
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
    await fluentRootReady(page);

    await page.getByRole('button', { name: 'Load demo' }).click();
    for (const name of NAMES) await expect(rowFor(page, name)).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Remove demo' })).toBeVisible();

    // A second load is idempotent and names every trigger the first one made.
    const again = await page.request.post('/api/demo/seed');
    expect(again.status()).toBe(200);
    const seeded = (await again.json()) as Seeded;

    const runIds: Record<string, string> = {};
    for (const key of ['1', '2', '3', '4']) {
      const runId = await runDemo(page, seeded, key);
      runIds[key] = runId;
      expect(await statusOf(page, runId), `demo pipeline ${key}`).toBe('success');
      if (key === '3') {
        const written = Object.fromEntries(
          (await eventsOf(page, runId))
            .filter((e) => e.payload.type === 'node.succeeded')
            .map((e) => [e.payload.nodeId, e.payload.outputs?.rowsWritten]),
        );
        expect(written).toMatchObject({ clean: 66, aggregate: 6, rejects: 20 });
      }
    }
    const broken = await runDemo(page, seeded, '5');
    expect(await statusOf(page, broken)).toBe('failure');
    const failed = (await eventsOf(page, broken)).filter((e) => e.payload.type === 'node.failed');
    expect(JSON.stringify(failed)).toContain('orders_2026-13.csv');

    await page.goto('/#/monitor/runs');
    for (const name of NAMES.slice(2)) {
      await expect(page.getByRole('row').filter({ hasText: name }).first()).toBeVisible();
    }

    // #1484 OR35 M1 — the Activities and Rows-written columns, from the server's
    // fold of each run. Demo 3: the If takes `true`, so `mark_clean` is the one
    // skipped activity, and its three copies write 66 + 6 + 20. Demo 2: a
    // sequential ForEach over two files, whose 49 + 43 rows are summed across
    // items. Demo 5: one failed copy, which reports no rows written.
    // At the issue's 1440×900 target, not the suite's wider default.
    await page.setViewportSize({ width: 1440, height: 900 });
    const headers = await page.getByRole('columnheader').allTextContents();
    const cell = (runId: string, header: string) =>
      page
        .getByRole('row')
        .filter({ hasText: runId })
        .getByRole('cell')
        .nth(headers.indexOf(header));
    expect(headers).toEqual(expect.arrayContaining(['Activities', 'Rows written']));
    await expect(cell(runIds['3']!, 'Activities')).toContainText('7 ✓ · 1 skipped');
    await expect(cell(runIds['3']!, 'Activities')).toHaveAttribute(
      'title',
      '7 succeeded, 1 skipped',
    );
    await expect(cell(runIds['3']!, 'Rows written')).toHaveText('92');
    // Drawn whole at 1440px, not cut to an ellipsis that would hide a count.
    expect(
      await cell(runIds['3']!, 'Activities').evaluate((td) => td.scrollWidth <= td.clientWidth),
    ).toBe(true);
    await expect(cell(runIds['2']!, 'Activities')).toContainText('5 ✓');
    await expect(cell(runIds['2']!, 'Rows written')).toHaveText('92');
    await expect(cell(broken, 'Activities')).toContainText('0 ✓ · 1 ✗');
    await expect(cell(broken, 'Rows written')).toHaveText('—');

    /* #1566 — every primary click in the Monitor lands on the RUN, as in ADF.
       The editor is only the labelled icon beside the name, at the version
       that ran. From the runs grid: */
    const demo3 = NAMES[2]!;
    const run3 = runIds['3']!;
    const row3 = page.getByRole('row').filter({ hasText: run3 });
    await expect(
      row3.getByRole('link', { name: new RegExp(`^Open ${demo3} v\\d+ in the editor$`) }),
    ).toHaveAttribute('href', /\?version=\d+$/);
    await row3.getByRole('link', { name: new RegExp(`^${demo3} v\\d+$`) }).click();
    await expectDemo3RunPage(page, run3);

    // From the run's trigger: its header links to that trigger's runs.
    await page.locator('.run-header a[href*="/monitor/runs?trigger="]').click();
    await expect(page).toHaveURL(/#\/monitor\/runs\?trigger=/);
    await page
      .getByRole('row')
      .filter({ hasText: run3 })
      .getByRole('link', { name: new RegExp(`^${demo3} v\\d+$`) })
      .click();
    await expectDemo3RunPage(page, run3);

    // From Home's recent runs.
    await page.goto('/#/');
    await page.locator(`.recent-runs a[href$="/monitor/runs/${run3}"]`).click();
    await expectDemo3RunPage(page, run3);

    await page.goto('/#/author/pipelines');
    await page.getByRole('button', { name: 'Remove demo' }).click();
    expect(await answerConfirm(page, 'accept')).toContain('all of their runs');
    await expect(page.getByRole('button', { name: 'Load demo' })).toBeVisible();
    for (const name of NAMES) await expect(rowFor(page, name)).toHaveCount(0);
    const status = await page.request.get('/api/demo');
    expect(await status.json()).toEqual({ loaded: false });

    await expectQuiet(page, problems);
  });
});
