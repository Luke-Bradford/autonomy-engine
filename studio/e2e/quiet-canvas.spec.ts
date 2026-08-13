import { expect, test, type Page } from '@playwright/test';
import { openCanvas } from './support/canvas';
import {
  canvasNodes,
  deselect,
  edgeGroup,
  seedSelectedEdge,
  selectEdge,
} from './support/canvasGraph';

/**
 * #992 + #997 — the canvas is QUIET AT REST, in a real browser.
 *
 * Both halves are cascade-and-measurement facts, so jsdom cannot see either. It
 * computes no cascade, so it cannot tell whether the collapsed `top: 50%` rule
 * actually beats React Flow's own handle positioning; and it measures nothing,
 * so it cannot tell whether an edge FOLLOWED its port when the fan opened. The
 * failure mode this file exists to catch is precisely the one that looks right
 * everywhere else: dots that fan out while the lines they belong to stay behind.
 */

/** The computed opacity of the nth source port, as a number. */
function portOpacity(page: Page, index: number): Promise<number> {
  return page.evaluate((i) => {
    const port = document.querySelectorAll('.flow-port')[i];
    return port === undefined ? -1 : Number(getComputedStyle(port).opacity);
  }, index);
}

/** Every source port's computed `top`, in order — the fan's geometry. */
function portTops(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.flow-port')].map((p) => getComputedStyle(p).top),
  );
}

/** Every source port's React Flow handle id, in order. */
function handleIds(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.flow-port')].map((p) => p.getAttribute('data-handleid')),
  );
}

/** The start point of the one edge path — where the line actually leaves the node. */
function edgeStart(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const path = document.querySelector('.react-flow__edge-path');
    if (path === null) throw new Error('no edge path rendered');
    const point = (path as SVGPathElement).getPointAtLength(0);
    return { x: point.x, y: point.y };
  });
}

function edgeLabelOpacity(page: Page): Promise<number> {
  return page.evaluate(() => {
    const wrapper = document.querySelector('.react-flow__edge-textwrapper');
    return wrapper === null ? -1 : Number(getComputedStyle(wrapper).opacity);
  });
}

/**
 * One canvas with one edge on it, under a name unique to the calling test.
 *
 * The suite runs single-worker against ONE shared SQLite file, so every spec's
 * pipeline names live in the same namespace for the whole run — `openCanvas`
 * records that trap in its own comments, and a shared `beforeEach` name walks
 * straight into it: the second test finds two "Open …" links and fails in strict
 * mode, which reads as a broken canvas rather than a duplicate fixture.
 */
async function quietCanvas(page: Page, name: string): Promise<void> {
  await openCanvas(page, `quiet-canvas ${name}`);
  await seedSelectedEdge(page);
  await deselect(page);
}

test.describe('a canvas at rest says it with colour alone', () => {
  test('#997 — no port is drawn, and every port sits at the same middle point', async ({
    page,
  }) => {
    await quietCanvas(page, 'collapsed');
    await expect.poll(() => portOpacity(page, 0)).toBe(0);

    const tops = await portTops(page);
    expect(tops.length).toBeGreaterThan(1);
    // Collapsed means literally ONE point: every port resolves to the same
    // `top`, which is what makes each edge appear to leave a single output.
    expect(new Set(tops).size).toBe(1);
  });

  test('#992 — no edge label text is painted until it is asked for', async ({ page }) => {
    await quietCanvas(page, 'labels-hidden');
    await expect.poll(() => edgeLabelOpacity(page)).toBe(0);
  });

  test('#992 — the routing key is still in the accessible name while the label is hidden', async ({
    page,
  }) => {
    await quietCanvas(page, 'aria-kept');
    // The visible <text> is not exposed under React Flow's own role anyway, so
    // this is the channel a screen reader has always used — hiding the label
    // must not have touched it.
    const aria = await edgeGroup(page).first().getAttribute('aria-label');
    expect(aria).toMatch(/on (success|failure|completion|skipped)/);
  });

  test('#992 — selecting an edge reveals its label', async ({ page }) => {
    await quietCanvas(page, 'select-reveals');
    await selectEdge(page);
    await expect.poll(() => edgeLabelOpacity(page)).toBe(1);
  });

  test('#997 — hovering fans the ports out, and the EDGE follows its port', async ({ page }) => {
    await quietCanvas(page, 'fan-out');
    /* WAIT FOR REST, do not assume it. Seeding the edge leaves the pointer on a
       node, and the close GRACE means the fan is still out for a beat after it
       leaves — so a baseline captured here without polling records a FANNED node
       as the resting state, and the comparison below then measures fanned
       against fanned and reports no movement. That is a false negative for the
       one mechanism this test exists to prove, and it is how this spec first
       failed. */
    await expect.poll(() => portOpacity(page, 0)).toBe(0);
    const restTops = await portTops(page);
    const restStart = await edgeStart(page);
    const restIds = await handleIds(page);

    await canvasNodes(page).first().hover();

    // The dwell is deliberate, so this is a poll rather than an instant read.
    await expect.poll(() => portOpacity(page, 0)).toBe(1);
    const hoverTops = await portTops(page);
    expect(new Set(hoverTops).size).toBeGreaterThan(1);

    /* THE assertion this file exists for. React Flow caches handle positions,
       so a CSS-only collapse would move the dots and leave the line attached
       where they used to be. If the edge's start point does not move with the
       fan, the ports and the edges are two different opinions about the same
       geometry. */
    await expect.poll(async () => (await edgeStart(page)).y).not.toBeCloseTo(restStart.y, 0);

    // Visual only: the binding is untouched throughout.
    expect(await handleIds(page)).toEqual(restIds);

    await page.mouse.move(5, 5);
    await expect.poll(() => portOpacity(page, 0)).toBe(0);
    expect(await portTops(page)).toEqual(restTops);
    expect(await handleIds(page)).toEqual(restIds);
  });

  test('#997 — keyboard focus fans the ports out too', async ({ page }) => {
    await quietCanvas(page, 'keyboard');
    // React Flow owns the focusable wrapper, so this also pins the focusin
    // listener the box has to add to its own parent.
    await page.keyboard.press('Tab');
    await page.evaluate(() => {
      const node = document.querySelector('.react-flow__node');
      (node as HTMLElement | null)?.focus();
    });
    await expect.poll(() => portOpacity(page, 0)).toBe(1);
    expect(new Set(await portTops(page)).size).toBeGreaterThan(1);
  });
});
