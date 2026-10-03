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

    for (const key of ['1', '2', '3', '4']) {
      const runId = await runDemo(page, seeded, key);
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
