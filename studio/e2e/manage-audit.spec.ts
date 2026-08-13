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
 * into this same log. So this spec locates its OWN uniquely-named pipeline's
 * row and asserts nothing about counts, ordering or which row is first —
 * newest-first is pinned in `AuditPage.test.tsx`, where the data is controlled.
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
    await page.getByRole('button', { name: 'Refresh' }).click();
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
});
