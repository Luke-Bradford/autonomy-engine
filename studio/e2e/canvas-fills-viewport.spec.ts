import { expect, test } from '@playwright/test';
import { openCanvas } from './support/canvas';

/**
 * #757 — the authoring canvas must USE the window it is given.
 *
 * `.canvas-grid` pinned `--canvas-height: 620px`, so the editor row was the same
 * height on every display: fine at 900px, and roughly 350px of dead panel below
 * the canvas on a 1347px-tall screen (which is how the operator noticed).
 *
 * WHY THE ASSERTIONS ARE ON BOXES, NOT ON THE GRID TEMPLATE. This shell has
 * already produced one bug where `grid-template-columns` read back perfectly
 * while the app rendered as a zero-width sliver (U3, auto-placement). A spec
 * that reads the template describes the stylesheet; only a spec that measures
 * `getBoundingClientRect()` describes the render.
 *
 * WHY TWO VIEWPORT HEIGHTS. One height cannot distinguish "fills the window"
 * from "happens to be tall enough at this size" — a hardcoded 620px passes a
 * single 700px-tall check. The pair is the discriminator: a constant cannot
 * satisfy both, because a fixed height that fills the short viewport leaves a
 * gap in the tall one.
 *
 * WHY A NON-ZERO FLOOR IS ASSERTED TOO. React Flow needs a parent with a
 * DEFINITE height — hand it `height: auto` and the canvas collapses to nothing.
 * That collapse is precisely what the hardcoded pixel value was avoiding, so
 * "fills the space" alone would be satisfied by a canvas of height 0 in a page
 * that also has no space. Assert it rendered, not just that it stretched.
 */

/** Below the editor's bottom edge, how much of the content area is unused. */
const SLACK_PX = 24;

for (const height of [800, 1400]) {
  test(`the canvas editor fills the content area at ${height}px tall`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height });
    await openCanvas(page, `fills-viewport-${height}`);

    const measured = await page.evaluate(() => {
      const rect = (selector: string) => {
        const el = document.querySelector(selector);
        return el ? el.getBoundingClientRect() : null;
      };
      const grid = rect('.canvas-grid');
      const main = rect('main');
      const flow = rect('.react-flow');
      const toolbox = rect('.activity-toolbox');
      return {
        viewportHeight: window.innerHeight,
        mainBottom: main ? main.bottom : null,
        gridBottom: grid ? grid.bottom : null,
        gridHeight: grid ? grid.height : null,
        flowHeight: flow ? flow.height : null,
        toolboxBottom: toolbox ? toolbox.bottom : null,
      };
    });

    expect(measured.mainBottom).not.toBeNull();
    expect(measured.gridBottom).not.toBeNull();

    // The editor reaches the bottom of the content area rather than stopping at
    // a constant. This is the assertion the 620px literal fails.
    const dead = measured.mainBottom! - measured.gridBottom!;
    expect(dead).toBeLessThanOrEqual(SLACK_PX);

    // ...and it actually rendered. Guards the collapse-to-zero failure mode that
    // the pinned height existed to prevent, so the fix cannot trade one for the
    // other.
    expect(measured.flowHeight!).toBeGreaterThan(200);

    // The three columns still agree with each other. The toolbox capped itself
    // to the same custom property, so a fix that frees the canvas but leaves the
    // toolbox pinned would look correct in a screenshot of the canvas alone.
    expect(Math.abs(measured.toolboxBottom! - measured.gridBottom!)).toBeLessThanOrEqual(2);
  });
}

test('the canvas page does not scroll the whole window', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCanvas(page, 'fills-viewport-noscroll');

  // A canvas sized to the viewport is easy to overshoot into a page-level
  // scrollbar, which is worse than the gap it replaces: the canvas would scroll
  // out from under the toolbox. The editor scrolls INSIDE its own columns.
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollHeight - document.body.clientHeight,
    docEl: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(overflow.body).toBeLessThanOrEqual(0);
  expect(overflow.docEl).toBeLessThanOrEqual(0);
});
