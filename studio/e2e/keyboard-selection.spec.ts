import { expect, test } from '@playwright/test';
import { openCanvas } from './support/canvas';
import {
  canvasNodes,
  deselect,
  firesOn,
  seedSelectedEdge,
  tabToFocus,
} from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';

/**
 * #737 — the canvas is operable from the KEYBOARD, not just the mouse.
 *
 * The property panel is the only way to edit anything on the canvas, and it
 * renders only for a selected element. Before this, selection came exclusively
 * from React Flow's pointer callbacks, so with a keyboard alone you could reach
 * every node and edge and hear what they were — and change none of them: no node
 * config, no connection, no delete, and (U6a) no edge-condition picker.
 *
 * WHY THIS HAS TO BE A BROWSER SPEC. Two of the three moving parts are things
 * jsdom does not have:
 *
 *  - React Flow's own keyboard handling. `NodeWrapper`/`EdgeWrapper` bind
 *    `onKeyDown` and act on Enter / Space / Escape. jsdom can focus the element
 *    but produces none of that, so a unit test asserting "Enter selects" would
 *    be asserting against a handler that never runs.
 *  - CONTROLLED-mode change routing, which is where the defect actually lived.
 *    The canvas drives React Flow from `nodes`/`edges` props, and in that mode
 *    RF does not apply a selection to its own store — it emits a `select` change
 *    and nothing else. `onEdgesChange` dropped those, so an edge's Enter went
 *    nowhere. Note the direction this points: `onSelectionChange` could NOT have
 *    been the fix, because RF's `edgeLookup` is rebuilt from the `edges` prop, so
 *    for edges that callback only ever reports back what this component already
 *    said. The unit tests cover the fold (`nextSelection`); only a browser can
 *    show that a change arrives to fold.
 *
 * Both element kinds are exercised deliberately: they take DIFFERENT paths
 * through React Flow (`handleNodeClick` vs `addSelectedEdges`) and the fix is
 * asymmetric — RF owns node selection in the view array, the store owns edge
 * selection — so a spec covering one kind would leave the other unguarded.
 */
test.describe('#737 keyboard selection', () => {
  test('TAB + Enter selects an EDGE and opens its condition picker', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e kbd edge');
    await seedSelectedEdge(page);
    // Start from nothing selected, so a passing assertion cannot be the
    // selection `seedSelectedEdge` already made.
    await deselect(page);

    await tabToFocus(page, 'react-flow__edge');
    await expect(firesOn(page), 'focus alone must not select').toHaveCount(0);

    await page.keyboard.press('Enter');
    await expect(firesOn(page)).toBeVisible();

    // Escape gives it back — the other half of the keyboard contract, and the
    // path through RF's `unselectNodesAndEdges` rather than a plain deselect.
    await page.keyboard.press('Escape');
    await expect(firesOn(page)).toHaveCount(0);
    await expectQuiet(page, problems);
  });

  test('Space also selects (React Flow treats it as an activation key)', async ({ page }) => {
    await openCanvas(page, 'e2e kbd space');
    await seedSelectedEdge(page);
    await deselect(page);

    await tabToFocus(page, 'react-flow__edge');
    await page.keyboard.press('Space');
    await expect(firesOn(page)).toBeVisible();
  });

  test('TAB + Enter selects a NODE and opens its editor', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e kbd node');
    // One node is enough, and it keeps the tab order short.
    await page
      .getByRole('complementary', { name: 'Activities' })
      .getByRole('button', {
        name: 'HTTP Request',
        exact: true,
      })
      .click();
    await expect(canvasNodes(page)).toHaveCount(1);

    const panel = page.getByRole('complementary', { name: 'Properties' });
    await expect(panel.getByText('Select a node or an edge to edit it.')).toBeVisible();

    await tabToFocus(page, 'react-flow__node');
    await page.keyboard.press('Enter');

    // The node editor, addressed by what it lets the operator DO — `Delete node`
    // is unique to it, where the "Properties" landmark is shared with the empty
    // state and the edge panel.
    await expect(panel.getByRole('button', { name: 'Delete node' })).toBeVisible();
    await expectQuiet(page, problems);
  });

  test('a click still selects — the pointer path is not regressed', async ({ page }) => {
    // The click handlers this fix removed (`onNodeClick`/`onEdgeClick`/
    // `onPaneClick`) were redundant, not load-bearing: React Flow routes a click
    // through the same `select` changes. That is a claim worth a test, because
    // getting it wrong breaks the MOUSE path — the one that already worked.
    await openCanvas(page, 'e2e kbd mouse');
    await seedSelectedEdge(page); // ends with the edge selected BY CLICK
    await expect(firesOn(page)).toBeVisible();
    await deselect(page); // pane click clears it
    await expect(firesOn(page)).toHaveCount(0);
  });
});
