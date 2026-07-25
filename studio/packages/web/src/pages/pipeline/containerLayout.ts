import { containerMembership, type Container } from '@autonomy-studio/shared';

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
 *    membership becomes authorable (U6d) and RF `parentId` lands (U23), that is
 *    the point at which a container may need geometry of its own; until then
 *    deriving it is strictly less state.
 *
 * Pure and framework-free — no React, no React Flow — so the arithmetic is
 * testable without mounting a canvas jsdom cannot measure anyway.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
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
): Map<string, Rect> {
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
     it on every render. */
  const content = [...nodeRects.values()].reduce<Rect | null>(
    (acc, r) => (acc === null ? r : union(acc, r)),
    null,
  );
  const fallbackX = content === null ? 0 : content.x + content.width + CONTAINER_GAP;
  const fallbackY = content === null ? 0 : content.y;
  let emptyIndex = 0;

  const rects = new Map<string, Rect>();
  for (const c of containers) {
    const children = drawable.get(c.id) ?? [];
    if (children.length === 0) {
      rects.set(c.id, {
        x: fallbackX,
        y: fallbackY + emptyIndex * (EMPTY_CONTAINER_SIZE.height + CONTAINER_GAP),
        ...EMPTY_CONTAINER_SIZE,
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
    });
  }
  return rects;
}
