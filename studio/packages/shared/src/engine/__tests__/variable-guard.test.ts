import { describe, expect, it } from 'vitest';
import type { VariableDef } from '../../schemas/pipeline.js';
import type { Container, Edge, EngineEvent, Node, VariableWrite } from '../types.js';
import { settledRawOf, variableReadsOf } from '../params.js';
import { copiedIdsOf, copiedVariableWritesOf, variableGuardErrors } from '../variable-guard.js';

/**
 * #844 V4 — the V-D6 determinism guard and the V-D7 reseed carry (spec
 * `2026-09-27-foundation-pipeline-variables.md`), tested directly. V5 wired
 * both; `variable-write.test.ts` covers the wiring. Every doc here passes both
 * validators (`guard` asserts it), because the guard's reader list is complete
 * only for such a doc.
 */

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}, type = 'agent_task'): Node {
  seq += 1;
  // #1480 — an agent_task saves only with its required `task`.
  const filled = type === 'agent_task' ? { task: 't', ...config } : config;
  return { id, type, config: filled, position: { x: seq, y: 0 } };
}
// An array variable has no literal form, so its `set` writes a whole-value `${}`.
const set = (id: string, variable = 'v'): Node =>
  node(id, { variable, value: variable === 'list' ? '${createArray(1)}' : '1' }, 'set_variable');
const append = (id: string, variable = 'list'): Node =>
  node(id, { variable, value: '1' }, 'append_variable');
const read = (id: string, variable = 'v'): Node => node(id, { prompt: `\${vars.${variable}}` });
const iff = (id: string): Node => node(id, { condition: '${true}' }, 'if');

let eseq = 0;
function e(from: string, to: string, on: Edge['on'] = 'success', extra: Partial<Edge> = {}): Edge {
  eseq += 1;
  return { id: `e${eseq}`, from, to, on, ...extra } as Edge;
}
function br(from: string, to: string, branch: string): Edge {
  eseq += 1;
  return { id: `e${eseq}`, from, to, on: 'branch', branch } as Edge;
}

const VARS: VariableDef[] = [
  { name: 'v', type: 'number', default: 0 },
  { name: 'list', type: 'array', default: [] },
];

function doc(nodes: Node[], edges: Edge[] = [], containers: Container[] = []) {
  return { params: [], nodes, edges, containers, variables: VARS };
}
const guard = (nodes: Node[], edges: Edge[] = [], containers: Container[] = []) => {
  const d = doc(nodes, edges, containers);
  const { reads, validatorErrors } = variableReadsOf(d);
  expect(validatorErrors, validatorErrors.join(' | ')).toEqual([]);
  return variableGuardErrors(d, reads);
};

describe('variableReadsOf — readers are a side output of the validators’ own scans', () => {
  it('collects node config, call params and a filter predicate under the node id', () => {
    const d = doc([
      read('cfg'),
      { ...node('caller'), call: { pipelineVersionId: 'pv', params: { x: '${vars.v}' } } },
      node('flt', { items: '${createArray(1)}', predicate: '${equals(item, vars.v)}' }, 'filter'),
      node('quiet', { prompt: 'no refs' }),
    ]);
    const { reads } = variableReadsOf(d);
    expect([...(reads.get('cfg') ?? [])]).toEqual(['v']);
    expect([...(reads.get('caller') ?? [])]).toEqual(['v']);
    expect([...(reads.get('flt') ?? [])]).toEqual(['v']);
    expect([...(reads.get('quiet') ?? [])]).toEqual([]);
  });

  it('collects a container’s own items / exitWhen under the CONTAINER id', () => {
    const d = doc(
      [node('body1'), node('body2')],
      [],
      [
        { id: 'fe', kind: 'foreach', children: ['body1'], items: '${vars.list}' },
        { id: 'lp', kind: 'loop', children: ['body2'], exitWhen: '${equals(vars.v, 3)}' },
      ],
    );
    const { reads } = variableReadsOf(d);
    expect([...(reads.get('fe') ?? [])]).toEqual(['list']);
    expect([...(reads.get('lp') ?? [])]).toEqual(['v']);
  });

  it('reaches a ref nested in a function argument and a default() fallback', () => {
    const d = doc([
      node('n', { prompt: "${concat(string(vars.v), string(default(vars.list, 'x')))}" }),
    ]);
    expect([...(variableReadsOf(d).reads.get('n') ?? [])].sort()).toEqual(['list', 'v']);
  });
});

