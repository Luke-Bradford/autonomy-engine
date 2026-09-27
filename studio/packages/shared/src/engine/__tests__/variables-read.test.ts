import { describe, expect, it } from 'vitest';
import type { VariableDef } from '../../schemas/pipeline.js';
import type { Container, Edge, EngineEvent, Node, Param, SubstitutionContext } from '../types.js';
import { SubstituteError } from '../types.js';
import {
  availableRefs,
  substitute,
  validatePipelineDoc,
  validateRefs,
  validateTriggerBindings,
} from '../params.js';
import { createEngine } from '../reduce.js';

/**
 * #844 V2 — READING pipeline variables (spec `2026-09-27-foundation-pipeline-
 * variables.md` V-D3/V-D5). `${vars.<name>}` is a root of its own; until V5
 * nothing can write one, so every read sees the declared default.
 */

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}, extra: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 }, ...extra };
}

const VARS: VariableDef[] = [
  { name: 'count', type: 'number', default: 0 },
  { name: 'label', type: 'string', default: 'start' },
  { name: 'done', type: 'boolean', default: false },
  { name: 'rows', type: 'array', default: [{ id: 1 }, { id: 2 }] },
];

function doc(
  nodes: Node[],
  over: {
    edges?: Edge[];
    params?: Param[];
    containers?: Container[];
    variables?: VariableDef[] | undefined;
  } = {},
) {
  return {
    params: over.params ?? [],
    nodes,
    edges: over.edges ?? [],
    containers: over.containers ?? [],
    ...('variables' in over ? { variables: over.variables } : { variables: VARS }),
  };
}

function errorsOf(nodes: Node[], over: Parameters<typeof doc>[1] = {}): string {
  return validatePipelineDoc(doc(nodes, over)).join('\n');
}

function ctx(variables: Record<string, unknown>): SubstitutionContext {
  return { params: {}, nodeOutputs: {}, nodeStatuses: {}, run: {}, trigger: {}, variables };
}

describe('${vars.<name>} at run time', () => {
  it('resolves a variable from the context', () => {
    expect(substitute('${vars.count}', ctx({ count: 3 }))).toBe(3);
    expect(substitute('n=${vars.count}', ctx({ count: 3 }))).toBe('n=3');
    expect(substitute('${vars.rows[1].id}', ctx({ rows: [{ id: 1 }, { id: 2 }] }))).toBe(2);
  });

  // A declared variable ALWAYS has a value (seeded from its default), so an
  // unknown one is an authoring error. It must not be a `MissingValueError`,
  // which `default()` catches and would turn into a silent fallback.
  it('refuses an unknown variable, and default() does not rescue it', () => {
    expect(() => substitute('${vars.nope}', ctx({}))).toThrow(SubstituteError);
    expect(() => substitute('${default(vars.nope, 1)}', ctx({}))).toThrow(
      /unknown variable reference/,
    );
  });

  it('does not read an inherited property as a variable', () => {
    expect(() => substitute('${vars.toString}', ctx({}))).toThrow(/unknown variable reference/);
  });
});

describe('${vars.<name>} at save time', () => {
  it('accepts a declared variable in a node config', () => {
    expect(errorsOf([node('a', { x: '${vars.count}', y: 'is ${vars.label}' })])).toBe('');
  });

  it('refuses an undeclared variable, worded like the undeclared param', () => {
    expect(errorsOf([node('a', { x: '${vars.missing}' })])).toMatch(
      /\$\{vars\.missing\} is not a declared variable/,
    );
  });

  // `ValidatedDoc.variables` is optional until V3 (#1359). Absent must mean
  // "none declared", which REFUSES a read, never "anything goes".
  it('refuses a variable read when the doc declares none', () => {
    expect(validateRefs(doc([node('a', { x: '${vars.count}' })], { variables: undefined }))).toEqual(
      [expect.stringMatching(/is not a declared variable/)],
    );
  });

  it('types a read by its declared type', () => {
    // `not` takes a boolean; a `number` variable is statically wrong there.
    expect(errorsOf([node('a', { x: '${not(vars.count)}' })])).toMatch(/must be a boolean/);
    expect(errorsOf([node('a', { x: '${not(vars.done)}' })])).toBe('');
    expect(errorsOf([node('a', { x: '${length(vars.rows)}' })])).toBe('');
  });

  it('indexes an array variable, and refuses a field step on it', () => {
    expect(errorsOf([node('a', { x: '${vars.rows[0]}' })])).toBe('');
    expect(errorsOf([node('a', { x: '${vars.rows[0].id}' })])).toBe('');
    expect(errorsOf([node('a', { x: '${vars.rows.id}' })])).toMatch(/deep addressing/);
  });

  it('refuses deep addressing into a scalar variable', () => {
    expect(errorsOf([node('a', { x: '${vars.label.x}' })])).toMatch(/deep addressing/);
    expect(errorsOf([node('a', { x: '${vars.count[0]}' })])).toMatch(/deep addressing/);
  });

  it('is readable in container fields', () => {
    const containers: Container[] = [
      { id: 'fe', kind: 'foreach', children: ['a'], items: '${vars.rows}' } as Container,
      {
        id: 'lp',
        kind: 'loop',
        children: ['b'],
        exitWhen: '${vars.done}',
        maxRounds: 3,
      } as Container,
    ];
    expect(errorsOf([node('a'), node('b')], { containers })).toBe('');
  });

  // V-D5: a binding is evaluated before the run exists, and a tool expression
  // sees only its own arguments. Both closed root sets exclude `vars`, and this
  // pins it, so widening either cannot admit it by accident.
  it('is refused in a trigger param binding', () => {
    expect(validateTriggerBindings({ p: '${vars.count}' }).join(' ')).toMatch(
      /may reference only \$\{trigger\.\*\}/,
    );
  });

  it('is refused in an llm_call tool expression', () => {
    const tool = {
      name: 'adder',
      description: 'Adds.',
      parameters: { type: 'object', properties: { a: { type: 'number' } } },
      expression: '${vars.count}',
    };
    const llm = node('n', { prompt: 'hi', tools: [tool] }, { type: 'llm_call' });
    expect(validateRefs(doc([llm])).join(' ')).toMatch(/tool expression may reference only/);
  });
});

