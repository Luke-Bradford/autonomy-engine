import { expect, type Locator, type Page } from '@playwright/test';
import { RECONNECT_RADIUS } from '../../packages/web/src/pages/pipeline/ports';

/**
 * Driving the canvas: the toolbox, node placement, and building an actual GRAPH.
 *
 * ONE copy, for the reason `support/theme.ts`'s header records — this repo has
 * already paid for a helper that existed twice and got hardened in only one of
 * them. Three of the steps below encode a browser fact whose failure mode is a
 * spec that appears to be testing something else:
 *
 *  - React Flow attaches drag handlers only once it has measured a node; its
 *    `draggable` class is that signal. Dragging earlier produces a gesture the
 *    library never sees, and the spec fails on "the node never moved".
 *  - `fitView` re-centres and re-zooms asynchronously. A `boundingBox()` read
 *    during it is a SCREEN box that has moved by the time the pointer arrives,
 *    so `mouse.down()` lands on empty canvas.
 *  - `onlyRenderVisibleElements` is ON, so a node added outside the current
 *    viewport is not in the DOM at all — on a fresh canvas the second staggered
 *    add can be culled, and `nth(1)` then times out looking like a broken add.
 *
 * The first two were found the hard way while building the drag-reconciliation
 * spec; they live here so `seedSelectedEdge` inherits them rather than being
 * the un-hardened second copy.
 */

/** The activities toolbox, addressed the way a user perceives it. */
export function toolbox(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Activities' });
}

/** Every rendered activity node on the canvas. */
export function canvasNodes(page: Page): Locator {
  return page.locator('.react-flow__node');
}

export function edgeGroup(page: Page): Locator {
  return page.locator('.react-flow__edge');
}

/**
 * The edge-outcome picker, present only while an edge is selected.
 *
 * U19 slice 2 retired the `Fires on` `<select>` for a radio GROUP over the same
 * outcomes (a `<fieldset>` + `<legend>`, so `getByLabel` no longer resolves it).
 * Kept as one helper under the same name because two specs use it purely as a
 * liveness probe for "the edge panel is open" — `selectEdge` and `deselect`
 * below — and re-pointing it here keeps every caller working unchanged.
 */
export function firesOn(page: Page): Locator {
  return page.getByRole('group', { name: 'Fires on' });
}

/** One outcome radio inside that group, addressed by its encoded condition. */
export function outcomeRadio(page: Page, encoded: string): Locator {
  return firesOn(page).locator(`input[type="radio"][value="${encoded}"]`);
}

/** Add an activity by CLICK — the accessible path; no drag needed. */
export async function addActivity(page: Page, title: string): Promise<void> {
  await toolbox(page).getByRole('button', { name: title, exact: true }).click();
}

/** Wait until React Flow's viewport transform stops changing. */
export async function viewportSettled(page: Page): Promise<void> {
  const read = () =>
    page.evaluate(
      () =>
        (document.querySelector('.react-flow__viewport') as HTMLElement | null)?.style.transform,
    );
  let previous = await read();
  await expect
    .poll(
      async () => {
        const current = await read();
        const stable = current !== undefined && current !== '' && current === previous;
        previous = current;
        return stable;
      },
      { message: 'the React Flow viewport never stopped moving' },
    )
    .toBe(true);
}

/**
 * Reveal everything the viewport culled and settle it — then the node at `index`
 * is measured, draggable, and where its `boundingBox()` says it is.
 */
export async function fitAndSettle(page: Page, index = 0): Promise<void> {
  await page.locator('.react-flow__controls-fitview').click();
  await expect(canvasNodes(page).nth(index)).toHaveClass(/\bdraggable\b/);
  await viewportSettled(page);
}

