import { expect, test } from '@playwright/test';

import { edgeMidpoint } from './support/canvasGraph';

/**
 * #1067 — `edgeMidpoint` returns a point that has STOPPED MOVING.
 *
 * A test of a test helper, which needs its reason stated. `edgeMidpoint` is the
 * only thing standing between every edge-clicking spec and a 60px miss: an edge
 * drawn by a connect gesture is laid out twice, and clicking the first reading
 * lands on empty pane. That failure is INVISIBLE on a fast local machine and
 * showed up only as a CI failure in an unrelated spec ("the Fires on picker
 * never appeared"), so the helper's own correctness cannot be left to the specs
 * that use it — they pass either way on the machine one writes them on.
 *
 * NO TIMING IN THIS FIXTURE. The obvious shape — move the path after N
 * milliseconds — proves nothing, because whether the helper wins depends on
 * whether the probe schedule happens to straddle that instant, which is the very
 * machine-speed dependence being removed. Instead the point moves on its THIRD
 * READ. That makes the ordering a fact about the fixture rather than about the
 * host: the helper's seed read and its first probe both see the pre-move point,
 * which is exactly the coincidence a single comparison mistakes for a settle.
 *
 * So this spec goes RED against the one-comparison version of the helper — it
 * returns the pre-move point — and green only for a helper that requires a quiet
 * window. Verified by reverting the helper, not assumed.
 */

/** SVG-space points the scripted path reports: pre-move, then settled. */
const FANNED = { x: 10, y: 10 };
const SETTLED = { x: 10, y: 70 };

test.describe('#1067 — reading an edge midpoint once it has stopped moving', () => {
  test('a midpoint that moves on its third read settles on where it moved TO', async ({ page }) => {
    await page.goto('about:blank');

    // A path whose reported midpoint changes with the READ, not with the clock:
    // the first two reads agree on `FANNED`, every read after that is `SETTLED`.
    const expected = await page.evaluate(
      ([fanned, settled]) => {
        // The helper parks the pointer clear of every node before it reads, and
        // the pane is what it parks ON — so the fixture has to have one. A
        // canvas is exactly the page this helper is for; a fixture without a
        // pane is not a smaller version of that page, it is a different one.
        const pane = document.createElement('div');
        pane.className = 'react-flow__pane';
        pane.style.cssText = 'position:absolute;left:0;top:0;width:400px;height:400px';
        document.body.appendChild(pane);

        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('width', '400');
        svg.setAttribute('height', '400');
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('class', 'react-flow__edge-path');
        path.setAttribute('d', 'M 0 0 L 100 100');
        svg.appendChild(path);
        document.body.appendChild(svg);

        let reads = 0;
        path.getPointAtLength = () => {
          reads += 1;
          const p = reads <= 2 ? fanned : settled;
          return new DOMPoint(p.x, p.y);
        };

        // The helper transforms through the live screen CTM, so the expected
        // screen points are computed through the same one rather than assumed.
        const ctm = path.getScreenCTM();
        if (!ctm) throw new Error('the fixture path has no screen transform');
        const toScreen = (p: { x: number; y: number }) => {
          const s = new DOMPoint(p.x, p.y).matrixTransform(ctm);
          return { x: s.x, y: s.y };
        };
        return { fanned: toScreen(fanned), settled: toScreen(settled) };
      },
      [FANNED, SETTLED] as const,
    );

    const point = await edgeMidpoint(page);

    expect(point.x).toBeCloseTo(expected.settled.x, 3);
    expect(point.y).toBeCloseTo(expected.settled.y, 3);

    // Stated separately, because "close to settled" and "not the reading the
    // race would have returned" are only the same claim while the two points
    // are far apart — and a future fixture edit could quietly move them together.
    const missBy = Math.hypot(point.x - expected.fanned.x, point.y - expected.fanned.y);
    expect(
      missBy,
      'the helper returned the pre-move point — the settle did not hold',
    ).toBeGreaterThan(10);
  });
});
