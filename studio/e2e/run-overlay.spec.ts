import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * U11 — the run monitor draws the AUTHORED GRAPH with the run's state on it.
 *
 * The first e2e in this suite to drive a real run: seed a version, bind a manual
 * trigger, fire it, wait for it to settle, then open the run and read the
 * canvas. Everything it asserts is a fact the doc-free node table structurally
 * cannot produce, which is the point of the ticket.
 *
 * The fixture is EGRESS-FREE by construction — every node is a `fail`, a
 * `control` activity the reducer resolves itself (no connection, no network, no
 * subprocess), so the run settles deterministically on any machine:
 *
 *     start ──failure──▶ handled          (runs, and fails)
 *       │
 *       └──success───▶ neverRan           (never dispatched → skipped)
 */
const DOC = {
  nodes: [
    { id: 'start', type: 'fail', config: { message: 'planned' }, position: { x: 0, y: 0 } },
    {
      id: 'handled',
      type: 'fail',
      config: { message: 'also planned' },
      position: { x: 260, y: 0 },
    },
    {
      id: 'neverRan',
      type: 'fail',
      config: { message: 'unreachable' },
      position: { x: 260, y: 160 },
    },
  ],
  edges: [
    { from: 'start', to: 'handled', on: 'failure' as const },
    { from: 'start', to: 'neverRan', on: 'success' as const },
  ],
};

test('U11 — the run canvas shows the engine’s own status for every node, including one that never ran', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, 'U11 overlay', DOC);
  const runId = await fireAndSettle(page, pipelineVersionId);

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  const canvas = page.getByTestId('run-canvas');
  await expect(canvas).toBeVisible();

  // Every node in the DOC is drawn — including the one that never dispatched.
  // The table below is fed by events, so nothing in the LOG accounts for
  // `neverRan`; this is the whole reason R1 hands the page the version doc.
  // (U25 then made the table read that same projection, so it has a row for it
  // now too — the spec below asserts exactly that.)
  await expect(canvas.locator('.run-node')).toHaveCount(3);

  /* Wait for the OVERLAY specifically, not just for the canvas. The graph is
     drawn from the R1 fetch alone, with every node reading `not projected`,
     before the WebSocket has replayed — so the count above is satisfied a beat
     early, and the single `evaluate` below has no auto-retry to save it. This
     is a retrying assertion that can only hold once the projection has landed. */
  await expect(canvas.locator('.run-node-failure')).toHaveCount(2);
  await expect(canvas.getByText('not projected')).toHaveCount(0);

  /* One evaluate, every assertion — a per-assertion round trip is what makes a
     browser-driven verification expensive. Returns the node label, its status
     word, its resolved outline colour and style, keyed by the DOC id RF puts on
     the wrapper. */
  const nodes = await page.evaluate(() => {
    const out: Record<string, { status: string; outline: string; style: string; classes: string }> =
      {};
    for (const el of document.querySelectorAll('.react-flow__node')) {
      const inner = el.querySelector('.run-node');
      if (inner === null) continue;
      const cs = getComputedStyle(inner);
      out[(el as HTMLElement).dataset.id ?? '?'] = {
        status: inner.querySelector('.run-node-status')?.textContent?.trim() ?? '',
        outline: cs.outlineColor,
        style: cs.outlineStyle,
        classes: inner.className,
      };
    }
    return out;
  });

  expect(nodes.start!.status).toBe('failure');
  expect(nodes.handled!.status).toBe('failure');
  // `skipped` is a status no EVENT carries — the reducer computes it — so it can
  // only be known from the doc plus the log together.
  expect(nodes.neverRan!.status).toBe('skipped');

  // The status is not conveyed by colour alone (the word is on the node), and
  // the colours are genuinely distinct + genuinely resolved — a `--var` that
  // failed to resolve would come back as `rgba(0, 0, 0, 0)` or the initial
  // `currentcolor`, which is the silent failure a screenshot cannot catch.
  expect(nodes.start!.outline).toMatch(/^rgb\(/);
  expect(nodes.start!.outline).not.toBe(nodes.neverRan!.outline);

  // Settled encoding: a skipped node is grey and DASHED, matching the skipped
  // edge, so "this did not run" reads the same everywhere on the canvas.
  expect(nodes.neverRan!.style).toBe('dashed');
  expect(nodes.start!.style).toBe('solid');

  // The monitor is READ-ONLY: React Flow marks a draggable node with its own
  // class, and a run canvas must never carry it.
  await expect(canvas.locator('.react-flow__node.draggable')).toHaveCount(0);
  // …and there is no container delete control anywhere on it (the affordance a
  // `readOnly` prop on the author canvas would NOT have suppressed).
  await expect(canvas.locator('.flow-container-delete')).toHaveCount(0);

  await expectQuiet(page, problems);
});

