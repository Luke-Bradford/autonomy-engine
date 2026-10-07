import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { fireAndSettle, seedVersion, type SeedDoc } from './support/seedDoc';

/**
 * #1569 OR37 slice 1 — the pipelines list as an engineer's grid: last run,
 * success rate, next run and triggers from one batched read
 * (`GET /api/pipelines/summaries`), sortable with the order in the URL, dense
 * at 1440×900, and with no Version column and no prose intro.
 *
 * Self-seeded rather than riding the demo pack: the suite shares one database,
 * and the demo spec removes its pack in `afterAll`.
 */

/** `wait ${0}` settles immediately — the cheapest SUCCEEDED run (`fireAndSettle`). */
const OK: SeedDoc = {
  nodes: [{ id: 'w', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 0 } }],
};
const BROKEN: SeedDoc = {
  nodes: [{ id: 'f', type: 'fail', config: { message: 'planned' }, position: { x: 0, y: 0 } }],
};

async function createScheduleTrigger(page: Page, pipelineVersionId: string): Promise<void> {
  const res = await page.request.post('/api/triggers', {
    data: {
      name: 'e2e 1569 hourly',
      pipelineVersionId,
      params: {},
      mode: 'schedule',
      schedule: '17 * * * *',
      webhook: null,
      concurrency: { policy: 'skip_if_running' },
      runWindows: null,
      enabled: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
}

test('#1569 — the pipelines grid: last run, success %, next run, triggers; sorted in the URL; dense at 1440×900', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const problems = collectPageProblems(page);
  const tag = `e2e 1569 ${String(Date.now())}`;
  const okName = `${tag} ok`;
  const brokenName = `${tag} broken`;

  const ok = await seedVersion(page, okName, OK);
  const broken = await seedVersion(page, brokenName, BROKEN);
  const okRun = await fireAndSettle(page, ok.pipelineVersionId, 'e2e 1569 manual');
  await fireAndSettle(page, broken.pipelineVersionId, 'e2e 1569 manual');
  await createScheduleTrigger(page, ok.pipelineVersionId);
  // Enough rows that the density target is measurable whatever ran before.
  for (let i = 0; i < 20; i++) {
    const res = await page.request.post('/api/pipelines', {
      data: { name: `${tag} filler ${String(i).padStart(2, '0')}` },
    });
    expect(res.status()).toBe(201);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  const summariesRead = page.waitForResponse((r) => r.url().endsWith('/api/pipelines/summaries'));
  await page.goto('/#/author/pipelines');
  await fluentRootReady(page);
  await summariesRead;

  const row = (name: string) =>
    page.getByRole('row').filter({ has: page.getByRole('link', { name: `Open ${name}` }) });

  // The succeeded pipeline: its run, 100%, both triggers active, the :17 tick.
  const okRow = row(okName);
  const lastRun = okRow.getByRole('link', { name: /success/ });
  await expect(lastRun).toHaveAttribute('href', `#/monitor/runs/${okRun}`);
  await expect(okRow.getByRole('cell').nth(2)).toHaveText('100%');
  await expect(okRow.getByText('2 active / 2')).toBeVisible();
  // Asserted on the machine-readable instant, so the display zone cannot matter.
  await expect(okRow.getByRole('cell').nth(3).locator('time')).toHaveAttribute(
    'datetime',
    /:17:00\.000Z$/,
  );

  // The broken one: its last run is a failure and its rate 0%.
  const brokenRow = row(brokenName);
  await expect(brokenRow.getByRole('link', { name: /failure/ })).toBeVisible();
  await expect(brokenRow.getByRole('cell').nth(2)).toHaveText('0%');
  await expect(brokenRow.getByText('1 active / 1')).toBeVisible();

  // No Version column, no prose intro.
  // The sort arrow (▲▼) is part of a sorted header's text; drop it.
  const headers = (await page.getByRole('columnheader').allTextContents()).map((h) =>
    h.replace(/[▲▼]/g, '').trim(),
  );
  expect(headers.slice(0, 7)).toEqual([
    'Name',
    'Last run',
    'Success % (7d)',
    'Next run',
    'Triggers',
    'Live state',
    'Modified',
  ]);
  expect(headers.some((h) => /version/i.test(h))).toBe(false);
  // No prose between the heading and the grid. (The import and demo panels
  // below it keep their hints until a later slice moves them into drawers.)
  const proseAbove = await page.evaluate(() => {
    const grid = document.querySelector('.pipelines-grid');
    return [...document.querySelectorAll('.pipelines-page .page-hint')].filter(
      (h) => grid !== null && h.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).length;
  });
  expect(proseAbove).toBe(0);

  // Density at 1440×900: 32px rows, the first data row high on the page, and
  // at least 20 rows inside the viewport.
  const measured = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.pipelines-grid tbody tr')];
    const rects = rows.map((r) => r.getBoundingClientRect());
    return {
      firstTop: Math.round(rects[0]?.top ?? -1),
      rowHeight: Math.round(rects[0]?.height ?? -1),
      inViewport: rects.filter((r) => r.bottom <= window.innerHeight).length,
      fontSize: getComputedStyle(rows[0]?.querySelector('td') ?? document.body).fontSize,
    };
  });
  expect(measured.firstTop).toBeGreaterThan(0);
  expect(measured.firstTop).toBeLessThanOrEqual(200);
  expect(measured.rowHeight).toBe(32);
  expect(measured.fontSize).toBe('13px');
  expect(measured.inViewport).toBeGreaterThanOrEqual(20);

  // Sort by Last run: newest first, so the broken pipeline (run second) sits
  // directly above the ok one, and every never-run filler after both.
  await page.getByRole('button', { name: /Last run/ }).click();
  await expect(page).toHaveURL(/[?&]sort=lastRun(&|$)/);
  const order = async () =>
    (await page.locator('.pipelines-grid tbody tr td:first-child a').allTextContents()).filter(
      (n) => n.startsWith(tag),
    );
  const sortedOrder = [brokenName, okName];
  await expect.poll(async () => (await order()).slice(0, 2)).toEqual(sortedOrder);

  // …and the order survives a reload, through the URL.
  await page.reload();
  await fluentRootReady(page);
  await expect(page.getByRole('columnheader', { name: /Last run/ })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  await expect.poll(async () => (await order()).slice(0, 2)).toEqual(sortedOrder);

  // The last run's link lands on that run.
  await row(okName)
    .getByRole('link', { name: /success/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`#/monitor/runs/${okRun}$`));

  await expectQuiet(page, problems);
});
