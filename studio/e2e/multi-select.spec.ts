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

/** Two activities, spread apart, both measured — the shape every spec here needs. */
async function seedTwoNodes(page: Page, name: string): Promise<void> {
  await openCanvas(page, name);
  await addActivity(page, 'HTTP Request');
  await expect(canvasNodes(page)).toHaveCount(1);
  await addActivity(page, 'Write File');
  await fitAndSettle(page, 1);
  await expect(canvasNodes(page)).toHaveCount(2);
  // Clear of each other, so a marquee can contain both and neither hides the
  // edge. Same gesture and same order as `seedSelectedEdge`, whose comment
  // records why the drag comes before any connect.
  await dragNodeBy(page, 1, 200, 40);
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

    await fitAndSettle(page, 1);
    await marqueeAllNodes(page, 2);
    await expect(selectedNodes(page)).toHaveCount(2);

    // The panel agrees — the half a class-only assertion would miss, and the
    // proof the gesture reached the STORE rather than only React Flow's view.
    const panel = page.getByRole('complementary', { name: 'Properties' });
    await expect(panel.getByRole('heading', { name: '2 selected' })).toBeVisible();
    await expect(panel.getByText('2 activities')).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('a node inside a live marquee is still clickable', async ({ page }) => {
    const problems = collectPageProblems(page);
    await seedTwoNodes(page, 'e2e marquee clickable');

    await fitAndSettle(page, 1);
    await marqueeAllNodes(page, 2);
    await expect(selectedNodes(page)).toHaveCount(2);

    // React Flow's selection rect covers the bounding box of both nodes. If it
    // is left in the DOM with its default `pointer-events: all`, this click
    // lands on the overlay and the selection never narrows.
    await canvasNodes(page).first().click();
    await expect(selectedNodes(page)).toHaveCount(1);
    await expect(
      page.getByRole('complementary', { name: 'Properties' }).getByRole('button', {
        name: 'Delete node',
      }),
    ).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('dragging one member moves the whole group, and ONE undo puts it back', async ({ page }) => {
    const problems = collectPageProblems(page);
    await seedTwoNodes(page, 'e2e marquee move');

    const positions = async () =>
      canvasNodes(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transform));
    const before = await positions();

    await fitAndSettle(page, 1);
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
    await seedTwoNodes(page, 'e2e marquee delete');
    await connectNodes(page, 0, 1);
    await expect(edgeGroup(page)).toHaveCount(1);

    await fitAndSettle(page, 1);
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
    await seedTwoNodes(page, 'e2e marquee anchors');
    await connectNodes(page, 0, 1);
    await expect(edgeGroup(page)).toHaveCount(1);

    // One edge selected on its own: the U19 slice 2 behaviour, unchanged.
    await edgeGroup(page).first().click();
    await expect(reconnectAnchors(page)).toHaveCount(2);

    // Marquee'd: React Flow also selects the edge (it is incident to both
    // lassoed nodes), so the anchors would come back if they were gated on
    // "selected" rather than "the ONE selected element".
    await fitAndSettle(page, 1);
    await marqueeAllNodes(page, 2);
    await expect(selectedNodes(page)).toHaveCount(2);
    await expect(reconnectAnchors(page)).toHaveCount(0);

    await expectQuiet(page, problems);
  });
});
