import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * R2 + U10 — the Monitor's front door becomes readable.
 *
 * The runs list rendered `pipelineVersionId` RAW as its only identity column, so
 * every row read `pv_…` and an operator with more than one pipeline could not
 * tell their runs apart without opening each. It had no duration (two absolute
 * timestamps, subtract them yourself) and no filter at all.
 *
 * The fixture is a settled run of a NAMED pipeline, fired through the public API
 * exactly as an operator would. `fail` is a control activity — egress-free, no
 * connection and no network — so the run reaches a terminal status on a test
 * machine and its duration is a real measured elapsed rather than a live one.
 *
 * Every assertion is scoped to THIS run's row. The e2e database is shared with
 * the rest of the suite, so a global "the Manual tab is empty" claim would be
 * true only until another spec created a rerun; "our triggered run is absent
 * from the Child tab" is true no matter what else has run.
 */
test('R2/U10 — the runs list names the pipeline, times the run, and filters by what started it', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const pipelineName = `Run list readable ${Date.now()}`;
  const { pipelineVersionId } = await seedVersion(page, pipelineName, {
    nodes: [{ id: 'n1', type: 'fail', config: { message: 'expected' }, position: { x: 0, y: 0 } }],
  });
  const triggerName = 'e2e run-list trigger';
  const runId = await fireAndSettle(page, pipelineVersionId, triggerName);

  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);

  const row = page.getByRole('row').filter({ hasText: runId });
  await expect(row).toHaveCount(1);

  // R2 — the pipeline's NAME and version number, and NOT the opaque key it
  // replaced. Asserting the id's ABSENCE is the half that matters: printing the
  // name beside the id would satisfy a name-only check while leaving the column
  // exactly as unreadable as before.
  await expect(row).toContainText(pipelineName);
  await expect(row).toContainText('v1');
  await expect(page.getByText(pipelineVersionId, { exact: true })).toHaveCount(0);
  // Demoted, not discarded — still reachable for whoever needs the raw key.
  await expect(row.locator(`[title="${pipelineVersionId}"]`)).toHaveCount(1);

  // R2 — the trigger's name, joined server-side; #1484 — after what started
  // the run, which the SERVER classifies (fireAndSettle uses Fire now).
  await expect(row).toContainText(`Fire now · ${triggerName}`);

  // R2 — a real measured duration for a settled run: some number followed by a
  // unit, and specifically NOT the em-dash that means "no answer".
  // Located by its HEADER, not a fixed index — columns have been added and
  // reordered (RS6, #1484), and a hardcoded position silently reads the wrong one.
  const durationColumn = (await page.getByRole('columnheader').allTextContents()).indexOf(
    'Duration',
  );
  expect(durationColumn).toBeGreaterThanOrEqual(0);
  const duration = row.getByRole('cell').nth(durationColumn);
  await expect(duration).toHaveText(/^\d+(\.\d+)?(ms|s|m \d+s|h \d+m)$/);

  // #1484 — what started the run is a SERVER-side filter now, a checkbox menu
  // over the kinds. This run was a Fire now, so it is kept under "Fire now" and
  // dropped under "Schedule"; and the filter is URL state that survives a reload.
  const kindMenu = page.getByRole('button', { name: /^Triggered by:/ });
  await kindMenu.click();
  await page.getByRole('menuitemcheckbox', { name: 'Fire now' }).click();
  await expect.poll(() => new URL(page.url()).hash).toContain('kind=manual');
  await expect(page.getByRole('row').filter({ hasText: runId })).toHaveCount(1);
  await page.getByRole('menuitemcheckbox', { name: 'Fire now' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Schedule' }).click();
  await expect.poll(() => new URL(page.url()).hash).toContain('kind=schedule');
  await expect(page.getByRole('row').filter({ hasText: runId })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.reload();
  await fluentRootReady(page);
  await expect(kindMenu).toHaveText(/Triggered by: Schedule/);
  await expect(page.getByRole('row').filter({ hasText: runId })).toHaveCount(0);

  await expectQuiet(page, problems);
});

/**
 * #1484 OR35 M1 — the runs list is a dense, full-width grid, and a row is a way
 * into its run. Measured in a real layout at the ticket's 1440×900, because
 * width, row height and what a click lands on are all things jsdom cannot see.
 */
test('#1484 — the runs list is a full-width grid of 32px rows, and a row opens its run', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Long on purpose: whatever a row holds, the grid must not widen the page.
  const pipelineName = `Runs grid ${Date.now()} ${'with a very long name '.repeat(8)}`.trim();
  const { pipelineVersionId } = await seedVersion(page, pipelineName, {
    nodes: [{ id: 'n1', type: 'fail', config: { message: 'expected' }, position: { x: 0, y: 0 } }],
  });
  const runId = await fireAndSettle(page, pipelineVersionId, 'e2e runs grid');

  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);
  const row = page.getByRole('row').filter({ hasText: runId });
  await expect(row).toHaveCount(1);

  const measured = await page.evaluate(() => {
    const content = document.querySelector('.content');
    const table = document.querySelector('table.runs-grid');
    const rowEl = document.querySelector('tr.runs-grid__row');
    const cell = rowEl?.querySelector('td');
    return {
      contentWidth: content?.getBoundingClientRect().width ?? 0,
      tableWidth: table?.getBoundingClientRect().width ?? 0,
      rowHeight: rowEl?.getBoundingClientRect().height ?? 0,
      fontSize: cell ? getComputedStyle(cell).fontSize : '',
      wraps: cell ? getComputedStyle(cell).whiteSpace : '',
      // `.content` is the element that scrolls (the shell is viewport-height).
      sideScroll:
        (content?.scrollWidth ?? 0) > (content?.clientWidth ?? 0) + 1 ||
        document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  // The 900px reading width is gone: the page and its table use the screen.
  expect(measured.contentWidth).toBeGreaterThan(1100);
  expect(measured.tableWidth).toBeGreaterThan(1000);
  expect(measured.rowHeight).toBeGreaterThanOrEqual(31);
  expect(measured.rowHeight).toBeLessThanOrEqual(33);
  expect(measured.fontSize).toBe('13px');
  expect(measured.wraps).toBe('nowrap');
  expect(measured.sideScroll, 'the grid fits without a sideways scroll').toBe(false);

  // The short id is drawn; the row still carries the full id for search and
  // for assistive tech, and the link is named for it.
  await expect(row.getByRole('link', { name: `Open run ${runId}` })).toBeVisible();

  // A click on a plain cell (the status pill) opens the run.
  await row.locator('.run-status').click();
  await expect.poll(() => new URL(page.url()).hash).toBe(`#/monitor/runs/${runId}`);

  await expectQuiet(page, problems);
});

/**
 * U26 — the Monitor's server-side filter pane.
 *
 * What only an e2e can prove here is that the filter is a REAL round trip to
 * `GET /api/runs` and that the resulting view is URL-addressable — a unit test
 * with a mocked client proves the page asks for the right thing, not that the
 * server answers it, and it cannot reload a page.
 *
 * Two runs of DIFFERENT pipelines, one failing and one succeeding, so every
 * assertion can be scoped to a specific run id. The shared e2e database means a
 * global claim ("the failure filter shows one row") is true only until another
 * spec runs; "OUR success is absent from the failure filter" stays true whatever
 * else has run.
 */
test('U26 — the runs list filters by status, pipeline and window, and the filter is a linkable URL', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const stamp = Date.now();
  const failingName = `Filter pane failing ${stamp}`;
  const passingName = `Filter pane passing ${stamp}`;
  const { pipelineVersionId: failingVersion } = await seedVersion(page, failingName, {
    nodes: [{ id: 'n1', type: 'fail', config: { message: 'expected' }, position: { x: 0, y: 0 } }],
  });
  const { pipelineVersionId: passingVersion } = await seedVersion(page, passingName, {
    // A zero-second `wait`: egress-free like `fail`, but it SUCCEEDS — the
    // status axis needs one of each to be worth asserting. Same fixture
    // `rerun-from-failed.spec.ts` uses for a run that settles immediately.
    nodes: [{ id: 'n1', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 0 } }],
  });
  const failedRun = await fireAndSettle(page, failingVersion, `e2e filter fail ${stamp}`);
  const passedRun = await fireAndSettle(page, passingVersion, `e2e filter pass ${stamp}`);

  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);

  const rowFor = (runId: string) => page.getByRole('row').filter({ hasText: runId });
  await expect(rowFor(failedRun)).toHaveCount(1);
  await expect(rowFor(passedRun)).toHaveCount(1);

  // STATUS — the failed run stays, the successful one is filtered out by the
  // SERVER (it is not merely hidden: the row is not in the response at all).
  await page.getByLabel('Status').selectOption('failure');
  await expect(rowFor(failedRun)).toHaveCount(1);
  await expect(rowFor(passedRun)).toHaveCount(0);
  expect(page.url()).toContain('status=failure');

  // URL-addressable: the half a unit test cannot reach. A real reload must land
  // on the same filtered view, with the control still showing what is applied.
  await page.reload();
  await fluentRootReady(page);
  await expect(page.getByLabel('Status')).toHaveValue('failure');
  await expect(rowFor(failedRun)).toHaveCount(1);
  await expect(rowFor(passedRun)).toHaveCount(0);

  // PIPELINE — narrowing to the OTHER pipeline empties this view entirely, and
  // the pane survives that emptiness with a message that names the cause and a
  // control that undoes it. A pane rendered only when rows exist would strand
  // the operator here.
  /* ANCHORED, because `getByLabel` matches by substring and a `<label>`-wrapped
     `<select>` contributes its OPTION text to that label: this picker's label
     text reads "PipelineAll pipelines<every pipeline name>", and the Trigger
     picker's reads "TriggerAll triggers<every trigger name>". So a bare
     `getByLabel('Pipeline')` matched the TRIGGER picker too the moment any spec
     in the suite created a trigger with "pipeline" in its name — a real
     cross-spec coupling through the shared database, and one that would keep
     recurring. `^Pipeline` can only match the picker whose own label starts with
     it. (`{ exact: true }` does NOT work here: the option text is part of the
     string, so nothing is exactly "Pipeline".) */
  await page.getByLabel(/^Pipeline/).selectOption({ label: passingName });
  await expect(rowFor(failedRun)).toHaveCount(0);
  await expect(page.getByText(/No runs match these filters/i)).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rowFor(failedRun)).toHaveCount(1);
  await expect(rowFor(passedRun)).toHaveCount(1);
  // Cleared means the params are GONE, not set to an empty value.
  expect(page.url()).not.toContain('status=');
  expect(page.url()).not.toContain('pipeline=');

  // WINDOW — the runs were fired seconds ago, so the tightest window keeps them
  // both; this pins that the relative preset resolves to a real bound server-side
  // rather than being dropped.
  await page.getByLabel('Started').selectOption('1h');
  expect(page.url()).toContain('since=1h');
  await expect(rowFor(failedRun)).toHaveCount(1);

  // A stale/hand-edited link degrades to the unfiltered view rather than to an
  // error page — the server would 400 this query, so the page must never send it.
  await page.goto('/#/monitor/runs?status=not-a-status&since=forever');
  await fluentRootReady(page);
  await expect(page.getByLabel('Status')).toHaveValue('');
  await expect(rowFor(failedRun)).toHaveCount(1);

  await expectQuiet(page, problems);
});