/**
 * U21 — shift-drag a marquee over every node currently on the canvas.
 *
 * Raw `page.mouse` for the same reason `dragNodeBy` uses it: this is a gesture,
 * not a click on an element, and Playwright's actionability checks have nothing
 * to check. It also makes the spec immune to whatever sits on top of the pane —
 * which matters here, because the thing this gesture creates (React Flow's
 * `nodesselection-rect`) is exactly such an overlay.
 *
 * `expected` is how many nodes the caller needs the gesture to reach. It is not
 * an assertion about the result — it decides how long to keep fitting, and
 * turns "a node was still off screen" into a named failure rather than a wrong
 * selection count at the caller.
 */
export async function marqueeAllNodes(page: Page, expected: number): Promise<void> {
  /* Fit until everything really is on screen, re-fitting each attempt.
     ONE `fitAndSettle` is not enough after a node drag: the drag commits to the
     domain store, which re-renders and can move the viewport again after
     `viewportSettled` has already reported it steady — so a single fit
     intermittently leaves the dragged node hanging over the pane edge, where a
     `Full`-mode marquee cannot see it. Polling makes the wait a condition
     ("all nodes are on screen") rather than a guess about timing. */
  await expect
    .poll(
      async () => {
        await fitAndSettle(page, 0);
        return page.evaluate(() => {
          const pane = document.querySelector('.react-flow__pane')?.getBoundingClientRect();
          if (!pane) return -1;
          return [...document.querySelectorAll('.react-flow__node')].filter((el) => {
            const n = el.getBoundingClientRect();
            return (
              n.x >= pane.x && n.y >= pane.y && n.right <= pane.right && n.bottom <= pane.bottom
            );
          }).length;
        });
      },
      { message: 'the view never fitted every node fully on screen' },
    )
    .toBeGreaterThanOrEqual(expected);

  const box = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane')?.getBoundingClientRect();
    const nodes = [...document.querySelectorAll('.react-flow__node')].map((el) =>
      el.getBoundingClientRect(),
    );
    if (!pane || nodes.length === 0) return null;
    /* The WHOLE pane, inset by 2px, rather than a box fitted to the nodes.
       Two browser facts make the fitted version wrong, and both cost a
       debugging session:

       React Flow starts a box selection from a pointerdown on the pane element
       ITSELF, so a corner computed from the node rects can begin on the toolbox
       and the gesture is simply never seen.

       And `selectionMode` is the default `Full`, so a node counts only when the
       box contains it WHOLE — while a node can sit partly OUTSIDE the pane
       (`fitView` is not re-run after every drag). A box clamped to the pane then
       silently omits it, which reads as a selection bug rather than a layout
       one. Marqueeing the whole pane makes the gesture's reach exactly "what is
       on screen", and `expected` below turns any node still off-screen into a
       named failure rather than a wrong count. */
    const inside = nodes.filter(
      (n) => n.x >= pane.x && n.y >= pane.y && n.right <= pane.right && n.bottom <= pane.bottom,
    ).length;
    const startsOnPane = document
      .elementFromPoint(pane.x + 2, pane.y + 2)
      ?.classList.contains('react-flow__pane');
    return {
      left: pane.x + 2,
      top: pane.y + 2,
      right: pane.right - 2,
      bottom: pane.bottom - 2,
      inside,
      total: nodes.length,
      startsOnPane: startsOnPane === true,
    };
  });
  if (box === null) throw new Error('no pane or no nodes to marquee');
  if (!box.startsOnPane) throw new Error('the pane corner is covered — the marquee cannot start');
  if (box.inside < expected) {
    throw new Error(
      `only ${String(box.inside)} of ${String(box.total)} nodes are fully on screen, so a Full-mode marquee cannot select ${String(expected)} — fit the view first`,
    );
  }

  await page.keyboard.down('Shift');
  await page.mouse.move(box.left, box.top);
  await page.mouse.down();
  await page.mouse.move(box.right, box.bottom, { steps: 10 });
  const started = await page.evaluate(
    () => document.querySelector('.react-flow__selection') !== null,
  );
  await page.mouse.up();
  await page.keyboard.up('Shift');
  // Distinguishes "the gesture was never seen" from "it ran and selected the
  // wrong things" — the two failures look identical at the assertion.
  if (!started) throw new Error('the marquee never started — React Flow drew no selection rect');
}