/**
 * U25 — the graph and the node table are ONE vocabulary, and the table stops
 * omitting the nodes only the doc can account for.
 *
 * Reuses the fixture above deliberately: `neverRan` is routed around, and the
 * U11 spec's own comment recorded the defect this closes — "the table below is
 * fed by events, so it has no row for `neverRan` at all". One page, two answers.
 *
 * The load-bearing assertion is the equality of the two maps: for every node,
 * the word on the graph equals the word in the table.
 *
 * Be honest about its REACH, because it is easy to overclaim. This fixture is
 * three `fail` nodes, so the statuses in play are `failure`/`failure`/`skipped`
 * — all three of which word to themselves. The equality therefore proves the
 * two surfaces read the same MAP; it would still hold if neither of them worded
 * anything. What pins the wording itself is `runFlow.test.ts`'s `dispatched` →
 * "running" case (graph side) and `RunDetailPage.test.tsx` (table and panel
 * side), both of which use statuses whose label differs from their identifier
 * and both of which go red when the label call is removed. An e2e that parked a
 * real node on a timer would fold those together, and needs a `wait` fixture
 * that settles deterministically — worth doing, not worth blocking on.
 */
test('U25 — the node table and the graph give every node the same word, including a skipped one', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, 'U25 vocabulary', DOC);
  const runId = await fireAndSettle(page, pipelineVersionId);

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  /* Wait on the RECONCILED table rather than the canvas: the reconciliation is
     gated on a complete WebSocket replay, so a row for `neverRan` existing at
     all is proof the projection landed AND that the table read it. Before U25
     this row could never appear, no matter how long the wait. */
  const skippedRow = page.getByRole('row').filter({ hasText: 'neverRan' });
  await expect(skippedRow).toHaveCount(1);
  await expect(skippedRow.getByText('skipped', { exact: true })).toBeVisible();

  // The drill-in panel is the third surface that renders a status, so it reads
  // from the same map — a node routed around says so there too.
  await page.getByRole('button', { name: 'Fail 3', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Node Fail 3' }).getByText('skipped', {
      exact: true,
    }),
  ).toBeVisible();

  /* ONE evaluate for the whole comparison — a per-node round trip is what makes
     a browser-driven check expensive. Pairs each node's graph word with its
     table word, keyed by the doc id React Flow puts on the wrapper and by the
     row's own node-id cell. */
  const words = await page.evaluate(() => {
    const graph: Record<string, string> = {};
    for (const el of document.querySelectorAll('.react-flow__node')) {
      const inner = el.querySelector('.run-node');
      if (inner === null) continue;
      graph[(el as HTMLElement).dataset.id ?? '?'] =
        inner.querySelector('.run-node-status')?.textContent?.trim() ?? '';
    }
    const table: Record<string, string> = {};
    for (const row of document.querySelectorAll('tbody tr')) {
      /* The row's node-id cell, NOT the drill-in button — since #882 the button
         holds the activity NAME ('Fail 3') while the graph wrapper is keyed on
         the doc id, so keying off the button would compare two different things
         and report a difference that is not one. The button is still the
         fallback, because it is what holds the id when the pipeline version will
         not resolve and there is no name to show. */
      const id =
        row.querySelector('.node-id')?.textContent?.trim() ??
        row.querySelector('.node-drill-in')?.textContent?.trim();
      const status = row.querySelector('.node-status')?.textContent?.trim();
      if (id !== undefined && status !== undefined) table[id] = status;
    }
    return { graph, table };
  });

  // Every node the graph draws has a table row — that equivalence is new, and
  // it is what "the table stops omitting nodes" means concretely.
  expect(Object.keys(words.table).sort()).toEqual(Object.keys(words.graph).sort());
  // …and neither surface has a word the other does not.
  expect(words.table).toEqual(words.graph);
  // Pinned outright, so a change that made BOTH surfaces agree on the wrong
  // word could not pass the equality above in silence.
  expect(words.table.neverRan).toBe('skipped');
  expect(words.table.start).toBe('failure');

  await expectQuiet(page, problems);
});
