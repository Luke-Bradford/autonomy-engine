import { describe, expect, it } from 'vitest';
import type { Container, Edge, Node } from '@autonomy-studio/shared';
import { autoLayout, LAYOUT_GAP } from './autoLayout';
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
    const pos = positionsOf(
      [node('a'), node('b'), node('c')],
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
    // No viewport write: the result lands where the operator is already
    // looking, so the existing React Flow fit control stays the only thing
    // that moves the camera.
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

  it('skips an edge whose endpoint matches no node or container', () => {
    // An imported doc is exactly the input this feature exists for, and it can
    // carry a dangling endpoint. It must not rank anything, and must not throw.
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
