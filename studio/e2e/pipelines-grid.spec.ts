import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { fireAndSettle, mintVersion, seedVersion, type SeedDoc } from './support/seedDoc';
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

  // Import opens BESIDE the grid, a column rather than an overlay: the list's
  // column (which scrolls the grid sideways if it must) ends where the drawer
  // starts, and the drawer is wholly on screen.
  const drawer = await openImportDrawer(page);
  await expect(drawer.getByLabel('Export file')).toBeFocused();
  await expect(drawer.getByRole('group', { name: 'Demo workspace' })).toBeVisible();
  const layout = await page.evaluate(() => {
    const list = document.querySelector('.drawer-layout-open > :first-child');
    const rows = list?.querySelectorAll('.pipelines-grid tbody tr').length ?? 0;
    const column = list?.getBoundingClientRect();
    const side = document.querySelector('.form-drawer')?.getBoundingClientRect();
    return {
      rows,
      listRight: column?.right ?? -1,
      drawerLeft: side?.left ?? -1,
      drawerRight: side?.right ?? Infinity,
    };
  });
  expect(layout.rows).toBeGreaterThan(0);
  expect(layout.listRight).toBeGreaterThan(0);
  expect(layout.drawerLeft).toBeGreaterThanOrEqual(layout.listRight);
  expect(layout.drawerRight).toBeLessThanOrEqual(1440);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeFocused();

  await expectQuiet(page, problems);
});

test('#1569 slice 5 — a description typed in New pipeline is its first version, and the grid finds it', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const tag = `e2e 1569 described ${String(Date.now())}`;
  const name = `${tag} pipeline`;
  const description = `Loads the ${tag} extract`;

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#/author/pipelines');
  await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
  await fluentRootReady(page);

  await newPipelineButton(page).click();
  const form = page.getByRole('form', { name: 'New pipeline' });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await form.getByRole('textbox', { name: 'Description' }).fill(description);
  await form.getByRole('button', { name: 'Create pipeline' }).click();
  await expect(form).toBeHidden();

  // Searching by the description finds it: the summaries read carries it.
  await page.getByRole('searchbox', { name: 'Search pipelines' }).fill(`Loads the ${tag}`);
  const open = page.getByRole('link', { name: `Open ${name}`, exact: true });
  await expect(open).toHaveCount(1);
  const id = decodeURIComponent((await open.getAttribute('href'))!.split('/').pop()!);

  // Stored on a first version: an empty graph carrying it, as typed.
  const versions = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
  expect(versions.status()).toBe(200);
  const items = (await versions.json()) as {
    version: number;
    description: string;
    nodes: unknown[];
  }[];
  expect(items.map((v) => [v.version, v.description, v.nodes.length])).toEqual([
    [1, description, 0],
  ]);

  // And the editor's General tab opens on it.
  await open.click();
  await page.locator('.react-flow__renderer').waitFor();
  await page.getByRole('tab', { name: 'General' }).click();
  await expect(page.getByLabel('pipeline description')).toHaveValue(description);

  await expectQuiet(page, problems);
});

