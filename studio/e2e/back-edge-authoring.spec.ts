import { expect, test, type Page } from '@playwright/test';
import { openCanvas } from './support/canvas';
import {
  addActivity,
  canvasNodes,
  connectNodes,
  dragNodeBy,
  edgeGroup,
  firesOn,
  fitAndSettle,
} from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';

/**
 * U6e — authoring a BACK-EDGE on the canvas, in a real browser.
 *
 * The engine has run back-edges since P2c (`fireBackEdges`: bounce counters,
 * reset bodies, a `capped` failure) and the save gate has validated them just
 * as long. The canvas could only ever REFUSE the gesture that means one, with a
 * message that named `maxBounces` as the remedy and gave no way to reach it —
 * so a pipeline with a retry loop was authorable by API and by git import, and
 * not by the operator.
 *
 * What only a browser can show, and what the unit specs cannot: that the offer
 * appears on the real refusal panel after a real drag, that taking it AUTHORS a
 * savable version, and that the resulting edge says on screen that it loops and
 * how far. `connectRules.test.ts` pins which candidates are legal;
 * `EdgePanel.test.tsx` pins the cap field's refusals. This pins that they are
 * wired to a gesture.
 */

const REFUSAL = '.canvas-refusal';
const OFFER = 'Make it a back-edge';

/** See `connect-validation.spec.ts` — a reverse drag needs all four ports in the pane. */
const WIDE_CANVAS = { width: 1800, height: 1000 };

/** `HTTP Request → Write File`, so the reverse drag closes a forward cycle. */
async function seedChain(page: Page): Promise<void> {
  await addActivity(page, 'HTTP Request');
  await expect(canvasNodes(page)).toHaveCount(1);
  await addActivity(page, 'Write File');
  await fitAndSettle(page, 1);
  await expect(canvasNodes(page)).toHaveCount(2);
  await dragNodeBy(page, 1, 300, 60);
  await connectNodes(page, 0, 1);
  await expect(edgeGroup(page)).toHaveCount(1);
}

