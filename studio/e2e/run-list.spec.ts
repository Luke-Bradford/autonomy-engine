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
test('R2/U10 — the runs list names the pipeline, times the run, and filters by origin', async ({
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

  // R2 — the trigger's name, joined server-side.
  await expect(row).toContainText(triggerName);

  // R2 — a real measured duration for a settled run: some number followed by a
  // unit, and specifically NOT the em-dash that means "no answer".
  const duration = row.getByRole('cell').nth(5);
  await expect(duration).toHaveText(/^\d+(\.\d+)?(ms|s|m \d+s|h \d+m)$/);

  // U10 — the origin tabs. This run was fired by a trigger, so it belongs to
  // Triggered and to no other origin tab.
  await expect(page.getByRole('tab')).toHaveCount(4);
  await page.getByRole('tab', { name: /Triggered/ }).click();
  await expect(page.getByRole('tab', { name: /Triggered/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('row').filter({ hasText: runId })).toHaveCount(1);

  await page.getByRole('tab', { name: /Child/ }).click();
  await expect(page.getByRole('row').filter({ hasText: runId })).toHaveCount(0);

  await page.getByRole('tab', { name: /Manual/ }).click();
  await expect(page.getByRole('row').filter({ hasText: runId })).toHaveCount(0);

  await page.getByRole('tab', { name: /^All/ }).click();
  await expect(page.getByRole('row').filter({ hasText: runId })).toHaveCount(1);
  // `all` is the default view, so it is the ABSENCE of the param.
  expect(page.url()).not.toContain('tab=');

  // U10 — the tab is URL state, which is the half a unit test cannot prove: a
  // filtered view must survive a real RELOAD and be linkable, not just re-render.
  await page.getByRole('tab', { name: /Triggered/ }).click();
  expect(page.url()).toContain('tab=triggered');

  await page.reload();
  await fluentRootReady(page);
  await expect(page.getByRole('tab', { name: /Triggered/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('row').filter({ hasText: runId })).toHaveCount(1);

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
  const firstPage = (await first.json()) as { items: { id: string }[]; nextCursor: string | null };
  // BOUNDED — the property the route did not have. One row means one row.
  expect(firstPage.items).toHaveLength(1);
  // Newest-first, so the run fired second leads.
  expect(firstPage.items[0]!.id).toBe(newer);
  expect(firstPage.nextCursor).not.toBeNull();

  const second = await page.request.get(
    `/api/runs?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
  );
  expect(second.status()).toBe(200);
  const secondPage = (await second.json()) as { items: { id: string }[] };
  // The cursor RESUMED rather than restarting: the older run, not the newer one
  // again. A silently-ignored cursor is the failure this pins.
  expect(secondPage.items[0]!.id).toBe(older);

  // A cursor the server did not mint is a 400, never a silent first page.
  const bad = await page.request.get('/api/runs?cursor=not-a-real-cursor');
  expect(bad.status()).toBe(400);

  // ── The UI: Load older runs appends, and the tab count says so ─────────────
  // The first page reports an older page exists; the second ends the walk.
  let served = 0;
  await page.route('**/api/runs?*', async (route) => {
    const body = await (await route.fetch()).json();
    served += 1;
    await route.fulfill({
      json:
        served === 1
          ? { items: [body.items[0]], nextCursor: 'e2e_cursor' }
          : { items: [body.items[1]], nextCursor: null },
    });
  });

  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);

  await expect(page.getByRole('row').filter({ hasText: newer })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: older })).toHaveCount(0);
  // OPEN-ENDED while older pages remain: the strip counts what is loaded, and a
  // bare number there would be a census claim over a prefix.
  await expect(page.getByRole('tab', { name: /Triggered \d+\+/ })).toHaveCount(1);

  await page.getByRole('button', { name: 'Load older runs' }).click();

  // APPENDED — the reader keeps the rows they were already looking at.
  await expect(page.getByRole('row').filter({ hasText: older })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: newer })).toHaveCount(1);
  // The walk ended, so the control goes and the count is a complete claim again.
  await expect(page.getByRole('button', { name: 'Load older runs' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Triggered \d+\+/ })).toHaveCount(0);

  await expectQuiet(page, problems);
});