test('#1569 slice 4 — pipelines grid columns resize, can be chosen, persist per viewer, and reset', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const problems = collectPageProblems(page);
  const tag = `e2e 1569 columns ${String(Date.now())}`;
  const ok = await seedVersion(page, tag, OK);
  await fireAndSettle(page, ok.pipelineVersionId, 'e2e 1569 columns');

  await page.setViewportSize({ width: 1440, height: 900 });
  const summariesRead = page.waitForResponse((r) => r.url().endsWith('/api/pipelines/summaries'));
  await page.goto(`/#/author/pipelines?q=${encodeURIComponent(tag)}`);
  await fluentRootReady(page);
  await summariesRead;
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: `Open ${tag}` }) });
  await expect(row).toHaveCount(1);
  const header = (name: string) => page.getByRole('columnheader', { name, exact: true });
  const measure = () =>
    page.evaluate(() => {
      const box = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
      const scroll = document.querySelector('.runs-grid-scroll');
      const content = document.querySelector('.content');
      const ths = [...document.querySelectorAll('.pipelines-grid thead th')];
      return {
        name: box('#pipelines-grid-col-name')?.width ?? 0,
        nameRight: box('#pipelines-grid-col-name')?.right ?? 0,
        lastRun: box('#pipelines-grid-col-lastRun')?.width ?? 0,
        actions: ths.at(-1)?.getBoundingClientRect().width ?? -1,
        gridScrolls: (scroll?.scrollWidth ?? 0) > (scroll?.clientWidth ?? 0) + 1,
        pageScrolls: (content?.scrollWidth ?? 0) > (content?.clientWidth ?? 0) + 1,
      };
    });

  // Defaults: the default columns fit at 1440×900 with the ⋯ column whole.
  const start = await measure();
  expect(start.name).toBeCloseTo(240, 0);
  expect(start.actions).toBeGreaterThanOrEqual(48);
  expect(start.gridScrolls).toBe(false);
  expect(start.pageScrolls).toBe(false);

  // A pointer drag of 40px moves the Name edge 40px, and does not sort.
  const handle = page.getByRole('separator', { name: 'Resize Name column' });
  const hb = await handle.boundingBox();
  if (hb === null) throw new Error('no Name resize handle');
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 20, hb.y + hb.height / 2);
  await page.mouse.move(hb.x + hb.width / 2 + 40, hb.y + hb.height / 2);
  await page.mouse.up();
  const dragged = await measure();
  expect(dragged.name).toBeCloseTo(280, 0);
  expect(dragged.nameRight - start.nameRight).toBeCloseTo(40, 0);
  expect(new URL(page.url()).hash).not.toContain('sort=');

  // The keyboard path: one 16px step on Last run.
  await page.getByRole('separator', { name: 'Resize Last run column' }).press('ArrowRight');
  await expect.poll(async () => Math.round((await measure()).lastRun)).toBe(168 + 16);

  // Turn on Runs (7d) and Activities, turn off Next run.
  await page.getByRole('button', { name: /^Columns/ }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Runs (7d)' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Activities' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Next run' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'p50 / p95' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Description' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Concurrency' }).click();
  // Name holds the row's link: it cannot be turned off.
  await expect(page.getByRole('menuitemcheckbox', { name: 'Name' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(header('Next run')).toHaveCount(0);
  const cellUnder = async (name: string) => {
    const names = await page
      .getByRole('columnheader')
      .evaluateAll((ths) => ths.map((th) => th.getAttribute('aria-label')));
    return row.getByRole('cell').nth(names.indexOf(name));
  };
  // One run in the window, one activity in the saved version.
  await expect(await cellUnder('Runs (7d)')).toHaveText('1');
  await expect(await cellUnder('Activities')).toHaveText('1');
  // Both durations of the one finished run; no description saved; no cap.
  await expect(await cellUnder('p50 / p95')).toHaveText(/^[\d.]+s \/ [\d.]+s$/);
  await expect(await cellUnder('Description')).toHaveText('—');
  const cap = await cellUnder('Concurrency');
  await expect(cap).toHaveText('—');
  await expect(cap).toHaveAttribute('title', 'No cap');

  // Sorted by Runs (7d), that column is drawn whatever the choice, so its box
  // cannot be unticked.
  await header('Runs (7d)').getByRole('button').click();
  await expect(page).toHaveURL(/[?&]sort=runs(&|$)/);
  await page.getByRole('button', { name: /^Columns/ }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Runs (7d)' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.goto(`/#/author/pipelines?q=${encodeURIComponent(tag)}`);

  // A reload keeps the widths and the choice: they are the viewer's.
  await page.reload();
  await fluentRootReady(page);
  await expect(row).toHaveCount(1);
  await expect(header('Next run')).toHaveCount(0);
  await expect(header('Runs (7d)')).toHaveCount(1);
  const reloaded = await measure();
  expect(reloaded.name).toBeCloseTo(280, 0);
  expect(reloaded.lastRun).toBeCloseTo(184, 0);

  // Wider than the page: the GRID scrolls sideways, the page does not, and the
  // ⋯ column keeps its width.
  await page.getByRole('separator', { name: 'Resize Name column' }).press('End');
  await page.getByRole('separator', { name: 'Resize Last run column' }).press('End');
  await expect.poll(async () => (await measure()).gridScrolls).toBe(true);
  const wide = await measure();
  expect(wide.pageScrolls).toBe(false);
  expect(wide.actions).toBeGreaterThanOrEqual(48);

  // Reset brings every column back at its default width.
  await page.getByRole('button', { name: /^Columns/ }).click();
  await page.getByRole('menuitem', { name: 'Reset columns' }).click();
  await expect(header('Next run')).toHaveCount(1);
  await expect(header('Runs (7d)')).toHaveCount(0);
  await expect.poll(async () => Math.round((await measure()).name)).toBe(240);
  expect((await measure()).gridScrolls).toBe(false);

  // The Archived view draws a fixed pair of columns, so it has no picker.
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Columns/ })).toHaveCount(0);

  await expectQuiet(page, problems);
});

/**
 * #1581 — the router commits a navigation in a transition, so the URL moves
 * before the page re-renders with it. A sort written from the RENDERED params
 * in that gap overwrote the one just written. Both clicks run in ONE task, so
 * the gap is certain rather than a matter of load: the second click must flip
 * the first one's order, not repeat it.
 */
