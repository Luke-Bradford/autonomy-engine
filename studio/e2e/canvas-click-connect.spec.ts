import { expect, test, type Page } from '@playwright/test';
import { openCanvas } from './support/canvas';
import {
  WIDE_CANVAS,
  addActivity,
  canvasNodes,
  clickConnect,
  connectNodes,
  dragNodeBy,
  edgeGroup,
  fitAndSettle,
} from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';

/**
 * #941 — click-to-connect, in a real browser.
 *
 * React Flow authors an edge two ways: drag a port to a port, and CLICK a source
 * port then a target (`connectOnClick` defaults true). Every spec in this suite
 * drove the pointer path, so the click gesture had no coverage at all — and that
 * is precisely how it kept a defect U6a/U6b were written to remove. The refusal
 * panel that answers "why did nothing happen?" was wired to `onConnectStart`/
 * `onConnectEnd`, so a refused CLICK authored nothing and said nothing.
 *
 * Both gestures consult the same `isValidConnection`, so the refusal itself was
 * always correct. What was missing, and what this file pins, is that the reason
 * reaches the screen either way. A spec asserting only "no edge appeared" would
 * have passed against the broken build — which is the same trap
 * `connect-validation.spec.ts` documents for the drag path.
 */

const REFUSAL = '.canvas-refusal';

/** See `connect-validation.spec.ts` for why the default viewport is too narrow
 *  to hold all four ports of a two-node graph. */

async function seedTwoNodes(page: Page): Promise<void> {
  await addActivity(page, 'HTTP Request');
  await expect(canvasNodes(page)).toHaveCount(1);
  await addActivity(page, 'Write File');
  await fitAndSettle(page, 1);
  await expect(canvasNodes(page)).toHaveCount(2);
  await dragNodeBy(page, 1, 300, 60);
}

test.describe('#941 click-to-connect', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(WIDE_CANVAS);
  });

  test('authors an edge from two clicks, with nothing to explain', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'click-connect-valid');
    await seedTwoNodes(page);
    await expect(edgeGroup(page)).toHaveCount(0);

    await clickConnect(page, { index: 0 }, { index: 1 });

    await expect(edgeGroup(page)).toHaveCount(1);
    await expect(page.locator(REFUSAL)).toHaveCount(0);
    await expectQuiet(page, problems);
  });

  test('SAYS WHY a clicked connection was refused', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'click-connect-refused');
    await seedTwoNodes(page);
    await connectNodes(page, 0, 1);
    await expect(edgeGroup(page)).toHaveCount(1);
    // Asserted ABSENT before the gesture: the drag above is itself legal, but a
    // panel surviving from anywhere would make the assertion below meaningless.
    await expect(page.locator(REFUSAL)).toHaveCount(0);

    // The reverse pair closes a forward cycle — refused, and the one refusal
    // whose message the drag path already pins, so any difference in wording
    // between the two gestures shows up here.
    await clickConnect(page, { index: 1 }, { index: 0 });

    await expect(edgeGroup(page)).toHaveCount(1); // nothing authored
    const refusal = page.locator(REFUSAL);
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('would close a loop');
    await expect(refusal).toContainText('maxBounces');

    // Assertive, like the drag path's — a refusal a screen reader never hears is
    // still a silent no.
    await expect(refusal.locator('[role="alert"]')).toBeVisible();
    await expectQuiet(page, problems);
  });

  test('refuses a DUPLICATE clicked connection out loud', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'click-connect-duplicate');
    await seedTwoNodes(page);

    await clickConnect(page, { index: 0 }, { index: 1 });
    await expect(edgeGroup(page)).toHaveCount(1);
    await expect(page.locator(REFUSAL)).toHaveCount(0);

    // The same pair again, same outcome port. One edge, and a sentence.
    await clickConnect(page, { index: 0 }, { index: 1 });

    await expect(edgeGroup(page)).toHaveCount(1);
    await expect(page.locator(REFUSAL)).toContainText(/already/i);
    await expectQuiet(page, problems);
  });

  test('offers the back-edge answer to a clicked cycle, and authors it', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'click-connect-backedge');
    await seedTwoNodes(page);
    await connectNodes(page, 0, 1);
    await expect(edgeGroup(page)).toHaveCount(1);

    await clickConnect(page, { index: 1 }, { index: 0 });

    // U6e's offer is reachable from the click gesture too. It has to be: a click
    // is never a rewire, so the offer's `rewiring` guard cannot suppress it, and
    // accepting AUTHORS the loop the operator was reaching for.
    const offer = page.locator(`${REFUSAL} .canvas-refusal-action`);
    await expect(offer).toBeVisible();
    await offer.click();

    await expect(edgeGroup(page)).toHaveCount(2);
    // Accepting clears the attempt, or the live region keeps announcing a
    // refusal for an edge that now exists.
    await expect(page.locator(REFUSAL)).toHaveCount(0);
    await expectQuiet(page, problems);
  });
});
