import { describe, expect, it } from 'vitest';
import type {
  Container,
  Edge,
  EdgeOn,
  Node,
  OperationalEdge,
  Param,
  PipelineVersion,
} from '../types.js';
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
function edge(
  from: string,
  to: string,
  on: EdgeOn,
  extra: Partial<Omit<OperationalEdge, 'on'>> = {},
): Edge {
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

  it('rejects a loop with no exitWhen', () => {
    const d = doc([node('w')], [], [{ id: 'lp', kind: 'loop', children: ['w'] }]);
    expect(validateDoc(d).join(' ')).toContain('a loop needs an exitWhen');
  });

  it('rejects a maxRounds-only loop (maxRounds is the cap, exitWhen is the exit)', () => {
    const d = doc([node('w')], [], [{ id: 'lp', kind: 'loop', children: ['w'], maxRounds: 3 }]);
    expect(validateDoc(d).join(' ')).toContain('a loop needs an exitWhen');
  });

  it('rejects an exitWhen on a stage (loop-only)', () => {
    const d = doc(
      [node('a')],
      [],
      [{ id: 'stg', kind: 'stage', children: ['a'], exitWhen: '${params.x}' }],
    );
    expect(validateDoc(d).join(' ')).toContain('exitWhen is only meaningful on a loop');
  });

  // A constant is not an exit condition: `${true}` exits after round one and
  // `${false}` never exits. These were unresolvable-ref errors until literals
  // became parseable at #6 E1, so the rule is now explicit.
  it.each(['${true}', '${false}', '${7.5}', "${'done'}"])(
    'rejects the constant exitWhen %s',
    (exitWhen) => {
      const d = doc([node('w')], [], [{ id: 'lp', kind: 'loop', children: ['w'], exitWhen }]);
      expect(validateDoc(d).join(' ')).toContain('must reference child outputs, not the constant');
    },
  );

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
      [node('w'), node('check', { outputs: [{ name: 'done', type: 'boolean' }] })],
      [
        edge('w', 'check', 'success'),
        edge('check', 'lp', 'failure', { back: true, maxBounces: 2 }),
      ],
      [
        {
          id: 'lp',
          kind: 'loop',
          children: ['w', 'check'],
          exitWhen: '${nodes.check.output.done}',
          maxRounds: 5,
        },
      ],
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

// ===========================================================================
// P2c fix wave — termination + id safety (back-edge bounds, cycles, id space)
// ===========================================================================

describe('validateDoc — back-edge termination guards', () => {
  it('rejects a back-edge with no maxBounces (an unbounded loop never terminates)', () => {
    // gen -> check forward; check -> gen back, but NO maxBounces.
    const d = doc(
      [node('gen'), node('check')],
      [edge('gen', 'check', 'success'), edge('check', 'gen', 'failure', { back: true })],
    );
    expect(validateDoc(d).join(' ')).toContain('must declare maxBounces');
  });

  it('accepts a bounded back-edge whose reset body re-runs its source', () => {
    const d = doc(
      [node('gen'), node('check')],
      [
        edge('gen', 'check', 'success'),
        edge('check', 'gen', 'failure', { back: true, maxBounces: 3 }),
      ],
    );
    expect(validateDoc(d)).toEqual([]);
  });

  it('rejects a container-targeted back-edge whose source is OUTSIDE the container (no progress)', () => {
    // lp -> post forward (so lp reaches post → ancestry passes); post -> lp back.
    // The reset body is lp's children {w, check}, which does NOT include `post`,
    // so firing resets nothing that un-satisfies the edge — it would re-fire forever.
    const d = doc(
      [node('w'), node('check', { outputs: [{ name: 'done', type: 'boolean' }] }), node('post')],
      [
        edge('w', 'check', 'success'),
        edge('lp', 'post', 'success'),
        edge('post', 'lp', 'failure', { back: true, maxBounces: 2 }),
      ],
      [
        {
          id: 'lp',
          kind: 'loop',
          children: ['w', 'check'],
          exitWhen: '${nodes.check.output.done}',
          maxRounds: 5,
        },
      ],
    );
    expect(validateDoc(d).join(' ')).toContain('makes no progress');
  });
});

describe('validateDoc — forward graph must be a DAG', () => {
  it('rejects a forward cycle (a -> b -> a, both forward edges)', () => {
    const d = doc([node('a'), node('b')], [edge('a', 'b', 'success'), edge('b', 'a', 'success')]);
    expect(validateDoc(d).join(' ')).toContain('forward cycle detected');
  });

  it('a genuine loop expressed as a back-edge is NOT flagged as a forward cycle', () => {
    const d = doc(
      [node('a'), node('b')],
      [edge('a', 'b', 'success'), edge('b', 'a', 'failure', { back: true, maxBounces: 3 })],
    );
    expect(validateDoc(d).some((e) => e.includes('forward cycle'))).toBe(false);
  });
});

describe('validateDoc — global id uniqueness', () => {
  it('rejects a container id that collides with a node id', () => {
    const d = doc([node('x')], [], [{ id: 'x', kind: 'stage', children: ['x'] }]);
    expect(validateDoc(d).join(' ')).toContain('collides with an existing node id');
  });

  it('rejects two containers sharing an id', () => {
    const d = doc(
      [node('a'), node('b')],
      [],
      [
        { id: 'dup', kind: 'stage', children: ['a'] },
        { id: 'dup', kind: 'stage', children: ['b'] },
      ],
    );
    expect(validateDoc(d).join(' ')).toContain('collides with an existing container id');
  });

  it('rejects a duplicate node id', () => {
    const d = doc([node('a'), node('a')]);
    expect(validateDoc(d).join(' ')).toContain("duplicate node id 'a'");
  });
});

describe('validateDoc — container boundary encapsulation', () => {
  it('rejects a forward edge from a child to an OUTSIDE top-level node', () => {
    // `a` is a child of stg; a -> b crosses the container boundary.
    const d = doc(
      [node('a'), node('b')],
      [edge('a', 'b', 'success')],
      [{ id: 'stg', kind: 'stage', children: ['a'] }],
    );
    expect(validateDoc(d).join(' ')).toContain('crosses a container boundary');
  });

  it('accepts a child→child edge and the container→outside outer edge', () => {
    const d = doc(
      [node('a'), node('b'), node('after')],
      [edge('a', 'b', 'success'), edge('stg', 'after', 'success')],
      [{ id: 'stg', kind: 'stage', children: ['a', 'b'] }],
    );
    expect(validateDoc(d)).toEqual([]);
  });
});

// ===========================================================================
// Business `branch` edges — reported as inert (#1 owns the union, T3)
// ===========================================================================

describe('validateDoc — business branch edges are reported as inert', () => {
  // The union is settled HERE so #4 A0/A1/A2 can build `if`/`switch` against a
  // final schema — but until an activity actually emits a branch outcome, a
  // branch edge can never be satisfied. Parse stays permissive (a git import
  // must round-trip one); `validateDoc` reports it, naming the ticket that
  // lifts it.
  //
  // ADVISORY, not a gate: the only caller is the canvas, which renders the
  // result as a badge and still permits Save, and the server never validates
  // (#444). The reducer's diagnostic (edge-model.test.ts) is the real run-time
  // observability — which is why F1 put one there rather than trust this.
  it('reports a branch edge and names the ticket that lifts it', () => {
    const d = doc(
      [node('if_1'), node('t')],
      [{ id: 'e1', from: 'if_1', to: 't', on: 'branch', branch: 'true' }],
    );
    const errors = validateDoc(d).join(' ');
    expect(errors).toContain("edge 'e1'");
    expect(errors).toMatch(/branch/i);
    expect(errors).toMatch(/A0|A1|A2|if\/switch/);
  });

  it('still accepts the four operational conditions', () => {
    const d = doc(
      [node('a'), node('b')],
      [
        edge('a', 'b', 'success'),
        edge('a', 'b', 'failure'),
        edge('a', 'b', 'completion'),
        edge('a', 'b', 'skipped'),
      ],
    );
    expect(validateDoc(d)).toEqual([]);
  });
});