test('#1581 — two sort clicks before the router re-renders both count', async ({ page }) => {
  const problems = collectPageProblems(page);
  // A grid has a header only once there is a row to put under it.
  const res = await page.request.post('/api/pipelines', {
    data: { name: `e2e 1581 ${String(Date.now())}` },
  });
  expect(res.status(), await res.text()).toBe(201);
  await page.goto('/#/author/pipelines');
  await fluentRootReady(page);
  const lastRun = page.getByRole('columnheader', { name: /Last run/ });
  await expect(lastRun).toHaveCount(1);

  const clicked = await page.evaluate(async () => {
    const button = [...document.querySelectorAll('th')]
      .find((th) => th.textContent?.includes('Last run'))
      ?.querySelector('button');
    button?.click();
    // Long enough for the URL to move, too short for the router's render.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const urlInGap = window.location.hash;
    button?.click();
    return { urlInGap, found: button !== undefined && button !== null };
  });
  expect(clicked).toEqual({ urlInGap: expect.stringMatching(/sort=lastRun/), found: true });

  await expect(lastRun).toHaveAttribute('aria-sort', 'ascending');
  await expect(page).toHaveURL(/[?&]dir=asc(&|$)/);
  await expectQuiet(page, problems);
});

test('#1569 slice 7 — the row opens the editor; ⋯ triggers it now, opens its last run and its runs', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const problems = collectPageProblems(page);
  const name = `e2e 1569s7 ${String(Date.now())}`;
  const seeded = await seedVersion(page, name, OK);
  const firstRun = await fireAndSettle(page, seeded.pipelineVersionId, 'e2e 1569s7 manual');
  await createScheduleTrigger(page, seeded.pipelineVersionId);

  await page.setViewportSize({ width: 1440, height: 900 });
  const gridUrl = `/#/author/pipelines?q=${encodeURIComponent(name)}`;
  const row = () =>
    page.getByRole('row').filter({ has: page.getByRole('link', { name: `Open ${name}` }) });
  // Ready once the row's facts are drawn. Waited on the cell, not the
  // summaries response: coming back from the Monitor is a hash change, and the
  // read may already have answered.
  const triggersLink = () => row().getByRole('link', { name: '2 active / 2 triggers' });
  const open = async () => {
    await page.goto(gridUrl);
    await fluentRootReady(page);
    await expect(triggersLink()).toBeVisible();
  };
  const choose = async (item: string) => {
    // The row's own ⋯: the Factory Resources pane has one for it too.
    await row()
      .getByRole('button', { name: `Actions for ${name}` })
      .click();
    await page.getByRole('menuitem', { name: item }).click();
  };
  await open();

  // The Triggers count lists this pipeline's triggers.
  await expect(triggersLink()).toHaveAttribute(
    'href',
    `#/manage/triggers?pipeline=${seeded.pipelineId}`,
  );

  // ⋯ → Runs: the Monitor, filtered to the pipeline.
  await choose('Runs');
  await expect(page).toHaveURL(new RegExp(`#/monitor/runs\\?pipeline=${seeded.pipelineId}$`));

  // ⋯ → Open last run: that run.
  await open();
  await choose('Open last run');
  await expect(page).toHaveURL(new RegExp(`#/monitor/runs/${firstRun}$`));

  // ⋯ → Trigger now…: the latest version starts, and the notice links to it.
  await open();
  await choose('Trigger now…');
  const drawer = page.getByRole('dialog', { name: `Trigger now — ${name}` });
  await expect(drawer.getByText('v1 · latest')).toBeVisible();
  await drawer.getByRole('button', { name: 'Start run' }).click();
  const notice = drawer.getByRole('status');
  await expect(notice).toHaveText('Started v1 · Open run');
  const runHref = await notice.getByRole('link', { name: 'Open run' }).getAttribute('href');
  expect(runHref).toMatch(/^#\/monitor\/runs\/[^/]+$/);
  expect(runHref).not.toBe(`#/monitor/runs/${firstRun}`);
  await drawer.getByRole('button', { name: 'Done' }).click();
  await expect(drawer).toHaveCount(0);

  // A click on a plain cell is a click on the row: the editor opens.
  await row().locator('td').nth(2).click();
  await expect(page).toHaveURL(new RegExp(`#/author/pipelines/${seeded.pipelineId}$`));

  await expectQuiet(page, problems);
});

/**
 * #1569 OR37 slice 8 — the row's ⋯ → Clone from version… and Duplicate…, one
 * drawer. Two versions whose SHARED node differs in config, so each copy is
 * proved to be the version it names by what a node holds.
 */
