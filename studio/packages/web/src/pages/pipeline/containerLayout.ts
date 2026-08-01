import { Position, type NodeHandle } from '@xyflow/react';
import { containerMembership, type Container, type ContainerKind } from '@autonomy-studio/shared';
import { SOURCE_PORT_ID, TARGET_PORT_ID } from './ports';

/**
 * U6c — where a container is DRAWN.
 *
 * A `Container` carries no geometry: it is `{id, kind, children, …}` and nothing
 * else. That is deliberate — the engine groups by MEMBERSHIP, not by position,
 * and a doc that stored a box would have two sources of truth about what is
 * inside a loop. So the box is DERIVED here: the union of the container's
 * children's rects, plus padding and a header band.
 *
 * Consequences worth stating, because they are the design and not an accident:
 *  - Moving a child RESIZES its container, live. There is no drag-the-group
 *    gesture to keep in sync with membership, and none can drift out of sync.
 *  - A container cannot be positioned independently of its children. When
 *    RF `parentId` lands (U23, #839), that is
 *    the point at which a container may need geometry of its own; until then
 *    deriving it is strictly less state.
 *  - The box can assert a membership the DOC DOES NOT HAVE. It is the union of
 *    its children's rects, so a NON-member positioned between two spread-out
 *    members is drawn inside the box, and two containers with interleaved
 *    children draw overlapping boxes. That undercuts the point of U6c — the box
 *    exists to make membership visible — and it is not fixable here: only RF
 *    `parentId` subflows, which clip children to their parent and are U23's,
 *    make enclosure and membership the same fact. Until then the box is a HINT
 *    at membership, and `connectRules` (not the picture) is what enforces it.
 *
 * Pure and React-free, so the arithmetic is testable without mounting a canvas
 * jsdom cannot measure anyway. NOT React-Flow-free: `containerHandles` states
 * port bounds in React Flow's own `NodeHandle` shape and uses its `Position`
 * enum (a VALUE import), which is the price of the handles being stated rather
 * than measured. Nothing here renders or holds component state.
 *
 * The module owns the box's derived GEOMETRY and what the box ANNOUNCES
 * (`containerAriaLabel`) — both derived from the same membership, which is why
 * they live together rather than the label sitting beside the component that
 * renders it.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A container's box, plus the number of children that box was DERIVED from.
 *
 * The count travels with the rect deliberately. It is what the box announces to
 * a screen reader, and taking it from `container.children.length` instead would
 * make the announcement disagree with the picture the moment the two sets differ
 * — a phantom child (deleted node, id still listed) or a child an earlier
 * container already claimed both count in the raw array and are both absent from
 * the box. That reads as "loop container, 2 activities" over an empty fallback
 * box: not a rounding error, a straight lie about what is on screen.
 */
export interface ContainerBox extends Rect {
  childCount: number;
}

/** Breathing room between a container's edge and its outermost children. */
export const CONTAINER_PADDING = 20;

/**
 * The band at the top of the box the label lives in. Added to the TOP padding
 * only, so the header never overlaps the highest child — the box grows upward
 * to make room rather than the label being drawn over an activity.
 */
export const CONTAINER_HEADER_HEIGHT = 26;

/** Distance a fallback box keeps from the graph, and from the box above it. */
export const CONTAINER_GAP = 40;

/** The size of a container that has nothing to derive a size from. */
export const EMPTY_CONTAINER_SIZE = { width: 220, height: 120 };

/** Screen px kept between a box `revealTransform` pans into view and the edge. */
export const REVEAL_MARGIN = 24;

/**
 * How much of the pane's right and bottom edges the reveal must NOT land a box
 * against, because canvas chrome is drawn there INSIDE the pane.
 *
 * `<MiniMap>` sits bottom-right in a `.react-flow__panel` with `pointer-events:
 * all`, at React Flow's default 200x150 plus the stylesheet's 15px panel margin,
 * so it owns roughly the last 215 x 165 of the pane; `<Controls>` occupies the
 * same bottom band on the left. A box landed flush against those edges can have
 * its delete control — which is at the box's TOP-RIGHT — underneath the minimap:
 * revealed, and still unclickable. That is #785's trap intact, so the reveal
 * treats the covered strips as not-usable rather than as viewport.
 *
 * Deliberately conservative and deliberately a BAND, not the corner rect the
 * chrome actually occupies: the arithmetic stays one subtraction per axis, and
 * over-insetting only ever pans a little further than strictly needed. It must
 * be revisited if the MiniMap is ever given an explicit size.
 */
export const CANVAS_CHROME_INSET = { right: 215, bottom: 165 };

