import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openCanvas } from './support/canvas';

/**
 * #1075 — Monitor › Audit: an act performed in the app appears in the workspace
 * audit log, in the reader's words.
 *
 * Why this needs a browser. Three separately-tested pieces have to line up and
 * no unit suite spans them: the SERVER writes a `pipeline.archived` event on
 * `POST /api/pipelines/:id/archive`, the api wrapper walks
 * `GET /api/workspace/audit`, and `describeWorkspaceEvent` turns the payload
 * into a sentence. The page test mocks the api, so a wrapper pointed at the
 * wrong path — or a route the hub links to but never registered — passes every
 * vitest run in the repo. This is the seam.
 *
 * ISOLATION, because the audit log is the one surface that accumulates the
 * WHOLE run's history: `reset-state.mjs` wipes the DB once per run, not per
 * spec, and every other spec that archives, restores or connects a repo writes
 * into this same log. So each test here locates its OWN uniquely-named
 * pipeline's row and asserts nothing about the log's total COUNT.
 *
 * #1076 AMENDED THAT, in one specific way, and the amendment is safe for a
 * reason worth writing down rather than assuming. The second test below DOES
 * assert which row is first — which the original wording ruled out. What made
 * that rule right was never "the data is uncontrolled"; it was that another
 * spec could append between the act and the read. It cannot: `playwright.config.ts`
 * runs `workers: 1, fullyParallel: false`, so specs are strictly serial and
 * nothing else writes to this log while a test here is running. An event this
 * test appends is therefore the newest event in the workspace, full stop. Every
 * OTHER assertion still avoids counts, because the rows BELOW the ones this
 * test appends belong to whatever ran before it.
 */

/** The pipeline id out of the canvas's own URL (`#/author/pipelines/<id>`). */
function pipelineIdFrom(url: string): string {
  const id = url.split('/').pop();
  expect(id, `no pipeline id in canvas url ${url}`).toBeTruthy();
  return id!;
}

test.describe('#1075 the workspace audit log is readable in the app', () => {
  test('an archive performed in the workspace shows up as a named entry', async ({ page }) => {
    const problems = collectPageProblems(page);
    const name = 'e2e 1075 audited pipeline';

    await openCanvas(page, name);
    const pipelineId = pipelineIdFrom(page.url());

    // The audit page BEFORE the act. The log is shared with every other spec,
    // so the meaningful precondition is not "empty" — it is that this
    // pipeline's own entry is absent, which is what makes its later presence
    // evidence of the archive rather than of a row that was always there.
    await page.goto('/#/monitor/audit');
    const entry = page.getByRole('row').filter({ hasText: `Archived the pipeline ${name}` });
    await expect(page.getByRole('heading', { name: 'Audit' })).toBeVisible();
    await expect(entry).toHaveCount(0);

    // Archived over the API rather than through the list UI: this spec is about
    // the AUDIT surface, and driving the archive through another page would
    // make it fail for that page's reasons too (`archive-from-list.spec.ts`
    // owns that narrative).
    const archived = await page.request.post(`/api/pipelines/${pipelineId}/archive`);
    expect(archived.status()).toBe(200);

    // The page loads on mount and does not poll — an audit log only moves when
    // the operator acts elsewhere — so this is the reader's own refresh.
    await page.getByRole('button', { name: 'Refresh audit log' }).click();
    await expect(entry).toBeVisible();

    // The row carries the actor and the particulars, not just the act. The
    // archive disabled no triggers (this pipeline has none), and the log says
    // so rather than leaving the cell blank — an absent fact and a zero are
    // different things.
    await expect(entry).toContainText('local');
    await expect(entry).toContainText('No triggers were enabled, so none were disabled.');

    // Reachable the way an operator reaches it, not only by typed URL: the
    // Monitor hub's own pane must offer the section.
    await page.goto('/#/monitor/runs');
    await page.getByRole('navigation', { name: 'Monitor sections' }).getByText('Audit').click();
    await expect(page).toHaveURL(/#\/monitor\/audit$/);
    await expect(entry).toBeVisible();

    await expectQuiet(page, problems);
  });

  /**
   * #1076 — the page asks the SERVER for newest-first and renders one page, so
   * the two facts this asserts are (a) the newest event is at the TOP on first
   * paint, and (b) an entry pushed past the page boundary is not silently
   * missing — it is behind "Load older entries".
   *
   * Why this needs a browser rather than the page test that already pins both
   * shapes against mocked data: the ORDER and the PAGE SIZE are decided by the
   * server, from a query the api wrapper builds. A wrapper that dropped
   * `order=desc`, or a route whose default direction disagreed with it, would
   * pass every vitest run in the repo and put the OLDEST entries on screen
   * under a "most recent entry first" caption. This is the only place the two
   * halves meet.
   */
  test('the newest entry is on top, and older ones are a page away', async ({ page }) => {
    const problems = collectPageProblems(page);
    const name = 'e2e 1076 first entry';

    await openCanvas(page, name);
    const targetId = pipelineIdFrom(page.url());
    expect((await page.request.post(`/api/pipelines/${targetId}/archive`)).status()).toBe(200);

    // (a) FIRST PAINT. Nothing else can have appended since the archive above
    // (single worker, serial specs), so this pipeline's entry IS the newest
    // event in the workspace and must be the first data row.
    await page.goto('/#/monitor/audit');
    const rows = page.getByRole('table').getByRole('row');
    const target = rows.filter({ hasText: `Archived the pipeline ${name}` });
    await expect(target).toHaveCount(1);
    // `.nth(1)` — row 0 is the header.
    await expect(rows.nth(1)).toContainText(`Archived the pipeline ${name}`);

    // Bury it. Archive and restore each emit only on a REAL state change, so a
    // cycle is exactly two events; 13 cycles is 26, one more than a page.
    const filler = 'e2e 1076 filler';
    await openCanvas(page, filler);
    const fillerId = pipelineIdFrom(page.url());
    for (let i = 0; i < 13; i++) {
      expect((await page.request.post(`/api/pipelines/${fillerId}/archive`)).status()).toBe(200);
      expect((await page.request.post(`/api/pipelines/${fillerId}/restore`)).status()).toBe(200);
    }

    // (b) The entry is now off the first page — and its ABSENCE is the point:
    // before #1076 the page walked the whole log, so every entry was always
    // present and there was nothing to load.
    await page.goto('/#/monitor/audit');
    await expect(rows.nth(1)).toContainText('Restored the pipeline');
    await expect(target).toHaveCount(0);

    const older = page.getByRole('button', { name: 'Load older entries' });
    await expect(older).toBeVisible();

    // Click until it surfaces or the log runs out. A fixed number of clicks
    // would be a guess: earlier specs in the run leave their own entries above
    // this one, and that count is not this spec's to know.
    for (let click = 0; click < 10 && (await target.count()) === 0; click++) {
      if (!(await older.isVisible())) break;
      const before = await rows.count();
      await older.click();
      // A row-count INCREASE is the settled signal: the older page appends, so
      // the table grows, and this waits for the append rather than for the
      // request. It also pins that the page appends rather than replaces —
      // a replacing page would leave the count flat and time out here.
      await expect.poll(() => rows.count()).toBeGreaterThan(before);
    }
    await expect(target).toHaveCount(1);

    await expectQuiet(page, problems);
  });
});