test('#1569 slice 8 — ⋯ Clone from version… copies THAT version; Duplicate… copies the latest', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const URL_V1 = 'https://example.test/s8-v1';
  const URL_V2 = 'https://example.test/s8-v2';
  const at = (url: string) => ({ id: 'n_a', position: { x: 0, y: 0 }, config: { url } });
  // No "v1" in any name: the suite shares one database, and other specs' pickers
  // match `/v1/`.
  const stamp = `e2e 1569s8 ${String(Date.now())}`;
  const src = `${stamp} src`;
  const { pipelineId, pipelineVersionId } = await seedVersion(page, src, {
    nodes: [at(URL_V1)],
    annotations: ['nightly'],
  });
  await mintVersion(
    page,
    pipelineId,
    { nodes: [at(URL_V2), { id: 'n_c', position: { x: 320, y: 0 } }], annotations: ['nightly'] },
    pipelineVersionId,
    src,
  );

  interface Version {
    version: number;
    nodes: { id: string; config: { url?: string } }[];
    annotations: string[];
  }
  // The copy's id from its own row in the grid: it is there without a reload.
  const onlyVersionOf = async (name: string): Promise<Version> => {
    const href = await rowOf(name)
      .getByRole('link', { name: `Open ${name}`, exact: true })
      .getAttribute('href');
    const id = decodeURIComponent(href!.split('/').pop()!);
    expect(id).not.toBe(pipelineId);
    const res = await page.request.get(`/api/pipelines/${encodeURIComponent(id)}/versions`);
    const versions = (await res.json()) as Version[];
    expect(versions).toHaveLength(1);
    return versions[0]!;
  };

  await page.goto(`/#/author/pipelines?q=${encodeURIComponent(stamp)}`);
  await fluentRootReady(page);
  const rowOf = (name: string) =>
    page.getByRole('row').filter({ has: page.getByRole('link', { name: `Open ${name}` }) });
  await expect(rowOf(src)).toBeVisible();
  const choose = async (item: string) => {
    await rowOf(src)
      .getByRole('button', { name: `Actions for ${src}` })
      .click();
    const menuItem = page.getByRole('menuitem', { name: item });
    // Clone waits on the row's version count, which arrives with the grid's facts.
    await expect(menuItem).not.toHaveAttribute('aria-disabled', 'true');
    await menuItem.click();
  };

  // Clone from version…: starts on v1, focused, and copies v1.
  await choose('Clone from version…');
  let drawer = page.getByRole('dialog', { name: `Clone from version — ${src}` });
  const version = drawer.getByRole('combobox', { name: 'Version' });
  await expect(version).toHaveValue('1');
  await expect(version).toBeFocused();
  await expect(drawer.getByRole('option', { name: 'Latest (v2)' })).toBeAttached();
  // Sized to its options, not stretched across the drawer (UI standard rule 5).
  const selectBox = (await version.boundingBox())!;
  const drawerBox = (await drawer.boundingBox())!;
  expect(selectBox.width).toBeLessThan(drawerBox.width / 2);
  const name = drawer.getByRole('textbox', { name: /Name/ });
  await expect(name).toHaveValue(`${src} v1 (copy)`);
  const cloneName = `${stamp} clone`;
  await name.fill(cloneName);
  await drawer.getByRole('button', { name: 'Clone', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  // The copy joins the grid without a reload.
  await expect(rowOf(cloneName)).toBeVisible();
  const clone = await onlyVersionOf(cloneName);
  expect(clone.nodes.map((n) => n.id)).toEqual(['n_a']);
  expect(clone.nodes[0]!.config.url).toBe(URL_V1);
  expect(clone.annotations).toEqual(['nightly', `cloned from ${src} v1`]);

  // Duplicate…: Latest by default, and copies v2 with no provenance label.
  await choose('Duplicate…');
  drawer = page.getByRole('dialog', { name: `Duplicate — ${src}` });
  await expect(drawer.getByRole('combobox', { name: 'Version' })).toHaveValue('latest');
  await expect(drawer.getByRole('textbox', { name: /Name/ })).toHaveValue(`${src} (copy)`);
  const dupName = `${stamp} dup`;
  await drawer.getByRole('textbox', { name: /Name/ }).fill(dupName);
  await drawer.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(rowOf(dupName)).toBeVisible();
  const dup = await onlyVersionOf(dupName);
  expect(dup.nodes.map((n) => n.id).sort()).toEqual(['n_a', 'n_c']);
  expect(dup.nodes.find((n) => n.id === 'n_a')!.config.url).toBe(URL_V2);
  expect(dup.annotations).toEqual(['nightly']);

  await expectQuiet(page, problems);
});
