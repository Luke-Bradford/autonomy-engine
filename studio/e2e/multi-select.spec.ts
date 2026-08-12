import { expect, test, type Page } from '@playwright/test';
import { openCanvas } from './support/canvas';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  addActivity,
  canvasNodes,
  connectNodes,
  dragNodeBy,
  edgeGroup,
  edgeMidpoint,
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

/**
 * #947 — the OTHER way to build a selection: hold a modifier and click.
 *
 * The marquee above proves the store's set model end to end, but only through
 * one gesture. This one takes a different route into the same seam — React
 * Flow's `handleNodeClick`/`addSelectedEdges`, which branch on
 * `multiSelectionActive` — and #935 shipped without covering it because it
 * could not be driven.
 *
 * WHY IT COULD NOT BE DRIVEN, since the answer is a trap worth keeping written
 * down. React Flow reads the modifier from a `keydown` listener, and picks
 * WHICH modifier from `isMacOs()` — a user-agent substring test. Playwright's
 * `devices['Desktop Chrome']` descriptor carries a WINDOWS user agent, so on a
 * Mac host React Flow listened for Control while the host treated Control-click
 * as its secondary-button gesture: Chromium then dispatches `contextmenu`
 * INSTEAD of `click` (the button stays 0 — it is the click that goes missing),
 * and since `nodeDragThreshold` defaults to 1, pointer selection runs in
 * React's `onClick` and so never ran at all. Passing both modifiers explicitly
 * (`multiSelectionKeyCode` in `FlowCanvas`) is what makes the gesture
 * independent of what the user agent claims to be.
 *
 * Meta throughout, deliberately and on every platform: Control-click is the
 * secondary-button gesture on macOS, so it is not drivable there and never will
 * be, while Meta is a plain modifier everywhere. Nor is `ControlOrMeta` any use
 * here — Playwright resolves that from the RUNNER's platform, so on CI's ubuntu
 * it becomes Control, which is what React Flow's spoofed-UA default already
 * watches, and the spec would pass without the prop it exists to guard.
 *
 * The Control half — the gesture a Windows/Linux operator actually makes — is
 * therefore covered in `FlowCanvas.test.tsx` instead, where jsdom's own user
 * agent makes Control React Flow's default and both modifiers are reachable.
 * The two tests below are the ones that need a real browser: genuine hit
 * testing on a bezier, and the property panel rendering the result.
 */
