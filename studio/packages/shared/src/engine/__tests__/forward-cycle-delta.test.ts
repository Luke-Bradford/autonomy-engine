import { describe, expect, it } from 'vitest';
import type { Container, Edge, EdgeOn, Node, PipelineVersion } from '../types.js';
import { closesForwardCycle, validatePipelineDoc } from '../params.js';

/**
 * `closesForwardCycle` — the CONNECT-TIME half of the DAG rule (U6b).
 *
 * The canvas needs to answer "would drawing this edge wedge the run?" while a
 * connection drag is still in flight, i.e. BEFORE the edge exists. The rule it
 * has to agree with is `validatePipelineDoc`'s `forward cycle detected`, which
 * is what the #444 write gate refuses a save for.
 *
 * These specs pin the AGREEMENT, not a re-implementation: every case asserts the
 * predicate against `validatePipelineDoc`'s own verdict on the doc that WOULD be
 * saved. That is the anti-drift shape U6a used for `stableEdgeKey` — two
 * definitions that must not disagree are asserted against each other rather
 * than left to stay in step by inspection.
 */

let seq = 0;
function node(id: string): Node {
  seq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: seq, y: 0 } };
}
function edge(from: string, to: string, on: EdgeOn = 'success', extra: Partial<Edge> = {}): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on, ...extra } as Edge;
}
function doc(
  nodes: Node[],
  edges: Edge[] = [],
  containers: Container[] = [],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'> {
  return { params: [], nodes, edges, containers };
}

/** Does `validatePipelineDoc` — the save gate — report a forward cycle here? */
function gateSeesCycle(d: Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'>) {
  return validatePipelineDoc(d).some((e) => e.includes('forward cycle'));
}

describe('closesForwardCycle — agrees with the save gate on the candidate doc', () => {
  it('a straight chain accepts another forward edge', () => {
    const base = doc([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);
    expect(closesForwardCycle(base, base.containers, 'a', 'c')).toBe(false);
    expect(gateSeesCycle(doc(base.nodes, [...base.edges, edge('a', 'c')]))).toBe(false);
  });

  it('an edge that closes a 2-cycle is refused, and the gate would refuse the doc', () => {
    const base = doc([node('a'), node('b')], [edge('a', 'b')]);
    expect(closesForwardCycle(base, base.containers, 'b', 'a')).toBe(true);
    expect(gateSeesCycle(doc(base.nodes, [...base.edges, edge('b', 'a')]))).toBe(true);
  });

  it('an edge that closes a LONGER cycle is refused too (transitive, not just 2-cycles)', () => {
    const base = doc([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);
    expect(closesForwardCycle(base, base.containers, 'c', 'a')).toBe(true);
    expect(gateSeesCycle(doc(base.nodes, [...base.edges, edge('c', 'a')]))).toBe(true);
  });

  it('a self-edge closes a cycle', () => {
    const base = doc([node('a')]);
    expect(closesForwardCycle(base, base.containers, 'a', 'a')).toBe(true);
  });

  /**
   * The reverse direction is NOT symmetric, and this is the case a reachability
   * shortcut gets wrong: `b -> a` closes a cycle, `a -> b` (again) does not.
   */
  it('a duplicate-direction edge does not close a cycle', () => {
    const base = doc([node('a'), node('b')], [edge('a', 'b')]);
    expect(closesForwardCycle(base, base.containers, 'a', 'b')).toBe(false);
  });

  it('an existing BACK-edge is not part of the forward graph, so it cannot be closed into a cycle', () => {
    // a -> b forward, b -> a back. Adding b -> a FORWARD would close a cycle;
    // the pre-existing back-edge does not make a -> b a cycle.
    const base = doc(
      [node('a'), node('b')],
      [edge('a', 'b'), edge('b', 'a', 'failure', { back: true, maxBounces: 2 })],
    );
    expect(closesForwardCycle(base, base.containers, 'a', 'b')).toBe(false);
    expect(gateSeesCycle(base)).toBe(false);
  });

  /**
   * CONTAINMENT IS NOT FORWARD ADJACENCY, and the save gate is the authority on
   * that: `forwardCycleErrors` builds its graph purely from `doc.edges`, while
   * the (unrelated) back-edge ancestry rule additionally treats a container as
   * reaching its own children. A predicate built on the latter would refuse
   * `b -> C` — a legal, savable edge — for a reason (C contains b) the canvas
   * does not even render yet.
   */
  it('a container-mediated path is NOT a forward cycle — the gate accepts it, so the canvas must', () => {
    const base = doc(
      [node('a'), node('b'), node('t')],
      [edge('a', 'b'), edge('C', 't')],
      [{ id: 'C', kind: 'stage', children: ['a', 'b'] }],
    );
    const candidate = doc(base.nodes, [...base.edges, edge('b', 'C')], base.containers);
    expect(gateSeesCycle(candidate)).toBe(false);
    expect(closesForwardCycle(base, base.containers, 'b', 'C')).toBe(false);
  });

  it('an edge INTO a container that the container already reaches by EDGES is a cycle', () => {
    const base = doc(
      [node('a')],
      [edge('C', 'a')],
      [{ id: 'C', kind: 'stage', children: [] as string[] }],
    );
    expect(closesForwardCycle(base, base.containers, 'a', 'C')).toBe(true);
    expect(gateSeesCycle(doc(base.nodes, [...base.edges, edge('a', 'C')], base.containers))).toBe(
      true,
    );
  });

  /**
   * A doc that is ALREADY cyclic does not make every further edge guilty.
   *
   * The predicate is a DELTA — "does this edge close a cycle that was not there"
   * — because the alternative blames the operator's next edge for a cycle a
   * legacy version (or another edit) brought in, and then refuses every
   * connection on the canvas until they find it. The doc-level error is already
   * on screen as a validation badge and still blocks the save.
   */
  it('on an ALREADY-cyclic doc, an unrelated edge is still allowed (the badge owns the pre-existing cycle)', () => {
    const base = doc(
      [node('a'), node('b'), node('x'), node('y')],
      [edge('a', 'b'), edge('b', 'a')],
    );
    expect(gateSeesCycle(base)).toBe(true);
    expect(closesForwardCycle(base, base.containers, 'x', 'y')).toBe(false);
  });
});
