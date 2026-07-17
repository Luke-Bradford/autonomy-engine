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
import {
  validateDoc,
  validatePipelineDoc,
  validateRefs,
  type PipelineResolver,
} from '../params.js';

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
// config.outputs — a corrupt contract is REPORTED, not silently ignored (F13a)
// ===========================================================================

describe('validateDoc — config.outputs (F13a)', () => {
  it('reports a malformed config.outputs', () => {
    const d = doc([node('a', { outputs: [{ name: 'text', type: 'strng' }] })]);
    expect(validateDoc(d).join(' ')).toContain("node 'a': config.outputs is malformed");
  });

  it('reports duplicate output names', () => {
    const d = doc([
      node('a', {
        outputs: [
          { name: 'text', type: 'string' },
          { name: 'text', type: 'number' },
        ],
      }),
    ]);
    expect(validateDoc(d).join(' ')).toContain('duplicate output name');
  });

  it('reports a malformed contract ONCE per node, not once per ref against it', () => {
    const d = doc(
      [
        node('a', { outputs: [{ name: 'text', type: 'strng' }] }),
        node('b', { x: '${nodes.a.output.text}', y: '${nodes.a.output.other}' }),
      ],
      [edge('a', 'b', 'success')],
    );
    const malformed = validateDoc(d).filter((e) => e.includes('config.outputs is malformed'));
    expect(malformed).toHaveLength(1);
  });

  it('says nothing about a node with no declared outputs', () => {
    expect(validateDoc(doc([node('a')])).join(' ')).not.toContain('config.outputs');
  });

  it('says nothing about a valid contract', () => {
    const d = doc([node('a', { outputs: [{ name: 'text', type: 'string' }] })]);
    expect(validateDoc(d).join(' ')).not.toContain('config.outputs');
  });
});

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

  // #6 E2 — `exitWhen` is a whole-value-REQUIRED field: an embedded expression
  // resolves to the STRING "true"/"false", never a boolean, so the loop silently
  // spins to maxRounds instead of exiting. Spec #6's spike proved this shape.
  it('rejects an EMBEDDED exitWhen (it would coerce the boolean to a string)', () => {
    const d = doc(
      [node('w', { outputs: [{ name: 'done', type: 'boolean' }] })],
      [],
      [{ id: 'lp', kind: 'loop', children: ['w'], exitWhen: 'done=${nodes.w.output.done}' }],
    );
    expect(validateDoc(d).join(' ')).toContain('whole-value');
  });

  it('accepts a PADDED lone exitWhen — the canonical trim decides the mode (I1)', () => {
    // A stray space must not demote the boolean. This is Round-2 I1's whole point.
    const d = doc(
      [node('w', { outputs: [{ name: 'done', type: 'boolean' }] })],
      [],
      [{ id: 'lp', kind: 'loop', children: ['w'], exitWhen: ' ${nodes.w.output.done} ' }],
    );
    expect(validateDoc(d)).toEqual([]);
  });

  it('reports an embedded CONSTANT exitWhen as embedded, not as a constant', () => {
    // Pre-E2 the constant rule scanned every match, so `x=${true}` was reported
    // as a constant though the real defect is the embedding. One mode decision,
    // one accurate diagnostic.
    const errors = doc(
      [node('w')],
      [],
      [{ id: 'lp', kind: 'loop', children: ['w'], exitWhen: 'x=${true}' }],
    );
    const joined = validateDoc(errors).join(' ');
    expect(joined).toContain('whole-value');
    expect(joined).not.toContain('not the constant');
  });

  it('reports an unterminated exitWhen EXACTLY once', () => {
    // The mode check and the grammar scan both look at this field; only the
    // grammar scan owns the message. Two identical badges is a real (if small)
    // regression, so pin the count end-to-end where "once" actually means
    // something — `validateWholeValue` alone cannot make this claim.
    const d = doc(
      [node('w')],
      [],
      [{ id: 'lp', kind: 'loop', children: ['w'], exitWhen: '${nodes.w.output.done' }],
    );
    const errors = validateDoc(d).filter((e) => e.includes('unterminated'));
    expect(errors).toHaveLength(1);
  });

  it('rejects a LITERAL exitWhen without claiming it is interpolated', () => {
    // `exitWhen: 'true'` has no braces at all — the embedded-interpolation
    // message would be factually wrong. Distinct modes, distinct diagnostics.
    const d = doc([node('w')], [], [{ id: 'lp', kind: 'loop', children: ['w'], exitWhen: 'true' }]);
    const joined = validateDoc(d).join(' ');
    expect(joined).toContain('exitWhen must be a ${...} expression');
    expect(joined).not.toContain('text around the braces');
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
// foreach container (#4 A4)
// ===========================================================================

describe('validateDoc — foreach container (#4 A4)', () => {
  const LIST: Param = { name: 'list', type: 'json', required: true };

  it('accepts a well-formed foreach (items + a body child, ${item} in the body)', () => {
    const d = doc(
      [node('w', { x: '${item}' })],
      [],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${params.list}' }],
      [LIST],
    );
    expect(validateDoc(d)).toEqual([]);
    expect(validateRefs(d)).toEqual([]);
  });

  it('rejects a foreach with no items expression', () => {
    const d = doc([node('w')], [], [{ id: 'fe', kind: 'foreach', children: ['w'] }]);
    expect(validateDoc(d).join(' ')).toContain('a foreach needs an items expression');
  });

  it('rejects an exitWhen on a foreach (loop-only)', () => {
    const d = doc(
      [node('w')],
      [],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${params.list}', exitWhen: '${x}' }],
      [LIST],
    );
    expect(validateDoc(d).join(' ')).toContain(
      'exitWhen is only meaningful on a loop, not a foreach',
    );
  });

  it('rejects a maxRounds on a foreach (loop-only)', () => {
    const d = doc(
      [node('w')],
      [],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${params.list}', maxRounds: 3 }],
      [LIST],
    );
    expect(validateDoc(d).join(' ')).toContain(
      'maxRounds is only meaningful on a loop, not a foreach',
    );
  });

  it('rejects a stray items on a loop or stage (foreach-only, symmetric with exitWhen)', () => {
    const onLoop = doc(
      [node('w', { outputs: [{ name: 'done', type: 'boolean' }] })],
      [],
      [
        {
          id: 'lp',
          kind: 'loop',
          children: ['w'],
          exitWhen: '${nodes.w.output.done}',
          items: '${params.list}',
        },
      ],
      [LIST],
    );
    expect(validateDoc(onLoop).join(' ')).toContain(
      'items is only meaningful on a foreach, not a loop',
    );
    const onStage = doc(
      [node('a')],
      [],
      [{ id: 'stg', kind: 'stage', children: ['a'], items: '${params.list}' }],
      [LIST],
    );
    expect(validateDoc(onStage).join(' ')).toContain(
      'items is only meaningful on a foreach, not a stage',
    );
  });

  it('rejects a foreach with no children (a useless empty body)', () => {
    const d = doc(
      [],
      [],
      [{ id: 'fe', kind: 'foreach', children: [], items: '${params.list}' }],
      [LIST],
    );
    expect(validateDoc(d).join(' ')).toContain('a foreach needs at least one child');
  });

  it('rejects a non-whole-value (interpolated) items — it can only be a string', () => {
    const d = doc(
      [node('w')],
      [],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: 'x=${params.list}' }],
      [LIST],
    );
    expect(validateDoc(d).join(' ')).toContain('whole-value');
  });

  it('rejects a literal items with no ${} at all', () => {
    const d = doc(
      [node('w')],
      [],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: 'a,b,c' }],
    );
    expect(validateDoc(d).join(' ')).toContain('items must be a ${...} expression');
  });

  it('rejects items that references ${item} (unbound — items runs before any item exists)', () => {
    const d = doc(
      [node('w')],
      [],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${item}' }],
    );
    expect(validateDoc(d).join(' ')).toContain('only bound inside a filter/map/count');
  });

  it('rejects items that references its OWN child output (not produced until the body runs)', () => {
    const d = doc(
      [node('w', { outputs: [{ name: 'v', type: 'number' }] })],
      [],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${nodes.w.output.v}' }],
    );
    // `w` is the foreach's own child, excluded from the items outer scope.
    expect(validateDoc(d).join(' ')).toContain('nodes.w.output.v');
  });

  it('accepts items that references an UPSTREAM node output', () => {
    const d = doc(
      [node('src', { outputs: [{ name: 'rows', type: 'json' }] }), node('w')],
      [edge('src', 'fe', 'success')],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${nodes.src.output.rows}' }],
    );
    expect(validateDoc(d)).toEqual([]);
    expect(validateRefs(d)).toEqual([]);
  });

  it('KEEPS rejecting ${item} in a NON-foreach node config (regression on the itemInScope gate)', () => {
    const d = doc([node('lonely', { x: '${item}' })]);
    expect(validateRefs(d).join(' ')).toContain('only bound inside a filter/map/count');
  });

  it('KNOWN #567: a downstream ${nodes.<foreach>.output.results} draws an advisory false-reject', () => {
    // Container ids are not first-class producers in `computeGraph`/`outputsById`
    // (a pre-existing loop/stage gap), so a downstream container-output ref is
    // statically refused at save even though the RUN path resolves it (proven in
    // reduce-p2c: 'exposes results to a downstream …'). Pinned so the follow-up
    // (#567) that models container producers flips this deliberately, not silently.
    const d = doc(
      [node('w'), node('after', { got: '${nodes.fe.output.results}' })],
      [edge('fe', 'after', 'success')],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${params.list}' }],
      [LIST],
    );
    expect(validateRefs(d).join(' ')).toContain('nodes.fe.output.results');
  });

  it('disables ${nodes.<foreachChild>.status} refs — the child re-runs per item (G1)', () => {
    // A foreach re-runs its children (one round per item) via resetContainerRound,
    // so a status ref to a re-running child is not stable — refused at save, the
    // same rule a loop/back-edge triggers (`canReRunNodes`).
    const withForeach = doc(
      [node('w'), node('reader', { s: '${nodes.w.status}' })],
      [edge('fe', 'reader', 'success')],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${params.list}' }],
      [LIST],
    );
    expect(validateRefs(withForeach).join(' ')).toContain('nodes.w.status');
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

  // #6 E2 — a `$${`-escaped call target is a LITERAL id, not a dynamic `${}` one.
  // The old `includes('${')` test read the escape as dynamic and silently dropped
  // the node from the cycle/depth analysis, exempting it from both checks.
  it('a $${-escaped call target is literal — it does NOT escape cycle detection', () => {
    const d = doc([callNode('caller', '$${pv_self}')]);
    // The id the run would actually call is `${pv_self}` (substitute unescapes it
    // and resolves no refs), so that is the id the call graph must analyse.
    expect(validateDoc(d, { selfId: '${pv_self}' }).join(' ')).toContain('calls its own version');
  });

  it('a genuinely dynamic ${} call target is still skipped (unresolvable at save)', () => {
    const d = doc([callNode('caller', '${params.target}')]);
    expect(validateDoc(d, { selfId: 'pv_self' })).toEqual([]);
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

  // validatePipelineDoc is the ONE composition both gates call. The server gate
  // passes an owner-scoped resolver (#495); the canvas passes none. Pin that the
  // options FORWARD, so the call graph runs only when a resolver is supplied —
  // preserving canvas parity (a doc that badges clean is not newly refused).
  it('validatePipelineDoc forwards options to validateDoc (call graph runs only with a resolver)', () => {
    const d = doc([callNode('caller', 'pv_self')]);
    expect(validatePipelineDoc(d)).toEqual([]); // no selfId → call graph does not run
    expect(validatePipelineDoc(d, { selfId: 'pv_self' }).join(' ')).toContain(
      'calls its own version',
    );
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
// Business `branch` edges — the declared-branch rule (#4 A0 makes them routable)
// ===========================================================================

describe('validateDoc — branch edges route against the declared-branch rule (#4 A0)', () => {
  // Since #4 A0 a branch edge is valid iff its SOURCE is a branching activity
  // that DECLARES the label. `if` declares exactly {'true','false'}; any other
  // source declares none. Parse stays permissive (a git import round-trips one);
  // this rule is advisory (canvas badge + the #444 write gate). The reducer's
  // run-time routing (`edge-model`/`branch-routing.test.ts`) is the other half.
  const ifNode = (id: string, condition = "${equals(nodes.c.output.ok, 'true')}"): Node =>
    node(id, { condition }, { type: 'if' });

  it('accepts an if node with true/false branch edges', () => {
    const d = doc(
      [ifNode('if_1'), node('a'), node('b')],
      [
        { id: 'e1', from: 'if_1', to: 'a', on: 'branch', branch: 'true' },
        { id: 'e2', from: 'if_1', to: 'b', on: 'branch', branch: 'false' },
      ],
    );
    // No branch-edge or condition error (there may be a ref error for `nodes.c`,
    // which does not exist — so assert on the branch/condition rules only).
    const errors = validateDoc(d).join(' ');
    expect(errors).not.toMatch(/does not declare branch/);
    expect(errors).not.toMatch(/is not a branching activity/);
  });

  it('rejects a branch edge whose source is NOT a branching activity', () => {
    const d = doc(
      [node('plain'), node('t')],
      [{ id: 'e1', from: 'plain', to: 't', on: 'branch', branch: 'true' }],
    );
    const errors = validateDoc(d).join(' ');
    expect(errors).toContain("edge 'e1'");
    expect(errors).toMatch(/not a branching activity/);
  });

  it('rejects a branch label an if does not declare', () => {
    const d = doc(
      [ifNode('if_1'), node('t')],
      [{ id: 'e1', from: 'if_1', to: 't', on: 'branch', branch: 'maybe' }],
    );
    const errors = validateDoc(d).join(' ');
    expect(errors).toContain("edge 'e1'");
    expect(errors).toMatch(/does not declare branch 'maybe'/);
  });

  it('rejects an if whose condition is missing or an embedded (non-whole-value) expression', () => {
    const missing = validateDoc(doc([node('if_1', {}, { type: 'if' })])).join(' ');
    expect(missing).toMatch(/node\.if_1\.condition: an if needs a boolean condition/);

    const embedded = validateDoc(doc([ifNode('if_2', 'ok=${nodes.c.output.ok}')])).join(' ');
    expect(embedded).toMatch(/node\.if_2\.condition:/);
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

  // #4 A2 — a `switch` declares its configured `cases` labels PLUS `default`.
  const switchNode = (id: string, on: unknown, cases: unknown): Node =>
    node(id, { on, cases }, { type: 'switch' });

  it('accepts a switch with case + default branch edges (incl. an embedded on)', () => {
    const d = doc(
      [
        switchNode('sw', 'tier-${nodes.c.output.n}', ['tier-1', 'tier-2']),
        node('a'),
        node('b'),
        node('z'),
      ],
      [
        { id: 'e1', from: 'sw', to: 'a', on: 'branch', branch: 'tier-1' },
        { id: 'e2', from: 'sw', to: 'b', on: 'branch', branch: 'tier-2' },
        { id: 'e3', from: 'sw', to: 'z', on: 'branch', branch: 'default' },
      ],
    );
    const errors = validateDoc(d).join(' ');
    expect(errors).not.toMatch(/does not declare branch/);
    expect(errors).not.toMatch(/is not a branching activity/);
    expect(errors).not.toMatch(/node\.sw\./);
  });

  it('rejects a switch branch edge for an undeclared case', () => {
    const d = doc(
      [switchNode('sw', '${nodes.c.output.tier}', ['gold']), node('t')],
      [{ id: 'e1', from: 'sw', to: 't', on: 'branch', branch: 'silver' }],
    );
    const errors = validateDoc(d).join(' ');
    expect(errors).toContain("edge 'e1'");
    expect(errors).toMatch(/does not declare branch 'silver'/);
  });

  it('rejects a switch missing on, an empty cases, and a case named default', () => {
    const noOn = validateDoc(doc([node('sw', { cases: ['x'] }, { type: 'switch' })])).join(' ');
    expect(noOn).toMatch(/node\.sw\.on: a switch needs a string 'on'/);

    const noCases = validateDoc(doc([switchNode('sw', '${nodes.c.output.t}', [])])).join(' ');
    expect(noCases).toMatch(/node\.sw\.cases: a switch needs a non-empty/);

    const dupAndDefault = validateDoc(
      doc([switchNode('sw', '${nodes.c.output.t}', ['a', 'a', 'default'])]),
    ).join(' ');
    expect(dupAndDefault).toMatch(/node\.sw\.cases\[1\]: duplicate case label 'a'/);
    expect(dupAndDefault).toMatch(/node\.sw\.cases\[2\]: a case may not be named 'default'/);
  });
});