/** Drag a node by its body (never a handle — that starts a CONNECTION). */
export async function dragNodeBy(page: Page, index: number, dx: number, dy: number): Promise<void> {
  const box = await canvasNodes(page).nth(index).boundingBox();
  if (!box) throw new Error(`node ${String(index)} is not laid out`);
  await page.mouse.move(box.x + box.width / 2, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + 6 + dy, { steps: 10 });
  await page.mouse.up();
}

/**
 * Two nodes with one edge between them, the edge SELECTED so the picker is up.
 * `sourceTitle` chooses what the edge hangs off — an `If Condition` is the one
 * that declares business branches.
 */
export async function seedSelectedEdge(page: Page, sourceTitle = 'HTTP Request'): Promise<void> {
  await addActivity(page, sourceTitle);
  await expect(canvasNodes(page)).toHaveCount(1);
  await addActivity(page, 'Write File');
  await fitAndSettle(page, 1);
  await expect(canvasNodes(page)).toHaveCount(2);

  // Drag the second node clear of the first so the edge has open canvas to
  // cross — otherwise every point on it is behind a node, and React Flow paints
  // nodes above edges.
  await dragNodeBy(page, 1, 300, 60);

  await connectNodes(page, 0, 1);
  await expect(edgeGroup(page)).toHaveCount(1);

  await selectEdge(page);
}

/**
 * How a spec names one node on the canvas.
 *
 * By INDEX is the original form and stays valid for docs the canvas authored
 * itself. By ID is what a SEEDED doc needs (`support/seedDoc.ts`): U6c renders
 * container boxes FIRST so they paint behind their children, so in any doc with
 * a container, index 0 is a box rather than the first activity — a positional
 * lookup would quietly address the wrong element.
 */
export type NodeRef = { index: number } | { id: string };

/**
 * The centre of one node's source (right) or target (left) port, in screen coords.
 *
 * Module-internal: every spec reaches it through one of the `connect*` gestures
 * below, which is the useful unit. Exporting the coordinate helpers as well would
 * offer two ways to do the same thing and invite a spec to hand-roll the drag.
 */
/**
 * #997 — fan a node's source ports out before anything measures one.
 *
 * At rest every source port is collapsed onto the SAME point at the middle of
 * the node, so all four rects are identical and a coordinate-based drag lands on
 * whichever handle happens to be topmost: `outcome-ports.spec.ts` asked for the
 * `failure` port and authored a `skipped` edge. A port's geometry only means
 * anything once the fan is out, which is also the gesture a real user makes —
 * hover, then reach for the port they want.
 *
 * #1066 gave a CONTAINER the same collapse, and it is aimed at differently on
 * purpose. An activity is fanned by hovering its BOX; a container's box is
 * `pointer-events: none` (#748), so the only thing on it a pointer can reach is
 * a port — which is exactly why a container's ports stay drawn while an
 * activity's do not. Aiming at the box centre there would hover whatever child
 * node sits under the middle of the region and fan THAT instead.
 */
async function fanSourcePorts(page: Page, ref: NodeRef): Promise<void> {
  const node =
    'id' in ref
      ? page.locator(`.react-flow__node[data-id="${ref.id}"]`)
      : page.locator('.react-flow__node').nth(ref.index);
  const box = node.locator('.flow-node, .flow-container');
  if ((await box.count()) === 0) return;
  /* RAW pointer move, not `hover()`. Playwright's hover runs actionability
     checks and aims at the element's centre — and a container box drawn OVER an
     activity makes that centre resolve to the container, so the activity never
     sees the pointer, never fans, and the drag that follows starts from a
     collapsed port. This is a gesture, not a click on a control, so the same
     reasoning `dragNodeBy` and `marqueeAllNodes` already record applies. */
  const container = (await node.locator('.flow-container').count()) > 0;
  const aim = container ? node.locator('.flow-port.react-flow__handle').first() : node;
  const rect = await aim.boundingBox();
  if (rect === null) throw new Error('the node has no box to hover');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  // Polls, because the fan is deliberately delayed by a dwell.
  await expect(box.first()).toHaveAttribute('data-ports-expanded', 'true');
}