describe('variableReadsOf — incompleteness is visible', () => {
  it('returns the validators’ errors with the reads, never drops them', () => {
    const d = doc([node('bad', { prompt: '${vars.undeclared}' })]);
    expect(variableReadsOf(d).validatorErrors.join('\n')).toContain('not a declared variable');
  });
});

describe('variableGuardErrors — a writer it cannot read is refused, not skipped', () => {
  it.each([
    ['missing', {}],
    ['non-string', { variable: 3 }],
    ['empty', { variable: '' }],
    ['an expression', { variable: '${params.name}' }],
  ])('refuses a set_variable whose variable is %s', (_label, config) => {
    // `validateDoc` refuses these too (V5), so `validatePipelineDoc` never runs
    // the guard on them; this pins the guard's own backstop, called directly.
    const d = doc([node('w', { value: '1', ...config }, 'set_variable')]);
    const errs = variableGuardErrors(d, variableReadsOf(d).reads);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("node 'w' (set_variable)");
  });
});

describe('settledRawOf — must-precede, not zeroed by a looping doc', () => {
  it('keeps the top-level relation when the doc also has a loop container', () => {
    const d = doc(
      [node('a'), node('b'), node('inner')],
      [e('a', 'b')],
      [
        {
          id: 'lp',
          kind: 'loop',
          children: ['inner'],
          exitWhen: "${equals(nodes.inner.status, 'success')}",
        },
      ],
    );
    expect(settledRawOf(d).get('b')?.has('a')).toBe(true);
  });
});

describe('variableGuardErrors — ordered pairs', () => {
  // An edge-less doc runs as an implicit success chain in node order
  // (`effectiveEdges`), so an unordered fixture needs one real edge.
  const loose = (): [Node[], Edge[]] => [[node('u1'), node('u2')], [e('u1', 'u2')]];

  it('treats an edge-less doc as the implicit chain it runs as', () => {
    expect(guard([set('a'), set('b')])).toEqual([]);
  });

  it('refuses two unordered writers, naming both and the variable', () => {
    const [ln, le] = loose();
    const errs = guard([set('a'), set('b'), ...ln], le);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("variable 'v'");
    expect(errs[0]).toContain("'a'");
    expect(errs[0]).toContain("'b'");
  });

  it('accepts a chain of writers', () => {
    expect(guard([set('a'), set('b')], [e('a', 'b')])).toEqual([]);
  });

  it('refuses a writer beside an unordered reader, accepts it ordered on any outcome', () => {
    const [ln, le] = loose();
    expect(guard([set('w'), read('r'), ...ln], le)).toHaveLength(1);
    expect(guard([set('w'), read('r')], [e('w', 'r')])).toEqual([]);
    expect(guard([set('w'), read('r')], [e('w', 'r', 'completion')])).toEqual([]);
  });

  it('ignores reader/reader pairs and variables nobody writes', () => {
    expect(
      guard([read('r1'), read('r2'), set('w', 'list'), read('r3', 'list')], [e('w', 'r3')]),
    ).toEqual([]);
  });

  it('refuses an any-join reader a sibling can release before the writer finishes', () => {
    const r = node('r', { prompt: '${vars.v}', join: 'any' });
    expect(guard([set('w'), node('p'), r], [e('w', 'r'), e('p', 'r')])).toHaveLength(1);
  });

  it('refuses a reader behind a skipped edge, which can fire while the writer runs', () => {
    const nodes = [set('w'), node('p'), node('x'), read('r')];
    const edges = [e('w', 'x'), e('p', 'x'), e('x', 'r', 'skipped')];
    expect(guard(nodes, edges)).toHaveLength(1);
  });

  it('uses the pre-refusal relation: a loop elsewhere does not refuse an ordered pair', () => {
    const errs = guard(
      [set('w'), read('r'), node('inner')],
      [e('w', 'r')],
      [
        {
          id: 'lp',
          kind: 'loop',
          children: ['inner'],
          exitWhen: "${equals(nodes.inner.status, 'success')}",
        },
      ],
    );
    expect(errs).toEqual([]);
  });
});

