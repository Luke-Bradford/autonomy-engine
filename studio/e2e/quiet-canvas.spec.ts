import { expect, test, type Page } from '@playwright/test';
import { openCanvas } from './support/canvas';
import { nodeById, openSeededCanvas } from './support/seedDoc';
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

/**
 * #1066 — the CONTAINER half, which is a different mechanism wearing the same
 * clothes.
 *
 * An activity collapses in CSS and then tells React Flow to re-measure. A
 * container cannot: RF resets a derived node to unmeasured on every render and
 * takes `containerHandles`' numbers verbatim, so its collapse has to be STATED
 * in the node object and the stylesheet has to be told the same thing
 * separately. Two sources for one fact, which is exactly the shape that ships
 * broken and looks fine — the dots move and the edges stay, or the reverse, and
 * nothing throws either way.
 *
 * So the assertion is not "the ports moved". It is that the ports and the EDGE
 * BOUND TO THEM moved together, which is the only thing that can tell a working
 * collapse from two disagreeing opinions about where a port is.
 */
test.describe('#1066 — a container collapses its ports too', () => {
  const CONTAINED = {
    nodes: [
      { id: 'a', position: { x: 0, y: 0 } },
      { id: 'after', type: 'file_write' as const, position: { x: 420, y: 40 } },
    ],
    edges: [{ from: 'stage_1', to: 'after', on: 'success' as const }],
    containers: [{ id: 'stage_1', kind: 'stage' as const, children: ['a'] }],
  };

  /** Every container port's computed `top` — the fan's geometry, in order. */
  function containerPortTops(page: Page): Promise<string[]> {
    return page.evaluate(() =>
      [...document.querySelectorAll('.flow-container .flow-port')].map(
        (p) => getComputedStyle(p).top,
      ),
    );
  }

  test('its ports sit on one point at rest and fan together with their edge', async ({ page }) => {
    await openSeededCanvas(page, 'quiet container', CONTAINED);

    /* AT REST: one point, not four. Asserted as a SET so it says "they coincide"
       rather than restating whatever `top` happens to compute to. */
    await expect.poll(async () => new Set(await containerPortTops(page)).size).toBe(1);

    /* STILL DRAWN, unlike an activity's, and this is the half most likely to be
       "tidied" away later. A container's box is `pointer-events: none` (#748),
       so a port is the only thing on it a pointer can reach — hide the ports and
       the fan becomes unreachable by mouse, with no way back at all. The single
       visible dot IS the affordance. */
    const dot = page.locator('.flow-container .flow-port').first();
    await expect(dot).toHaveCSS('opacity', '1');

    const restStart = await edgeStart(page);
    const restIds = await handleIds(page);

    const stack = await dot.boundingBox();
    if (stack === null) throw new Error('the container has no port to hover');
    await page.mouse.move(stack.x + stack.width / 2, stack.y + stack.height / 2);

    // The dwell is deliberate, so this polls rather than reading once.
    await expect.poll(async () => new Set(await containerPortTops(page)).size).toBeGreaterThan(1);

    /* THE assertion. The edge is bound to the container's `success` port, and
       that port has just moved — so the line must have moved with it. A stated
       collapse that forgot to restate the fanned bounds leaves this exactly
       where it was while the dots spread out around it. */
    await expect.poll(async () => (await edgeStart(page)).y).not.toBeCloseTo(restStart.y, 0);

    // Visual only, the same invariant the activity half holds: ids never change.
    expect(await handleIds(page)).toEqual(restIds);
  });

  /**
   * The fan STAYS open once a container's port has opened it.
   *
   * This is the half of #1066 that reads as a style detail and is not one. A
   * container's box is `pointer-events: none`, so the single collapsed dot is
   * the ONLY thing a pointer can use to open the fan — and the moment it opens,
   * the ports move out from under the pointer that opened them. At a 24px pitch
   * the nearest fanned dot is 12px away and only 6px across, so the drawn dots
   * alone leave the pointer over nothing: `onPointerLeave` fires, the close
   * grace elapses, the column collapses back under the cursor and opens again.
   * A fan that flickers shut on the gesture that opens it is unusable.
   *
   * What prevents it is the invisible target, which is why a container's ports
   * carry one too. The targets TILE at exactly the pitch, so the point the
   * collapsed dot occupied is still inside a port's target after the fan opens,
   * and the pointer never leaves.
   *
   * Asserted by WAITING rather than by measuring the target: the defect is
   * temporal, and a spec that read the `::after` box would pass against a fan
   * that collapsed a beat later for some other reason.
   */
  test('the fan stays open after the port that opened it has moved away', async ({ page }) => {
    await openSeededCanvas(page, 'container fan holds', CONTAINED);

    const dot = page.locator('.flow-container .flow-port').first();
    const stack = await dot.boundingBox();
    if (stack === null) throw new Error('the container has no port to hover');
    await page.mouse.move(stack.x + stack.width / 2, stack.y + stack.height / 2);

    await expect.poll(async () => new Set(await containerPortTops(page)).size).toBeGreaterThan(1);

    /* Well past the close grace, with the pointer NOT moved. Anything that lets
       go of the pointer when the ports move will have collapsed by now. */
    await page.waitForTimeout(600);
    expect(
      new Set(await containerPortTops(page)).size,
      'the fan collapsed under a stationary pointer — the ports moved out from under it',
    ).toBeGreaterThan(1);
  });

  /**
   * The fan must not steal the box's own controls.
   *
   * A container's ✕ and ⚙ sit top-right, which is the corner the port column
   * fans INTO: on an emptied box the `success` port lands 36px above the middle
   * and its invisible 24px target covers the ✕'s centre. React Flow's handles
   * carry no `z-index`, so DOM order decided the overlap and `SourcePorts`
   * renders last — the port won.
   *
   * The shape of the failure is why this is asserted directly rather than left
   * to the spec that found it. Hovering the ✕ for the dwell is what FANS the
   * ports, so the target that steals the click only arrives once the pointer has
   * been sitting on the button: the hit-test passes, the button is visibly
   * hovered, and then mousedown starts a connection. `container-membership.spec`
   * reports that as an emptied container that can no longer be deleted — #748's
   * one-way trap reopened, on a box whose only escape hatch this is — which
   * names the symptom three steps downstream of the cause.
   *
   * Read through `elementFromPoint` because that is what decides it: React Flow
   * resolves a press against the topmost element, not against its own geometry.
   */
  test('its chrome still takes the click once the ports have fanned over it', async ({ page }) => {
    await openSeededCanvas(page, 'container chrome', CONTAINED);

    /* THE BOX MUST BE EMPTY, and that is the fixture doing real work rather than
       setting a scene. A container sized around a child is tall enough that the
       fanned column never reaches its header, so this same assertion passes with
       the stacking fix REMOVED — mutation-proved, and it is how this test was
       first written. Only at `EMPTY_CONTAINER_SIZE`'s 120px does the outermost
       port land 36px above the middle and lay its 24px target across a ✕ pinned
       2px from the top. */
    await nodeById(page, 'a').click();
    await page.getByRole('button', { name: 'Delete node' }).click();
    await expect(nodeById(page, 'a')).toHaveCount(0);
    await expect
      .poll(async () => (await page.locator('.flow-container').boundingBox())?.height)
      .toBeLessThan(140);

    const remove = page
      .locator('.react-flow__node[data-id="stage_1"]')
      .getByRole('button', { name: /^Delete / });
    const box = await remove.boundingBox();
    if (box === null) throw new Error('the container has no delete control');
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // The gesture exactly as it fails: rest on the button until the fan opens.
    await page.mouse.move(centre.x, centre.y);
    await expect.poll(async () => new Set(await containerPortTops(page)).size).toBeGreaterThan(1);

    const topmost = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return {
        isChrome: el?.closest('.flow-container-delete') !== null,
        found: `${el?.tagName ?? 'nothing'}.${el?.className ?? ''}`,
      };
    }, centre);
    expect(topmost.isChrome, `the fanned ports took the ✕: hit ${topmost.found}`).toBe(true);
  });
});