describe('availableRefs offers variables', () => {
  it('lists every declared variable with its declared type', () => {
    const offers = availableRefs(doc([node('a')]), { kind: 'node', nodeId: 'a' }).filter(
      (s) => s.kind === 'variable',
    );
    expect(offers).toEqual(
      VARS.map((v) => ({
        ref: `vars.${v.name}`,
        insert: `\${vars.${v.name}}`,
        kind: 'variable',
        name: v.name,
        declaredType: v.type,
        availability: 'available',
      })),
    );
  });

  it('offers them at a container site too', () => {
    const containers = [{ id: 'fe', kind: 'foreach', children: ['a'], items: '' } as Container];
    const offers = availableRefs(doc([node('a')], { containers }), {
      kind: 'container',
      containerId: 'fe',
      field: 'items',
    });
    expect(offers.some((s) => s.ref === 'vars.rows')).toBe(true);
  });
});

describe('RunState.variables', () => {
  const RUN = 'r1';
  const startedEv: EngineEvent = {
    type: 'run.started',
    runId: RUN,
    pipelineVersionId: 'pv1',
    params: {},
  };

  it('is seeded from the declared defaults, before and after run.started', () => {
    const eng = createEngine({ nodes: [node('a')], edges: [], variables: VARS });
    const defaults = { count: 0, label: 'start', done: false, rows: [{ id: 1 }, { id: 2 }] };
    expect(eng.seedState().variables).toEqual(defaults);
    expect(eng.reduce(eng.seedState(), startedEv).state.variables).toEqual(defaults);
  });

  it('is empty for a doc that declares none', () => {
    const eng = createEngine({ nodes: [node('a')], edges: [] });
    expect(eng.seedState().variables).toEqual({});
    expect(eng.reduce(eng.seedState(), startedEv).state.variables).toEqual({});
  });

  it('feeds a dispatched node its default, identically on replay', () => {
    const eng = createEngine({
      nodes: [node('a', { n: '${vars.count}', rows: '${vars.rows}', s: '${vars.label}!' })],
      edges: [],
      variables: VARS,
    });
    const r = eng.reduce(eng.seedState(), startedEv);
    const cmd = r.commands.find((c) => c.type === 'dispatchNode') as {
      preparedInput: Record<string, unknown>;
    };
    expect(cmd.preparedInput).toEqual({ n: 0, rows: [{ id: 1 }, { id: 2 }], s: 'start!' });
    expect(eng.projectRunState([startedEv])).toEqual(eng.projectRunState([startedEv]));
  });

  // The name rule admits `__proto__`. An assignment would set the seed's
  // prototype instead, and the variable would silently not exist.
  it('seeds a variable named __proto__ as a variable', () => {
    const eng = createEngine({
      nodes: [node('a', { v: '${vars.__proto__}' })],
      edges: [],
      variables: [{ name: '__proto__', type: 'string', default: 'x' }],
    });
    const r = eng.reduce(eng.seedState(), startedEv);
    expect(Object.prototype.hasOwnProperty.call(r.state.variables, '__proto__')).toBe(true);
    const cmd = r.commands.find((c) => c.type === 'dispatchNode') as {
      preparedInput: Record<string, unknown>;
    };
    expect(cmd.preparedInput).toEqual({ v: 'x' });
  });

  // The state must not alias the doc: V5's writes replace values, but a caller
  // mutating a prepared input must never be able to reach the immutable doc.
  it('does not alias a default into state', () => {
    const eng = createEngine({ nodes: [node('a')], edges: [], variables: VARS });
    const state = eng.reduce(eng.seedState(), startedEv).state;
    expect(state.variables['rows']).not.toBe(VARS[3]!.default);
  });
});