describe('variableGuardErrors — exclusive pairs', () => {
  it('accepts writers on an if’s true and false branches', () => {
    expect(
      guard([iff('n'), set('t'), set('f')], [br('n', 't', 'true'), br('n', 'f', 'false')]),
    ).toEqual([]);
  });

  it('accepts writers on a node’s success and failure edges', () => {
    expect(guard([node('n'), set('s'), set('f')], [e('n', 's'), e('n', 'f', 'failure')])).toEqual(
      [],
    );
  });

  it('accepts a switch case against its default', () => {
    const sw = node('sw', { on: "${'x'}", cases: ['a'] }, 'switch');
    expect(guard([sw, set('a'), set('d')], [br('sw', 'a', 'a'), br('sw', 'd', 'default')])).toEqual(
      [],
    );
  });

  it('refuses completion against success — completion overlaps it', () => {
    expect(
      guard([node('n'), set('s'), set('c')], [e('n', 's'), e('n', 'c', 'completion')]),
    ).toHaveLength(1);
  });

  it('refuses an if’s success edge against its true branch — success fires on every branch', () => {
    expect(guard([iff('n'), set('s'), set('t')], [e('n', 's'), br('n', 't', 'true')])).toHaveLength(
      1,
    );
  });

  it('refuses the skip inversion: n→false F →skipped G runs G exactly when n took true', () => {
    const nodes = [iff('n'), set('t'), node('f'), set('g')];
    const edges = [br('n', 't', 'true'), br('n', 'f', 'false'), e('f', 'g', 'skipped')];
    expect(guard(nodes, edges)).toHaveLength(1);
  });

  it('refuses when a root path bypasses the decision', () => {
    const t = node('t', { variable: 'v', value: '1', join: 'any' }, 'set_variable');
    const nodes = [iff('n'), t, set('f'), node('side')];
    const edges = [br('n', 't', 'true'), br('n', 'f', 'false'), e('side', 't')];
    expect(guard(nodes, edges)).toHaveLength(1);
  });

  it('accepts an all-join branch writer that also takes a data edge from upstream', () => {
    const nodes = [node('fetch'), iff('n'), set('t'), set('f')];
    const edges = [e('fetch', 'n'), e('fetch', 't'), br('n', 't', 'true'), br('n', 'f', 'false')];
    expect(guard(nodes, edges)).toEqual([]);
  });

  it('refuses an any-join writer reachable under both outcomes', () => {
    const j = node('j', { variable: 'v', value: '1', join: 'any' }, 'set_variable');
    const nodes = [iff('n'), node('a'), node('b'), j, set('f')];
    const edges = [
      br('n', 'a', 'true'),
      br('n', 'b', 'false'),
      e('a', 'j'),
      e('b', 'j'),
      br('n', 'f', 'false'),
    ];
    expect(guard(nodes, edges)).toHaveLength(1);
  });

  it('accepts a container as the decision node', () => {
    const nodes = [node('inner'), set('s'), set('f')];
    const edges = [e('st', 's'), e('st', 'f', 'failure')];
    expect(guard(nodes, edges, [{ id: 'st', kind: 'stage', children: ['inner'] }])).toEqual([]);
  });
});

