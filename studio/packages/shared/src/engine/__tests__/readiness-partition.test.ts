import { describe, expect, it } from 'vitest';
import type { Container, Edge, EdgeOn, Node } from '../types.js';
import { containerMembership, partitionReadiness } from '../params.js';

// ===========================================================================
// partitionReadiness — the SHARED forward-readiness edge partition consumed by
// BOTH the runtime reducer (`reduce.ts`) and the static ref-checker
// (`computeGraph`, #567). This is the SSOT that keeps the two from drifting: if
// this partition is wrong, the static analysis describes a different engine than
// the one that runs. Each case maps a doc shape to the exact per-endpoint
// readiness-gating incoming edges, pinning the #480/#488/#498 rules.
// ===========================================================================

let seq = 0;
function node(id: string): Node {
  seq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: seq, y: 0 } };
}
function edge(
  from: string,
  to: string,
  opts: { on?: EdgeOn; back?: boolean; maxBounces?: number } = {},
): Edge {
  const { on = 'success', back, maxBounces } = opts;
  return { id: `${from}->${to}`, from, to, on, ...(back ? { back, maxBounces } : {}) };
}
function run(nodes: Node[], edges: Edge[], containers: Container[]) {
  const owner = containerMembership(containers).owner;
  return partitionReadiness({ nodes, edges }, containers, owner);
}
/** edge ids gating an endpoint's readiness, from the merged incoming maps. */
function incoming(part: ReturnType<typeof run>, id: string): string[] {
  const es = part.topIncoming.get(id) ?? part.childIncoming.get(id) ?? [];
  return es.map((e) => e.id).sort();
}

describe('partitionReadiness — top-level + container endpoints', () => {
  it('a top chain gates each node by its predecessor', () => {
    const part = run([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')], []);
    expect(incoming(part, 'a')).toEqual([]);
    expect(incoming(part, 'b')).toEqual(['a->b']);
    expect(incoming(part, 'c')).toEqual(['b->c']);
  });

  it('a CONTAINER id is a first-class endpoint: X → C → Y gates C by X and Y by C', () => {
    // C is a container; the outer edges name its id. This is the shape a downstream
    // ${nodes.C.output.*} ref depends on (#567).
    const part = run(
      [node('w'), node('x'), node('y')],
      [edge('x', 'c'), edge('c', 'y')],
      [{ id: 'c', kind: 'stage', children: ['w'] }],
    );
    expect(incoming(part, 'c')).toEqual(['x->c']);
    expect(incoming(part, 'y')).toEqual(['c->y']);
  });

  it('an INTERNAL edge (same-container children) gates the child within its body, not the top level', () => {
    const part = run(
      [node('a'), node('b')],
      [edge('a', 'b')],
      [{ id: 'c', kind: 'stage', children: ['a', 'b'] }],
    );
    expect(incoming(part, 'b')).toEqual(['a->b']); // childIncoming
    expect(part.topIncoming.has('a')).toBe(false); // children are not top entities
    expect(part.topIncoming.has('b')).toBe(false);
  });

  it('a child → its OWN enclosing container edge is DROPPED (#488 — would strand the run)', () => {
    const part = run([node('a')], [edge('a', 'c')], [{ id: 'c', kind: 'stage', children: ['a'] }]);
    expect(incoming(part, 'c')).toEqual([]); // a→c not a readiness gate for c
  });

  it('a child → a TOP-LEVEL target edge is KEPT (#480 — it still skips the target)', () => {
    const part = run(
      [node('a'), node('t')],
      [edge('a', 't')],
      [{ id: 'c', kind: 'stage', children: ['a'] }],
    );
    expect(incoming(part, 't')).toEqual(['a->t']);
  });

  it('a child → child of a DIFFERENT container edge gates NEITHER (#498 cross-boundary, inert)', () => {
    const part = run(
      [node('a'), node('b')],
      [edge('a', 'b')],
      [
        { id: 'c1', kind: 'stage', children: ['a'] },
        { id: 'c2', kind: 'stage', children: ['b'] },
      ],
    );
    expect(incoming(part, 'b')).toEqual([]); // not internal (different owners), not top
    expect(part.internalForwardByContainer.get('c1')).toEqual([]);
    expect(part.internalForwardByContainer.get('c2')).toEqual([]);
  });

  it('a back-edge is split out of the forward partition (drives fireBackEdges, not readiness)', () => {
    const part = run(
      [node('gen'), node('check')],
      [edge('gen', 'check'), edge('check', 'gen', { on: 'failure', back: true, maxBounces: 2 })],
      [],
    );
    expect(incoming(part, 'gen')).toEqual([]); // the back-edge does NOT gate gen
    expect(part.backEdges.map((e) => e.id)).toEqual(['check->gen']);
  });
});
