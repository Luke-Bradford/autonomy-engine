import { expect, test, type Page } from '@playwright/test';
import { openCanvas } from './support/canvas';
import {
  WIDE_CANVAS,
  addActivity,
  canvasNodes,
  connectNodes,
  connectNodesBackwards,
  dragNodeBy,
  edgeGroup,
  fitAndSettle,
  selectEdge,
} from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { computedStyleOf, documentTheme, resolvedPaletteColor } from './support/theme';

/**
 * The condition → palette-var mapping, as `index.css` declares it and
 * `palette.test.ts` guards it structurally. Repeated here because this file
 * asserts the RESOLVED value, which only a browser can produce.
 */
const VARIANT_HUES = [
  ['success', '--success'],
  ['failure', '--error'],
  ['completion', '--accent'],
  ['skipped', '--muted'],
  ['branch', '--branch'],
] as const;

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
 *
 * WIDENED 1800 -> 2000 when the node became an icon-and-name card of a FIXED
 * width, which is wider than the ~120 units a wrapping title used to produce.
 * The same failure this constant was invented for came straight back — the
 * right-hand node's source port landed 20px OUTSIDE the pane and the reverse
 * drag started nothing. Measured rather than guessed, at the layout this file
 * actually builds: 1800 gives -20px of margin on the worst port, 1900 gives 31,
 * and 2000 gives 81. Taking the roomy one, because a margin of tens of pixels is
 * what stops the next change to the node or the shell chrome reopening this.
 */

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
    await expect(refusal).toContainText("'Write File 1' → 'HTTP Request 1'");
    await expect(refusal).not.toContainText('n_');

    /* U6e — the refusal now also OFFERS the remedy it names. Asserted here, not
       only in `back-edge-authoring.spec.ts`, because this is the spec that owns
       "what the operator sees when a cycle is refused" — leaving it silent
       would let the offer disappear without a red test. Dismissing is still the
       other way out, and taking the offer is covered by that file. */
    await expect(refusal.getByRole('button', { name: 'Make it a back-edge' })).toBeVisible();

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
      "'HTTP Request 1' → 'Write File 1' already has a 'success' edge",
    );

    /* The panel states the reason as it is NOW, so removing the obstacle removes
       the message — no dismiss needed. It also cannot go stale and name an
       activity that has since been deleted, which is why the component keeps the
       attempted ENDS rather than a frozen string. */
    await selectEdge(page);
    await page.keyboard.press('Backspace');
    await expect(edgeGroup(page)).toHaveCount(0);
    await expect(page.locator(REFUSAL)).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  /**
   * The same refusal, from a BACKWARDS drag — the gesture that broke it.
   *
   * React Flow hands `onConnectEnd` the raw (pointer-down, pointer-up) pair, not
   * the source→target connection it normalised to decide validity. Read raw, the
   * reason is computed for the OPPOSITE edge: this duplicate was explained as a
   * cycle, and a backwards cycle-closer produced no message at all (the reversed
   * candidate is legal, so the panel simply did not render) — a silent refusal
   * inside the feature built to remove silent refusals. Found by review, not by
   * the forward specs above, every one of which passed throughout.
   */
  test('a BACKWARDS drag gets the reason for the edge it would actually make', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'u6b-backwards');
    await seedTwoNodes(page);
    await connectNodes(page, 0, 1);
    await expect(edgeGroup(page)).toHaveCount(1);

    // Drawing the SAME edge backwards: down on Write File's `in`, up on HTTP
    // Request's `out`. That is the duplicate `HTTP Request → Write File`.
    await connectNodesBackwards(page, 0, 1);
    await expect(edgeGroup(page)).toHaveCount(1);
    const refusal = page.locator(REFUSAL);
    await expect(refusal).toContainText(
      "'HTTP Request 1' → 'Write File 1' already has a 'success' edge",
    );
    await expect(refusal).not.toContainText('close a loop');

    // And the reverse case: a backwards cycle-closer must SAY something.
    await refusal.getByRole('button', { name: 'Dismiss' }).click();
    await connectNodesBackwards(page, 1, 0);
    await expect(edgeGroup(page)).toHaveCount(1);
    await expect(refusal).toContainText("'Write File 1' → 'HTTP Request 1' would close a loop");

    await expectQuiet(page, problems);
  });

  /**
   * EVERY arrowhead hue, in BOTH themes.
   *
   * The narrow version of this — one marker, one theme — was the automated part
   * of a claim the as-built section made about all five in both, with the rest
   * resting on a single manual reading. A light-mode arrowhead is exactly the
   * kind of thing that silently keeps its dark value, which is the failure the
   * whole theme bridge exists to prevent.
   */
  test('every edge variant arrowhead paints its palette hue, in both themes', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'u6b-markers');
    await seedTwoNodes(page);
    await connectNodes(page, 0, 1);
    await expect(edgeGroup(page)).toHaveCount(1);

    for (const theme of ['dark', 'light'] as const) {
      if (theme === 'light') await page.getByRole('switch', { name: 'Dark mode' }).click();
      await expect
        .poll(() => documentTheme(page), { message: `theme never became ${theme}` })
        .toBe(theme);
      for (const [variant, cssVar] of VARIANT_HUES) {
        const expected = await resolvedPaletteColor(page, cssVar);
        expect(expected, `${cssVar} resolved to nothing`).toMatch(/^rgb/);
        expect(
          await computedStyleOf(page, `#edge-arrow-${variant} path`, 'fill'),
          `#edge-arrow-${variant} in ${theme}`,
        ).toBe(expected);
      }
      // The one arrowhead an edge is actually USING matches that edge's stroke.
      expect(await computedStyleOf(page, '#edge-arrow-success path', 'fill')).toBe(
        await computedStyleOf(page, '.react-flow__edge-path', 'stroke'),
      );
    }

    await expectQuiet(page, problems);
  });

  test('a self-connection is refused', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'u6b-self');
    await seedTwoNodes(page);

    await connectNodes(page, 0, 0);
    await expect(edgeGroup(page)).toHaveCount(0);
    await expect(page.locator(REFUSAL)).toContainText("'HTTP Request 1' cannot connect to itself");

    await expectQuiet(page, problems);
  });
});
