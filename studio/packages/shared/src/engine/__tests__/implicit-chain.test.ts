/**
 * #788 — the implicit success chain is DISCOVERABLE.
 *
 * `effectiveEdges` synthesizes a success chain over `nodes` array order whenever
 * a doc authors no edges, so an edge list going from non-empty to empty does not
 * merely remove routing — it REPLACES it with a sequential topology. The engine
 * semantics are unchanged (operator decision on #788: keep the inference, surface
 * it); `implicitRouting` is the surfacing seam, and its whole job is to be
 * incapable of telling a surface something the engine will not do.
 */
import { describe, expect, it } from 'vitest';
import type { Container, Edge, EdgeOn, Node, PipelineVersion } from '../types.js';
import { effectiveEdges, implicitRouting, partitionReadiness, validateDoc } from '../params.js';

let nodeSeq = 0;
function node(id: string): Node {
  nodeSeq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: nodeSeq, y: 0 } };
}

function edge(from: string, to: string, on: EdgeOn = 'success'): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}

function doc(
  nodes: Node[],
  edges: Edge[],
  containers: Container[] = [],
): Pick<PipelineVersion, 'nodes' | 'edges' | 'containers'> {
  return { nodes, edges, containers };
}

describe('implicitRouting (#788)', () => {
  it('reports the synthesized run order for an edge-less doc', () => {
    expect(implicitRouting(doc([node('a'), node('b'), node('c')], []))).toEqual({
      kind: 'chain',
      order: ['a', 'b', 'c'],
    });
  });

  it('follows node ARRAY order, not id order — that is what the chain is built from', () => {
    expect(implicitRouting(doc([node('c'), node('a'), node('b')], []))).toEqual({
      kind: 'chain',
      order: ['c', 'a', 'b'],
    });
  });

  it('is null once the doc authors ANY edge — nothing is inferred, nothing to surface', () => {
    const d = doc([node('a'), node('b'), node('c')], [edge('a', 'c')]);
    expect(implicitRouting(d)).toBeNull();
  });

  it('is null for a single-edge doc even when that edge is a failure/back edge', () => {
    expect(implicitRouting(doc([node('a'), node('b')], [edge('a', 'b', 'failure')]))).toBeNull();
  });

  it('is null below two nodes — there is no sequence to warn about', () => {
    expect(implicitRouting(doc([], []))).toBeNull();
    expect(implicitRouting(doc([node('a')], []))).toBeNull();
  });

  /**
   * The container case is REACHABLE — nothing refuses an edge-less doc that has
   * containers (asserted below) — and it is where a naive surface lies. `nodes`
   * is FLAT, so the synthesized chain crosses container boundaries; the walk then
   * DROPS those edges. No single LINE can be claimed, so there is no `order`; what
   * the doc gets instead is the partition itself (#840), read off the same
   * `partitionReadiness` the walk uses.
   */
  it('describes the partition when containers are present — the chain is not the walk', () => {
    const d = doc([node('a'), node('b')], [], [{ id: 'c1', kind: 'stage', children: ['b'] }]);
    // Reachability, not a hypothetical: the write gate accepts this doc as-is.
    expect(validateDoc({ ...d, params: [] })).toEqual([]);
    expect(implicitRouting(d)).toEqual({
      kind: 'partitioned',
      partition: {
        roots: ['a', 'c1'],
        containerRoots: [{ containerId: 'c1', children: ['b'] }],
        follows: [],
      },
    });
  });
});

/**
 * #840 — the partition is what makes a container edit's routing change VISIBLE.
 *
 * `implicitRouting` used to collapse every containered edge-less doc to a
 * detail-free `{kind:'partitioned'}`, so the canvas's pre-edit warning — which
 * compared only that KIND — fired nothing for a membership edit on a doc that
 * already had a container, and nothing for deleting the last one. The doc still
 * changed what runs after what, and saving still minted it into an IMMUTABLE
 * version. These tests pin the detail that closes that gap.
 */
