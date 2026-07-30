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
   * DROPS those edges. Routing is still inferred and still worth announcing, so
   * this is `partitioned` rather than `null`, but the order is deliberately
   * withheld because it would be wrong.
   */
  it('withholds the order when containers are present — the chain is not the walk', () => {
    const d = doc([node('a'), node('b')], [], [{ id: 'c1', kind: 'stage', children: ['b'] }]);
    // Reachability, not a hypothetical: the write gate accepts this doc as-is.
    expect(validateDoc({ ...d, params: [] })).toEqual([]);
    expect(implicitRouting(d)).toEqual({ kind: 'partitioned' });
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
