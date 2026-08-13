import { describe, expect, it } from 'vitest';
import type { Container, Edge, Node } from '@autonomy-studio/shared';
import { arrangeMoves, autoLayout, LAYOUT_GAP } from './autoLayout';
import { containerRects, unmeasuredNodeSize, type Rect } from './containerLayout';

const node = (id: string, position = { x: 0, y: 0 }): Node => ({
  id,
  type: 'agent_task',
  config: {},
  position,
});

const edge = (from: string, to: string, extra: Partial<Edge> = {}): Edge =>
  ({ id: `${from}->${to}`, from, to, on: 'success', ...extra }) as Edge;

const stage = (id: string, children: string[]): Container => ({ id, kind: 'stage', children });

/* The nominal size the LAYOUT assumed, read from the same function it uses — a
   hardcoded size here would make the overlap assertion pass or fail on whether
   the two guesses happened to agree rather than on the layout. */
const NODE_SIZE = unmeasuredNodeSize(0);

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The laid-out positions keyed by node id, for the assertions below. */
function positionsOf(nodes: Node[], edges: Edge[], containers: Container[] = []) {
  const moves = autoLayout(nodes, edges, containers);
  return new Map(moves.map((m) => [m.id, m.position]));
}

/** The x of each id, in the order asked for. */
function xs(pos: Map<string, { x: number; y: number }>, ids: string[]) {
  return ids.map((id) => pos.get(id)!.x);
}

