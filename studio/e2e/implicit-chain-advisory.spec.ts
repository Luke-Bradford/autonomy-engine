import { expect, test } from '@playwright/test';
import { edgeGroup, selectEdge } from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openSeededCanvas, type SeedDoc } from './support/seedDoc';

/**
 * #788 — an edge-less doc runs as a SEQUENCE, and the canvas says so.
 *
 * `effectiveEdges` synthesizes a success chain over node array order whenever a
 * doc authors no edges. So an edge list going from non-empty to empty does not
 * merely remove routing, it REPLACES it: the graph that said "three independent
 * roots" now means "run them in a line", and the only thing that ever announced
 * the convention was the absence of edges. The engine semantics are unchanged
 * (the operator's call on #788 — the inference is in the shipped MVP and docs
 * authored without edges depend on it); what this covers is that the topology is
 * now legible before it gets minted into an immutable version.
 *
 * Why an e2e and not just the unit specs: the load-bearing case is a GESTURE.
 * `FlowCanvas.test.tsx` can mount a store that already holds an edge-less graph,
 * but it cannot delete the last edge through React Flow's own selection and key
 * handling and watch the advisory arrive — and "delete every edge and save" is
 * exactly the path the ticket was filed about.
 */

const ADVISORY = '.canvas-advisory';

function chainDoc(ids: string[]): SeedDoc {
  return { nodes: ids.map((id, i) => ({ id, position: { x: i * 220, y: 0 } })) };
}

test.describe('implicit-chain advisory (#788)', () => {
  test('deleting the LAST edge announces the sequence the graph has become', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'implicit chain — last edge', {
      ...chainDoc(['a', 'b', 'c']),
      edges: [
        { from: 'a', to: 'b', on: 'success' },
        { from: 'a', to: 'c', on: 'success' },
      ],
    });

    // Routed: a fans out to b and c. Nothing is inferred, so nothing is said.
    await expect(edgeGroup(page)).toHaveCount(2);
    await expect(page.locator(ADVISORY)).toHaveCount(0);

    await selectEdge(page);
    await page.keyboard.press('Backspace');
    await expect(edgeGroup(page)).toHaveCount(1);
    // Still routed — one edge is enough to switch the inference off entirely.
    await expect(page.locator(ADVISORY)).toHaveCount(0);

    await selectEdge(page);
    await page.keyboard.press('Backspace');
    await expect(edgeGroup(page)).toHaveCount(0);

    /* The fan-out is gone and the graph is now a LINE — which is the surprising
       part, and the whole reason the panel exists. It names the order, so the
       operator can see that it is array order and not anything they drew. */
    const advisory = page.locator(ADVISORY);
    await expect(advisory).toContainText('run in one sequence');
    await expect(advisory).toContainText('a → b → c');

    await expectQuiet(page, problems);
  });

  test('a seeded edge-less doc is announced on arrival, before anything is touched', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    // The import / git-checkout path — the operator did not author this state,
    // so it is the one they are least likely to have reasoned about.
    await openSeededCanvas(page, 'implicit chain — seeded', chainDoc(['first', 'second', 'third']));

    await expect(page.locator(ADVISORY)).toContainText('first → second → third');
    await expectQuiet(page, problems);
  });

  test('says nothing about a single activity — there is no sequence to warn about', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'implicit chain — lone node', chainDoc(['only']));

    await expect(page.locator(ADVISORY)).toHaveCount(0);
    await expectQuiet(page, problems);
  });

  /**
   * `pointer-events: none` is not cosmetic here. The panel sits at top-center
   * over live canvas, and it appears exactly when the operator is mid-edit
   * (they just deleted an edge) — so if it swallowed clicks it would block the
   * re-authoring it exists to prompt.
   */
  test('does not eat clicks aimed at the canvas underneath it', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'implicit chain — hit testing', chainDoc(['a', 'b']));

    const box = await page.locator(ADVISORY).boundingBox();
    expect(box, 'the advisory must be on screen for this to mean anything').not.toBeNull();
    const hit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return { advisory: el?.closest('.canvas-advisory') != null };
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );
    expect(hit.advisory).toBe(false);

    await expectQuiet(page, problems);
  });
});
