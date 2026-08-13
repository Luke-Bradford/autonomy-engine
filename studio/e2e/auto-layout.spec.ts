import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { viewportSettled } from './support/canvasGraph';
import { openSeededCanvas, rectOf } from './support/seedDoc';

/**
 * U9 — Arrange, the canvas auto-layout (#1004).
 *
 * The layout itself is unit-tested (`autoLayout.test.ts`), where the graph cases
 * live. What only a real browser can prove is the half those tests cannot see:
 * that the button is WIRED, that a bulk position write actually REPAINTS through
 * `FlowCanvas`'s position carry-forward (the hatch U17 built for exactly this,
 * and the one way a correct layout can still leave the picture unchanged), and
 * that the result is one undo step rather than one per node.
 *
 * Every doc here is seeded through the API, which is deliberate and is the
 * ticket's own motivating case: a doc minted anywhere but this canvas — an
 * import, the CLI, a git checkout — routinely carries `{ x: 0, y: 0 }` for every
 * node, and arrives as a pile with its edges invisible underneath.
 *
 * Every assertion below was mutation-checked (recorded in the PR).
 */
const PILE = { x: 40, y: 40 };

test.describe('canvas auto-layout (U9)', () => {
  test('an imported pile becomes a readable left-to-right graph', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e arrange pile', {
      nodes: [
        { id: 'first', position: PILE },
        { id: 'second', position: PILE },
        { id: 'third', position: PILE },
      ],
      edges: [
        { from: 'first', to: 'second', on: 'success' },
        { from: 'second', to: 'third', on: 'success' },
      ],
    });
    await viewportSettled(page);

    const at = (id: string) => rectOf(page, `.react-flow__node[data-id="${id}"]`);

    // The state the ticket is about: three nodes drawn on top of each other.
    const before = await Promise.all([at('first'), at('second'), at('third')]);
    expect(new Set(before.map((r) => `${r.left},${r.top}`)).size).toBe(1);

    const arrange = page.getByRole('button', { name: 'Arrange', exact: true });
    await expect(arrange).toBeEnabled();
    await arrange.click();
    await viewportSettled(page);

    // Laid out along the chain. Screen coords, so this also proves the domain
    // write reached the DOM rather than only the store.
    const [first, second, third] = await Promise.all([at('first'), at('second'), at('third')]);
    expect(first!.left).toBeLessThan(second!.left);
    expect(second!.left).toBeLessThan(third!.left);
    // A chain is one row: same top, and no two nodes left overlapping.
    expect(second!.top).toBeCloseTo(first!.top, 0);
    expect(first!.right).toBeLessThan(second!.left);

    await expect(page.getByText('Arranged 2 activities.')).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('the whole re-layout is ONE undo step', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e arrange undo', {
      nodes: [
        { id: 'a', position: PILE },
        { id: 'b', position: PILE },
        { id: 'c', position: PILE },
      ],
      edges: [
        { from: 'a', to: 'b', on: 'success' },
        { from: 'b', to: 'c', on: 'success' },
      ],
    });
    await viewportSettled(page);

    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeDisabled();

    await page.getByRole('button', { name: 'Arrange', exact: true }).click();
    await viewportSettled(page);
    const spread = await rectOf(page, '.react-flow__node[data-id="c"]');

    // ONE press puts every node back — not one press per node moved. A layout
    // recorded as three entries would leave undo enabled here.
    await undo.click();
    await viewportSettled(page);
    const back = await rectOf(page, '.react-flow__node[data-id="c"]');
    expect(back.left).not.toBeCloseTo(spread.left, 0);
    await expect(undo).toBeDisabled();

    await expectQuiet(page, problems);
  });

  test('a second press says so rather than looking broken', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e arrange idempotent', {
      nodes: [
        { id: 'a', position: PILE },
        { id: 'b', position: PILE },
      ],
      edges: [{ from: 'a', to: 'b', on: 'success' }],
    });
    await viewportSettled(page);

    const arrange = page.getByRole('button', { name: 'Arrange', exact: true });
    await arrange.click();
    await expect(page.getByText('Arranged 1 activity.')).toBeVisible();
    await viewportSettled(page);

    // The already-arranged case. `moveNodes` drops a no-op move silently, so
    // without the message this press is indistinguishable from a dead button.
    await arrange.click();
    await expect(page.getByText('Already arranged — nothing moved.')).toBeVisible();
    // And it recorded nothing: undo still has only the first press to give back.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

    await expectQuiet(page, problems);
  });

  test('#1005 a node WIDER than the nominal size does not crowd the next column', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    // A node is as wide as its TITLE, and the title falls back to the raw
    // activity `type` when the catalog has no entry for it — which the write
    // gate permits (an unknown type fails at DISPATCH, not at save), so this is
    // the doc an import from a newer or older build actually produces. One
    // unbroken token on purpose: a multi-word title can wrap, which would make
    // the width precondition below depend on the pane width instead of on the
    // layout.
    await openSeededCanvas(page, 'e2e arrange wide', {
      nodes: [
        { id: 'wide', type: 'an_extremely_long_unregistered_activity_type_name', position: PILE },
        { id: 'next', position: PILE },
      ],
      edges: [{ from: 'wide', to: 'next', on: 'success' }],
    });
    await viewportSettled(page);

    const at = (id: string) => rectOf(page, `.react-flow__node[data-id="${id}"]`);

    // The PRECONDITION, asserted rather than assumed: this fixture is only the
    // failing case while the rendered box really is wider than the nominal
    // 150 + LAYOUT_GAP 60 the layout used to reserve for it. If a future style
    // change caps node width, this goes red HERE and says why, rather than
    // quietly passing as a test of nothing.
    const wideBefore = await at('wide');
    expect(wideBefore!.width, 'the fixture must render wider than the reserved column').toBeGreaterThan(210);

    await page.getByRole('button', { name: 'Arrange', exact: true }).click();
    await viewportSettled(page);

    // Screen coords: the wide box must END before its neighbour BEGINS. Packed
    // from the nominal width this overlapped by the difference.
    const [wide, next] = await Promise.all([at('wide'), at('next')]);
    expect(wide!.right).toBeLessThan(next!.left);

    await expectQuiet(page, problems);
  });

  test('a container keeps its children, and encloses nothing else', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e arrange container', {
      nodes: [
        { id: 'before', position: PILE },
        { id: 'inner1', position: PILE },
        { id: 'inner2', position: PILE },
        { id: 'after', position: PILE },
      ],
      edges: [
        { from: 'before', to: 'stage1', on: 'success' },
        { from: 'inner1', to: 'inner2', on: 'success' },
        { from: 'stage1', to: 'after', on: 'success' },
      ],
      containers: [{ id: 'stage1', kind: 'stage', children: ['inner1', 'inner2'] }],
    });
    await viewportSettled(page);

    await page.getByRole('button', { name: 'Arrange', exact: true }).click();
    await viewportSettled(page);

    // The box is DERIVED from the union of its members' rects, so a layout that
    // scattered them would draw a box over the nodes in between — asserting a
    // membership the doc does not have.
    const box = await rectOf(page, '.react-flow__node[data-id="stage1"] .flow-container');
    for (const id of ['inner1', 'inner2']) {
      const r = await rectOf(page, `.react-flow__node[data-id="${id}"]`);
      expect(r.left, `${id} sits inside its own box`).toBeGreaterThanOrEqual(box.left - 1);
      expect(r.right, `${id} sits inside its own box`).toBeLessThanOrEqual(box.right + 1);
    }
    for (const id of ['before', 'after']) {
      const r = await rectOf(page, `.react-flow__node[data-id="${id}"]`);
      const overlaps = r.left < box.right && box.left < r.right;
      expect(overlaps, `${id} must not be drawn inside the container box`).toBe(false);
    }

    await expectQuiet(page, problems);
  });
});
