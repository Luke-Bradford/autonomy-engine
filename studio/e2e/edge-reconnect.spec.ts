import { expect, test, type Page } from '@playwright/test';
import {
  edgeGroup,
  outcomePort,
  outcomeRadio,
  reconnectEdgeEnd,
  connectById,
  selectEdge,
} from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';
import { collectPageProblems, expectQuiet } from './support/console-guard';

/**
 * U19 slice 2 — an existing edge can be MOVED, in a real browser.
 *
 * The gesture is unreachable from the unit suite for the reason
 * `outcome-ports.spec.ts` records: jsdom measures every element as zero, React
 * Flow culls unmeasured nodes, and a simulated pointer therefore asserts on
 * nothing. Two facts here are additionally invisible to any non-browser test,
 * and both are why this file exists rather than more `canvasStore` cases:
 *
 *  1. **Whether the anchor can be grabbed at all.** React Flow draws it tangent
 *     to the handle and displaced outward by `reconnectRadius`, and nodes paint
 *     above edges — so the handle covers its inner half. If the radius were at
 *     or under `HANDLE_SIZE / 2` there would be no grabbable crescent and the
 *     whole feature would be dead while every unit test stayed green.
 *  2. **Whether it STEALS the port.** The anchor sits where the operator also
 *     starts a NEW edge. A grab area that swallowed the handle would trade one
 *     capability for another, silently, and the store would never know.
 *
 * So the two are asserted together, on the same port, in both directions.
 */

const CHAIN = {
  nodes: [
    { id: 'n_a', type: 'http_request', position: { x: 0, y: 0 } },
    { id: 'n_b', type: 'http_request', position: { x: 320, y: 0 } },
    { id: 'n_c', type: 'http_request', position: { x: 320, y: 200 } },
  ],
  edges: [{ id: 'e_1', from: 'n_a', to: 'n_b', on: 'success' as const }],
};

/** What the panel says the SELECTED edge fires on. */
async function checkedOutcome(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const group = document.querySelector('.edge-outcomes');
    const checked = group?.querySelector<HTMLInputElement>('input[type="radio"]:checked');
    return checked?.value ?? null;
  });
}

/** `(from, to, on)` of every edge the canvas is currently drawing. */
async function renderedEdges(page: Page): Promise<{ id: string; variant: string }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.react-flow__edge')].map((g) => ({
      id: g.getAttribute('data-id') ?? '',
      variant:
        [...g.classList]
          .find((c) => c.startsWith('edge-variant-'))
          ?.slice('edge-variant-'.length) ?? '',
    })),
  );
}

