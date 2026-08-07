import {
  containerMembership,
  effectiveEdges,
  type Container,
  type Edge,
  type Node,
} from '@autonomy-studio/shared';
import { CONTAINER_HEADER_HEIGHT, CONTAINER_PADDING, unmeasuredNodeSize } from './containerLayout';
import { sourcePortsOf, usedConditionsBySource } from './ports';

/**
 * Auto-layout for the author canvas (U9): where every activity goes, given the
 * graph alone.
 *
 * `Node.position` is REQUIRED by the schema but that does not make it
 * meaningful. A doc authored anywhere but this canvas — the CLI, a raw
 * `POST .../versions`, an import, the engine's own test corpus — routinely
 * carries `{ x: 0, y: 0 }` for every node, which renders as one pile with the
 * edges invisible underneath it. Before this there was no way out of that but
 * dragging each node by hand.
 *
 * ## What this is NOT
 *
 * This function is PURE and moves no camera: it answers "where does each node
 * go", nothing more. The viewport is a separate concern that the caller owns —
 * and it does have to own it. A re-layout is exactly the operation that makes a
 * graph wider than the pane, `onlyRenderVisibleElements` then removes the
 * off-screen nodes from the DOM, and the operator is left looking at a fraction
 * of their pipeline. `FlowCanvas`'s `fitSignal` is where that is handled, and
 * its docblock records the measurement.
 *
 * The result is still ANCHORED at the top-left of where the graph already was
 * (see the anchor step below), so nothing teleports to the origin and a small
 * graph that already fits barely moves at all.
 *
 * It also does not reduce edge CROSSINGS. Order within a column is document
 * order — deterministic and explainable. A barycenter pass is a real
 * improvement and a separate one; nothing here forecloses it.
 *
 * ## Why it is a two-level layout
 *
 * A container carries no geometry: `containerRects` DERIVES its box from the
 * union of its members' rects. So a layout that ranked members individually
 * would scatter one container's children across several columns, and the box
 * drawn around their union would then swallow every unrelated node in between —
 * asserting a membership the doc does not have. Instead each container that has
 * at least one resolvable child is packed as a single super-node whose reserved
 * slot is exactly the box `containerRects` will draw, and its children are laid
 * out inside that slot.
 */
export interface LayoutMove {
  id: string;
  position: { x: number; y: number };
}

/**
 * The space left between neighbouring slots, on both axes.
 *
 * It is a floor, not a taste: it is also what guarantees the container property
 * above. Slots are packed disjointly and a container's box fills its slot
 * exactly, so any positive gap keeps a non-member's rect out of the box — but a
 * zero gap would let them share an edge and count as touching.
 */
export const LAYOUT_GAP = 60;

interface Size {
  width: number;
  height: number;
}

interface Slot extends Size {
  /** The ids to place, in document order, once the slot's origin is known. */
  place: (origin: { x: number; y: number }) => LayoutMove[];
}

/**
 * Re-position every node into a layered left-to-right DAG layout.
 *
 * Returns a move for EVERY node, not only the ones that changed —
 * `canvasStore`'s `moveNodes` already drops no-ops (and records no history
 * entry when none are real), so filtering here would duplicate that rule in a
 * second place where the two could disagree.
 */