function portCentreOf(
  page: Page,
  ref: NodeRef,
  side: 'source' | 'target',
  outcome: string = DEFAULT_OUTCOME,
): Promise<{ x: number; y: number }> {
  /* U19 — a source port is addressed by its HANDLE ID, not by which side of the
     node it sits on. Every outcome's port is on the right, so the old
     `.react-flow__handle-right` selector would now resolve to whichever one the
     DOM happens to list first and silently drag from `success` in every spec.
     `data-handleid` is React Flow's own attribute, and the ids are
     escaped to a `[A-Za-z0-9-_.%]` alphabet, so they need no escaping
     inside the quoted selector. */
  const selector =
    side === 'source'
      ? `.react-flow__handle[data-handleid="${outcome}"]`
      : '.react-flow__handle-left';
  if (side === 'source') return fanSourcePorts(page, ref).then(() => measure());
  return measure();

  function measure(): Promise<{ x: number; y: number }> {
    return page.evaluate(
      ({ ref: r, cls }) => {
        const node =
          'id' in r
            ? document.querySelector(`.react-flow__node[data-id="${r.id}"]`)
            : document.querySelectorAll('.react-flow__node')[r.index];
        const box = node?.querySelector(cls)?.getBoundingClientRect();
        if (!box) throw new Error(`node ${JSON.stringify(r)} has no ${cls} port laid out`);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      },
      { ref, cls: selector },
    );
  }
}

/**
 * The port every gesture below drags from unless a spec names another.
 *
 * `success` is what a connection MEANT before U19 gave each outcome its own
 * port, so keeping it the default is what makes the pre-U19 specs still describe
 * the graph they were written to build.
 */
const DEFAULT_OUTCOME = 'op:success';

/** The handle id of an operational outcome's port — U19's `encodeCondition`. */
export function outcomePort(on: 'success' | 'failure' | 'completion' | 'skipped'): string {
  return `op:${on}`;
}

/**
 * Drag a connection from one node's SOURCE port to another's TARGET port.
 *
 * Deliberately does NOT assert that an edge appeared: as of U6b a connection can
 * be legitimately REFUSED, and the specs that exercise a refusal need the same
 * gesture as the ones that expect an edge. `inspect` runs while the pointer is
 * still DOWN over the target port, which is the only moment React Flow's
 * mid-gesture handle state (`connectingto`, `valid`) exists to be read.
 */
async function connectRefs(
  page: Page,
  from: NodeRef,
  to: NodeRef,
  inspect?: () => Promise<void>,
  outcome?: string,
): Promise<void> {
  const source = await portCentreOf(page, from, 'source', outcome);
  const target = await portCentreOf(page, to, 'target');
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  if (inspect) await inspect();
  await page.mouse.up();
}

export function connectNodes(
  page: Page,
  from: number,
  to: number,
  inspect?: () => Promise<void>,
  outcome?: string,
): Promise<void> {
  return connectRefs(page, { index: from }, { index: to }, inspect, outcome);
}

/**
 * CLICK-to-connect: the OTHER gesture React Flow authors an edge with (#941).
 *
 * Click a source port, then a target — no button held in between. RF runs this
 * through `onClickConnectStart`/`onClickConnectEnd`, callbacks entirely separate
 * from the drag path's, which is why it needs its own helper and why its absence
 * from this file is how the missing refusal explanation stayed invisible.
 *
 * `mouse.click` moves then presses at a single point, so the drag threshold
 * (`@xyflow/system` index.js:2471) is never crossed and the pure click path
 * runs. There is deliberately no `inspect` hook: unlike a drag there is no
 * moment with a button down, so RF's mid-gesture `connectingto` state — the
 * thing `connectRefs`' hook exists to read — never exists here.
 *
 * Spelled out as move / down / up rather than `mouse.click`, and that is
 * load-bearing rather than style. Measured: two `mouse.click` calls back to back
 * leave the graph with no edge, no refusal, and the arm sitting on the TARGET
 * handle — the second click found no armed handle and simply re-armed, because
 * Playwright presses before the first gesture's pointer handlers have finished
 * with the move that precedes it. Each step here is its own round-trip, which is
 * the gap a real pointer always has between arriving at a port and being pressed.
 * Nothing a person can reproduce: it needs two clicks on different ports inside a
 * millisecond.
 *
 * Deliberately NOT synchronised on React Flow's `clickconnecting` class instead.
 * That was tried: it is set and cleared faster than a Playwright locator can
 * poll, so it reads as absent even on the runs that go on to author the edge.
 *
 * Takes `NodeRef`s rather than plain indices because `portCentreOf` is private
 * to this module by design; a spec cannot address a port on its own.
 */