describe('implicitRouting partition (#840)', () => {
  function partitionOf(d: ReturnType<typeof doc>) {
    const routing = implicitRouting(d);
    if (routing?.kind !== 'partitioned') throw new Error(`expected partitioned, got ${routing?.kind}`);
    return routing.partition;
  }

  /**
   * THE case the ticket is about, and the one that pins `follows.scope` as
   * load-bearing: `roots` and `containerRoots` are IDENTICAL on both sides, and
   * the `b -> c` pair survives on both sides. The only thing that changes is
   * WHERE it runs — inside the stage's body, or at the top level. A projection
   * carrying `{from, to}` alone reports no change here, which is precisely the
   * silence #840 was filed about.
   */
  it('distinguishes a membership move that changes only WHERE a pair runs', () => {
    const nodes = () => [node('a'), node('b'), node('c')];
    const inside = partitionOf(doc(nodes(), [], [{ id: 'c1', kind: 'stage', children: ['b', 'c'] }]));
    const moved = partitionOf(doc(nodes(), [], [{ id: 'c1', kind: 'stage', children: ['b'] }]));

    expect(inside).toEqual({
      roots: ['a', 'c1'],
      containerRoots: [{ containerId: 'c1', children: ['b'] }],
      follows: [{ from: 'b', to: 'c', scope: 'c1' }],
    });
    expect(moved).toEqual({
      roots: ['a', 'c1'],
      containerRoots: [{ containerId: 'c1', children: ['b'] }],
      follows: [{ from: 'b', to: 'c', scope: null }],
    });
    // Stated as its own assertion because it is the property, not a by-product.
    expect(moved).not.toEqual(inside);
    expect(moved.roots).toEqual(inside.roots);
    expect(moved.containerRoots).toEqual(inside.containerRoots);
  });

  /**
   * An EMPTIED container is still a top-level root — it is a `topIncoming` key
   * with an empty bucket, whatever it does or does not contain. Pinned because
   * the plan for this ticket guessed `['a']` and the walk says `['a', 'c1']`.
   */
  it('keeps an emptied container as a parallel root, and claims no children for it', () => {
    expect(partitionOf(doc([node('a'), node('b')], [], [{ id: 'c1', kind: 'stage', children: [] }])))
      .toEqual({
        roots: ['a', 'c1'],
        containerRoots: [{ containerId: 'c1', children: [] }],
        follows: [{ from: 'a', to: 'b', scope: null }],
      });
  });

  /**
   * A container may DECLARE a child that is not in `doc.nodes` — the dangling ref
   * #746/#425 are about, and a state the warning fires in, since it fires on
   * candidate docs that are unsavable. Listing a ghost as something that runs
   * would be the surface stating the opposite of what happens, so membership is
   * intersected with the walk's own `endpointIds`.
   */
  it('does not claim a ghost child runs', () => {
    expect(
      partitionOf(
        doc([node('a'), node('b')], [], [{ id: 'c1', kind: 'stage', children: ['b', 'ghost'] }]),
      ).containerRoots,
    ).toEqual([{ containerId: 'c1', children: ['b'] }]);
  });

  /**
   * Two containers claiming the same child: `containerMembership` resolves it
   * first-wins, and the projection must resolve it the SAME way rather than
   * listing the node under both — a second reader of that rule is #847's
   * anti-pattern.
   */
  it('attributes a duplicated child to its first-wins owner only', () => {
    expect(
      partitionOf(
        doc(
          [node('a'), node('b')],
          [],
          [
            { id: 'c1', kind: 'stage', children: ['b'] },
            { id: 'c2', kind: 'stage', children: ['b'] },
          ],
        ),
      ).containerRoots,
    ).toEqual([
      { containerId: 'c1', children: ['b'] },
      { containerId: 'c2', children: [] },
    ]);
  });

  /**
   * ANTI-DRIFT, and the assertion that catches the bug an `effectiveEdges`-only
   * comparison cannot: `effectiveEdges` is the edge SET, `partitionReadiness` is
   * the WALK. Whenever a `chain` is claimed, the engine's own readiness buckets
   * must actually show that chain — each node after the first fed by exactly its
   * predecessor. Any doc for which that is false must not come back as `chain`.
   *
   * Measured before this guard existed: `nodes [a,b] · containers [stage[b]]`
   * validates clean, yet `topIncoming` is `{a: [], stage: []}` — two parallel
   * roots — while the synthesized set still says `a->b`.
   */
  it('never claims a chain the readiness partition does not walk', () => {
    const shapes = [
      doc([node('a'), node('b')], []),
      doc([node('a'), node('b'), node('c')], []),
      doc([node('a'), node('b')], [], [{ id: 'c1', kind: 'stage', children: ['b'] }]),
      doc(
        [node('a'), node('b'), node('c')],
        [],
        [{ id: 'c1', kind: 'stage', children: ['a', 'b'] }],
      ),
    ];

    let chains = 0;
    for (const d of shapes) {
      const routing = implicitRouting(d);
      if (routing?.kind !== 'chain') continue;
      chains += 1;

      const childToContainer = new Map<string, string>();
      for (const c of d.containers)
        for (const child of c.children) childToContainer.set(child, c.id);
      const { topIncoming } = partitionReadiness(d, d.containers, childToContainer);

      routing.order.forEach((id, i) => {
        const incoming = (topIncoming.get(id) ?? []).map((e) => e.from);
        expect(incoming, `incoming for '${id}'`).toEqual(i === 0 ? [] : [routing.order[i - 1]]);
      });
    }
    // Or the loop above asserted nothing at all.
    expect(chains).toBeGreaterThan(0);
  });

  /**
   * WHICH docs get a synthesized chain at all — the one thing `effectiveEdges` is
   * still authority for. Deliberately not re-computing the order from `synth`
   * here: that would just restate the implementation character-for-character and
   * discriminate nothing, since the order is already pinned literally above and
   * checked against the real walk by the test before this one.
   */
  it('claims routing for exactly the docs effectiveEdges synthesizes edges for', () => {
    const shapes = [
      doc([], []),
      doc([node('a')], []),
      doc([node('a'), node('b')], []),
      doc([node('a'), node('b'), node('c')], []),
      doc([node('a'), node('b')], [edge('a', 'b')]),
    ];
    for (const d of shapes) {
      const synthesized = d.edges.length === 0 && effectiveEdges(d).length > 0;
      expect(implicitRouting(d) !== null, JSON.stringify(d.nodes.map((n) => n.id))).toBe(
        synthesized,
      );
    }
  });
});
