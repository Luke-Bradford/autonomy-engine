import { expect, type Locator, type Page } from '@playwright/test';

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

/** The edge-condition picker (U6a), present only while an edge is selected. */
export function firesOn(page: Page): Locator {
  return page.getByLabel('Fires on');
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

  const handles = await page.evaluate(() => {
    const nodes = document.querySelectorAll('.react-flow__node');
    const s = nodes[0]?.querySelector('.react-flow__handle-right')?.getBoundingClientRect();
    const t = nodes[1]?.querySelector('.react-flow__handle-left')?.getBoundingClientRect();
    if (!s || !t) throw new Error('node handles are not laid out');
    return {
      sx: s.x + s.width / 2,
      sy: s.y + s.height / 2,
      tx: t.x + t.width / 2,
      ty: t.y + t.height / 2,
    };
  });
  await page.mouse.move(handles.sx, handles.sy);
  await page.mouse.down();
  await page.mouse.move(handles.tx, handles.ty, { steps: 10 });
  await page.mouse.up();
  await expect(edgeGroup(page)).toHaveCount(1);

  await selectEdge(page);
}

/**
 * Select the one edge by clicking the MIDPOINT of its rendered path.
 *
 * Not `edgeGroup(page).click()`: that targets the `<g>`'s bounding-box centre,
 * which for a bezier need not lie on the curve — it can land on a node behind
 * it and select THAT, leaving a spec asserting against the node property panel
 * while reporting an edge failure.
 */
export async function selectEdge(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const path = document.querySelector('.react-flow__edge-path') as SVGPathElement | null;
    if (!path) throw new Error('no edge path on the canvas');
    const mid = path.getPointAtLength(path.getTotalLength() / 2);
    const ctm = path.getScreenCTM();
    if (!ctm) throw new Error('the edge path has no screen transform');
    const p = new DOMPoint(mid.x, mid.y).matrixTransform(ctm);
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(firesOn(page)).toBeVisible();
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
