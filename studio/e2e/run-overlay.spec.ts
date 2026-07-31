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
  // The table below is fed by events, so it has no row for `neverRan` at all;
  // this is the whole reason R1 hands the page the version doc.
  await expect(canvas.locator('.run-node')).toHaveCount(3);

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

  // The ENGINE's vocabulary, not the table's `running|retrying|waiting|…`.
  expect(nodes.start!.status).toBe('failure');
  expect(nodes.handled!.status).toBe('failure');
  // `skipped` is not in the doc-free table's vocabulary AT ALL — it can only be
  // known from the graph plus the log together.
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
