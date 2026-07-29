import { describe, expect, it } from 'vitest';
import type { Container, Edge, EdgeOn, Node, PipelineVersion } from '../types.js';
import { containerMembership, crossesContainerBoundary, validatePipelineDoc } from '../params.js';

/**
 * `crossesContainerBoundary` — the CONNECT-TIME half of the encapsulation rule
 * (U6c).
 *
 * The rule it has to agree with is `validatePipelineDoc`'s "crosses a container
 * boundary", which is what the #444 write gate refuses a save for: a child's
 * forward edges must stay within its container, or the outside node would run
 * from the child's terminal before the container exits.
 *
 * These specs pin the AGREEMENT, not a re-implementation — the shape
 * `forward-cycle-delta.test.ts` established for U6b's DAG rule. Every case
 * asserts the predicate against `validatePipelineDoc`'s own verdict on the doc
 * that WOULD be saved, so the canvas cannot come to refuse a different set of
 * gestures than the gate refuses saves for.
 *
 * Unlike the cycle rule this is NOT a delta: boundary-crossing is a property of
 * the single candidate edge, so a doc that already contains one does not make
 * the next edge guilty. The `already-crossing doc` spec below pins exactly that.
 */

let seq = 0;
function node(id: string): Node {
  seq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: seq, y: 0 } };
}
function edge(from: string, to: string, on: EdgeOn = 'success', extra: Partial<Edge> = {}): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on, ...extra } as Edge;
}
/** A `stage`, the one kind with no exit configuration to get in the way. */
function stage(id: string, children: string[]): Container {
  return { id, kind: 'stage', children };
}
function doc(
  nodes: Node[],
  edges: Edge[] = [],
  containers: Container[] = [],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'> {
  return { params: [], nodes, edges, containers };
}

/** Does the save gate report a boundary crossing here? */
function gateSeesCrossing(d: Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'>) {
  return validatePipelineDoc(d).some((e) => e.includes('crosses a container boundary'));
}

/** The predicate, called the way both real callers call it. */
function crosses(containers: Container[], from: string, to: string): boolean {
  return crossesContainerBoundary(containerMembership(containers).owner, from, to);
}

describe('crossesContainerBoundary — agrees with the save gate on the candidate doc', () => {
  it('two top-level nodes may connect', () => {
    const base = doc([node('a'), node('b')], [], [stage('s', [])]);
    expect(crosses(base.containers, 'a', 'b')).toBe(false);
    expect(gateSeesCrossing(doc(base.nodes, [edge('a', 'b')], base.containers))).toBe(false);
  });

  it('two children of the SAME container may connect', () => {
    const base = doc([node('a'), node('b')], [], [stage('s', ['a', 'b'])]);
    expect(crosses(base.containers, 'a', 'b')).toBe(false);
    expect(gateSeesCrossing(doc(base.nodes, [edge('a', 'b')], base.containers))).toBe(false);
  });

  it('a child may NOT connect out to a top-level node', () => {
    const base = doc([node('a'), node('b')], [], [stage('s', ['a'])]);
    expect(crosses(base.containers, 'a', 'b')).toBe(true);
    expect(gateSeesCrossing(doc(base.nodes, [edge('a', 'b')], base.containers))).toBe(true);
  });

  it('a top-level node may NOT connect in to a child', () => {
    const base = doc([node('a'), node('b')], [], [stage('s', ['b'])]);
    expect(crosses(base.containers, 'a', 'b')).toBe(true);
    expect(gateSeesCrossing(doc(base.nodes, [edge('a', 'b')], base.containers))).toBe(true);
  });

  it('children of DIFFERENT containers may not connect', () => {
    const base = doc([node('a'), node('b')], [], [stage('s', ['a']), stage('t', ['b'])]);
    expect(crosses(base.containers, 'a', 'b')).toBe(true);
    expect(gateSeesCrossing(doc(base.nodes, [edge('a', 'b')], base.containers))).toBe(true);
  });

  it('a top-level node may connect to the CONTAINER ITSELF (both have no owner)', () => {
    const base = doc([node('a'), node('b')], [], [stage('s', ['b'])]);
    expect(crosses(base.containers, 'a', 's')).toBe(false);
    expect(gateSeesCrossing(doc(base.nodes, [edge('a', 's')], base.containers))).toBe(false);
  });

  /**
   * FIRST-declared-wins, read from the shared `containerMembership` SSOT rather
   * than re-derived. A doubly-listed child is itself a validation error, but the
   * canvas must still resolve its owner the way the reducer does (#492, where the
   * reducer silently took the LAST owner instead) — otherwise the connect rule
   * refuses a gesture the gate allows, or worse the reverse.
   */
  it('a doubly-listed child is owned by the FIRST container that lists it', () => {
    /* The containers are built so the two rules DISAGREE: 'b' is a child of 't'
       only, so for the edge a -> b …
         FIRST-wins: 'a' belongs to 's', 'b' to 't'  → crosses
         LAST-wins:  'a' belongs to 't', 'b' to 't'  → does NOT cross
       An earlier draft asserted `crosses(…, 'a', 'b')` with 'b' owned by NOBODY,
       which is `true` under either resolution — it pinned nothing. */
    const containers = [stage('s', ['a']), stage('t', ['a', 'b'])];
    const owner = containerMembership(containers).owner;
    expect(owner.get('a')).toBe('s');
    expect(crossesContainerBoundary(owner, 'a', 'b')).toBe(true);
    // And the gate agrees, which is the point of resolving it the same way.
    expect(gateSeesCrossing(doc([node('a'), node('b')], [edge('a', 'b')], containers))).toBe(true);
  });

  /**
   * NOT a delta, and this is the spec that says so. `closesForwardCycle` has to
   * subtract the base doc's own cycles or one bad legacy version refuses every
   * subsequent connection; boundary-crossing needs no such guard, because the
   * property is local to the candidate edge. Pinned rather than assumed: the two
   * rules sit side by side in `connectRejection` and the asymmetry is easy to
   * "fix" into a bug.
   */
  it('an ALREADY-crossing doc does not make an unrelated legal edge guilty', () => {
    const containers = [stage('s', ['a'])];
    const nodes = [node('a'), node('b'), node('c')];
    const base = doc(nodes, [edge('a', 'b')], containers);
    expect(gateSeesCrossing(base)).toBe(true); // the pre-existing crossing
    expect(crosses(containers, 'b', 'c')).toBe(false); // still allowed
  });

  /**
   * Back-edges are exempt in the validator (`if (e.back) continue`), so the
   * predicate must not be consulted for one — the same shape as
   * `closesForwardCycle`, which back-edges escape by construction. Asserted
   * against the gate so the exemption cannot quietly move.
   */
  it('the gate exempts a BACK-edge that crosses, so callers must not consult this for one', () => {
    const containers = [stage('s', ['a'])];
    const nodes = [node('a'), node('b')];
    // ONLY the back-edge crosses. An accompanying FORWARD edge between the same
    // two would cross on its own account and make this spec vacuous — the first
    // draft did exactly that and failed here, which is the assertion working.
    const crossing = doc(nodes, [edge('a', 'b', 'success', { back: true })], containers);
    expect(gateSeesCrossing(crossing)).toBe(false);
    // The predicate itself is condition-only and would say `true` — which is why
    // it is the CALLER's job to skip it for a back-edge.
    expect(crosses(containers, 'a', 'b')).toBe(true);
  });
});
