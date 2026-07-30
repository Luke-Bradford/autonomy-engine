/**
 * #788 — the implicit success chain is DISCOVERABLE.
 *
 * `effectiveEdges` synthesizes a success chain over `nodes` array order whenever
 * a doc authors no edges, so an edge list going from non-empty to empty does not
 * merely remove routing — it REPLACES it with a sequential topology. The engine
 * semantics are unchanged (operator decision on #788: keep the inference, surface
 * it); `implicitChainOrder` is the surfacing seam, and its whole job is to be
 * incapable of disagreeing with what the engine will actually walk.
 */
import { describe, expect, it } from 'vitest';
import type { Container, Edge, EdgeOn, Node, PipelineVersion } from '../types.js';
import { effectiveEdges, implicitChainOrder } from '../params.js';

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

describe('implicitChainOrder (#788)', () => {
  it('reports the synthesized run order for an edge-less doc', () => {
    expect(implicitChainOrder(doc([node('a'), node('b'), node('c')], []))).toEqual(['a', 'b', 'c']);
  });

  it('follows node ARRAY order, not id order — that is what the chain is built from', () => {
    expect(implicitChainOrder(doc([node('c'), node('a'), node('b')], []))).toEqual(['c', 'a', 'b']);
  });

  it('is null once the doc authors ANY edge — nothing is inferred, nothing to surface', () => {
    const d = doc([node('a'), node('b'), node('c')], [edge('a', 'c')]);
    expect(implicitChainOrder(d)).toBeNull();
  });

  it('is null for a single-edge doc even when that edge is a failure/back edge', () => {
    expect(implicitChainOrder(doc([node('a'), node('b')], [edge('a', 'b', 'failure')]))).toBeNull();
  });

  it('is null below two nodes — there is no sequence to warn about', () => {
    expect(implicitChainOrder(doc([], []))).toBeNull();
    expect(implicitChainOrder(doc([node('a')], []))).toBeNull();
  });

  /**
   * The container case is REACHABLE (nothing refuses an edge-less doc that has
   * containers) and it is exactly the case the advisory must not hide: `nodes`
   * is FLAT, so the synthesized chain runs straight through container
   * membership. The surfacing reports what the engine will do — which is the
   * point — so the caller's wording must be about the NODE run order, not about
   * containers being sequenced.
   */
  it('still reports the chain when the doc has containers — the chain ignores membership', () => {
    const d = doc(
      [node('a'), node('b'), node('c')],
      [],
      [{ id: 'loop1', kind: 'loop', children: ['b'] }],
    );
    expect(implicitChainOrder(d)).toEqual(['a', 'b', 'c']);
  });

  /**
   * ANTI-DRIFT. The whole reason this lives beside `effectiveEdges` rather than
   * being re-derived in the web layer: if someone changes how the chain is
   * synthesized, a surface that independently reasoned about `edges.length === 0`
   * would keep confidently describing the OLD topology. This asserts the reported
   * order IS the walk of the synthesized edges.
   */
  it('matches the from/to walk of effectiveEdges for the same doc', () => {
    for (const ids of [
      ['a', 'b'],
      ['a', 'b', 'c'],
      ['n1', 'n2', 'n3', 'n4', 'n5'],
    ]) {
      const d = doc(ids.map(node), []);
      const synth = effectiveEdges(d);
      const walked = [synth[0]!.from, ...synth.map((e) => e.to)];
      expect(implicitChainOrder(d)).toEqual(walked);
    }
  });
});
