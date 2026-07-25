import { expect, test, type Page } from '@playwright/test';
import { openCanvas } from './support/canvas';
import {
  addActivity,
  canvasNodes,
  connectNodes,
  dragNodeBy,
  edgeGroup,
  fitAndSettle,
} from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { computedStyleOf, resolvedPaletteColor } from './support/theme';

/**
 * U6b — connect-time validation and arrowheads, in a real browser.
 *
 * Every claim here is one the unit suite cannot make. The rules themselves are
 * pinned in `connectRules.test.ts`; what only a browser can show is that React
 * Flow actually CONSULTS them — that a refused drag authors nothing, that the
 * handle under the pointer says so MID-GESTURE, and that the reason reaches the
 * screen. jsdom cannot produce a pointer drag over a measured handle, and it
 * computes no cascade, so it can neither refuse a connection nor see an
 * arrowhead's colour.
 *
 * The failure this file exists to catch is specifically a SILENT one: before
 * U6b the store refused three of these four candidates already, and the operator
 * saw nothing at all — the gesture simply ended with no edge and no explanation.
 * A spec that only asserted "no edge appeared" would have passed against that.
 */

const REFUSAL = '.canvas-refusal';

/**
 * A viewport wide enough that all FOUR ports of a two-node graph are inside the
 * canvas pane.
 *
 * Load-bearing, not cosmetic. At the default 1280px the shell's rail + resources
 * pane + toolbox leave the canvas 397px wide, and `fitView` clamps at its
 * `maxZoom` of 2 — so a 120px node is 240px on screen and TWO of them cannot
 * both fit. Laying them out for an edge therefore pushes the first node's TARGET
 * port and the second's SOURCE port outside the pane (they land under the
 * toolbox, still in the DOM). A left-to-right source→target drag still works
 * there, which is why U6a never noticed; a REVERSE drag — the gesture that
 * closes a cycle, and the whole point of these specs — puts the pointer down on
 * the toolbox and starts nothing at all, failing as "no refusal was shown".
 */
const WIDE_CANVAS = { width: 1800, height: 1000 };

/** Two nodes, laid out apart, with no edges yet. */
async function seedTwoNodes(page: Page): Promise<void> {
  await addActivity(page, 'HTTP Request');
  await expect(canvasNodes(page)).toHaveCount(1);
  await addActivity(page, 'Write File');
  await fitAndSettle(page, 1);
  await expect(canvasNodes(page)).toHaveCount(2);
  await dragNodeBy(page, 1, 300, 60);
}

/** The mid-gesture state of the port the pointer is over. */
function connectingPort(page: Page) {
  return page.locator('.react-flow__handle.connectingto');
}

test.describe('U6b connect-time validation', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(WIDE_CANVAS);
  });

  test('a legal connection is made, and carries a hued arrowhead', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'u6b-valid');
    await seedTwoNodes(page);

    // MID-GESTURE: the port under the pointer reports the connection is valid.
    // This is the affordance `isValidConnection` buys — RF adds `valid` only
    // when the predicate said yes.
    await connectNodes(page, 0, 1, async () => {
      await expect(connectingPort(page)).toHaveClass(/\bvalid\b/);
      expect(
        await computedStyleOf(page, '.react-flow__handle.connectingto', 'background-color'),
      ).toBe(await resolvedPaletteColor(page, '--success'));
    });

    await expect(edgeGroup(page)).toHaveCount(1);
    await expect(page.locator(REFUSAL)).toHaveCount(0);

    // The arrowhead: the edge REFERENCES the marker, and the marker paints the
    // same hue as the stroke. Both halves matter — a marker id that resolves to
    // nothing renders no arrowhead at all, silently.
    await expect(page.locator('.react-flow__edge-path')).toHaveAttribute(
      'marker-end',
      "url('#edge-arrow-success')",
    );
    const success = await resolvedPaletteColor(page, '--success');
    expect(await computedStyleOf(page, '#edge-arrow-success path', 'fill')).toBe(success);
    expect(await computedStyleOf(page, '.react-flow__edge-path', 'stroke')).toBe(success);

    await expectQuiet(page, problems);
  });

  test('a cycle-closing connection is REFUSED, and the canvas says why', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'u6b-cycle');
    await seedTwoNodes(page);
    await connectNodes(page, 0, 1);
    await expect(edgeGroup(page)).toHaveCount(1);

    // Now the other way round: that closes a forward cycle, which wedges the run
    // (`settle` never makes either node ready) and is refused by the save gate.
    await connectNodes(page, 1, 0, async () => {
      const port = connectingPort(page);
      await expect(port).toHaveCount(1);
      await expect(port).not.toHaveClass(/\bvalid\b/);
      // Non-colour channel too, but the colour must be the error hue.
      expect(
        await computedStyleOf(page, '.react-flow__handle.connectingto', 'background-color'),
      ).toBe(await resolvedPaletteColor(page, '--error'));
    });

    await expect(edgeGroup(page)).toHaveCount(1); // nothing authored
    const refusal = page.locator(REFUSAL);
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('would close a loop');
    // The engine's own remedy, so the refusal does not read as "no loops here".
    await expect(refusal).toContainText('maxBounces');
    /* It names the ACTIVITIES, and not the internal ids — which is a claim only a
       real run can make, because these ids are minted by `newLocalId` and the
       unit fixtures use readable ones. The first draft of this panel read
       "'n_7c44a16f-…' → 'n_9c4bb103-…'" and every unit spec was green. */
    await expect(refusal).toContainText("'Write File' → 'HTTP Request'");
    await expect(refusal).not.toContainText('n_');

    // Dismissable, and gone on the next attempt either way.
    await refusal.getByRole('button', { name: 'Dismiss' }).click();
    await expect(refusal).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('a DUPLICATE connection is refused with the condition named', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'u6b-duplicate');
    await seedTwoNodes(page);
    await connectNodes(page, 0, 1);
    await expect(edgeGroup(page)).toHaveCount(1);

    await connectNodes(page, 0, 1);
    await expect(edgeGroup(page)).toHaveCount(1);
    await expect(page.locator(REFUSAL)).toContainText(
      "'HTTP Request' → 'Write File' already has a 'success' edge",
    );

    await expectQuiet(page, problems);
  });

  test('a self-connection is refused', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'u6b-self');
    await seedTwoNodes(page);

    await connectNodes(page, 0, 0);
    await expect(edgeGroup(page)).toHaveCount(0);
    await expect(page.locator(REFUSAL)).toContainText("'HTTP Request' cannot connect to itself");

    await expectQuiet(page, problems);
  });
});
