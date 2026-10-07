import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { fireAndSettle, seedVersion, type SeedDoc } from './support/seedDoc';
import { newPipelineButton, openImportDrawer } from './support/pipelinesPage';

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
  // No prose anywhere on the page: since #1569 slice 3 the create card and the
  // import and demo panels are drawers, opened from the toolbar.
  expect(await page.locator('.pipelines-page .page-hint').count()).toBe(0);

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
      // #1569 slice 2 — the filter bar is ONE row (two would be ~56px).
      barHeight: Math.round(
        document.querySelector('.pipelines-filters')?.getBoundingClientRect().height ?? -1,
      ),
    };
  });
  expect(measured.firstTop).toBeGreaterThan(0);
  expect(measured.firstTop).toBeLessThanOrEqual(200);
  expect(measured.rowHeight).toBe(32);
  expect(measured.fontSize).toBe('13px');
  expect(measured.inViewport).toBeGreaterThanOrEqual(20);
  expect(measured.barHeight).toBeGreaterThan(0);
  expect(measured.barHeight).toBeLessThanOrEqual(40);

  // Sort by Last run: newest first, so the broken pipeline (run second) sits
  // directly above the ok one, and every never-run filler after both.
  // The header's button — the filter bar has a "Last run: All" menu too.
  await page
    .getByRole('columnheader', { name: /Last run/ })
    .getByRole('button')
    .click();
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

  // #1569 slice 2 — filter by last run: in the URL beside the sort, and it
  // survives a reload.
  await page.getByRole('button', { name: /^Last run: All/ }).click();
  await page.getByRole('menuitemcheckbox', { name: 'failure' }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/[?&]last=failure(&|$)/);
  await expect.poll(order).toEqual([brokenName]);
  await page.reload();
  await fluentRootReady(page);
  await expect(page.getByRole('button', { name: /^Last run: failure/ })).toBeVisible();
  await expect.poll(order).toEqual([brokenName]);
  // A search on top of it that matches nothing says so; Clear brings every row
  // back, in the sorted order.
  await page.getByRole('searchbox', { name: 'Search pipelines' }).fill(okName);
  await expect(page.getByText('No pipelines match the filters.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).not.toHaveURL(/[?&](last|q)=/);
  await expect.poll(async () => (await order()).slice(0, 2)).toEqual(sortedOrder);

  // The last run's link lands on that run.
  await row(okName)
    .getByRole('link', { name: /success/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`#/monitor/runs/${okRun}$`));

  await expectQuiet(page, problems);
});

test('#1569 slice 3 — New pipeline and Import are toolbar drawers beside the grid', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const tag = `e2e 1569 drawers ${String(Date.now())}`;
  const folder = `Ops ${tag}`;
  // An existing folder, so a different case of it can be typed below.
  const seeded = await page.request.post('/api/pipelines', {
    data: { name: `${tag} seeded`, folder },
  });
  expect(seeded.status()).toBe(201);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/author/pipelines');
  await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
  await fluentRootReady(page);

  // Nothing to create or import with until the toolbar asks for it, and the
  // toolbar shares the title's row.
  await expect(page.getByRole('form', { name: 'New pipeline' })).toHaveCount(0);
  await expect(page.getByLabel('Export file')).toHaveCount(0);
  const header = await page.locator('.pipelines-page > .page-header').evaluate((el) => {
    const title = el.querySelector('h2')?.getBoundingClientRect();
    const button = el.querySelector('button')?.getBoundingClientRect();
    return {
      height: Math.round(el.getBoundingClientRect().height),
      sameRow: title !== undefined && button !== undefined && button.top < title.bottom,
    };
  });
  expect(header.sameRow).toBe(true);
  expect(header.height).toBeLessThanOrEqual(40);

  // Create in a folder typed in another case: it is filed under the existing one.
  const name = `${tag} created`;
  await newPipelineButton(page).click();
  const form = page.getByRole('form', { name: 'New pipeline' });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await form.getByRole('combobox', { name: 'Folder' }).fill(folder.toLowerCase());
  await form.getByRole('button', { name: 'Create pipeline' }).click();
  await expect(form).toBeHidden();
  await expect(newPipelineButton(page)).toBeFocused();
  const created = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: `Open ${name}`, exact: true }) });
  await expect(created.locator('.pipelines-grid__folder')).toHaveText(new RegExp(`^${folder}`));

  // Import opens BESIDE the grid, a column rather than an overlay: the grid's
  // rows stay in view and to its left.
  const drawer = await openImportDrawer(page);
  await expect(drawer.getByLabel('Export file')).toBeFocused();
  await expect(drawer.getByRole('group', { name: 'Demo workspace' })).toBeVisible();
  const layout = await page.evaluate(() => {
    const grid = document.querySelector('.pipelines-grid')?.getBoundingClientRect();
    const side = document.querySelector('.form-drawer')?.getBoundingClientRect();
    return { gridRight: grid?.right ?? -1, drawerLeft: side?.left ?? -1 };
  });
  expect(layout.gridRight).toBeGreaterThan(0);
  expect(layout.drawerLeft).toBeGreaterThanOrEqual(layout.gridRight);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeFocused();

  await expectQuiet(page, problems);
});
