import { describe, expect, it } from 'vitest';
import type { Container, Edge, Node, Param, PipelineVersion } from '../types.js';
import { validateDoc, type PipelineResolver } from '../params.js';

// --- helpers ---------------------------------------------------------------

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}, extra: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 }, ...extra };
}
function callNode(id: string, pipelineVersionId: string): Node {
  return node(id, {}, { type: 'call_pipeline', call: { pipelineVersionId, params: {} } });
}
function edge(from: string, to: string, on: Edge['on'], extra: Partial<Edge> = {}): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on, ...extra };
}
function doc(
  nodes: Node[],
  edges: Edge[] = [],
  containers: Container[] = [],
  params: Param[] = [],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'> {
  return { params, nodes, edges, containers };
}

// ===========================================================================
// Container children — existence + disjointness + loop/stage config
// ===========================================================================

describe('validateDoc — containers', () => {
  it('accepts a well-formed stage + loop doc (no errors)', () => {
    const d = doc(
      [node('a'), node('w'), node('check', { outputs: [{ name: 'done', type: 'boolean' }] })],
      [edge('w', 'check', 'success')],
      [
        { id: 'stg', kind: 'stage', children: ['a'] },
        {
          id: 'lp',
          kind: 'loop',
          children: ['w', 'check'],
          exitWhen: '${nodes.check.output.done}',
          maxRounds: 5,
        },
      ],
    );
    expect(validateDoc(d)).toEqual([]);
  });

  it('rejects a child id that is not a node', () => {
    const d = doc([node('a')], [], [{ id: 'stg', kind: 'stage', children: ['a', 'ghost'] }]);
    expect(validateDoc(d).join(' ')).toContain("child 'ghost' is not a node");
  });

  it('rejects a child shared by two containers (must be disjoint)', () => {
    const d = doc(
      [node('a'), node('b')],
      [],
      [
        { id: 'c1', kind: 'stage', children: ['a', 'b'] },
        { id: 'c2', kind: 'stage', children: ['b'] },
      ],
    );
    expect(validateDoc(d).join(' ')).toContain('must be disjoint');
  });

  it('rejects a loop with neither exitWhen nor maxRounds', () => {
    const d = doc([node('w')], [], [{ id: 'lp', kind: 'loop', children: ['w'] }]);
    expect(validateDoc(d).join(' ')).toContain('needs an exitWhen or a maxRounds');
  });

  it('rejects an exitWhen on a stage (loop-only)', () => {
    const d = doc(
      [node('a')],
      [],
      [{ id: 'stg', kind: 'stage', children: ['a'], exitWhen: '${params.x}' }],
    );
    expect(validateDoc(d).join(' ')).toContain('exitWhen is only meaningful on a loop');
  });

  it('rejects an exitWhen referencing a non-child node output', () => {
    const d = doc(
      [node('w'), node('outsider', { outputs: [{ name: 'done', type: 'boolean' }] })],
      [],
      [
        {
          id: 'lp',
          kind: 'loop',
          children: ['w'],
          exitWhen: '${nodes.outsider.output.done}',
          maxRounds: 3,
        },
      ],
    );
    expect(validateDoc(d).join(' ')).toContain('outsider');
  });
});

// ===========================================================================
// Back-edge ancestry
// ===========================================================================

describe('validateDoc — back-edge ancestry', () => {
  it('accepts a back-edge whose target is an ancestor of its source', () => {
    // gen -> check (forward); check -> gen (back) — gen IS an ancestor of check.
    const d = doc(
      [node('gen'), node('check')],
      [
        edge('gen', 'check', 'success'),
        edge('check', 'gen', 'failure', { back: true, maxBounces: 3 }),
      ],
    );
    expect(validateDoc(d)).toEqual([]);
  });

  it('rejects a back-edge whose target is NOT an ancestor of its source', () => {
    // gen -> check forward; a back-edge gen -> check is NOT valid (check is a
    // DESCENDANT of gen, not an ancestor).
    const d = doc(
      [node('gen'), node('check')],
      [edge('gen', 'check', 'success'), edge('gen', 'check', 'failure', { back: true })],
    );
    expect(validateDoc(d).join(' ')).toContain('must be an ancestor');
  });

  it('accepts a back-edge whose target is the enclosing loop CONTAINER (containment ancestry)', () => {
    // check is a child of lp → lp encloses (is an ancestor of) check, so a
    // back-edge check -> lp is valid.
    const d = doc(
      [node('w'), node('check')],
      [
        edge('w', 'check', 'success'),
        edge('check', 'lp', 'failure', { back: true, maxBounces: 2 }),
      ],
      [{ id: 'lp', kind: 'loop', children: ['w', 'check'], maxRounds: 5 }],
    );
    expect(validateDoc(d).some((e) => e.includes('must be an ancestor'))).toBe(false);
  });
});

// ===========================================================================
// call_pipeline cycle + depth
// ===========================================================================

describe('validateDoc — call graph', () => {
  it('rejects a direct self-call (a node calling its own version)', () => {
    const d = doc([callNode('caller', 'pv_self')]);
    expect(validateDoc(d, { selfId: 'pv_self' }).join(' ')).toContain('calls its own version');
  });

  it('rejects a call CYCLE across pipelines (A → B → A)', () => {
    const resolve: PipelineResolver = (id) => {
      if (id === 'pv_b') return { nodes: [callNode('back', 'pv_a')] };
      return undefined;
    };
    const d = doc([callNode('c', 'pv_b')]); // pv_a calls pv_b, pv_b calls pv_a
    const errs = validateDoc(d, { selfId: 'pv_a', resolvePipeline: resolve });
    expect(errs.join(' ')).toContain('cycle');
  });

  it('rejects a call chain deeper than maxCallDepth', () => {
    // pv_a → pv_b → pv_c → pv_d → pv_e : 4 hops, exceeds a maxCallDepth of 3.
    const chain: Record<string, string | null> = {
      pv_b: 'pv_c',
      pv_c: 'pv_d',
      pv_d: 'pv_e',
      pv_e: null,
    };
    const resolve: PipelineResolver = (id) => {
      const next = chain[id];
      if (next === undefined) return undefined;
      return { nodes: next === null ? [] : [callNode('n', next)] };
    };
    const d = doc([callNode('c', 'pv_b')]);
    const errs = validateDoc(d, { selfId: 'pv_a', resolvePipeline: resolve, maxCallDepth: 3 });
    expect(errs.join(' ')).toContain('depth exceeds 3');
  });

  it('accepts a call chain within maxCallDepth', () => {
    const chain: Record<string, string | null> = { pv_b: 'pv_c', pv_c: null };
    const resolve: PipelineResolver = (id) => {
      const next = chain[id];
      if (next === undefined) return undefined;
      return { nodes: next === null ? [] : [callNode('n', next)] };
    };
    const d = doc([callNode('c', 'pv_b')]);
    expect(validateDoc(d, { selfId: 'pv_a', resolvePipeline: resolve, maxCallDepth: 3 })).toEqual(
      [],
    );
  });

  it('skips a dynamic ${} call target (not statically resolvable — no false cycle)', () => {
    const d = doc([callNode('c', '${params.child}')]);
    expect(validateDoc(d, { selfId: 'pv_a' })).toEqual([]);
  });
});
