import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';
import { DENSITIES, expectAppearance, preferAppearance } from './support/appearance';
import { offRampText } from './support/typeRamp';

/**
 * U15 slice 1 (#1085) — the Home hub stops being a placeholder.
 *
 * `/` is the app's entry point AND the router's catch-all, so it is the surface
 * an operator sees most and, until this ticket, the one that said least: it
 * signposted the hubs and reported nothing at all about the workspace.
 *
 * The fixture is a real settled run of a NAMED pipeline, fired through the
 * public API exactly as an operator would. `fail` is a control activity —
 * egress-free, no connection, no network — so the run terminalizes on a test
 * machine without a provider.
 *
 * SCOPED TO THIS RUN, never to a position or a count. The e2e database is
 * shared and the suite is serial (`workers: 1`), so "the newest row is ours"
 * holds only until another spec fires a run, and Home shows a bounded PREFIX
 * (five) of a list every other spec is appending to. "Our run's pipeline is
 * named on Home" stays true regardless of what else has run — provided the
 * suite has not pushed it past the fifth row, which is why this spec fires its
 * run immediately before looking.
 *
 * The empty state is deliberately NOT covered here: it needs a workspace with
 * zero runs, which a shared serial database cannot offer. `HomePage.test.tsx`
 * owns it, along with the loading and error states.
 */
test('U15 — Home names the workspace’s recent runs and links each to its detail', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const pipelineName = `Home recent ${Date.now()}`;
  const { pipelineVersionId } = await seedVersion(page, pipelineName, {
    nodes: [{ id: 'n1', type: 'fail', config: { message: 'expected' }, position: { x: 0, y: 0 } }],
  });
  const runId = await fireAndSettle(page, pipelineVersionId, 'e2e home trigger');

  // Count the run-list requests the page actually makes. Home must fetch ONE
  // page and stop — the never-walks rule, proved in the real browser rather
  // than against a mocked wrapper.
  const runListCalls: URLSearchParams[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname === '/api/runs') runListCalls.push(url.searchParams);
  });

  await page.goto('/#/');
  await fluentRootReady(page);

  // The section exists and is labelled, so a screen reader reaches it as a
  // named region rather than a loose list under the page heading.
  const recent = page.getByRole('region', { name: 'Recent runs' });
  await expect(recent).toBeVisible();

  // OUR run, by the pipeline it ran — the identity an operator reads.
  const ours = recent.getByRole('link').filter({ hasText: pipelineName });
  await expect(ours).toHaveCount(1);
  await expect(ours).toHaveAttribute('href', new RegExp(`/monitor/runs/${runId}$`));

  // The status WORD, from the Monitor's one vocabulary, in our run's row. The
  // seeded run fails by construction, so this also proves Home reports an
  // outcome rather than painting every row the same.
  await expect(recent.getByRole('row').filter({ hasText: pipelineName })).toContainText('failure');

  // Exactly one page, and it asked for Home's own size rather than a reader's
  // screenful of 50. `limit` reaching the wire is the whole point of the
  // `pageSize` parameter — the server aggregates metered costs per returned
  // row, so an over-fetch is billed work thrown away on the catch-all route.
  //
  // Read the param and compare it EXACTLY. A `toContain('limit=5')` over the
  // query string passes against `limit=50` — "50" contains "5" — so the
  // assertion survived the very mutation it exists to catch (page size dropped,
  // wrapper falls back to RUNS_PAGE_SIZE=50). Found by the mutation pass.
  expect(runListCalls).toHaveLength(1);
  expect(runListCalls[0]!.get('limit')).toBe('5');
  expect(runListCalls[0]!.get('cursor')).toBeNull();

  // Nothing offers to extend the prefix: Home is not a paged list.
  await expect(page.getByRole('button', { name: /older|load more/i })).toHaveCount(0);

  // The hub signposts survive the rework — they are the one thing the
  // placeholder got right, and `hub-nav.spec.ts` scopes around them.
  //
  // SCOPED to Home's own section: the rail names the same hubs, so an unscoped
  // `getByRole('link', {name: 'Author'})` matches two elements and fails strict
  // mode. `App.test.tsx` carries the same warning about the same ambiguity —
  // this spec rediscovered it the expensive way.
  const shortcuts = page.getByRole('region', { name: 'Go to' });
  for (const label of ['Author', 'Monitor', 'Manage']) {
    await expect(shortcuts.getByRole('link', { name: label })).toBeVisible();
  }

  await expectQuiet(page, problems);
});

/**
 * #1594 OR40 S6 — Home on the design system, in both densities: every piece of
 * its text on the type ramp, its runs a table (the one table style, which
 * `table-style.spec.ts` measures) rather than a stack of cards, its shortcuts
 * plain links, and no paragraph of prose under the title.
 */
for (const density of DENSITIES) {
  test(`#1594 OR40 S6 — Home's text is on the type ramp, with no cards or prose (${density})`, async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    // A run, so the table (not the empty line) is what is measured.
    const { pipelineVersionId } = await seedVersion(page, `S6 Home ${density} ${Date.now()}`, {
      nodes: [
        { id: 'n1', type: 'fail', config: { message: 'expected' }, position: { x: 0, y: 0 } },
      ],
    });
    await fireAndSettle(page, pipelineVersionId, `S6 Home ${density}`);
    await preferAppearance(page, 'light', density);
    await page.goto('/#/');
    await fluentRootReady(page);
    await expectAppearance(page, 'light', density);
    await expect(
      page.getByRole('table', { name: 'Recent runs' }).getByRole('row').nth(1),
    ).toBeVisible();

    expect(await offRampText(page, density)).toEqual([]);
    const shape = await page.evaluate(() => ({
      prose: document.querySelectorAll('.content .page-hint').length,
      cards: [...document.querySelectorAll<HTMLElement>('.content a')].filter((a) => {
        const s = getComputedStyle(a);
        return s.borderTopWidth !== '0px' || s.backgroundColor !== 'rgba(0, 0, 0, 0)';
      }).length,
    }));
    expect(shape).toEqual({ prose: 0, cards: 0 });

    await expectQuiet(page, problems);
  });
}
