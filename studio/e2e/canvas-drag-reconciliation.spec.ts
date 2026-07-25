import { expect, test, type Page } from '@playwright/test';
import { openCanvas } from './support/canvas';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes, viewportSettled } from './support/canvasGraph';

/**
 * The P5c drag-reconciliation invariant the epic asks to be pinned "before
 * U6a", and which U6a therefore owns.
 *
 * `FlowCanvas`'s store→view effect rebuilds the React Flow node array from the
 * domain nodes on every store change, carrying forward each surviving node's
 * LIVE view position and its `measured` size. Without that carry-forward, a
 * store change lands the node back on its domain position and drops the
 * measured box.
 *
 * U5 attempted this as a unit test and DELETED it rather than ship it green:
 * "an unrelated store change does not remount an existing node" does not
 * discriminate, because React keys node elements by id, so DOM identity
 * survives even with the carry-forward removed outright (confirmed by
 * mutation). The property only diverges MID-GESTURE, when the view position
 * leads the uncommitted domain position — a state jsdom cannot produce and
 * which does not survive a settled drag. So it has to be driven with a real
 * pointer here, and observed while the button is still down.
 *
 * The mid-gesture store change is forced by clicking a toolbox button through
 * `dispatchEvent` while the mouse is held. That is synthetic — but the
 * invariant under test is the RECONCILIATION, not the provenance of the store
 * change, and what makes the spec real is the mutation check: deleting the
 * position carry-forward turns the assertion below red (recorded in the PR).
 */

/** The `translate(x, y)` React Flow writes on a node, in FLOW coordinates.
 *  Read from the node itself, never from `boundingBox()` — a screen box also
 *  moves with the viewport, so a pan or a fitView would masquerade as a
 *  reconciliation failure (and vice versa). */
function nodeTransform(page: Page, index: number): Promise<string> {
  return page.evaluate((i) => {
    const nodes = document.querySelectorAll('.react-flow__node');
    const el = nodes[i as number];
    if (!el) throw new Error(`no node at index ${String(i)}`);
    return (el as HTMLElement).style.transform;
  }, index);
}

function nodeCount(page: Page): Promise<number> {
  return canvasNodes(page).count();
}

test.describe('canvas drag reconciliation (P5c invariant)', () => {
  test('a store change MID-DRAG does not snap the dragged node back', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e drag reconcile');

    await addActivity(page, 'HTTP Request');
    await expect(canvasNodes(page)).toHaveCount(1);

    // WAIT for React Flow to have measured the node and attached its drag
    // handlers — the `draggable` class is RF's own signal that it has. Dragging
    // before that produces a gesture the library never sees, and the spec then
    // fails on "the node never moved" for a reason that has nothing to do with
    // the invariant.
    const node = canvasNodes(page).first();
    await expect(node).toHaveClass(/\bdraggable\b/);
    // Centre the node deterministically. Without this the grab point is
    // whatever the un-resolved `fitView` left on screen, and a node whose
    // centre falls outside `.canvas-wrap` (which clips) still reports a full
    // `boundingBox()` — so the pointer lands off the canvas and no drag starts.
    await page.locator('.react-flow__controls-fitview').click();
    await viewportSettled(page);

    const settled = await nodeTransform(page, 0);
    expect(settled).not.toBe('');

    const box = await node.boundingBox();
    if (!box) throw new Error('the node is not laid out');

    // Grab the node BODY (not a handle — that would start a CONNECTION) and
    // drag it well past React Flow's drag threshold, WITHOUT releasing. The
    // small nudge first crosses the threshold; `dragging` is RF confirming the
    // gesture is live, so the big move below is measured against a real drag.
    await page.mouse.move(box.x + box.width / 2, box.y + 6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + 16, { steps: 3 });
    await expect(node).toHaveClass(/\bdragging\b/);
    await page.mouse.move(box.x + box.width / 2 + 140, box.y + 6 + 90, { steps: 12 });

    const midDrag = await nodeTransform(page, 0);
    expect(midDrag, 'the drag never moved the node').not.toBe(settled);

    // Force a domain-store change while the gesture is still in flight. A
    // native click cannot be delivered with a button held down, so the button
    // is activated directly — the reconciliation is what is under test, not how
    // the store came to change.
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const add = buttons.find((b) => b.textContent?.includes('HTTP Request'));
      if (!add) throw new Error('no toolbox button to click');
      add.click();
    });
    await expect.poll(() => nodeCount(page)).toBe(2);

    // THE INVARIANT: the dragged node is still where the pointer put it. With
    // the carry-forward removed it reverts to its domain position — which is
    // `settled`, because a mid-drag position change is deliberately not
    // committed to the store.
    expect(
      await nodeTransform(page, 0),
      'the dragged node snapped back to its domain position mid-gesture',
    ).toBe(midDrag);

    await page.mouse.up();

    // NOTE: there is deliberately no "…and the settled drag still commits to the
    // store" assertion here. The obvious one — re-reading the transform after
    // `mouse.up()` and expecting `midDrag` — CANNOT FAIL: the view position is
    // carried forward unconditionally (the KNOWN LIMIT in `FlowCanvas`), so the
    // node sits there whether or not `moveNode` was ever called. Deleting the
    // `onNodesChange` commit branch leaves it green. Observing the real domain
    // commit needs the store, which the page does not expose, or a save +
    // reload — a different test, and one this spec does not owe.

    await expectQuiet(page, problems);
  });
});
