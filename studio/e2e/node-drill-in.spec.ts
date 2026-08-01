import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * U24 (slice 1) — the run monitor says WHY a node failed, and a node OPENS.
 *
 * Before this, `#1 F0` had moved the failure class out of the message string
 * and into `node.failed.kind`/`.code` fields, and nothing in the web app read
 * either — so a throttled provider and a dead credential rendered identically,
 * as the bare message. A node's declared outputs were shown nowhere at all.
 *
 * EGRESS-FREE by construction, like `run-overlay.spec.ts`: both nodes are
 * `fail`, a `control` activity the reducer resolves itself with no connection,
 * no network and no subprocess. The driver appends its `node.failed` with a
 * FIXED `kind:'permanent'` and `code:'forced_fail'` (`run/driver.ts`), which is
 * what makes this deterministic — and `forced_fail` in particular is a string
 * that exists nowhere in the UI's own vocabulary, so seeing it on screen can
 * only mean it was read out of the event log.
 *
 *     start ──failure──▶ handled
 */
const DOC = {
  nodes: [
    { id: 'start', type: 'fail', config: { message: 'planned' }, position: { x: 0, y: 0 } },
    {
      id: 'handled',
      type: 'fail',
      /* NOT a substring of `start`'s message, deliberately: a text locator that
         matches both rows is a strict-mode violation, and the near-miss version
         of that is worse — an assertion that passes against the WRONG row. */
      config: { message: 'downstream' },
      position: { x: 260, y: 0 },
    },
  ],
  edges: [{ from: 'start', to: 'handled', on: 'failure' as const }],
};

test('U24 — a failed node names its failure CLASS, and opens a drill-in', async ({ page }) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, 'U24 drill-in', DOC);
  const runId = await fireAndSettle(page, pipelineVersionId);

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  // The node table's Detail column now carries the class beside the message.
  // Retrying assertion: it can only hold once the stream has replayed.
  await expect(
    page.getByRole('cell', { name: 'planned (permanent · forced_fail)', exact: true }),
  ).toBeVisible();

  /* #882 — the table names a node the way the GRAPH beside it does, and keeps
     the raw id. Both halves are asserted, because each fails a different way: a
     straight swap to the name would break the only lookup that matches this
     run's `${nodes.<id>…}` expressions and the ids in the event feed below, and
     the `exact: true` selectors throughout this spec catch the opposite mistake
     — an id left INSIDE the button, where it would join the accessible name and
     make every row announce `Fail 1 start`.

     `getByRole('button', { name: 'Fail 1', exact: true })` is therefore already
     the load-bearing assertion for the naming half; this adds the id's survival,
     which nothing else here would notice the loss of. */
  const nodeCell = page.getByRole('row').filter({ hasText: 'Fail 1' }).getByRole('cell').first();
  await expect(nodeCell).toContainText('start');

  // No drill-in until one is asked for.
  await expect(page.getByRole('complementary', { name: 'Node Fail 1' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Fail 1', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Node Fail 1' });
  await expect(panel).toBeVisible();

  /* One evaluate, every assertion — a per-assertion round trip is what makes a
     browser-driven verification expensive. Reads the panel's rendered text plus
     the computed colour of its status pill, because a `--var` that failed to
     resolve is exactly the silent failure a screenshot cannot catch. */
  const seen = await page.evaluate(() => {
    const el = document.querySelector('aside.node-detail-panel');
    if (el === null) return null;
    const pill = el.querySelector('.node-status');
    return {
      text: (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
      pill: pill?.textContent?.trim() ?? '',
      pillColor: pill === null ? '' : getComputedStyle(pill).color,
      // The drill-in must not smuggle in a control-plane WRITE (U28 keeps the
      // monitor read-only): the only button in the panel is Close.
      buttons: [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? ''),
    };
  });

  expect(seen).not.toBeNull();
  expect(seen!.text).toContain('planned');
  expect(seen!.text).toContain('permanent');
  // The one string that cannot have come from anywhere but the event log.
  expect(seen!.text).toContain('forced_fail');
  expect(seen!.pill).toBe('failure');
  expect(seen!.pillColor).toMatch(/^rgb/);
  expect(seen!.buttons).toEqual(['Close']);

  // Opening a DIFFERENT node swaps the panel rather than stacking one.
  await page.getByRole('button', { name: 'Fail 2', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Node Fail 2' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Node Fail 1' })).toHaveCount(0);

  await page
    .getByRole('complementary', { name: 'Node Fail 2' })
    .getByRole('button', { name: 'Close' })
    .click();
  await expect(page.getByRole('complementary', { name: 'Node Fail 2' })).toHaveCount(0);

  await expectQuiet(page, problems);
});