describe('autoLayout', () => {
  it('lays a linear chain out left to right on one row', () => {
    const pos = positionsOf([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);

    const [xa, xb, xc] = xs(pos, ['a', 'b', 'c']);
    expect(xa).toBeLessThan(xb!);
    expect(xb!).toBeLessThan(xc!);
    expect(pos.get('b')!.y).toBe(pos.get('a')!.y);
    expect(pos.get('c')!.y).toBe(pos.get('a')!.y);
  });

  it('stacks a fan-out into one column', () => {
    const pos = positionsOf([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('a', 'c')]);

    expect(pos.get('b')!.x).toBe(pos.get('c')!.x);
    expect(pos.get('b')!.y).not.toBe(pos.get('c')!.y);
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x);
  });

  it('ranks a diamond join by its LONGEST path, not its shortest', () => {
    // a -> b -> d and a -> c -> d, plus the short-circuit a -> d. `d` must land
    // in column 2 (after b and c), not column 1 beside them — otherwise the
    // edges from b and c point BACKWARDS on screen.
    const pos = positionsOf(
      [node('a'), node('b'), node('c'), node('d')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('a', 'd')],
    );

    expect(pos.get('d')!.x).toBeGreaterThan(pos.get('b')!.x);
    expect(pos.get('d')!.x).toBeGreaterThan(pos.get('c')!.x);
  });

  it('ignores a back-edge when ranking', () => {
    // The loop idiom: c feeds back to a. Ranking must read the FORWARD graph
    // only, or every node is in one residual cycle and the columns collapse.
    //
    // The nodes are declared in an order that DISAGREES with the topology on
    // purpose. Honouring the back-edge makes the whole graph one cycle, and the
    // residual-cycle fallback then ranks in document order — which, for a doc
    // whose declaration order happens to match its topology, produces the same
    // left-to-right answer and lets a broken filter pass. Declaring `c` first
    // separates the two: the fallback would put `c` in column 0.
    const pos = positionsOf(
      [node('c'), node('a'), node('b')],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'a', { back: true })],
    );

    const [xa, xb, xc] = xs(pos, ['a', 'b', 'c']);
    expect(xa).toBeLessThan(xb!);
    expect(xb!).toBeLessThan(xc!);
  });

  it('terminates on a residual forward cycle and places every node', () => {
    // Neither edge is flagged `back`, so dropping back-edges leaves a cycle —
    // which the engine itself warns is reachable. Kahn drains nothing here.
    const nodes = [node('a'), node('b'), node('c')];
    const pos = positionsOf(nodes, [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]);

    expect(pos.size).toBe(3);
    for (const n of nodes) {
      const p = pos.get(n.id)!;
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    // No two nodes may be stacked on the same point — that is the pile the
    // whole feature exists to undo.
    const points = new Set(nodes.map((n) => `${pos.get(n.id)!.x},${pos.get(n.id)!.y}`));
    expect(points.size).toBe(3);
  });

  it('lays an edge-less doc out as the implicit success chain it will RUN as', () => {
    // `effectiveEdges` synthesizes the chain over node order for a doc with no
    // declared edges. Laying such a doc out as three unconnected roots would
    // contradict how the engine is about to execute it.
    const pos = positionsOf([node('a'), node('b'), node('c')], []);

    const [xa, xb, xc] = xs(pos, ['a', 'b', 'c']);
    expect(xa).toBeLessThan(xb!);
    expect(xb!).toBeLessThan(xc!);
  });

  it('keeps every non-member node OUT of every container box', () => {
    // The property that matters on screen. `containerRects` derives a box from
    // the union of its members' rects, so a layout that interleaves a
    // non-member with a container's children draws that node inside a box it
    // is not in — a straight lie about membership.
    const nodes = [node('outsideA'), node('in1'), node('in2'), node('outsideB')];
    const edges = [
      edge('outsideA', 'in1'),
      edge('in1', 'in2'),
      edge('in2', 'outsideB'),
      edge('outsideA', 'outsideB'),
    ];
    const containers = [stage('c1', ['in1', 'in2'])];
    const pos = positionsOf(nodes, edges, containers);

    const rects = new Map<string, Rect>(
      nodes.map((n) => [n.id, { ...pos.get(n.id)!, ...NODE_SIZE }]),
    );
    const boxes = containerRects(containers, rects);
    const box = boxes.get('c1')!;

    for (const id of ['outsideA', 'outsideB']) {
      expect(intersects(rects.get(id)!, box), `${id} overlaps the container box`).toBe(false);
    }
    for (const id of ['in1', 'in2']) {
      expect(intersects(rects.get(id)!, box), `${id} is outside its own box`).toBe(true);
    }
  });

  /* #1005 — the cases the assertions above are structurally blind to.
     Every one of them sizes its rects with `NODE_SIZE`, the SAME nominal
     function the layout used, so the two agree by construction and no overlap
     can ever be observed. These size the rects the way the CANVAS does — from
     what React Flow measured — which is the only way the gap between assumed
     and rendered width becomes visible. */
  const WIDE = { width: 420, height: NODE_SIZE.height };

  it('#1005 packs a column from the MEASURED width, so a wide node does not crowd the next', () => {
    // A node is as wide as its title: `.flow-node` sets `min-width: 120px` and
    // no maximum, and an imported doc naming an activity type the catalog does
    // not have renders that raw type as the title. Sized nominally at 150, any
    // node past `150 + LAYOUT_GAP` was drawn straight through its neighbour.
    const nodes = [node('wide'), node('next')];
    const edges = [edge('wide', 'next')];
    const measured = new Map([['wide', WIDE]]);

    const pos = new Map(autoLayout(nodes, edges, [], measured).map((m) => [m.id, m.position]));
    const rectOf = (id: string): Rect => ({
      ...pos.get(id)!,
      ...(measured.get(id) ?? NODE_SIZE),
    });

    expect(intersects(rectOf('wide'), rectOf('next'))).toBe(false);
    // And the gap is the real one, not an accident of the two widths: the
    // column is as wide as what was MEASURED, plus the stated gap.
    expect(pos.get('next')!.x - pos.get('wide')!.x).toBe(WIDE.width + LAYOUT_GAP);
  });

  it('#1005 a WIDE container child does not push its derived box over a neighbour', () => {
    // Transitively the same defect: the container's slot is reserved from its
    // children's NOMINAL extent, but `containerRects` unions their REAL rects,
    // so an under-reserved slot draws the box across whatever sits next to it —
    // asserting a membership the doc does not have.
    const nodes = [node('inner'), node('after')];
    const edges = [edge('inner', 'after')];
    const containers = [stage('c1', ['inner'])];
    const measured = new Map([['inner', WIDE]]);

    const pos = new Map(
      autoLayout(nodes, edges, containers, measured).map((m) => [m.id, m.position]),
    );
    const rects = new Map<string, Rect>(
      nodes.map((n) => [n.id, { ...pos.get(n.id)!, ...(measured.get(n.id) ?? NODE_SIZE) }]),
    );
    const box = containerRects(containers, rects).get('c1')!;

    expect(intersects(rects.get('after')!, box), 'the box is drawn over a non-member').toBe(false);
    expect(intersects(rects.get('inner')!, box), 'the child sits inside its own box').toBe(true);
  });

  it('#1005 falls back to the nominal size for a node nothing has measured', () => {
    // The map is what React Flow has measured SO FAR — a node it has never
    // rendered is simply absent, and must lay out exactly as it does today
    // rather than collapsing to a zero-width slot.
    const nodes = [node('a'), node('b')];
    const edges = [edge('a', 'b')];

    const withEmptyMap = positionsOf(nodes, edges);
    const partial = new Map(autoLayout(nodes, edges, [], new Map()).map((m) => [m.id, m.position]));

    expect(partial.get('b')).toEqual(withEmptyMap.get('b'));
    expect(partial.get('b')!.x - partial.get('a')!.x).toBe(NODE_SIZE.width + LAYOUT_GAP);
  });

  it('drops an EMPTY container from the graph — its box is placed elsewhere', () => {
    // An empty container has no node position to write, and `containerRects`
    // parks its box outside the content bounds by design (#785). Reserving a
    // column slot for it would shove real activities aside for a box that is
    // drawn somewhere else entirely, so it must not affect the layout at all.
    const nodes = [node('a'), node('b')];
    const edges = [edge('a', 'b')];
    const withEmpty = positionsOf(nodes, edges, [stage('empty', [])]);
    const without = positionsOf(nodes, edges, []);

    expect([...withEmpty]).toEqual([...without]);
  });

  it('anchors the result at the top-left of where the graph already was', () => {
    // So a graph that already fits barely moves, and the fit that follows has a
    // short distance to travel rather than a jump to the origin.
    const nodes = [node('a', { x: 400, y: 250 }), node('b', { x: 400, y: 250 })];
    const pos = positionsOf(nodes, [edge('a', 'b')]);

    expect(Math.min(...[...pos.values()].map((p) => p.x))).toBe(400);
    expect(Math.min(...[...pos.values()].map((p) => p.y))).toBe(250);
  });

  it('is deterministic', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [edge('a', 'b'), edge('a', 'c')];

    expect(autoLayout(nodes, edges, [])).toEqual(autoLayout(nodes, edges, []));
  });

  it('neither throws nor constrains the layout on a dangling endpoint', () => {
    // An imported doc is exactly the input this feature exists for, and it can
    // carry an endpoint matching no node and no container.
    //
    // Pinned as BEHAVIOUR, deliberately not as coverage of one guard. Dangling
    // ids are excluded independently in three places — the endpoint set in
    // `forwardEdges`, the `topSet` check when bucketing, and `rank`'s own
    // membership filter — so removing any single one of them leaves this test
    // green. That redundancy is stated in `forwardEdges`' docblock rather than
    // papered over with a test that cannot see it.
    const nodes = [node('a'), node('b')];
    const pos = positionsOf(nodes, [edge('a', 'ghost'), edge('ghost', 'b')]);

    expect(pos.size).toBe(2);
    // Neither `a` nor `b` is constrained by the ghost, so both are roots.
    expect(pos.get('a')!.x).toBe(pos.get('b')!.x);
  });

  it('drops an edge between a container and its own child rather than ranking it', () => {
    // Illegal in an authored doc (`crossesContainerBoundary` refuses it) but
    // reachable by import. Both endpoints resolve to the same top-level
    // representative, so it constrains nothing and must simply be ignored.
    const nodes = [node('in1'), node('other')];
    const containers = [stage('c1', ['in1'])];
    const pos = positionsOf(nodes, [edge('c1', 'in1'), edge('c1', 'other')], containers);

    expect(pos.size).toBe(2);
    expect(pos.get('in1')!.x).toBeLessThan(pos.get('other')!.x);
  });

  it('returns nothing for a doc with no nodes', () => {
    expect(autoLayout([], [], [stage('c1', [])])).toEqual([]);
  });

  it('leaves a gap between neighbouring columns', () => {
    const pos = positionsOf([node('a'), node('b')], [edge('a', 'b')]);

    expect(pos.get('b')!.x - pos.get('a')!.x).toBeGreaterThanOrEqual(LAYOUT_GAP);
  });
});