test.describe('modifier-click multi-select (#947)', () => {
  /**
   * Hold Meta across an arbitrary gesture.
   *
   * A wrapper rather than `click({ modifiers: ['Meta'] })` — which does work,
   * and does dispatch real key events (`ensureModifiers` calls `keyboard.down`
   * per modifier) — because `page.mouse.click`, which the edge case below needs
   * for a point ON the bezier, takes no `modifiers` option. One mechanism for
   * both gesture styles beats two that look interchangeable and are not.
   *
   * #947's own report claimed the `modifiers` option dispatches no key event.
   * It does; that attempt failed for the same reason the manual one did, which
   * was React Flow watching the OTHER modifier. Recorded here so the false
   * explanation does not get picked up again.
   */
  async function metaClick(page: Page, act: () => Promise<void>): Promise<void> {
    await page.keyboard.down('Meta');
    try {
      await act();
    } finally {
      await page.keyboard.up('Meta');
    }
  }

  const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Properties' });

  test('⌘-click ADDS a node to the selection instead of replacing it', async ({ page }) => {
    const problems = collectPageProblems(page);
    await seedTwoNodes(page, 'e2e modifier add');

    await canvasNodes(page).nth(0).click();
    await expect(selectedNodes(page)).toHaveCount(1);

    await metaClick(page, () => canvasNodes(page).nth(1).click());
    await expect(selectedNodes(page)).toHaveCount(2);

    // The panel agrees, which is what makes this a claim about the STORE and
    // not merely about React Flow's own view array.
    await expect(panelOf(page).getByRole('heading', { name: '2 selected' })).toBeVisible();
    await expect(panelOf(page).getByText('2 activities')).toBeVisible();

    await expectQuiet(page, problems);
  });

  test('⌘-click builds a MIXED node-and-edge selection', async ({ page }) => {
    const problems = collectPageProblems(page);
    await seedTwoNodes(page, 'e2e modifier mixed', true);

    await canvasNodes(page).nth(0).click();
    await expect(selectedNodes(page)).toHaveCount(1);

    /* Edges take an ASYMMETRIC path through this canvas — React Flow owns node
       selection in the `nodes` array but the store owns edge selection, so an
       edge's `select` change arrives through `onEdgesChange` and a different
       `multiSelectionActive` branch (`addSelectedEdges`). A spec covering only
       nodes would leave that half unguarded. */
    const edge = await edgeMidpoint(page);
    await metaClick(page, () => page.mouse.click(edge.x, edge.y));

    await expect(selectedNodes(page)).toHaveCount(1);
    await expect(page.locator('.react-flow__edge.selected')).toHaveCount(1);
    await expect(panelOf(page).getByRole('heading', { name: '2 selected' })).toBeVisible();
    await expect(panelOf(page).getByText('1 activity, 1 connection')).toBeVisible();

    await expectQuiet(page, problems);
  });

  /**
   * #949 — a ⌘-click that MISSES lands on the pane, and must change nothing.
   *
   * What only a browser can supply here is genuine hit testing: that the click
   * reaches the PANE rather than some overlay above it, and so that the gesture
   * under test is the one an operator actually makes when a click misses a node
   * mid-selection. The modifier PAIR, and the store-level consequences of each
   * change seam, are pinned in `FlowCanvas.test.tsx` — Control-click is macOS's
   * secondary-button gesture and is not drivable here.
   *
   * Both directions live in ONE test on purpose. The surviving selection is a
   * NON-event, so it is only a real claim next to the unmodified click that
   * takes the same selection, at the same point, to zero.
   *
   * NO CONTAINER here, though #949's headline case is a ⌘-click in the empty
   * space inside one. That case is covered by COMPOSITION rather than left out:
   * `container-rendering.spec.ts` ('the box does not swallow gestures aimed
   * through it') already mutation-proves that a click through a container body
   * hit-tests to the pane, and CSS `pointer-events` resolution does not consult
   * event modifiers — so a modified click through a body reaches the pane for
   * exactly the same reason an unmodified one does, and from there it IS this
   * test. Stated rather than left for a reader to reconstruct.
   */
  test('a ⌘-click on empty pane keeps the selection; an unmodified one clears it', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await seedTwoNodes(page, 'e2e modified pane click', true);

    // A mixed selection, so the pane click has to spare BOTH change seams.
    await canvasNodes(page).nth(0).click();
    const edge = await edgeMidpoint(page);
    await metaClick(page, () => page.mouse.click(edge.x, edge.y));
    await expect(selectedNodes(page)).toHaveCount(1);
    await expect(page.locator('.react-flow__edge.selected')).toHaveCount(1);

    /* Found by asking the DOM rather than assumed from a layout guess: a
       hardcoded point that silently drifted onto a node would turn this into a
       test of node-click, which keeps the selection for its own reasons and
       would pass while proving nothing. */
    const empty = await page.evaluate(() => {
      const pane = document.querySelector('.react-flow__pane');
      if (!pane) return null;
      const r = pane.getBoundingClientRect();
      for (let fx = 0.1; fx < 0.95; fx += 0.1) {
        for (let fy = 0.1; fy < 0.95; fy += 0.1) {
          const x = r.x + r.width * fx;
          const y = r.y + r.height * fy;
          if (document.elementFromPoint(x, y) === pane) return { x, y };
        }
      }
      return null;
    });
    expect(empty, 'no empty pane point found').not.toBeNull();

    await metaClick(page, () => page.mouse.click(empty!.x, empty!.y));
    await expect(selectedNodes(page)).toHaveCount(1);
    await expect(page.locator('.react-flow__edge.selected')).toHaveCount(1);
    // The panel agrees, which makes this a claim about the STORE and not just
    // about React Flow's view array.
    await expect(panelOf(page).getByRole('heading', { name: '2 selected' })).toBeVisible();

    // The discriminator: same point, same selection, no modifier.
    await page.mouse.click(empty!.x, empty!.y);
    await expect(selectedNodes(page)).toHaveCount(0);
    await expect(page.locator('.react-flow__edge.selected')).toHaveCount(0);

    await expectQuiet(page, problems);
  });
});