test.describe('U6e back-edge authoring', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(WIDE_CANVAS);
  });

  test('the cycle refusal offers a back-edge, and taking it authors a savable loop', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'u6e-offer');
    await seedChain(page);

    // The gesture that means "loop back": refused as a forward edge, because the
    // forward graph must stay a DAG.
    await connectNodes(page, 1, 0);
    await expect(edgeGroup(page)).toHaveCount(1); // nothing authored yet
    const refusal = page.locator(REFUSAL);
    await expect(refusal).toContainText('would close a loop');

    // The remedy the message names is now a control, not just a sentence.
    const offer = refusal.getByRole('button', { name: OFFER });
    await expect(offer).toBeVisible();
    await offer.click();

    await expect(edgeGroup(page)).toHaveCount(2);
    // The refusal must GO. It is recomputed from the forward candidate, which is
    // still refused and always will be, so leaving it up would have the
    // assertive live region announcing a refusal for an edge that now exists.
    await expect(refusal).toHaveCount(0);

    /* Back-ness and the cap are on screen WITHOUT selecting the edge — the one
       number that decides whether the loop terminates. Encoded in the label
       rather than a hue, because a back-edge keeps its condition's colour and
       the dash channel is already spent on `skipped`. */
    await expect(page.locator('.react-flow__edge.edge-back')).toHaveCount(1);
    await expect(edgeGroup(page).filter({ hasText: '↺ success ×10' })).toHaveCount(1);

    /* The whole point of authoring a cap by default: the doc is SAVABLE the
       instant the edge exists. A back-edge without `maxBounces` is refused by
       the write gate, and a version is immutable — so an edge the canvas let the
       operator draw but not save would be unrepairable, only re-authorable.
       Asserted by actually saving, not by reading the button's disabled state. */
    await page.getByRole('button', { name: 'Save version' }).click();
    // v1: this pipeline is authored from scratch, so this is its FIRST version
    // (unlike the seeded-doc specs, where the same click mints v2).
    await expect(page.locator('.notice')).toHaveText('Saved v1.');

    await expectQuiet(page, problems);
  });

  test('the bounce cap is editable, and a bad one is refused out loud', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'u6e-cap');
    await seedChain(page);
    await connectNodes(page, 1, 0);
    await page.locator(REFUSAL).getByRole('button', { name: OFFER }).click();
    await expect(edgeGroup(page)).toHaveCount(2);

    /* NAME the edge, do not point at it. `selectEdge(page, 1)` clicks the
       middle of the second path, and these two edges run between the SAME pair
       of nodes in opposite directions — measured, their midpoints are 10px
       apart (1122,558 and 1112,558), so a coordinate on one is a coordinate on
       the other and the click picks whichever is topmost at that instant. The
       DOM order is stable (the back-edge is index 1, checked over five runs), so
       the flake was never about which path got measured; it was about what a
       pixel in the overlap belongs to. `selectEdge`'s own docblock already says
       a spec that can name its edge should prefer a selector — this one can, by
       the label only the back-edge carries. */
    await edgeGroup(page)
      .filter({ hasText: '↺ success ×10' })
      .locator('.react-flow__edge-textwrapper')
      .click();
    await expect(firesOn(page)).toBeVisible();
    const panel = page.getByLabel('Properties');
    await expect(panel.getByRole('heading')).toHaveText('Back-edge');
    const cap = panel.getByLabel(/Bounce cap/);
    await expect(cap).toHaveValue('10');

    // A real edit commits on blur, and the canvas label follows it.
    await cap.fill('3');
    await cap.blur();
    await expect(edgeGroup(page).filter({ hasText: '↺ success ×3' })).toHaveCount(1);

    /* A refused value KEEPS the operator's text and says why. Silently reverting
       is the defect class U6a fixed in the condition picker: a control that
       appears to accept a value and does nothing. */
    await cap.fill('1.5');
    await cap.blur();
    await expect(panel.getByRole('alert')).toContainText('whole number');
    await expect(cap).toHaveValue('1.5');
    // ...and the doc still holds the last GOOD value.
    await expect(edgeGroup(page).filter({ hasText: '↺ success ×3' })).toHaveCount(1);

    await expectQuiet(page, problems);
  });

  /**
   * The offer is gated on the whole back-edge rule set, not on the refusal's
   * REASON — so a refusal whose back shape is ALSO illegal gets no offer.
   *
   * The rule doing the suppressing here is ANCESTRY, not the duplicate rule
   * that produced the refusal: `authoringEdgeKey` keys back-ness deliberately,
   * so `a →back b` is not a duplicate of `a → b`. It is refused because `b`
   * leads nowhere, so there is no loop for it to close. Naming that precisely
   * matters — an earlier version of this comment credited the duplicate rule,
   * which `connectRules.test.ts` pins as exactly the wrong answer.
   */
  test('no offer is made where a back-edge would also be illegal', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'u6e-no-offer');
    await seedChain(page);

    // Re-drawing the existing forward edge: refused as a duplicate, and the
    // back shape of it fails ancestry, so there is nothing to offer.
    await connectNodes(page, 0, 1);
    const refusal = page.locator(REFUSAL);
    await expect(refusal).toContainText('already has');
    await expect(refusal.getByRole('button', { name: OFFER })).toHaveCount(0);
    await expect(edgeGroup(page)).toHaveCount(1);

    await expectQuiet(page, problems);
  });

  /**
   * The other shape with no offer, and the one whose docblock the test above
   * used to carry: a SELF-loop can never be a back-edge, because the ancestry
   * rule needs the target to forward-reach the source and no node reaches
   * itself. A repeated single activity is a loop CONTAINER (U6d), not an edge.
   */
  test('a self-connection is refused with no back-edge offer', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'u6e-self');
    await seedChain(page);

    await connectNodes(page, 0, 0);
    const refusal = page.locator(REFUSAL);
    await expect(refusal).toContainText('cannot connect to itself');
    await expect(refusal.getByRole('button', { name: OFFER })).toHaveCount(0);
    await expect(edgeGroup(page)).toHaveCount(1);

    await expectQuiet(page, problems);
  });
});