describe('arrangeMoves', () => {
  const piled = [node('a'), node('b'), node('c')];
  const chain = [edge('a', 'b'), edge('b', 'c')];

  it('breaks up a doc that arrived as one pile', () => {
    // `a` is absent on purpose and is not an omission: the layout is anchored at
    // the graph's existing top-left, and the pile is already there, so the node
    // that lands in column 0 is genuinely not moving. What matters is that the
    // pile stops being a pile.
    const moves = arrangeMoves(piled, chain, []);

    expect(moves.map((m) => m.id)).toEqual(['b', 'c']);
    expect(new Set(moves.map((m) => `${m.position.x},${m.position.y}`)).size).toBe(2);
    expect(moves.some((m) => m.position.x === 0 && m.position.y === 0)).toBe(false);
  });

  it('reports NOTHING to move for an already-arranged doc', () => {
    // The distinction the button's message hangs off: `moveNodes` would drop
    // these silently, leaving a press that does nothing and says nothing.
    const arranged = piled.map((n) => ({
      ...n,
      position: autoLayout(piled, chain, []).find((m) => m.id === n.id)!.position,
    }));

    expect(arrangeMoves(arranged, chain, [])).toEqual([]);
  });

  it('moves only the node that is out of place', () => {
    const laid = autoLayout(piled, chain, []);
    const mostly = piled.map((n) =>
      n.id === 'c' ? n : { ...n, position: laid.find((m) => m.id === n.id)!.position },
    );

    expect(arrangeMoves(mostly, chain, []).map((m) => m.id)).toEqual(['c']);
  });
});
