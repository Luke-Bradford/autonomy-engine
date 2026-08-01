import { expect, test, type Page } from '@playwright/test';
import { connectById, connectByIdBackwards, edgeGroup } from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import {
  nodeById,
  openSeededCanvas,
  rectOf,
  type ScreenRect,
  type SeedDoc,
} from './support/seedDoc';
import {
  CANVAS_TOKEN,
  computedStyleOf,
  contrastRatio,
  customProperty,
  documentTheme,
} from './support/theme';

/**
 * U6c — containers, drawn.
 *
 * Before U6c a container was pure pass-through on the canvas: carried forward on
 * save, fed to the connect rules, never rendered. Two things follow, and both are
 * invisible to the unit suite by construction:
 *
 *  1. The BOX IS A LAYOUT. `containerLayout.test.ts` pins the arithmetic, but
 *     arithmetic is not enclosure — the numbers can be perfect while the box is
 *     painted somewhere else, or at a size React Flow never applies, because the
 *     rect is derived from MEASURED child sizes that jsdom reports as 0×0. Only a
 *     real browser can say "this box contains those nodes".
 *  2. The EDGES. React Flow renders NOTHING for an edge whose endpoint node it
 *     considers uninitialised — `getEdgePosition` returns `null`, and RF's error
 *     channel is a no-op in a production build, so there is not even a console
 *     message. That is why a doc with a container lost every edge touching it,
 *     and why nothing caught it: the doc was right, the store was right, the
 *     `flowEdges` array was right, and the edge simply was not in the DOM.
 *
 * These specs FOUND the second one still broken after the first cut of U6c:
 * drawing the box is necessary but not sufficient, because a DERIVED node is
 * rebuilt on every render and React Flow discards the measurement it took of the
 * previous object. `FlowCanvas` now STATES `measured` and `handles` on the
 * container rather than waiting to be measured — and `keeps its edge after a
 * child moves` below is the test that goes red if that is ever undone.
 *
 * NOT covered here, deliberately, because a seeded doc cannot reach them:
 *  - the FIRST-wins resolution of a doubly-listed child — `validateDoc` refuses
 *    that doc outright, so it cannot be minted;
 *  - the back-edge exemption in the boundary rule — a canvas gesture always
 *    authors a forward edge, so `candidate.back` stays false until U6e.
 * Both live in the unit suites, which is the right place for them.
 */

/** WCAG 1.4.3 — normal-size text against its background. */
const TEXT_CONTRAST = 4.5;

/** Two children in a loop, one activity outside it, and a `loop -> outside` edge. */
function loopDoc(): SeedDoc {
  return {
    nodes: [
      { id: 'a', position: { x: 0, y: 0 } },
      { id: 'b', position: { x: 0, y: 160 } },
      // A DIFFERENT activity type. It predates #878 — when every node of one
      // type shared one name, `'HTTP Request' → 'HTTP Request'` would have passed
      // an assertion about naming while proving nothing about which end is which.
      // The ordinal now tells `a` and `b` apart on its own, and the refusal below
      // asserts `HTTP Request 2` (that is `b`, the enclosed end) precisely to pin
      // WHICH of the two identical-type nodes is named.
      { id: 'after', type: 'file_write', position: { x: 420, y: 80 } },
    ],
    edges: [
      { from: 'a', to: 'b', on: 'success' },
      { from: 'loop_1', to: 'after', on: 'success' },
    ],
    containers: [
      {
        id: 'loop_1',
        kind: 'loop',
        children: ['a', 'b'],
        // The save gate refuses a loop with no exit condition — `maxRounds` is
        // the cap, not the exit. Immaterial to what is drawn, but the seed goes
        // through the REAL write path, which is the point.
        exitWhen: '${equals(nodes.b.output.status, 200)}',
        maxRounds: 3,
      },
    ],
  };
}

/** Does `outer` fully enclose `inner`? */
function encloses(outer: ScreenRect, inner: ScreenRect): boolean {
  return (
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.right >= inner.right &&
    outer.bottom >= inner.bottom
  );
}

/**
 * The canvas surface colour, resolved through the browser's own serializer.
 *
 * Two steps, and not `resolvedPaletteColor`: the canvas token is a FLUENT one,
 * declared on `.app-fluent-root`, while that helper's probe lives on
 * `document.body` — outside the provider, where the token does not resolve and
 * the probe would silently report the initial colour instead.
 */