describe('variableGuardErrors — scopes', () => {
  it('lifts a body writer to its container and names it', () => {
    const errs = guard(
      [set('w'), read('r'), node('u1'), node('u2')],
      [e('u1', 'u2')],
      [{ id: 'st', kind: 'stage', children: ['w'] }],
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("'st'");
  });

  it('accepts a body writer when its container is ordered before the reader', () => {
    expect(
      guard([set('w'), read('r')], [e('st', 'r')], [{ id: 'st', kind: 'stage', children: ['w'] }]),
    ).toEqual([]);
  });

  it('refuses writers in two unordered containers', () => {
    const cs: Container[] = [
      { id: 's1', kind: 'stage', children: ['a'] },
      { id: 's2', kind: 'stage', children: ['b'] },
    ];
    expect(guard([set('a'), set('b'), node('u1'), node('u2')], [e('u1', 'u2')], cs)).toHaveLength(
      1,
    );
  });

  it('compares two children of one body inside that body', () => {
    const lp = (): Container[] => [
      {
        id: 'lp',
        kind: 'loop',
        children: ['a', 'b'],
        exitWhen: "${equals(nodes.a.status, 'success')}",
      },
    ];
    expect(guard([set('a'), set('b'), node('u1'), node('u2')], [e('u1', 'u2')], lp())).toHaveLength(
      1,
    );
    expect(guard([set('a'), set('b')], [e('a', 'b')], lp())).toEqual([]);
  });

  it('orders a container’s own fields around its body', () => {
    const loop: Container = {
      id: 'lp',
      kind: 'loop',
      children: ['w'],
      exitWhen: '${equals(vars.v, 3)}',
    };
    expect(guard([set('w')], [], [loop])).toEqual([]);
    const fe: Container = { id: 'fe', kind: 'foreach', children: ['a'], items: '${vars.list}' };
    expect(guard([append('a')], [], [fe])).toEqual([]);
  });

  it('accepts a foreach whose items read a variable written before it', () => {
    const fe: Container = { id: 'fe', kind: 'foreach', children: ['body'], items: '${vars.list}' };
    expect(guard([append('w'), node('body')], [e('w', 'fe')], [fe])).toEqual([]);
    expect(
      guard([append('w'), node('body'), node('u1'), node('u2')], [e('u1', 'u2')], [fe]),
    ).toHaveLength(1);
  });

  it('refuses any writer in a parallel foreach body, even the only one', () => {
    const par: Container = {
      id: 'fe',
      kind: 'foreach',
      children: ['a'],
      items: '${createArray(1, 2)}',
      batchCount: 2,
    };
    const errs = guard([append('a')], [], [par]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("parallel foreach 'fe'");
    expect(guard([append('a')], [], [{ ...par, batchCount: 1 }])).toEqual([]);
  });

  it('refuses a parallel body reader beside an unordered outer writer', () => {
    const par: Container = {
      id: 'fe',
      kind: 'foreach',
      children: ['r'],
      items: '${createArray(1)}',
      batchCount: 2,
    };
    expect(
      guard([read('r'), set('w'), node('u1'), node('u2')], [e('u1', 'u2')], [par]),
    ).toHaveLength(1);
    expect(guard([read('r'), set('w')], [e('w', 'fe')], [par])).toEqual([]);
  });
});

describe('variableGuardErrors — bare back-edge bodies', () => {
  const back = (from: string, to: string): Edge =>
    e(from, to, 'failure', { back: true, maxBounces: 3 });

  it('refuses a body writer with an accessor after the body, accepts one kept inside', () => {
    const errs = guard(
      [set('t'), node('s'), read('after')],
      [e('t', 's'), e('s', 'after'), back('s', 't')],
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('back-edge');
    expect(guard([set('t'), read('s')], [e('t', 's'), back('s', 't')])).toEqual([]);
  });

  it('refuses a body reader beside a writer downstream of the body', () => {
    const nodes = [read('t'), node('s'), set('down')];
    expect(guard(nodes, [e('t', 's'), e('s', 'down', 'failure'), back('s', 't')])).toHaveLength(1);
  });

  it('accepts a body reader whose writer finishes before the body starts', () => {
    expect(
      guard([set('w'), read('t'), node('s')], [e('w', 't'), e('t', 's'), back('s', 't')]),
    ).toEqual([]);
  });

  it('does not let a decision re-run by a bounce prove two outside accessors exclusive', () => {
    // Round 1 takes `true` (x writes, z is skipped), the bounce resets the body,
    // round 2 takes `false` and releases y while x may still be writing.
    const nodes = [node('t'), iff('n'), set('x'), node('z'), set('y')];
    const edges = [
      e('t', 'n'),
      br('n', 'x', 'true'),
      br('n', 'z', 'false'),
      e('z', 't', 'skipped', { back: true, maxBounces: 2 }),
      e('z', 'y'),
    ];
    expect(guard(nodes, edges)).toHaveLength(1);
  });

  it('leaves a container-targeted back-edge to the container: its exitWhen may read a body write', () => {
    const loop: Container = {
      id: 'lp',
      kind: 'loop',
      children: ['w'],
      exitWhen: '${equals(vars.v, 3)}',
    };
    expect(
      guard([set('w')], [e('w', 'lp', 'failure', { back: true, maxBounces: 2 })], [loop]),
    ).toEqual([]);
  });
});

describe('copiedVariableWritesOf — V-D7', () => {
  const w = (
    nodeId: string,
    attemptId: string,
    value: unknown,
    op: 'set' | 'append' = 'set',
  ): EngineEvent => ({
    type: op === 'set' ? 'variable.set' : 'variable.append',
    runId: 'r1',
    nodeId,
    attemptId,
    name: 'v',
    value,
  });
  // Filler events the carry must skip; only their `type` is read.
  const other = (type: string, extra: object = {}) =>
    ({ type, ...extra }) as unknown as EngineEvent;

  it('keeps exactly the copied nodes’ writes, in log order', () => {
    const events = [
      other('run.started'),
      w('a', 'a1', 1),
      w('b', 'b1', 2),
      w('a', 'a2', 3, 'append'),
      other('node.succeeded'),
    ];
    expect(copiedVariableWritesOf(events, new Set(['a']))).toEqual<VariableWrite[]>([
      { nodeId: 'a', op: 'set', name: 'v', value: 1 },
      { nodeId: 'a', op: 'append', name: 'v', value: 3 },
    ]);
  });

  it('maps an instance key back to its doc node', () => {
    const out = copiedVariableWritesOf([w('a@2', 'x', 5, 'append')], new Set(['a']));
    expect(out).toEqual([{ nodeId: 'a@2', op: 'append', name: 'v', value: 5 }]);
  });

  it('applies a duplicated event for one attempt once', () => {
    const out = copiedVariableWritesOf(
      [w('a', 'a1', 1, 'append'), w('a', 'a1', 1, 'append')],
      new Set(['a']),
    );
    expect(out).toHaveLength(1);
  });

  it('a rerun of a rerun: the source run’s carried writes come first, then its own, both filtered', () => {
    const carried: VariableWrite[] = [
      { nodeId: 'a', op: 'set', name: 'v', value: 10 },
      { nodeId: 'gone', op: 'set', name: 'v', value: 99 },
    ];
    const events = [
      other('run.started'),
      other('run.reseeded', { copiedVariableWrites: carried }),
      w('b', 'b1', 20),
      w('c', 'c1', 30),
    ];
    expect(copiedVariableWritesOf(events, new Set(['a', 'b']))).toEqual([
      { nodeId: 'a', op: 'set', name: 'v', value: 10 },
      { nodeId: 'b', op: 'set', name: 'v', value: 20 },
    ]);
  });

  it('copiedIdsOf = the frontier plus every copied container’s children', () => {
    const containers: Container[] = [
      { id: 'lp', kind: 'loop', children: ['c1', 'c2'], exitWhen: '${true}' },
      { id: 'st', kind: 'stage', children: ['s1'] },
    ];
    const ids = copiedIdsOf(
      { frontier: ['a'], copiedContainers: { lp: { status: 'success' } as never } },
      containers,
    );
    expect([...ids].sort()).toEqual(['a', 'c1', 'c2']);
  });
});