/**
 * The pane extent the reveal may land a box in: the measured pane, less the
 * strips `CANVAS_CHROME_INSET` covers.
 *
 * Floored at half the pane on each axis. On a pane narrow enough that the chrome
 * covers most of it, avoiding the chrome perfectly would leave a usable box too
 * small to contain the container at all, and `revealTransform` would then decline
 * to pan (or pan somewhere useless) — an invisible box is a worse outcome than a
 * partly-covered one, so the inset yields rather than the reveal.
 */
export function usableExtent(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(width - CANVAS_CHROME_INSET.right, Math.ceil(width / 2)),
    height: Math.max(height - CANVAS_CHROME_INSET.bottom, Math.ceil(height / 2)),
  };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * The box for each container, keyed by id, in document order.
 *
 * `nodeRects` is every ACTIVITY node's current rect on the canvas — its live view
 * position and measured size. Passing rects rather than nodes keeps this
 * independent of React Flow's node shape, and keeps the caller responsible for
 * the one thing only it knows: what to use before RF has measured a node.
 *
 * Ownership comes from `containerMembership` — FIRST-declared-wins, the shared
 * SSOT the reducer and the save gate both resolve with (#492). A doubly-listed
 * child is drawn in exactly one box, the one the engine will actually run it in,
 * rather than stretching both.
 */
export function containerRects(
  containers: Container[],
  nodeRects: ReadonlyMap<string, Rect>,
): Map<string, ContainerBox> {
  const { owner } = containerMembership(containers);

  // Children grouped by their RESOLVED owner, so a phantom child (no node) and a
  // child some earlier container already claimed both fall out here rather than
  // being special-cased in the arithmetic below.
  const drawable = new Map<string, Rect[]>();
  for (const c of containers) drawable.set(c.id, []);
  for (const [id, r] of nodeRects) {
    const own = owner.get(id);
    if (own !== undefined) drawable.get(own)?.push(r);
  }

  /* Where a container with nothing to enclose goes: to the RIGHT of everything
     on the canvas, stacked. An empty `stage` is a valid doc (only `loop` and
     `foreach` refuse zero children) and a container is a legal EDGE ENDPOINT, so
     it has to be drawn somewhere real — not rendering it would silently drop its
     edges, which is the defect U6c exists to fix. The placement is deterministic
     rather than clever: any layout that reads the box back would otherwise move
     it on every render.

     It is OUTSIDE the content bounds on purpose, and it stays that way (#785).
     Inside them the box would be drawn over activities it does NOT contain —
     the "asserts a membership the doc does not have" failure named above, only
     manufactured deliberately. The cost is that a fitted viewport ends flush
     with those bounds, so a box that appears here is reliably just off-screen
     and `onlyRenderVisibleElements` culls it out of the DOM. What fixes the
     REACHABILITY is `revealTransform` below, driven from the canvas: the
     viewport moves to the box rather than the box moving into the graph. */
  const content = [...nodeRects.values()].reduce<Rect | null>(
    (acc, r) => (acc === null ? r : union(acc, r)),
    null,
  );
  const fallbackX = content === null ? 0 : content.x + content.width + CONTAINER_GAP;
  const fallbackY = content === null ? 0 : content.y;
  let emptyIndex = 0;

  const rects = new Map<string, ContainerBox>();
  for (const c of containers) {
    const children = drawable.get(c.id) ?? [];
    if (children.length === 0) {
      rects.set(c.id, {
        x: fallbackX,
        y: fallbackY + emptyIndex * (EMPTY_CONTAINER_SIZE.height + CONTAINER_GAP),
        ...EMPTY_CONTAINER_SIZE,
        childCount: 0,
      });
      emptyIndex += 1;
      continue;
    }
    // Reduced from the first child rather than from a ±Infinity seed: an empty
    // reduction is impossible here (the branch above took it), and seeding with
    // Infinity is exactly how a non-finite position reaches React Flow.
    const box = children.reduce((acc, r) => union(acc, r));
    rects.set(c.id, {
      x: box.x - CONTAINER_PADDING,
      y: box.y - CONTAINER_PADDING - CONTAINER_HEADER_HEIGHT,
      width: box.width + 2 * CONTAINER_PADDING,
      height: box.height + 2 * CONTAINER_PADDING + CONTAINER_HEADER_HEIGHT,
      childCount: children.length,
    });
  }
  return rects;
}

/**
 * `containerRects`'s rect map, with view nodes the DOC no longer has removed.
 *
 * The canvas holds nodes TWICE — the store's domain array and React Flow's view
 * array — and a mutation lands in the store one render before the reconcile
 * effect rebuilds the view. For that one render the view still carries a node
 * the doc has dropped, and every box derived from it is computed against
 * geometry that is about to move. Harmless for a container's own box (it is
 * sized from its children, and a deleted child is no longer a member), but NOT
 * harmless for the empty FALLBACK, which is placed relative to the union of ALL
 * node rects: the phantom inflates those bounds, so a container emptied by
 * deleting the graph's rightmost node is placed far right of where it will
 * actually settle. Anything reading that position in the same render — the
 * `revealTransform` pan (#785) — then acts on a stale answer and is never
 * re-run, because the correcting render produces no new transition.
 *
 * Filtering here rather than at the reveal fixes it once for every reader, and
 * removes the box's visible one-frame jump as a side effect.
 */
export function liveNodeRects(
  viewRects: ReadonlyMap<string, Rect>,
  docNodeIds: ReadonlySet<string>,
): Map<string, Rect> {
  const live = new Map<string, Rect>();
  for (const [id, r] of viewRects) if (docNodeIds.has(id)) live.set(id, r);
  return live;
}

/**
 * The pan for ONE axis: how far to move so `[near, near+size)` is on screen.
 *
 * Two thresholds, and the difference between them is the point. A box that is
 * ALREADY fully visible is left alone even if it sits flush against the edge —
 * the reveal exists to un-hide a box, not to tidy the viewport, and a cosmetic
 * nudge on an operator's canvas is exactly the gratuitous movement to avoid.
 * Once a pan is warranted, the box lands `REVEAL_MARGIN` clear of the edge so it
 * is not left half under a control or a scrollbar.
 *
 * The ORDER of the last two lines decides the over-sized case: bring the FAR
 * edge in, then let the NEAR edge override. A box bigger than the viewport
 * cannot satisfy both, and NEAR wins. VERTICALLY that is the substantive
 * choice: a container box's header band is at the top, so clipping the bottom
 * loses nothing while clipping the top would hide the delete control the reveal
 * exists to expose. HORIZONTALLY the control is at the box's RIGHT edge, so
 * top-left alignment is the consistent answer rather than the protective one —
 * an empty box is 220 flow-px and React Flow's default `maxZoom` is 2, so a box
 * too wide for a real pane is not reachable through this caller, and the axes
 * are kept symmetrical rather than special-cased for a case that cannot happen.
 */
function axisPan(near: number, size: number, extent: number): number {
  const far = near + size;
  if (near >= 0 && far <= extent) return 0;
  const pan = far > extent - REVEAL_MARGIN ? extent - REVEAL_MARGIN - far : 0;
  return near + pan < REVEAL_MARGIN ? REVEAL_MARGIN - near : pan;
}

/**
 * Which containers are drawn as the EMPTY fallback box.
 *
 * `childCount` and not `children.length`, for the same reason the box announces
 * that count: a container whose every listed child is a phantom draws the
 * fallback and IS empty on screen, whatever its array still says.
 */
export function emptyContainerIds(boxes: ReadonlyMap<string, ContainerBox>): Set<string> {
  const empty = new Set<string>();
  for (const [id, box] of boxes) if (box.childCount === 0) empty.add(id);
  return empty;
}

/**
 * The ids that have JUST become empty — `now` minus `known`, in `now`'s order.
 *
 * `known === null` means nothing has been recorded yet, i.e. this is the first
 * observation, and the answer is deliberately EMPTY: a container that is empty
 * from the start was framed by React Flow's `fitView`, and treating that as an
 * appearance would pan the canvas on every page load. An id that LEAVES the set
 * (the container was deleted, or gained a child) is not an appearance either —
 * only the transition into emptiness is.
 */
export function appearedIds(known: ReadonlySet<string> | null, now: ReadonlySet<string>): string[] {
  if (known === null) return [];
  return [...now].filter((id) => !known.has(id));
}

/**
 * The minimum pan that brings every rect in `boxes` on screen — or `null` if
 * they are already visible, so "nothing to do" is a distinct answer and the
 * caller issues no viewport write at all.
 *
 * `transform` is React Flow's `[x, y, zoom]` and the result is a `Viewport`
 * object, because those are the shapes the two consumers use: the store hands
 * out the tuple, `setViewport` takes the object. The asymmetry saves an adapter
 * in the only caller.
 *
 * ZOOM IS NEVER CHANGED. A refit would also work and would be less code, but it
 * throws away the scale the operator chose, and re-framing a whole graph to
 * surface one box loses their place on the canvas. Panning keeps both.
 *
 * Pure, like the rest of this module: the boxes come from `containerRects`, the
 * transform and the viewport size come from React Flow, and the arithmetic is
 * testable without mounting a canvas.
 */
export function revealTransform(
  boxes: readonly Rect[],
  transform: readonly [number, number, number],
  width: number,
  height: number,
): { x: number; y: number; zoom: number } | null {
  // An unmeasured viewport (React Flow reports 0×0 until it has measured the
  // pane) cannot say what is visible. Refuse rather than pan against a 0×0 box:
  // the caller's effect re-runs when the measurement lands.
  if (width <= 0 || height <= 0) return null;

  const target = boxes.reduce<Rect | null>((acc, r) => (acc === null ? r : union(acc, r)), null);
  if (target === null) return null;

  const [tx, ty, zoom] = transform;
  const dx = axisPan(target.x * zoom + tx, target.width * zoom, width);
  const dy = axisPan(target.y * zoom + ty, target.height * zoom, height);
  if (dx === 0 && dy === 0) return null;
  return { x: tx + dx, y: ty + dy, zoom };
}

/**
 * The size assumed for a node React Flow has not measured yet.
 *
 * On the AUTHOR canvas it is used for ONE frame: `measured` is populated as soon
 * as RF observes the node, and the container box re-derives from the real size
 * on the next render — so the first paint of a freshly-loaded doc has a
 * plausible box instead of a zero-area one.
 *
 * The RUN canvas (`runFlow.ts`) uses it PERMANENTLY, because it derives its
 * boxes from the doc's positions rather than from React Flow's measurements. A
 * box there can sit a few pixels loose around its children; membership, which is
 * the part that carries meaning, is unaffected.
 */
export const UNMEASURED_NODE_SIZE = { width: 150, height: 52 };

/**
 * React Flow's own handle size, in flow units — its stylesheet draws a 6px dot
 * centred on the node's border (`left: -4px` and friends).
 */
const HANDLE_SIZE = 6;

/**
 * The port bounds of a derived container box, stated rather than measured.
 *
 * `x`/`y` are relative to the node's top-left, and React Flow reads an endpoint
 * off them positionally (`getHandlePosition`): a LEFT handle contributes
 * `(handle.x, y + height/2)` and a RIGHT one `(handle.x + handle.width, …)`.
 *
 * So centring each 6px dot on its border puts the endpoint 3px OUTSIDE the box
 * (`-HANDLE_SIZE / 2` on the left, `width + HANDLE_SIZE / 2` on the right) and
 * exactly on the vertical midpoint. Three pixels out is the convention, not a
 * miss: RF's own stylesheet draws an activity's handle the same way, and what it
 * MEASURES for one lands within a pixel of this. The line therefore meets the
 * rendered dot on a container exactly as it does on an activity.
 */
export function containerHandles(width: number, height: number): NodeHandle[] {
  const y = (height - HANDLE_SIZE) / 2;
  const size = { width: HANDLE_SIZE, height: HANDLE_SIZE };
  return [
    {
      id: TARGET_PORT_ID,
      type: 'target',
      position: Position.Left,
      x: -HANDLE_SIZE / 2,
      y,
      ...size,
    },
    {
      id: SOURCE_PORT_ID,
      type: 'source',
      position: Position.Right,
      x: width - HANDLE_SIZE / 2,
      y,
      ...size,
    },
  ];
}

/**
 * What the box announces. Lives on the NODE (`ariaRole`/`ariaLabel`), not on this
 * component's own `<div>`.
 *
 * React Flow owns the outer element — `role: node.ariaRole ?? (isFocusable ?
 * 'group' : undefined)` and `aria-label: node.ariaLabel` — and this file already
 * takes that route for edges (`ariaLabel: edgeAriaLabel(e)` below). Labelling the
 * inner div instead put the accessible name on a `pointer-events: none` child of
 * a wrapper that, because the container is not focusable, had NO role at all
 * while still carrying RF's unconditional `aria-roledescription="node"`.
 *
 * Counted from the box's OWN `childCount`, not `container.children.length`: see
 * `ContainerBox`. What is announced is what is drawn.
 *
 * `name` is whatever its CALLER draws on the box, not the kind — that is the
 * whole contract, and it widened in #883. The author canvas passes the
 * `containerLabels` ordinal ('loop 2'), because its box draws that. The run graph
 * (`runs/runFlow.ts`) still passes the bare kind, deliberately: its box still
 * draws the bare kind, and announcing an ordinal the run graph shows nowhere
 * would move the mismatch rather than close it. Closing it there is #886.
 *
 * The parameter is therefore `string` and no longer `ContainerKind`, which does
 * cost a compiler check — nothing now stops a caller passing a kind where its box
 * shows a name. The rule is stated here rather than typed because both call sites
 * are named above; a third one should extend that list, not guess.
 */
export function containerAriaLabel(name: string, childCount: number): string {
  return `${name} container, ${childCount} ${childCount === 1 ? 'activity' : 'activities'}`;
}
