import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

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
  const runListCalls: string[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname === '/api/runs') runListCalls.push(url.search);
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

  // The status WORD, from the Monitor's one vocabulary. The seeded run fails by
  // construction, so this also proves Home reports an outcome rather than
  // painting every row the same.
  await expect(ours).toContainText('failure');

  // Exactly one page, and it asked for Home's own size rather than a reader's
  // screenful of 50. `limit` reaching the wire is the whole point of the
  // `pageSize` parameter — the server aggregates metered costs per returned
  // row, so an over-fetch is billed work thrown away on the catch-all route.
  expect(runListCalls).toHaveLength(1);
  expect(runListCalls[0]).toContain('limit=5');
  expect(runListCalls[0]).not.toContain('cursor=');

  // Nothing offers to extend the prefix: Home is not a paged list.
  await expect(page.getByRole('button', { name: /older|load more/i })).toHaveCount(0);

  // The hub signposts survive the rework — they are the one thing the
  // placeholder got right, and `hub-nav.spec.ts` scopes around them.
  for (const label of ['Author', 'Monitor', 'Manage']) {
    await expect(page.getByRole('link', { name: label })).toBeVisible();
  }

  expectQuiet(problems);
});