/**
 * U26 — the ANNOTATION axis. A run is matched by the annotations of the version
 * it BOUND (F8a), exactly; the picker offers the annotations of the caller's
 * runs; the choice is a linkable URL. The tag deliberately carries a space, `&`,
 * `+` and a non-ASCII letter: it crosses the hash URL AND the API query string,
 * and each would silently turn an exact match into none if mis-encoded.
 */
test('U26 — the runs list filters by annotation, from a picker of the run annotations', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const stamp = Date.now();
  const tag = `Finance & ops+ café ${stamp}`;
  const { pipelineVersionId: taggedVersion } = await seedVersion(page, `Tagged ${stamp}`, {
    nodes: [{ id: 'n1', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 0 } }],
    annotations: [tag, `other ${stamp}`],
  });
  const { pipelineVersionId: plainVersion } = await seedVersion(page, `Untagged ${stamp}`, {
    nodes: [{ id: 'n1', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 0 } }],
    annotations: [`other ${stamp}`],
  });
  const taggedRun = await fireAndSettle(page, taggedVersion, `e2e tagged ${stamp}`);
  const plainRun = await fireAndSettle(page, plainVersion, `e2e untagged ${stamp}`);

  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);
  const rowFor = (runId: string) => page.getByRole('row').filter({ hasText: runId });
  await expect(rowFor(taggedRun)).toHaveCount(1);
  await expect(rowFor(plainRun)).toHaveCount(1);

  // Anchored for the reason the Pipeline picker is (see the test above).
  const picker = page.getByLabel(/^Annotation/);
  await picker.selectOption({ label: tag });
  await expect(rowFor(taggedRun)).toHaveCount(1);
  await expect(rowFor(plainRun)).toHaveCount(0);
  expect(page.url()).toContain('annotation=');

  // Linkable: a reload lands on the same exact-match view, the control still
  // naming the applied tag.
  await page.reload();
  await fluentRootReady(page);
  await expect(page.getByLabel(/^Annotation/)).toHaveValue(tag);
  await expect(rowFor(taggedRun)).toHaveCount(1);
  await expect(rowFor(plainRun)).toHaveCount(0);

  // A tag both versions carry keeps both runs.
  await page.getByLabel(/^Annotation/).selectOption({ label: `other ${stamp}` });
  await expect(rowFor(taggedRun)).toHaveCount(1);
  await expect(rowFor(plainRun)).toHaveCount(1);

  await page.getByRole('button', { name: 'Clear filters' }).click();
  expect(page.url()).not.toContain('annotation=');

  await expectQuiet(page, problems);
});

