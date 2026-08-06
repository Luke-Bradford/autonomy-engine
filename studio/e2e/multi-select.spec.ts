import { expect, test, type Page } from '@playwright/test';
import { openCanvas } from './support/canvas';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  addActivity,
  canvasNodes,
  connectNodes,
  dragNodeBy,
  edgeGroup,
  fitAndSettle,
  marqueeAllNodes,
} from './support/canvasGraph';

/**
 * U21 slice 2 — several things selected at once.
 *
 * The store's set model is unit-tested (`canvasStore.test.ts`); what only a real
 * browser can prove is that React Flow's own gestures reach it and come back
 * out. Every gesture here is one the library owns — the shift-marquee, the group
 * drag, the delete key — and each was previously discarded by the canvas, so
 * "the store has an array now" proves none of them.
 *
 * Three of these assertions guard a specific way this feature breaks rather than
 * a happy path:
 *  - a node INSIDE a live marquee stays clickable (React Flow draws a
 *    `nodesselection-rect` over the whole selection bbox with
 *    `pointer-events: all`, which swallows every gesture under it);
 *  - a marquee grants NO reconnect anchors (it selects every edge incident to a
 *    lassoed node, so "anchors on any selected edge" would stack them — the
 *    ambiguity U19 slice 2 exists to prevent);
 *  - deleting a connected node is ONE undo press, not two (React Flow's own
 *    delete path reports the edges and the nodes as separate callbacks).
 *
 * Every assertion below was mutation-checked (recorded in the PR): each fails
 * when the behaviour it names is removed.
 */

/**
 * Two activities, spread apart, both measured and both fully on screen.
 *
 * The ORDER here is the whole point, and each step is load-bearing:
 *  - the drag is 300px, far enough that the second node does not OVERLAP the
 *    first — a shorter offset leaves it covering the first's source port, and
 *    `connectNodes` then drags from the wrong element and authors no edge;
 *  - the connect happens BEFORE the final fit, at the zoom `seedSelectedEdge`
 *    is proven at — connecting after a re-fit authors nothing;
 *  - the fit comes LAST, because a `Full`-mode marquee can only select a node
 *    it contains whole, and a node dragged out of the viewport is not one.
 */
async function seedTwoNodes(page: Page, name: string, connect = false): Promise<void> {
  await openCanvas(page, name);
  await addActivity(page, 'HTTP Request');
  await expect(canvasNodes(page)).toHaveCount(1);
  await addActivity(page, 'Write File');
  await fitAndSettle(page, 1);
  await expect(canvasNodes(page)).toHaveCount(2);
  await dragNodeBy(page, 1, 300, 60);
  if (connect) {
    await connectNodes(page, 0, 1);
    await expect(edgeGroup(page)).toHaveCount(1);
  }
  await fitAndSettle(page, 1);
}

const selectedNodes = (page: Page) => page.locator('.react-flow__node.selected');
/** React Flow's reconnect grab-circles — present only on a `reconnectable` edge. */
const reconnectAnchors = (page: Page) => page.locator('.react-flow__edgeupdater');

test.describe('multi-select (U21)', () => {
  test('a shift-marquee selects every node it contains, and the panel says how many', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await seedTwoNodes(page, 'e2e marquee select');

    await marqueeAllNodes(page, 2);
    await expect(selectedNodes(page)).toHaveCount(2);

    // The panel agrees — the half a class-only assertion would miss, and the
    // proof the gesture reached the STORE rather than only React Flow's view.
    const panel = page.getByRole('complementary', { name: 'Properties' });
    await expect(panel.getByRole('heading', { name: '2 selected' })).toBeVisible();
    await expect(panel.getByText('2 activities')).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('the canvas under a live marquee still takes the gesture', async ({ page }) => {
    const problems = collectPageProblems(page);
    await seedTwoNodes(page, 'e2e marquee clickable');

    await marqueeAllNodes(page, 2);
    await expect(selectedNodes(page)).toHaveCount(2);

    /* React Flow draws `.react-flow__nodesselection-rect` over the bounding box
       of the selection with `pointer-events: all`, so with the rect in place
       every point between the two nodes belongs to the OVERLAY rather than to
       the canvas. Asked at the centre of that box — which is empty pane between
       the two nodes — and then acted on: a pane click deselects, and it can only
       arrive if nothing is sitting on top. */
    const midpoint = await page.evaluate(() => {
      const rects = [...document.querySelectorAll('.react-flow__node.selected')].map((el) =>
        el.getBoundingClientRect(),
      );
      const x = (Math.min(...rects.map((r) => r.x)) + Math.max(...rects.map((r) => r.right))) / 2;
      const y = (Math.min(...rects.map((r) => r.y)) + Math.max(...rects.map((r) => r.bottom))) / 2;
      return { x, y, on: document.elementFromPoint(x, y)?.className ?? '(nothing)' };
    });
    expect(midpoint.on).not.toContain('nodesselection');

    await page.mouse.click(midpoint.x, midpoint.y);
    await expect(selectedNodes(page)).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('dragging one member moves the whole group, and ONE undo puts it back', async ({ page }) => {
    const problems = collectPageProblems(page);
    await seedTwoNodes(page, 'e2e marquee move');

    const positions = async () =>
      canvasNodes(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transform));
    const before = await positions();

    await marqueeAllNodes(page, 2);
    await expect(selectedNodes(page)).toHaveCount(2);

    await dragNodeBy(page, 0, 90, 70);
    // BOTH moved: React Flow drags every selected node when one of them is
    // grabbed, and the canvas commits the whole batch.
    await expect.poll(positions).not.toEqual(before);
    const moved = await positions();
    expect(moved[0]).not.toEqual(before[0]);
    expect(moved[1]).not.toEqual(before[1]);

    // One gesture, one entry. Per node this would take two presses, and the
    // first would leave the group half-moved — a state nobody authored.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(positions).toEqual(before);

    await expectQuiet(page, problems);
  });

  test('Backspace deletes everything selected, and ONE undo restores it all', async ({ page }) => {
    const problems = collectPageProblems(page);
    await seedTwoNodes(page, 'e2e marquee delete', true);

    await marqueeAllNodes(page, 2);
    await expect(selectedNodes(page)).toHaveCount(2);

    await page.keyboard.press('Backspace');
    await expect(canvasNodes(page)).toHaveCount(0);
    await expect(edgeGroup(page)).toHaveCount(0);

    // The whole gesture comes back in one press — nodes AND the edge. React
    // Flow's own delete path reports them as two callbacks, which recorded two
    // entries and left the edge deleted after the first undo.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(canvasNodes(page)).toHaveCount(2);
    await expect(edgeGroup(page)).toHaveCount(1);

    await expectQuiet(page, problems);
  });

  test('a marquee grants NO reconnect anchors, but one selected edge still does', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await seedTwoNodes(page, 'e2e marquee anchors', true);

    // One edge selected on its own: the U19 slice 2 behaviour, unchanged.
    await edgeGroup(page).first().click();
    await expect(reconnectAnchors(page)).toHaveCount(2);

    // Marquee'd: React Flow also selects the edge (it is incident to both
    // lassoed nodes), so the anchors would come back if they were gated on
    // "selected" rather than "the ONE selected element".
    await marqueeAllNodes(page, 2);
    await expect(selectedNodes(page)).toHaveCount(2);
    await expect(reconnectAnchors(page)).toHaveCount(0);

    await expectQuiet(page, problems);
  });
});
