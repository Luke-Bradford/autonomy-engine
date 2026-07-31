import { describe, expect, it } from 'vitest';
import type { Container, Edge, EdgeOn, Node, PipelineVersion } from '../types.js';
import { backEdgeDefect, validatePipelineDoc } from '../params.js';

/**
 * `backEdgeDefect` — the CONNECT-TIME half of the back-edge rules (U6e).
 *
 * The canvas offers to turn a refused connection into a BACK-EDGE, and has to
 * decide whether that offer is legal before the edge exists. The rules it must
 * agree with are `validatePipelineDoc`'s three back-edge refusals: ancestry
 * (`must be an ancestor of`), progress (`makes no progress`) and the parallel
 * body (`cannot combine batchCount >= 2 with back-edge`).
 *
 * Like `forward-cycle-delta.test.ts`, these specs pin the AGREEMENT rather than
 * re-implement it: every case asserts the predicate against the save gate's own
 * verdict on the doc that WOULD be saved. Two definitions that must not
 * disagree are asserted against each other, not left to stay in step by
 * inspection.
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

/** The back-edge refusals the save gate would report for `from → to`. */
function gateBackErrors(
  d: Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'>,
  from: string,
  to: string,
): string[] {
  const probe = edge(from, to, 'success', { back: true, maxBounces: 3 });
  return validatePipelineDoc({ ...d, edges: [...d.edges, probe] }).filter(
    (e) =>
      e.includes('must be an ancestor of') ||
      e.includes('makes no progress') ||
      e.includes('cannot combine batchCount >= 2 with back-edge'),
  );
}

/**
 * The whole point of the predicate: it says `null` exactly when the save gate
 * has no back-edge complaint about the doc that would result.
 */
function agrees(
  d: Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'>,
  from: string,
  to: string,
): void {
  const defect = backEdgeDefect(d, d.containers ?? [], from, to);
  const gate = gateBackErrors(d, from, to);
  expect(defect === null, `predicate=${String(defect)} gate=${JSON.stringify(gate)}`).toBe(
    gate.length === 0,
  );
}

describe('backEdgeDefect — agreement with the save gate', () => {
  it('accepts the plain retry loop: b back to its own ancestor a', () => {
    const d = doc([node('a'), node('b')], [edge('a', 'b')]);
    expect(backEdgeDefect(d, [], 'b', 'a')).toBeNull();
    agrees(d, 'b', 'a');
  });

  it("refuses a target that is not an ancestor — 'ancestry'", () => {
    // a → b, and separately c. `c` does not reach `b`, so `b →back c` has no
    // loop to close.
    const d = doc([node('a'), node('b'), node('c')], [edge('a', 'b')]);
    expect(backEdgeDefect(d, [], 'b', 'c')).toBe('ancestry');
    agrees(d, 'b', 'c');
  });

  /**
   * The case the plan review caught, and the reason this file exists.
   *
   * Cycle-closure implies ANCESTRY (`forwardReach` is the DAG graph plus
   * containment edges, a superset) but it does NOT imply progress: the reset
   * body is computed over `nodeForwardAdjacency`, which is NODE-only, so a
   * cycle whose path runs through a CONTAINER endpoint leaves the source out of
   * its own reset body. Offering the back-edge here would author a doc the save
   * gate refuses — the exact failure the offer's gate exists to prevent.
   */
  it("refuses a container-mediated cycle whose reset body misses its source — 'no-progress'", () => {
    const d = doc(
      [node('a'), node('b'), node('x')],
      [edge('a', 'C'), edge('C', 'b')],
      [{ id: 'C', kind: 'stage', children: ['x'] }],
    );
    expect(backEdgeDefect(d, d.containers ?? [], 'b', 'a')).toBe('no-progress');
    agrees(d, 'b', 'a');
  });

  it('accepts a child back-edging to its own enclosing container', () => {
    const d = doc(
      [node('w'), node('after')],
      [edge('L', 'after')],
      [{ id: 'L', kind: 'loop', exitWhen: '${true}', children: ['w'] }],
    );
    expect(backEdgeDefect(d, d.containers ?? [], 'w', 'L')).toBeNull();
    agrees(d, 'w', 'L');
  });

  it("refuses a back-edge touching a parallel foreach body — 'parallel-body'", () => {
    const d = doc(
      [node('a'), node('item')],
      [edge('a', 'F')],
      [
        {
          id: 'F',
          kind: 'foreach',
          items: '${params.xs}',
          batchCount: 2,
          children: ['item'],
        } as Container,
      ],
    );
    expect(backEdgeDefect(d, d.containers ?? [], 'item', 'F')).toBe('parallel-body');
    agrees(d, 'item', 'F');
  });

  /**
   * The EDGELESS doc, pinned deliberately.
   *
   * The predicate's two halves read different edge sets: `forwardReach` reads
   * `doc.edges` raw, while the reset body reads `effectiveEdges`, which
   * SYNTHESIZES a success-chain over node order when a doc declares no edges.
   * Authoring the first edge destroys that synthesized chain, so a predicate
   * that judged the candidate against the doc's CURRENT edges would answer
   * about a graph that stops existing the moment the operator accepts the
   * offer. Both halves must judge `[...doc.edges, candidate]`.
   */
  it('judges the candidate against the doc it would create, not the implicit chain', () => {
    const d = doc([node('a'), node('b')]);
    // The implicit chain makes `a` reach `b`, so the raw doc looks like a legal
    // `b →back a`. It is not: authoring the edge replaces the chain, leaving
    // `a` reaching nothing.
    expect(backEdgeDefect(d, [], 'b', 'a')).toBe('ancestry');
    agrees(d, 'b', 'a');
  });
});
