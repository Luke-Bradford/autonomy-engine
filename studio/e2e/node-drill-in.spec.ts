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

/**
 * #869 — a node's declared outputs are bounded in the DOM, not merely clamped
 * on screen.
 *
 * `.node-detail-outputs` capped the block at `12rem` with a scrollbar, which
 * stops a payload taking over the panel and does nothing about the document:
 * every character was still serialized and still mounted. An agent node's
 * `text` output is realistically tens of KB.
 *
 * EGRESS-FREE like the test above. `filter` is the only egress-free activity
 * that SUCCEEDS carrying a real declared output (`kind:'control'`, no
 * connection, never dispatched — the reducer evaluates it and the driver
 * appends `node.succeeded{outputs:{result}}`; see `rerun-from-failed.spec.ts`).
 * Its `items` come from a param DEFAULT because `fireManualTrigger` sends no
 * params and `resolveRunParams` applies defaults at run start.
 *
 * The predicate passes EVERY item through deliberately: the fixture's purpose
 * is a large `result`, and a filtering predicate would make the rendered size
 * depend on arithmetic rather than on the cap under test.
 */
const BIG_OUTPUT_DOC = {
  params: [
    {
      name: 'nums',
      type: 'json' as const,
      required: false,
      // ~8.9 KB serialized — comfortably past the 4,000-character cap, and
      // stated as a range rather than a literal so the intent survives an edit.
      default: Array.from({ length: 2000 }, (_, i) => i + 1),
    },
  ],
  nodes: [
    {
      id: 'big',
      type: 'filter',
      config: { items: '${params.nums}', predicate: '${greater(item, 0)}' },
      position: { x: 0, y: 0 },
    },
  ],
};

const OUTPUT_CAP = 4000;

test('#869 — an oversized output is capped in the DOM, and the rest is one click away', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, '#869 big output', BIG_OUTPUT_DOC);
  const runId = await fireAndSettle(page, pipelineVersionId);

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  await page.getByRole('button', { name: 'Filter 1', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Node Filter 1' });
  await expect(panel).toBeVisible();

  /* ONE evaluate for every collapsed-state assertion — a per-assertion round
     trip is what makes a browser-driven verification expensive. */
  const collapsed = await page.evaluate(() => {
    const el = document.querySelector('aside.node-detail-panel');
    const code = el?.querySelector('.node-detail-outputs');
    const button = [...(el?.querySelectorAll('button') ?? [])].find((b) =>
      /^Show all /.test(b.textContent ?? ''),
    );
    return {
      // The DOM cap, read off the live document rather than off a snapshot.
      chars: code?.textContent?.length ?? -1,
      // The whole panel, so a tail hidden from the <code> but leaked elsewhere
      // would still be caught.
      panelChars: (el as HTMLElement | null)?.innerText.length ?? -1,
      hint: [...(el?.querySelectorAll('.page-hint') ?? [])]
        .map((p) => p.textContent ?? '')
        .join(' '),
      expanded: button?.getAttribute('aria-expanded') ?? null,
      controls: button?.getAttribute('aria-controls') ?? null,
      controlled: code?.id ?? null,
      // Offered WHILE COLLAPSED — selecting the block by hand at this point
      // would copy the cut string, so the full-value copy must not be behind
      // the reveal.
      copy: [...(el?.querySelectorAll('button') ?? [])].some((b) =>
        /^Copy all /.test(b.textContent ?? ''),
      ),
    };
  });

  expect(collapsed.chars).toBe(OUTPUT_CAP);
  expect(collapsed.hint).toContain(`showing the first ${OUTPUT_CAP} of`);
  expect(collapsed.expanded).toBe('false');
  // The toggle names the region it reveals, so a screen reader is not asked to
  // guess which block just changed.
  expect(collapsed.controls).toBe(collapsed.controlled);
  expect(collapsed.controlled).not.toBeNull();
  /* Presence only, here. WHAT it puts on the clipboard is pinned by the unit
     test, which can assert the string without asking Chromium for a
     clipboard-read permission this suite does not otherwise need. */
  expect(collapsed.copy).toBe(true);

  await panel.getByRole('button', { name: /^Show all / }).click();

  const opened = await page.evaluate(() => {
    const el = document.querySelector('aside.node-detail-panel');
    const code = el?.querySelector('.node-detail-outputs');
    const button = [...(el?.querySelectorAll('button') ?? [])].find((b) =>
      /^Show first /.test(b.textContent ?? ''),
    );
    return {
      chars: code?.textContent?.length ?? -1,
      tail: (code?.textContent ?? '').slice(-6),
      expanded: button?.getAttribute('aria-expanded') ?? null,
    };
  });

  // The whole value, ending where the real payload ends — a fixed tail rather
  // than "longer than the cap", which a merely-larger truncation would pass.
  expect(opened.chars).toBeGreaterThan(OUTPUT_CAP);
  expect(opened.tail).toBe('2000]}');
  expect(opened.expanded).toBe('true');

  await expectQuiet(page, problems);
});