export function autoLayout(
  nodes: readonly Node[],
  edges: readonly Edge[],
  containers: readonly Container[],
): LayoutMove[] {
  if (nodes.length === 0) return [];

  const { owner } = containerMembership([...containers]);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  /* Sizes come from the SAME nominal-size function the canvas falls back to
     before React Flow has measured a node, so the packing and the picture agree
     on how tall a node with four outcome ports is. `used` is read off the
     DECLARED edges, matching what the canvas actually renders ports for — the
     implicit chain below is a ranking device, not something that grows ports. */
  const used = usedConditionsBySource(edges);
  const sizeOfNode = (n: Node): Size =>
    unmeasuredNodeSize(sourcePortsOf(n, used.get(n.id) ?? []).length);

  /* Only containers with a child that resolves to a real node take part.
     An empty one has no node position to write and `containerRects` parks its
     box outside the content bounds on purpose (#785), so a slot reserved here
     would push real activities aside for a box drawn somewhere else. Its
     incident edges go with it — they cannot constrain a layout that has no way
     to honour them. */
  const memberIdsByContainer = new Map<string, string[]>();
  for (const n of nodes) {
    const own = owner.get(n.id);
    if (own === undefined) continue;
    const list = memberIdsByContainer.get(own);
    if (list === undefined) memberIdsByContainer.set(own, [n.id]);
    else list.push(n.id);
  }
  const laidOut = [...containers].filter((c) => memberIdsByContainer.has(c.id));

  /* The top-level participants, in document order: every node that is not
     inside a laid-out container, plus each laid-out container. Containers come
     after the free nodes only in the sense that ordering WITHIN a rank is by
     this array's order; ranking itself decides the columns. */
  const topIds: string[] = [
    ...nodes.filter((n) => !memberIdsByContainer.has(owner.get(n.id) ?? '')).map((n) => n.id),
    ...laidOut.map((c) => c.id),
  ];
  const topSet = new Set(topIds);

  /* The representative of an id at the top level: its container if it is a
     laid-out member, else itself. */
  const repOf = (id: string): string => {
    const own = owner.get(id);
    return own !== undefined && memberIdsByContainer.has(own) ? own : id;
  };

  const forward = forwardEdges(nodes, edges, containers);

  /* The bucketing rule is TOTAL, and the cases it discards are the point.
     An edge is a top-level constraint iff its endpoints have DIFFERENT
     representatives, and an internal constraint of container C iff both
     endpoints are members of C. Everything left over — most notably an edge
     between a container and its own child, which `crossesContainerBoundary`
     refuses on this canvas but an imported doc can still carry — resolves to a
     single representative, constrains nothing, and is dropped rather than
     silently mis-ranked. */
  const topEdges: Pair[] = [];
  const internalEdges = new Map<string, Pair[]>();
  for (const e of forward) {
    const ownFrom = owner.get(e.from);
    const ownTo = owner.get(e.to);
    if (ownFrom !== undefined && ownFrom === ownTo && memberIdsByContainer.has(ownFrom)) {
      const list = internalEdges.get(ownFrom);
      if (list === undefined) internalEdges.set(ownFrom, [{ from: e.from, to: e.to }]);
      else list.push({ from: e.from, to: e.to });
      continue;
    }
    const from = repOf(e.from);
    const to = repOf(e.to);
    if (from !== to && topSet.has(from) && topSet.has(to)) topEdges.push({ from, to });
  }

  /* Each container becomes one slot whose size is exactly the box
     `containerRects` will derive: the children's extent, plus padding on every
     side and the header band on top. Placing the children at
     `origin + (PADDING, PADDING + HEADER)` therefore makes the derived box fill
     the slot precisely, which is what keeps neighbouring slots out of it. */
  const slotById = new Map<string, Slot>();
  for (const c of laidOut) {
    const childIds = memberIdsByContainer.get(c.id)!;
    const childNodes = childIds.map((id) => nodeById.get(id)!);
    const inner = packColumns(
      childNodes.map((n) => ({ id: n.id, size: sizeOfNode(n) })),
      rank(childIds, internalEdges.get(c.id) ?? []),
    );
    slotById.set(c.id, {
      width: inner.width + 2 * CONTAINER_PADDING,
      height: inner.height + 2 * CONTAINER_PADDING + CONTAINER_HEADER_HEIGHT,
      place: (origin) =>
        inner.moves.map((m) => ({
          id: m.id,
          position: {
            x: origin.x + CONTAINER_PADDING + m.position.x,
            y: origin.y + CONTAINER_PADDING + CONTAINER_HEADER_HEIGHT + m.position.y,
          },
        })),
    });
  }
  for (const n of nodes) {
    if (slotById.has(n.id) || !topSet.has(n.id)) continue;
    const size = sizeOfNode(n);
    slotById.set(n.id, {
      ...size,
      place: (origin) => [{ id: n.id, position: origin }],
    });
  }

  const packed = packColumns(
    topIds.map((id) => ({ id, size: slotById.get(id)! })),
    rank(topIds, topEdges),
    slotById,
  );

  /* Anchor at the top-left of where the graph already was, rather than at the
     origin: a graph that already fits then barely moves, and the fit that
     follows has a short distance to travel instead of jumping across the plane
     from wherever the operator had panned to. */
  const anchorX = Math.min(...nodes.map((n) => n.position.x));
  const anchorY = Math.min(...nodes.map((n) => n.position.y));
  return packed.moves.map((m) => ({
    id: m.id,
    position: { x: m.position.x + anchorX, y: m.position.y + anchorY },
  }));
}

/**
 * The moves an Arrange press should apply: the layout, less every node it would
 * leave exactly where it already is.
 *
 * Separate from `autoLayout`, and exported, because the difference decides what
 * the operator is TOLD. `moveNodes` silently drops no-op moves and records no
 * history entry when none are real, so an already-arranged graph makes the
 * button look broken unless the caller can tell the two apart. Extracted here
 * rather than left in the click handler for the reason `undoRedo.ts` states
 * about its own rules: `PipelineCanvas` has no unit test, so a rule inside it is
 * a rule nothing checks.
 */
export function arrangeMoves(
  nodes: readonly Node[],
  edges: readonly Edge[],
  containers: readonly Container[],
): LayoutMove[] {
  const current = new Map(nodes.map((n) => [n.id, n.position]));
  return autoLayout(nodes, edges, containers).filter((move) => {
    const was = current.get(move.id);
    return was !== undefined && (was.x !== move.position.x || was.y !== move.position.y);
  });
}

interface Pair {
  from: string;
  to: string;
}