export async function clickConnect(
  page: Page,
  from: NodeRef,
  to: NodeRef,
  outcome?: string,
): Promise<void> {
  const source = await portCentreOf(page, from, 'source', outcome);
  const target = await portCentreOf(page, to, 'target');
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.up();
}

/** `connectNodes`, for a seeded doc where the endpoints are named by id. */
export function connectById(
  page: Page,
  from: string,
  to: string,
  inspect?: () => Promise<void>,
  outcome?: string,
): Promise<void> {
  return connectRefs(page, { id: from }, { id: to }, inspect, outcome);
}

/**
 * U19 slice 2 — drag one END of the SELECTED edge onto another port.
 *
 * The grab point is NOT the port. React Flow draws the reconnect anchor tangent
 * to the handle, displaced outward by `reconnectRadius` (`shiftX`,
 * `@xyflow/react` 12.11.2 index.mjs:2834-2852) — and since nodes paint above
 * edges, the handle itself covers the inner half, so a press on the port centre
 * starts a NEW connection instead of picking the edge up. What is grabbable is
 * the crescent beyond the handle, which is why this reaches PAST the port by a
 * radius: `+r` on the right for a source end, `-r` on the left for a target end.
 *
 * The anchor exists only while the edge is SELECTED (`reconnectable` is set per
 * edge on `selected`), so callers must select it first — `selectEdge` does.
 */
export async function reconnectEdgeEnd(
  page: Page,
  end: 'source' | 'target',
  from: { id: string; outcome?: string },
  to: { id: string; outcome?: string },
): Promise<void> {
  const grab = await portCentreOf(page, { id: from.id }, end, from.outcome);
  const anchor = {
    x: grab.x + (end === 'source' ? RECONNECT_RADIUS : -RECONNECT_RADIUS),
    y: grab.y,
  };
  const drop = await portCentreOf(page, { id: to.id }, end, to.outcome);
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.down();
  await page.mouse.move(drop.x, drop.y, { steps: 10 });
  await page.mouse.up();
}

/**
 * Draw the SAME edge `from → to`, but BACKWARDS: pointer down on the target's
 * `in` port and up on the source's `out` port.
 *
 * A supported gesture — React Flow makes every handle both a valid connection
 * start and end — and one no spec exercised until U6b, which is how the refusal
 * panel came to compute its reason for the reversed edge. Half of all real
 * connection gestures go through this path, so a rule that is only ever tested
 * forwards is only half tested.
 */
async function connectRefsBackwards(page: Page, from: NodeRef, to: NodeRef): Promise<void> {
  const target = await portCentreOf(page, to, 'target');
  const source = await portCentreOf(page, from, 'source');
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(source.x, source.y, { steps: 10 });
  await page.mouse.up();
}

export function connectNodesBackwards(page: Page, from: number, to: number): Promise<void> {
  return connectRefsBackwards(page, { index: from }, { index: to });
}

/** `connectNodesBackwards`, for a seeded doc where the endpoints are named by id. */
export function connectByIdBackwards(page: Page, from: string, to: string): Promise<void> {
  return connectRefsBackwards(page, { id: from }, { id: to });
}