test.describe('U19 slice 2 — rewiring an edge', () => {
  test('dragging the SOURCE end onto another outcome port retypes the edge in place', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u19s2 retype', CHAIN);

    await selectEdge(page);
    expect(await checkedOutcome(page)).toBe(outcomePort('success'));

    await reconnectEdgeEnd(
      page,
      'source',
      { id: 'n_a', outcome: outcomePort('success') },
      { id: 'n_a', outcome: outcomePort('failure') },
    );

    /* The EDGE, not a new one: same id, one line on the canvas, repainted in the
       new outcome's hue. Delete-and-redraw would satisfy "an edge now fires on
       failure" while losing the identity selection and the run log address it
       by, so the id is the assertion that distinguishes the two. */
    await expect.poll(() => renderedEdges(page)).toEqual([{ id: 'e_1', variant: 'failure' }]);

    await expectQuiet(page, problems);
  });

  /**
   * THE COLLISION GUARD, and the reason this spec is the gate for the ticket.
   *
   * The reconnect anchor is drawn at the same port an operator starts a new edge
   * from. Nothing in the unit suite can tell "the anchor is reachable" from "the
   * anchor ate the handle" — both leave the store's own tests green, because
   * neither gesture reaches the store at all when the wrong element takes the
   * pointer. Asserted on the SAME port, after a rewire has already proved the
   * anchor works, so a radius that grew until it covered the handle would fail
   * here rather than shipping as a silent loss of edge authoring.
   */
  test('a port that already has an edge can still start a NEW one', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u19s2 port not stolen', CHAIN);

    await connectById(page, 'n_a', 'n_c', undefined, outcomePort('success'));

    await expect(edgeGroup(page)).toHaveCount(2);
    const drawn = await renderedEdges(page);
    expect(drawn.filter((e) => e.variant === 'success')).toHaveLength(2);

    await expectQuiet(page, problems);
  });

  test('dragging the TARGET end onto another activity moves the edge there', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u19s2 move target', CHAIN);

    await selectEdge(page);
    await reconnectEdgeEnd(page, 'target', { id: 'n_b' }, { id: 'n_c' });

    /* The aria-label names both ENDS by node id (`edgeAriaLabel`), which is the
       only place the DOM states an edge's endpoints — the `<g>` carries its own
       id and its variant class, and nothing else. */
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector('.react-flow__edge')?.getAttribute('aria-label') ?? '',
        ),
      )
      .toBe('Edge from n_a to n_c, on success');

    // Moved, not replaced: still ONE edge, still `e_1`.
    expect(await renderedEdges(page)).toEqual([{ id: 'e_1', variant: 'success' }]);
    await expectQuiet(page, problems);
  });

  /**
   * A refused rewire must SAY SO, and must not offer to author a second edge.
   *
   * The back-edge offer is a button that calls `connect`. Shown on a rewire it
   * would answer "this edge cannot go there" by leaving the operator holding
   * two edges instead of one moved — the one branch in this feature that can
   * silently author state, which is why the decision is a pure predicate
   * (`backEdgeOffer`) and why it is asserted end to end here as well.
   */
  test('a refused rewire explains itself, and offers no back-edge', async ({ page }) => {
    await openSeededCanvas(page, 'e2e u19s2 refusal', {
      nodes: CHAIN.nodes,
      edges: [
        { id: 'e_1', from: 'n_a', to: 'n_b', on: 'success' },
        { id: 'e_2', from: 'n_b', to: 'n_c', on: 'success' },
      ],
    });

    // Select `n_b → n_c` and drag its TARGET end back onto `n_a`, which would
    // close a forward cycle.
    await page.locator('.react-flow__edge[data-id="e_2"]').click();
    await expect(outcomeRadio(page, outcomePort('success'))).toBeChecked();

    await reconnectEdgeEnd(page, 'target', { id: 'n_c' }, { id: 'n_a' });

    const refusal = page.locator('.canvas-refusal');
    await expect(refusal).toContainText('would close a loop');
    await expect(refusal.getByRole('button', { name: 'Make it a back-edge' })).toHaveCount(0);

    // ...and the edge is untouched: still two, still where they were.
    expect(await renderedEdges(page)).toHaveLength(2);
  });

  /**
   * Dropping an edge back where it started is a CANCEL, not a duplicate.
   *
   * Without the graph-minus-this-edge exclusion the candidate is byte-identical
   * to an edge that exists — itself — so the duplicate rule fires and the
   * operator is told the edge they are holding is in the way. This is the
   * end-to-end form of `canvasStore`'s "does not refuse an edge for DUPLICATING
   * ITSELF".
   */
  test('dropping an end back where it started says nothing at all', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u19s2 self drop', CHAIN);

    await selectEdge(page);
    await reconnectEdgeEnd(
      page,
      'source',
      { id: 'n_a', outcome: outcomePort('success') },
      { id: 'n_a', outcome: outcomePort('success') },
    );

    await expect(page.locator('.canvas-refusal')).toHaveCount(0);
    expect(await renderedEdges(page)).toEqual([{ id: 'e_1', variant: 'success' }]);
    await expectQuiet(page, problems);
  });

  /**
   * An UNSELECTED edge has no anchors (`reconnectable` is set per edge on
   * `selected`). Without that gate every edge into a node stacks a grab circle
   * on the one `in` port, and which edge you picked up would be whichever React
   * Flow rendered last.
   */
  test('only the selected edge offers grab anchors', async ({ page }) => {
    await openSeededCanvas(page, 'e2e u19s2 anchors', CHAIN);

    const anchors = () => page.locator('.react-flow__edgeupdater').count();
    expect(await anchors()).toBe(0);

    await selectEdge(page);
    await expect.poll(anchors).toBeGreaterThan(0);
  });
});