/**
 * The forward edge set to rank over: the canonical edges, less back-edges, less
 * any edge with an endpoint that matches neither a node nor a container.
 *
 * `effectiveEdges` rather than `edges` because a doc with no declared edges RUNS
 * as the implicit success-chain over node order, and a layout that drew it as
 * a row of unconnected roots would contradict the engine about the same doc.
 * The dangling-endpoint guard IS belt-and-braces, and is kept knowingly. An
 * imported doc — precisely the input this feature exists for — can carry an
 * endpoint matching nothing, and `params.ts` guards its own walks the same way
 * (`forwardCycleErrors` builds its endpoint set from nodes ∪ containers for
 * exactly this). But a dangling id is ALSO excluded downstream twice over: it is
 * never a top-level participant, so the `topSet` check drops it when bucketing,
 * and `rank` skips any pair whose ends are not in the id set it was given. So no
 * test can attribute the behaviour to this line specifically — mutating it away
 * leaves the suite green, which is recorded here rather than hidden behind a
 * test that looks like coverage and is not.
 */
function forwardEdges(
  nodes: readonly Node[],
  edges: readonly Edge[],
  containers: readonly Container[],
): Edge[] {
  const endpoints = new Set<string>([...nodes.map((n) => n.id), ...containers.map((c) => c.id)]);
  return effectiveEdges({ nodes: [...nodes], edges: [...edges] }).filter(
    (e) => e.back !== true && endpoints.has(e.from) && endpoints.has(e.to),
  );
}

/**
 * Longest-path rank per id: Kahn's algorithm, with a deterministic fallback for
 * anything left standing in a residual cycle.
 *
 * Longest path rather than shortest, so a join lands to the RIGHT of every
 * branch that feeds it. Under a shortest-path rank the diamond
 * `a→b→d, a→c→d, a→d` would put `d` beside `b` and `c`, and the edges from them
 * would point backwards on screen.
 *
 * The fallback matters because a forward cycle is REACHABLE: dropping
 * back-flagged edges does not guarantee acyclicity, and the engine's own
 * analysis says as much. Every id left over is assigned once, in document
 * order, one rank past whichever of its predecessors already has one — so the
 * pass visits each id exactly once and cannot spin.
 */
function rank(ids: readonly string[], pairs: readonly Pair[]): Map<string, number> {
  const order = new Map(ids.map((id, i) => [id, i]));
  const succ = new Map<string, string[]>();
  const preds = new Map<string, string[]>();
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const p of pairs) {
    if (!order.has(p.from) || !order.has(p.to)) continue;
    (succ.get(p.from) ?? succ.set(p.from, []).get(p.from)!).push(p.to);
    (preds.get(p.to) ?? preds.set(p.to, []).get(p.to)!).push(p.from);
    indegree.set(p.to, (indegree.get(p.to) ?? 0) + 1);
  }

  const ranks = new Map<string, number>();
  const queue = ids.filter((id) => indegree.get(id) === 0);
  for (const id of queue) ranks.set(id, 0);
  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head]!;
    for (const v of succ.get(u) ?? []) {
      ranks.set(v, Math.max(ranks.get(v) ?? 0, (ranks.get(u) ?? 0) + 1));
      const left = (indegree.get(v) ?? 0) - 1;
      indegree.set(v, left);
      if (left === 0) queue.push(v);
    }
  }

  for (const id of ids) {
    if (ranks.has(id)) continue;
    const settled = (preds.get(id) ?? []).map((p) => ranks.get(p)).filter((r) => r !== undefined);
    ranks.set(id, settled.length === 0 ? 0 : Math.max(...settled) + 1);
  }
  return ranks;
}

/**
 * Place sized items into columns by rank, top-aligned, and report the extent.
 *
 * Positions are relative to `(0, 0)`; the caller translates. A column is as wide
 * as its widest member, so a column holding a container does not overlap the
 * next one.
 */
function packColumns(
  items: readonly { id: string; size: Size }[],
  ranks: ReadonlyMap<string, number>,
  slots?: ReadonlyMap<string, Slot>,
): { moves: LayoutMove[]; width: number; height: number } {
  const byRank = new Map<number, { id: string; size: Size }[]>();
  for (const item of items) {
    const r = ranks.get(item.id) ?? 0;
    const column = byRank.get(r);
    if (column === undefined) byRank.set(r, [item]);
    else column.push(item);
  }

  const moves: LayoutMove[] = [];
  let x = 0;
  let width = 0;
  let height = 0;
  for (const r of [...byRank.keys()].sort((a, b) => a - b)) {
    const column = byRank.get(r)!;
    let y = 0;
    for (const item of column) {
      const origin = { x, y };
      const slot = slots?.get(item.id);
      if (slot === undefined) moves.push({ id: item.id, position: origin });
      else moves.push(...slot.place(origin));
      y += item.size.height + LAYOUT_GAP;
    }
    const columnWidth = Math.max(...column.map((i) => i.size.width));
    width = Math.max(width, x + columnWidth);
    height = Math.max(height, y - LAYOUT_GAP);
    x += columnWidth + LAYOUT_GAP;
  }
  return { moves, width, height };
}