/**
 * Select an edge by clicking the MIDPOINT of its rendered path — the first by
 * default, or the one at `index` in DOM order.
 *
 * The index addresses `.react-flow__edge-path` in render order, which is fine
 * for the small authored graphs these specs build but is NOT a stable identity:
 * `onlyRenderVisibleElements` is on, so a culled edge is absent from the DOM
 * entirely. A spec that can name its edge should prefer a selector.
 *
 * Not `edgeGroup(page).click()`: that targets the `<g>`'s bounding-box centre,
 * which for a bezier need not lie on the curve — it can land on a node behind
 * it and select THAT, leaving a spec asserting against the node property panel
 * while reporting an edge failure.
 */
export async function selectEdge(page: Page, index = 0): Promise<void> {
  const point = await edgeMidpoint(page, index);
  await page.mouse.click(point.x, point.y);
  await expect(firesOn(page)).toBeVisible();
}

/**
 * The screen point at the middle of an edge's rendered path.
 *
 * Split out of `selectEdge` for callers that need the point but not its
 * assertion — a MODIFIED click adds the edge to a multi-selection, where the
 * single-edge condition picker `selectEdge` waits for is precisely what does
 * NOT appear.
 */
export async function edgeMidpoint(page: Page, index = 0): Promise<{ x: number; y: number }> {
  return page.evaluate((i) => {
    const paths = document.querySelectorAll('.react-flow__edge-path');
    const path = paths[i] as SVGPathElement | undefined;
    if (!path)
      throw new Error(`no edge path at index ${String(i)} (${String(paths.length)} on the canvas)`);
    const mid = path.getPointAtLength(path.getTotalLength() / 2);
    const ctm = path.getScreenCTM();
    if (!ctm) throw new Error('the edge path has no screen transform');
    const p = new DOMPoint(mid.x, mid.y).matrixTransform(ctm);
    return { x: p.x, y: p.y };
  }, index);
}

/**
 * TAB forward until the focused element carries `className`.
 *
 * TAB, never `.focus()`, for two reasons — and NOT for the tempting third one.
 * `:focus-visible` deliberately ignores programmatic focus, so a scripted
 * `.focus()` reports "no focus ring" against a perfectly working rule; and
 * TAB-REACHABILITY is itself part of what these specs assert (an element that
 * no amount of tabbing reaches is unusable however well it handles keys).
 *
 * What is NOT a reason: React Flow's `onKeyDown` is an ordinary React prop on
 * the node/edge element, so `.focus()` followed by a real key press does reach
 * it and the selection does happen. Said explicitly because the plausible
 * mechanism story ("programmatic focus doesn't wire up the handlers") is false,
 * and a false reason invites someone to "simplify" this to `.focus()` on the
 * strength of it working — losing both real reasons above.
 *
 * The canvas sits behind the rail, pane, command bar and toolbox, so a node or
 * edge is deep in the tab order; the bound is generous on purpose, and it
 * throws rather than returning false so the caller cannot silently proceed
 * against whatever happened to hold focus instead.
 */
export async function tabToFocus(page: Page, className: string, limit = 150): Promise<void> {
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    const reached = await page.evaluate(
      (cls) => Boolean(document.activeElement?.classList.contains(cls)),
      className,
    );
    if (reached) return;
  }
  throw new Error(`TAB never reached .${className} in ${String(limit)} presses`);
}

/** Deselect everything by clicking empty canvas. */
export async function deselect(page: Page): Promise<void> {
  await page.locator('.react-flow__pane').click({ position: { x: 30, y: 30 } });
  await expect(firesOn(page)).toHaveCount(0);
}

/** A computed property of the one edge path on the canvas. */
export function pathStyle(
  page: Page,
  property: 'stroke' | 'strokeDasharray' | 'strokeWidth',
): Promise<string> {
  return page.evaluate((prop) => {
    const el = document.querySelector('.react-flow__edge-path');
    if (!el) throw new Error('no edge path on the canvas');
    return getComputedStyle(el)[prop as 'stroke' | 'strokeDasharray' | 'strokeWidth'];
  }, property);
}