/**
 * #1083 — `GET /api/runs` was the last list route with no `limit` and no
 * `cursor`, over the one table with no retention policy: the whole run history
 * came back in one body, and this page rendered all of it.
 *
 * TWO HALVES, verified two ways, and the split is deliberate rather than
 * convenient. The SERVER's walk is asserted against the real API — a genuine
 * keyset walk over rows this suite really created. The UI's Load-more wiring is
 * asserted against an INTERCEPTED response, because forcing a page boundary
 * through the real server would mean seeding more than `RUNS_PAGE_SIZE` (50)
 * settled runs into a shared e2e database, which is minutes of fixture for a
 * control that the interception exercises exactly. Nothing about the server's
 * behaviour is mocked in the half that tests the server.
 */
test('#1083 — the runs list is served a page at a time, and extends on demand', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const pipelineName = `Run paging ${Date.now()}`;
  const { pipelineVersionId } = await seedVersion(page, pipelineName, {
    nodes: [{ id: 'n1', type: 'fail', config: { message: 'expected' }, position: { x: 0, y: 0 } }],
  });
  const older = await fireAndSettle(page, pipelineVersionId, 'e2e paging trigger A');
  const newer = await fireAndSettle(page, pipelineVersionId, 'e2e paging trigger B');

  // ── The server: a real keyset walk, one row at a time ──────────────────────
  const first = await page.request.get('/api/runs?limit=1');
  expect(first.status()).toBe(200);
  const firstPage = (await first.json()) as {
    items: Record<string, unknown>[];
    nextCursor: string | null;
  };
  // BOUNDED — the property the route did not have. One row means one row.
  expect(firstPage.items).toHaveLength(1);
  // Newest-first, so the run fired second leads.
  expect(firstPage.items[0]!.id).toBe(newer);
  expect(firstPage.nextCursor).not.toBeNull();

  const second = await page.request.get(
    `/api/runs?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
  );
  expect(second.status()).toBe(200);
  const secondPage = (await second.json()) as { items: Record<string, unknown>[] };
  // The cursor RESUMED rather than restarting: the older run, not the newer one
  // again. A silently-ignored cursor is the failure this pins.
  expect(secondPage.items[0]!.id).toBe(older);

  // A cursor the server did not mint is a 400, never a silent first page.
  const bad = await page.request.get('/api/runs?cursor=not-a-real-cursor');
  expect(bad.status()).toBe(400);

  // ── The UI: Load older runs appends ─────────────────────────────────────────
  /* The two pages are built from the REAL summaries fetched above — the same
     rows, re-served one at a time so the boundary lands after row one. The
     intercept deliberately does NOT forward to the server: the second request
     carries a cursor this test invented, and the server would (correctly) 400
     it, which is the very fail-closed behaviour asserted three lines up. */
  const newerRow = firstPage.items[0]!;
  const olderRow = secondPage.items[0]!;
  let served = 0;
  await page.route('**/api/runs?*', async (route) => {
    served += 1;
    await route.fulfill({
      json:
        served === 1
          ? { items: [newerRow], nextCursor: 'e2e_cursor' }
          : { items: [olderRow], nextCursor: null },
    });
  });

  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);

  await expect(page.getByRole('row').filter({ hasText: newer })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: older })).toHaveCount(0);

  await page.getByRole('button', { name: 'Load older runs' }).click();

  // APPENDED — the reader keeps the rows they were already looking at.
  await expect(page.getByRole('row').filter({ hasText: older })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: newer })).toHaveCount(1);
  // The walk ended, so the control goes.
  await expect(page.getByRole('button', { name: 'Load older runs' })).toHaveCount(0);

  await expectQuiet(page, problems);
});

/**
 * #1484 OR35 M1 slice 2 — the one-row filter bar: search finds a run by the id
 * the grid draws, by the start of its id, and by its error text; a day with no
 * runs says so; and the bar plus the grid meet the density target at 1440×900.
 */
test('#1484 — the filter bar searches runs and days, in one row above a dense grid', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  const marker = `boom-${Date.now()}`;
  const pipelineName = `Filter bar ${Date.now()}`;
  const { pipelineId, pipelineVersionId } = await seedVersion(page, pipelineName, {
    nodes: [{ id: 'n1', type: 'fail', config: { message: marker }, position: { x: 0, y: 0 } }],
  });
  const runId = await fireAndSettle(page, pipelineVersionId, 'e2e filter bar');

  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);
  const search = page.getByRole('searchbox', { name: 'Search runs' });
  const ours = page.getByRole('row').filter({ hasText: runId });

  // The error text, case-insensitively: only our run failed with this marker.
  await search.fill(marker.toUpperCase());
  await expect.poll(() => new URL(page.url()).hash).toContain(`q=${marker.toUpperCase()}`);
  await expect(ours).toHaveCount(1);
  await expect(page.locator('tr.runs-grid__row')).toHaveCount(1);
  // The tail the grid draws, and the first 8 characters of the id.
  for (const part of [runId.slice(-8), runId.slice(0, 8)]) {
    await search.fill(part);
    await expect.poll(() => new URL(page.url()).hash).toContain(`q=${part}`);
    await expect(ours).toHaveCount(1);
  }

  // A day long before any run: the empty state, not an empty table.
  await page.goto('/#/monitor/runs?on=2000-01-01');
  await fluentRootReady(page);
  await expect(page.getByLabel('Started')).toHaveValue('on');
  await expect(page.getByLabel('Day')).toHaveValue('2000-01-01');
  await expect(page.getByText(/No runs match these filters/)).toBeVisible();
  await expect(page.locator('table.runs-grid')).toHaveCount(0);

  // DENSITY, at the widest the bar gets: a pipeline filter (so the spend line
  // shows) and a range of days (two date inputs), still one row.
  await page.goto(
    `/#/monitor/runs?pipeline=${encodeURIComponent(pipelineId)}&from=2000-01-01&to=2100-01-01`,
  );
  await fluentRootReady(page);
  await expect(ours).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Lifetime spend' })).toBeVisible();
  const measured = await page.evaluate(() => {
    const bar = document.querySelector('.run-filters');
    const controls = bar ? [...bar.children].map((c) => c.getBoundingClientRect()) : [];
    const row = document.querySelector('tr.runs-grid__row');
    const rect = row?.getBoundingClientRect();
    return {
      controlCount: controls.length,
      tops: controls.map((r) => Math.round(r.top + r.height / 2)),
      widths: controls.map((r) => Math.round(r.width)),
      barWidth: Math.round(bar?.getBoundingClientRect().width ?? 0),
      firstRowTop: rect?.top ?? Infinity,
      rowHeight: rect?.height ?? 0,
      viewport: window.innerHeight,
      // Where the height above the first row goes, for the failure message.
      stack: [
        '.content',
        '.runs-page .page-header',
        '.run-filters',
        '.runs-summary-line',
        'table.runs-grid thead',
      ]
        .map((sel) => {
          const r = document.querySelector(sel)?.getBoundingClientRect();
          return r ? `${sel}@${Math.round(r.top)}+${Math.round(r.height)}` : `${sel}:none`;
        })
        .join(' '),
      sideScroll: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  // Status, kind, pipeline, trigger, annotation, started, two days, Clear. (The
  // search box is on the title row.)
  expect(measured.controlCount).toBe(9);
  const spread = Math.max(...measured.tops) - Math.min(...measured.tops);
  expect(
    spread,
    `one row: centres ${measured.tops.join(',')} widths ${measured.widths.join(',')} of ${measured.barWidth}`,
  ).toBeLessThanOrEqual(4);
  expect(measured.firstRowTop, measured.stack).toBeLessThanOrEqual(200);
  // ≥ 20 rows fit below the first one's top at 32px each.
  expect(
    Math.floor((measured.viewport - measured.firstRowTop) / measured.rowHeight),
  ).toBeGreaterThanOrEqual(20);
  expect(measured.sideScroll).toBe(false);

  await expectQuiet(page, problems);
});

/**
 * #1484 OR35 M1 slice 4 — the grid sorts by column, on the SERVER, and the sort
 * lives in the URL. Three pipelines ('Beta', 'alpha', 'charlie') are fired in
 * that order, so newest first (c, a, B), A–Z (a, B, c) and Z–A (c, B, a) are
 * three different orders: each assertion can only pass if the server applied
 * that exact sort and direction, without regard to case (a byte sort would put
 * 'B' before 'a').
 */
test('#1484 — the runs grid sorts by a header, server side, and the sort is a linkable URL', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const stamp = `Sort ${Date.now()}`;
  const fire = async (suffix: string) => {
    const { pipelineVersionId } = await seedVersion(page, `${stamp} ${suffix}`, {
      nodes: [{ id: 'n1', type: 'fail', config: { message: 'x' }, position: { x: 0, y: 0 } }],
    });
    return fireAndSettle(page, pipelineVersionId, `e2e sort ${suffix}`);
  };
  const upper = await fire('Beta');
  const lower = await fire('alpha');
  const last = await fire('charlie');

  await page.goto(`/#/monitor/runs?q=${encodeURIComponent(stamp)}`);
  await fluentRootReady(page);
  const rows = page.locator('tr.runs-grid__row');
  const order = async () => {
    const texts = await rows.allTextContents();
    return texts.map((t) =>
      t.includes(lower) ? 'alpha' : t.includes(upper) ? 'Beta' : t.includes(last) ? 'charlie' : '?',
    );
  };
  const header = (name: string) => page.getByRole('columnheader', { name, exact: true });

  // Default: newest first, and Started says so.
  await expect.poll(order).toEqual(['charlie', 'alpha', 'Beta']);
  await expect(header('Started')).toHaveAttribute('aria-sort', 'descending');
  await expect(header('Pipeline')).not.toHaveAttribute('aria-sort', /.*/);

  // Pipeline A–Z: the request carries the sort, and the order is the server's.
  const sorted = page.waitForRequest((r) => r.url().includes('sort=pipeline'));
  await header('Pipeline').getByRole('button').click();
  await sorted;
  await expect.poll(order).toEqual(['alpha', 'Beta', 'charlie']);
  await expect(header('Pipeline')).toHaveAttribute('aria-sort', 'ascending');
  await expect(header('Started')).not.toHaveAttribute('aria-sort', /.*/);
  expect(new URL(page.url()).hash).toContain('sort=pipeline');
  expect(new URL(page.url()).hash).not.toContain('dir=');

  // Again flips it, and a reload keeps it: the URL is the state.
  await header('Pipeline').getByRole('button').click();
  await expect.poll(order).toEqual(['charlie', 'Beta', 'alpha']);
  await expect.poll(() => new URL(page.url()).hash).toContain('dir=desc');
  await page.reload();
  await fluentRootReady(page);
  await expect(header('Pipeline')).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(order).toEqual(['charlie', 'Beta', 'alpha']);

  // The timeline view lays runs out by time and pages "older", so it asks for
  // the default order whatever the grid's sort is.
  const timeline = page.waitForRequest(
    (r) => r.url().includes('/api/runs?') && !r.url().includes('sort='),
  );
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  await timeline;
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(header('Pipeline')).toHaveAttribute('aria-sort', 'descending');

  // Back to Started is back to the default, which writes no sort at all.
  await header('Started').getByRole('button').click();
  await expect(header('Started')).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(() => new URL(page.url()).hash).not.toContain('sort=');
  // The search survived every sort click: the sort is not a filter.
  expect(new URL(page.url()).hash).toContain('q=');

  await expectQuiet(page, problems);
});