async function canvasBackground(page: Page): Promise<string> {
  const token = await customProperty(page, CANVAS_TOKEN);
  expect(token, 'Fluent never emitted the canvas-surface token').not.toBe('');
  return page.evaluate((value) => {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, token);
}

/**
 * A point inside the named container's box that is NOT over any activity node.
 *
 * Scoped to the container's own node rather than a bare `.flow-container`: the
 * helper's name hides its selector, so an unqualified one would go from "the
 * box" to "some box" the moment a spec seeds two containers — Playwright's
 * strict mode would refuse it, and a `.first()` would silently probe whichever
 * box RF happened to render first. Naming the container makes it neither.
 */
async function emptyPointInsideBox(
  page: Page,
  containerId: string,
): Promise<{ x: number; y: number }> {
  const box = await rectOf(page, `.react-flow__node[data-id="${containerId}"] .flow-container`);
  const point = { x: box.left + box.width / 2, y: box.bottom - 6 };
  const overNode = await page.evaluate(
    (p) => document.elementFromPoint(p.x, p.y)?.closest('.react-flow__node[data-id]') !== null,
    point,
  );
  expect(overNode, 'the probe point landed on an activity, not on empty box area').toBe(false);
  return point;
}

test.describe('U6c container rendering', () => {
  /**
   * The headline: the box is drawn, labelled by KIND, and actually ENCLOSES the
   * activities it owns — and only those.
   *
   * Enclosure is asserted against the rendered rects rather than against
   * `containerRects`' return value, because every interesting way this fails
   * leaves that return value correct: the size applied to `style` but not to the
   * node's `width`/`height`, the node positioned in the wrong coordinate space,
   * the box measured before React Flow has sized its children. The non-member
   * assertion is what keeps it honest — a box that grew to cover the whole canvas
   * would satisfy "contains its children" perfectly.
   */
  test('a container is drawn as a labelled box enclosing exactly its children', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u6c enclose', loopDoc());

    const box = page.locator('.flow-container');
    await expect(box).toHaveCount(1);
    // The KIND, in words — the epic's non-colour status encoding, and the same
    // word `connectRules` refuses a boundary crossing by.
    await expect(box.locator('.flow-container-label')).toHaveText('loop');
    /* The accessible name/role are on the NODE element React Flow renders (via the
       node's `ariaRole`/`ariaLabel`), not on the inner box — which is
       `pointer-events: none` inside a wrapper that, being non-focusable, would
       carry no role of its own. Asserted through the a11y tree rather than by
       selector, so it fails if the name stops being reachable. */
    await expect(page.getByRole('group', { name: 'loop container, 2 activities' })).toHaveCount(1);
    await expect(page.locator('.react-flow__node[data-id="loop_1"]')).toHaveAttribute(
      'aria-label',
      'loop container, 2 activities',
    );

    const boxRect = await rectOf(page, '.flow-container');
    for (const child of ['a', 'b']) {
      const rect = await rectOf(page, `.react-flow__node[data-id="${child}"]`);
      expect(encloses(boxRect, rect), `the box does not enclose child '${child}'`).toBe(true);
    }
    const outside = await rectOf(page, '.react-flow__node[data-id="after"]');
    expect(
      encloses(boxRect, outside),
      'the box swallowed an activity that is not in the container',
    ).toBe(false);

    /* BEHIND its children, which is what the `zIndex: 0` + containers-first array
       order buys. Under React Flow's basic z-index mode an unselected activity
       also resolves to 0, so DOM order is the only thing separating them, and RF
       emits nodes in the order of the `nodes` prop. Swap the spread and this is
       the assertion that goes red. */
    const firstPainted = await page.locator('.react-flow__node').first().getAttribute('data-id');
    expect(firstPainted, 'the container is painted in front of its children').toBe('loop_1');

    await expectQuiet(page, problems);
  });

  /**
   * The defect U6c exists to fix: an edge whose endpoint is a CONTAINER renders.
   *
   * `loop_1 -> after` is a perfectly legal edge — connecting the container itself
   * is the documented way for an outside step to wait for a whole loop — and
   * before U6c it was absent from the DOM with nothing logged.
   *
   * `getTotalLength()` rather than mere presence: an edge whose endpoint resolved
   * to a zero-size box at the origin still renders a `<path>`, just a degenerate
   * one, which a count assertion would happily accept.
   */
  test('an edge whose endpoint is a container is actually rendered', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u6c container edge', loopDoc());

    await expect(edgeGroup(page)).toHaveCount(2);
    const lengths = await page.evaluate(() =>
      [...document.querySelectorAll('.react-flow__edge-path')].map((p) =>
        (p as SVGPathElement).getTotalLength(),
      ),
    );
    expect(lengths).toHaveLength(2);
    for (const length of lengths) expect(length).toBeGreaterThan(10);

    await expectQuiet(page, problems);
  });

  /**
   * ...and it STILL renders once the box has been re-derived.
   *
   * This is the specific failure the first cut of U6c shipped with, and it is NOT
   * the same fact as the test above. A container node is rebuilt as a new object
   * whenever its children move, and React Flow keeps a node's measurements only
   * while the same object identity keeps coming back through the `nodes` prop. A
   * container that relies on being measured therefore drops to "uninitialised" on
   * the next render and takes its edges with it — permanently, and silently.
   * Moving a child is the cheapest way to force that re-derivation; removing
   * either `measured` or `handles` from the derived node turns this red.
   */
  test('a container keeps its edge after a child moves and the box is re-derived', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u6c edge survives', loopDoc());
    await expect(edgeGroup(page)).toHaveCount(2);

    const child = await rectOf(page, '.react-flow__node[data-id="b"]');
    await page.mouse.move(child.left + child.width / 2, child.top + child.height / 2);
    await page.mouse.down();
    await page.mouse.move(child.left + child.width / 2 - 90, child.top + child.height / 2 + 90, {
      steps: 10,
    });
    await page.mouse.up();

    await expect(edgeGroup(page)).toHaveCount(2);
    const stillDrawn = await page.evaluate(
      () =>
        (
          document.querySelector(
            '[aria-label*="from loop_1"] .react-flow__edge-path',
          ) as SVGPathElement | null
        )?.getTotalLength() ?? 0,
    );
    expect(stillDrawn, 'the container edge vanished when the box was re-derived').toBeGreaterThan(
      10,
    );

    await expectQuiet(page, problems);
  });

  /**
   * The box does not swallow gestures aimed through it.
   *
   * A React Flow node is an absolutely-positioned div, and this one spans a
   * REGION of the canvas containing other interactive things. Hit-testable, it
   * would sit in front of the pane and eat the click aimed at the space between
   * its children — the shape of the bug U6b already paid for once in its
   * `.react-flow__panel` form.
   *
   * Asserted as BEHAVIOUR, never as the computed `pointer-events` value: React
   * Flow itself writes `pointer-events: none` inline on the wrapper of a node
   * that is neither selectable nor draggable, and the property inherits, so a
   * computed-value assertion would stay green with the stylesheet rule deleted —
   * it would be measuring RF's default rather than our rule. Mutation-proven
   * instead against `selectable: false` in `FlowCanvas`, which is what actually
   * flips RF's inline value to `all` and makes the box start eating clicks.
   */
  test('the box does not swallow gestures aimed through it', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u6c pointer', loopDoc());

    const point = await emptyPointInsideBox(page, 'loop_1');
    const hitsBox = await page.evaluate(
      (p) => document.elementFromPoint(p.x, p.y)?.closest('.flow-container') !== null,
      point,
    );
    expect(
      hitsBox,
      'the container box is hit-testable — it will swallow pane clicks aimed through it',
    ).toBe(false);

    // ...and the click really does reach the pane: a selected node deselects.
    await nodeById(page, 'after').click();
    await expect(nodeById(page, 'after')).toHaveClass(/\bselected\b/);
    await page.mouse.click(point.x, point.y);
    await expect(nodeById(page, 'after')).not.toHaveClass(/\bselected\b/);

    await expectQuiet(page, problems);
  });

  /**
   * A container's PORTS stay grabbable, even though the box around them is inert.
   *
   * Driven as a GESTURE and read back through what the canvas says about it,
   * rather than by inspecting `pointer-events` on the handle: React Flow's own
   * stylesheet already gives every connectable handle `pointer-events: all`, so a
   * computed-value check there proves nothing about our rules either. Dragging
   * `loop_1 → after` — an edge the doc already has — must reach the connect rules
   * and come back as the DUPLICATE refusal. With no source handle on the
   * container, or no bounds for it, the drag never starts and no refusal appears
   * at all.
   */
  test('a container’s ports stay grabbable through the inert box', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u6c handles', loopDoc());

    await connectById(page, 'loop_1', 'after');

    const refusal = page.locator('.canvas-refusal');
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText('already');
    // Named by KIND — the word printed on the box — not by its raw id.
    await expect(refusal).toContainText('loop container');
    await expect(refusal).not.toContainText('loop_1');
    await expect(edgeGroup(page)).toHaveCount(2); // nothing authored

    await expectQuiet(page, problems);
  });

  /**
   * The box is DERIVED, so moving a child moves the box — live, with no container
   * state to fall out of step with membership.
   *
   * The settle assertion is the regression net for the feedback loop the
   * derivation exists to avoid: a container held in `useNodesState` would be
   * set → measured → recomputed → set. It shows up here as a height that never
   * stops changing — NOT as a console warning, since RF's error channel is a
   * no-op in the production build these specs run against, which is the whole
   * reason the missing edges went unnoticed. The poll is the only net there.
   */
  test('moving a child re-derives its container box', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u6c rederive', loopDoc());

    const before = await rectOf(page, '.flow-container');
    const child = await rectOf(page, '.react-flow__node[data-id="b"]');
    await page.mouse.move(child.left + child.width / 2, child.top + child.height / 2);
    await page.mouse.down();
    await page.mouse.move(child.left + child.width / 2, child.top + child.height / 2 + 120, {
      steps: 10,
    });
    await page.mouse.up();

    await expect
      .poll(async () => Math.round((await rectOf(page, '.flow-container')).height))
      .toBeGreaterThan(Math.round(before.height) + 100);

    const settled = await rectOf(page, '.flow-container');
    await page.waitForTimeout(150);
    const stillSettled = await rectOf(page, '.flow-container');
    expect(
      Math.round(stillSettled.height),
      'the container box never settled — derivation is feeding back into itself',
    ).toBe(Math.round(settled.height));

    expect(encloses(stillSettled, await rectOf(page, '.react-flow__node[data-id="b"]'))).toBe(true);
    await expectQuiet(page, problems);
  });

  /**
   * A container with nothing to enclose still gets a real box.
   *
   * An empty `stage` is a valid doc (only `loop`/`foreach` require children) and
   * a container is a legal edge endpoint, so "nothing to derive from" cannot mean
   * "not drawn" — that would silently drop its edges again. The hazard being
   * guarded is arithmetic: a min/max over no children is ±Infinity, and an
   * infinite React Flow position renders as garbage or as nothing at all, which
   * is why FINITE and non-degenerate are asserted rather than a specific spot.
   */
  test('an empty container still renders a finite, non-degenerate box', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u6c empty', {
      nodes: [{ id: 'solo', position: { x: 0, y: 0 } }],
      containers: [{ id: 'stage_1', kind: 'stage', children: [] }],
    });

    const box = await rectOf(page, '.flow-container');
    for (const [name, value] of Object.entries(box)) {
      expect(Number.isFinite(value), `the empty container's ${name} is not finite`).toBe(true);
    }
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    // Beside the graph, not on top of it.
    expect(encloses(box, await rectOf(page, '.react-flow__node[data-id="solo"]'))).toBe(false);

    await expectQuiet(page, problems);
  });

  /**
   * The boundary rule, as a GESTURE — in BOTH drag directions.
   *
   * `connectRules.test.ts` pins the predicate and the sentence; what it cannot
   * see is whether the drag from a child to an outside activity reaches that rule
   * at all, and whether the refusal renders where the operator is looking. Both
   * directions, because `onConnectEnd` hands over the raw (down, up) pair and the
   * reason is computed from it — U6b already shipped a rule that read correctly
   * forwards and named the wrong end backwards. The sentence must be identical
   * either way: it is a fact about the edge, not about the gesture.
   */
  test('connecting out of a container is refused, naming the container by kind', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u6c boundary', loopDoc());

    const refusal = page.locator('.canvas-refusal');
    for (const direction of ['forwards', 'backwards'] as const) {
      if (direction === 'forwards') await connectById(page, 'b', 'after');
      else await connectByIdBackwards(page, 'b', 'after');

      await expect(refusal).toBeVisible();
      await expect(refusal, `${direction}: not refused as a boundary crossing`).toContainText(
        'cross a container boundary',
      );
      await expect(refusal, `${direction}: the enclosed end is named wrong`).toContainText(
        "'HTTP Request 2' is inside the loop container",
      );
      await expect(refusal).not.toContainText('loop_1');
      // Nothing authored: still the two edges the doc was seeded with.
      await expect(edgeGroup(page)).toHaveCount(2);
      await refusal.getByRole('button', { name: 'Dismiss' }).click();
    }

    await expectQuiet(page, problems);
  });

  /**
   * Both themes: the box's own fill must actually PAINT, and differently in each.
   *
   * The fill is the cheapest thing here to get wrong and the hardest to notice —
   * a custom property that resolves to nothing does not throw, it paints nothing,
   * which is the silent white-in-dark failure the U0 bridge exists to prevent. So
   * the assertion is on the RESOLVED `background-color` of the rendered box, and
   * on the two themes DIFFERING: a dark tint is invisible on light mode's white
   * canvas, so a missing light-mode override is a real defect that a mere
   * "is it defined" check would sail straight past.
   *
   * Contrast is measured against the CANVAS surface. The fill is deliberately
   * translucent (8–10% alpha), so compositing it over that surface moves the
   * effective background by about a percent.
   */
  test('the container box paints, and reads, in both themes', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u6c theme', loopDoc());

    const readTheme = async () => ({
      fill: await computedStyleOf(page, '.flow-container', 'background-color'),
      label: await computedStyleOf(page, '.flow-container-label', 'color'),
      canvas: await canvasBackground(page),
    });

    const dark = await readTheme();
    await page.getByRole('switch', { name: 'Dark mode' }).click();
    await expect.poll(() => documentTheme(page)).toBe('light');
    const light = await readTheme();

    for (const [theme, read] of [
      ['dark', dark],
      ['light', light],
    ] as const) {
      // A transparent fill is the failure mode: the box stops being a region.
      expect(read.fill, `the ${theme} container fill did not resolve`).toMatch(/^rgba?\(/);
      expect(read.fill, `the ${theme} container fill is fully transparent`).not.toMatch(/,\s*0\)$/);
      expect(
        contrastRatio(read.label, read.canvas),
        `the container label ${read.label} is unreadable on the ${theme} canvas (${read.canvas})`,
      ).toBeGreaterThan(TEXT_CONTRAST);
    }
    expect(light.fill, 'both themes paint the same container fill').not.toBe(dark.fill);

    await expectQuiet(page, problems);
  });

  /**
   * The MINIMAP, which U6c changed without meaning to.
   *
   * React Flow's minimap draws every node in the lookup as one filled rect, so
   * putting containers in the lookup put them in the minimap too — a large blob in
   * the SAME fill as the activities it encloses, painted OVER them (containers
   * come first in the `nodes` prop and the minimap keeps that order). The overview
   * of a doc with a `loop` became a solid block.
   *
   * Asserted on the computed `fill`, because that is the whole claim: nothing about
   * the DOM changes when the rule is lost, only the paint. `fill: none` also has to
   * be read off the CONTAINER's rect specifically — a rule that hit every minimap
   * node would hide the whole overview and still satisfy a "container is not
   * filled" check, so the activity's fill is asserted in the same breath.
   */
  test('a container is an OUTLINE in the minimap, not another filled node', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e u6c minimap', loopDoc());

    const CONTAINER = '.react-flow__minimap-node.minimap-node-container';
    const ACTIVITY = '.react-flow__minimap-node:not(.minimap-node-container)';
    // One box, three activities — the seeded doc's own shape, so a miscounted
    // class (all nodes, or none) fails here rather than looking plausible.
    await expect(page.locator(CONTAINER)).toHaveCount(1);
    await expect(page.locator(ACTIVITY)).toHaveCount(3);

    expect(
      await computedStyleOf(page, CONTAINER, 'fill'),
      'the container is FILLED in the minimap, so it covers its own children',
    ).toBe('none');
    const stroke = await computedStyleOf(page, CONTAINER, 'stroke');
    expect(stroke, 'the outline did not resolve, so the container is invisible').toMatch(/^rgb/);

    const activityFill = await computedStyleOf(page, ACTIVITY, 'fill');
    expect(activityFill, 'the activities lost their fill too').not.toBe('none');
    expect(activityFill).toMatch(/^rgb/);

    await expectQuiet(page, problems);
  });
});
