import { expect, test } from '@playwright/test';

import { viewportSettled } from './support/canvasGraph';

/**
 * #1073 — `viewportSettled` returns only once the viewport has STOPPED MOVING.
 *
 * The same race `edge-midpoint-settle.spec.ts` pins for `edgeMidpoint`, on the
 * helper with the wider reach: `viewportSettled` sits under `fitAndSettle`,
 * `marqueeAllNodes` and `openSeededCanvas`, so nearly every canvas spec reads
 * coordinates on the strength of it. A one-comparison settle lets the seed read
 * and the first probe — two back-to-back round trips — agree on a viewport that
 * has not started moving yet, and every coordinate read after it lands against
 * a transform still in flight.
 *
 * NO TIMING IN THIS FIXTURE, for the reason that spec gives: the transform
 * changes on its THIRD READ, so the helper's seed read and first probe both see
 * the pre-move value by construction, not by the host's speed. Red against the
 * one-comparison helper, green only for one that requires a quiet window.
 */

const BEFORE = 'translate(0px, 0px) scale(1)';
const AFTER = 'translate(-120px, 40px) scale(0.5)';

test.describe('#1073 — waiting for the React Flow viewport to stop moving', () => {
  test('a transform that changes on its third read settles on where it moved TO', async ({
    page,
  }) => {
    await page.goto('about:blank');

    // A viewport whose transform changes with the READ, not with the clock: the
    // first two reads agree on BEFORE, every read after that is AFTER. `style`
    // is shadowed on the instance because the helper reads `style.transform`.
    await page.evaluate(
      ([before, after]) => {
        const viewport = document.createElement('div');
        viewport.className = 'react-flow__viewport';
        let reads = 0;
        Object.defineProperty(viewport, 'style', {
          value: {
            get transform() {
              reads += 1;
              return reads <= 2 ? before : after;
            },
          },
        });
        (window as unknown as { transformReads: () => number }).transformReads = () => reads;
        document.body.appendChild(viewport);
      },
      [BEFORE, AFTER] as const,
    );

    const settled = await viewportSettled(page);

    expect(settled, 'the helper returned the pre-move transform').toBe(AFTER);
    // The returned value alone could be right by luck of which read it kept;
    // the read count says the helper actually WATCHED the new value hold.
    const reads = await page.evaluate(() =>
      (window as unknown as { transformReads: () => number }).transformReads(),
    );
    expect(reads, 'the helper stopped watching before the new transform held').toBeGreaterThan(3);
  });
});
