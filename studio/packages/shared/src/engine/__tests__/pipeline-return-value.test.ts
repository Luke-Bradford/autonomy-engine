/**
 * #1600 OR41 C12b (catalogue §4.7) — Set variable · Operation *Pipeline return
 * value*: ADF's dictionary of keys a child pipeline hands its caller, read by the
 * parent as `${nodes.<call>.output.pipelineReturnValue.<key>}`. Not a variable
 * write: the node succeeds like a `filter` (`succeedControl` → `node.succeeded`)
 * with the one output `pipelineReturnValue`, which the child projection
 * (`projectChildRunOutputs`) hands to the parent's `call.returned`.
 */
import { describe, expect, it } from 'vitest';
import { lowerPipelineNodes } from '../../catalog/lower.js';
import type { VariableDef } from '../../schemas/pipeline.js';
import { projectChildRunOutputs } from '../child-outputs.js';
import { createEngine, type Engine } from '../reduce.js';
import type { Container, Edge, EngineCommand, EngineEvent, Node, RunState } from '../types.js';
import { VARIABLE_MAX_BYTES } from '../types.js';
import { validatePipelineDoc } from '../validate-pipeline.js';
import { driveRun, simpleResolve } from './helpers/run-driver.js';

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}, type = 'agent_task'): Node {
  seq += 1;
  const filled = type === 'agent_task' ? { task: 't', ...config } : config;
  return { id, type, config: filled, position: { x: seq, y: 0 } };
}
type Row = { key: unknown; type: unknown; value?: unknown };
const ret = (id: string, returnValues: Row[] | unknown): Node =>
  node(id, { operation: 'return', returnValues }, 'set_variable');
function edge(from: string, to: string, on: 'success' | 'failure' = 'success'): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}

const VARS: VariableDef[] = [
  { name: 'n', type: 'number', default: 0 },
  { name: 's', type: 'string', default: '' },
];
const PARAMS = [
  { name: 'x', type: 'number' as const, required: false, default: 1 },
  { name: 'j', type: 'json' as const, required: false, default: { a: 1 } },
];
function eng(nodes: Node[], edges: Edge[] = [], containers: Container[] = []): Engine {
  return createEngine({ nodes: lowerPipelineNodes(nodes), edges, containers, variables: VARS });
}
const RUN = 'r1';
const started = (params: Record<string, unknown> = {}): EngineEvent => ({
  type: 'run.started',
  runId: RUN,
  pipelineVersionId: 'pv1',
  params,
});
const failedOf = (log: EngineEvent[], id: string) =>
  log.find((e) => e.type === 'node.failed' && e.nodeId === id) as
    | Extract<EngineEvent, { type: 'node.failed' }>
    | undefined;

describe('a Pipeline return value node succeeds with the typed map as its output', () => {
  it('coerces each row to its type, writes no variable, and is never dispatched', () => {
    const e = eng([
      ret('r', [
        { key: 'label', type: 'string', value: 'n=${params.x}' },
        { key: 'empty', type: 'string' },
        { key: 'count', type: 'number', value: '42' },
        { key: 'twice', type: 'number', value: '${mul(params.x, 2)}' },
        { key: 'ok', type: 'boolean', value: 'true' },
        { key: 'list', type: 'array', value: '["a", "b"]' },
        { key: 'obj', type: 'object', value: '${params.j}' },
        { key: 'lit', type: 'object', value: '{"k": [1]}' },
        { key: 'none', type: 'null' },
      ]),
    ]);
    const { state, log, order, finish } = driveRun(e, {
      resolve: simpleResolve(),
      params: { x: 3, j: { a: 1 } },
    });
    const value = {
      label: 'n=3',
      empty: '',
      count: 42,
      twice: 6,
      ok: true,
      list: ['a', 'b'],
      obj: { a: 1 },
      lit: { k: [1] },
      none: null,
    };
    expect(finish?.outcome).toBe('success');
    expect(order).not.toContain('r');
    expect(log).toContainEqual({
      type: 'node.succeeded',
      runId: RUN,
      nodeId: 'r',
      attemptId: 'r#0',
      outputs: { pipelineReturnValue: value },
    });
    expect(state.outputs['r']).toEqual({ pipelineReturnValue: value });
    expect(log.some((ev) => ev.type.startsWith('variable.'))).toBe(false);
    expect(state.variables).toEqual({ n: 0, s: '' });
  });

  it('a downstream node in the child reads it like any output', () => {
    const e = eng(
      [
        ret('r', [{ key: 'total', type: 'number', value: '7' }]),
        node('w', { variable: 'n', value: '${nodes.r.output.pipelineReturnValue.total}' }, 'set_variable'),
      ],
      [edge('r', 'w')],
    );
    const { state, finish } = driveRun(e, { resolve: simpleResolve() });
    expect(finish?.outcome).toBe('success');
    expect(state.variables['n']).toBe(7);
  });

  it('a key named __proto__ is an own key of the map, never a prototype write', () => {
    // The save gate refuses it; a run of a stored doc must still not pollute.
    const e = eng([ret('r', [{ key: '__proto__', type: 'string', value: 'x' }])]);
    const { state } = driveRun(e, { resolve: simpleResolve() });
    const map = (state.outputs['r'] as Record<string, unknown>)['pipelineReturnValue'] as object;
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(map, '__proto__')?.value).toBe('x');
  });
});

describe('a value that cannot be RETURNED fails the node permanently', () => {
  it.each([
    ['a whole-value of the wrong type', { key: 'k', type: 'string', value: '${params.x}' }],
    ['a literal that is not a number', { key: 'k', type: 'number', value: 'five' }],
    ['JSON text that is not an array', { key: 'k', type: 'array', value: '{"a":1}' }],
    ['text that is not JSON', { key: 'k', type: 'object', value: 'nope' }],
    ['an array for an object', { key: 'k', type: 'object', value: '${createArray(1)}' }],
    ['a template for an object', { key: 'k', type: 'object', value: 'x${params.x}' }],
  ])('%s is a type mismatch naming the key', (_label, row) => {
    const { log, finish } = driveRun(eng([ret('r', [row])]), { resolve: simpleResolve() });
    const failed = failedOf(log, 'r');
    expect(failed?.failure).toMatchObject({ kind: 'permanent', code: 'VARIABLE_TYPE_MISMATCH' });
    expect(failed?.failure.message).toContain("return value 'k'");
    expect(finish?.outcome).toBe('failure');
  });

  it('a map over VARIABLE_MAX_BYTES is not returned, counted over the WHOLE map', () => {
    const half = 'x'.repeat(Math.ceil(VARIABLE_MAX_BYTES / 2));
    const { log } = driveRun(
      eng([
        ret('r', [
          { key: 'a', type: 'string', value: half },
          { key: 'b', type: 'string', value: half },
        ]),
      ]),
      { resolve: simpleResolve() },
    );
    expect(failedOf(log, 'r')?.failure).toMatchObject({ code: 'VARIABLE_TOO_LARGE' });
    expect(failedOf(log, 'r')?.failure.message).toContain('return value');
  });

  it('an evaluation that throws ends the run invalid_event, as for every control node', () => {
    const { finish } = driveRun(
      eng([ret('r', [{ key: 'k', type: 'string', value: '${nodes.nope.output.x}' }])]),
      { resolve: simpleResolve() },
    );
    expect(finish).toMatchObject({ outcome: 'failure', reason: 'invalid_event' });
  });

  it('a malformed table (not an array) ends the run invalid_event, never a guessed map', () => {
    const { finish } = driveRun(eng([ret('r', 'nope')]), { resolve: simpleResolve() });
    expect(finish).toMatchObject({ outcome: 'failure', reason: 'invalid_event' });
  });
});

describe('crash resume re-runs the SAME evaluation', () => {
  it('re-emits the succeedControl a projection discarded', () => {
    const e = eng([ret('r', [{ key: 'k', type: 'number', value: '${params.x}' }])]);
    const projected = e.projectRunState([started({ x: 4 })]);
    expect(projected.nodes['r']!.status).toBe('ready');
    const { commands } = e.resume(projected);
    expect(commands).toContainEqual<EngineCommand>({
      type: 'succeedControl',
      nodeId: 'r',
      attemptId: 'r#0',
      outputs: { pipelineReturnValue: { k: 4 } },
    });
  });
});

describe('the child projection hands the parent its return value', () => {
  const docOf = (...nodes: Node[]) => ({ nodes });
  const stateOf = (outputs: Record<string, Record<string, unknown>>) =>
    ({ outputs }) as Pick<RunState, 'outputs'>;

  it('pipelineReturnValue comes only from a return node; another node’s same-named output is dropped', () => {
    const out = projectChildRunOutputs(
      docOf(node('a'), ret('m', [])),
      stateOf({ a: { pipelineReturnValue: 'stray', rows: 2 }, m: { pipelineReturnValue: { k: 1 } } }),
    );
    expect(out).toEqual({ rows: 2, pipelineReturnValue: { k: 1 } });
  });

  it('with no return node, a nested call’s pipelineReturnValue does not pass up', () => {
    const out = projectChildRunOutputs(
      docOf(node('call', {}, 'execute_pipeline')),
      stateOf({ call: { pipelineReturnValue: { k: 1 }, other: 1 } }),
    );
    expect(out).toEqual({ other: 1 });
  });

  it('two return nodes that both ran: the last by sorted id wins, whole (keys are not merged)', () => {
    const out = projectChildRunOutputs(
      docOf(ret('z', []), ret('a', [])),
      stateOf({ a: { pipelineReturnValue: { x: 1, y: 1 } }, z: { pipelineReturnValue: { x: 2 } } }),
    );
    expect(out).toEqual({ pipelineReturnValue: { x: 2 } });
  });
});

describe('the contract is derived from the Operation', () => {
  const outputsOf = (n: Node) => lowerPipelineNodes([n])[0]!.config['outputs'];
  const ROW = [{ name: 'pipelineReturnValue', type: 'json' }];

  it('a return node declares pipelineReturnValue, over whatever it held', () => {
    expect(outputsOf(ret('r', []))).toEqual(ROW);
    expect(outputsOf({ ...ret('r', []), config: { operation: 'return', outputs: [] } })).toEqual(ROW);
  });

  it('switching back to Set heals the derived row to the catalog default', () => {
    expect(outputsOf(node('w', { variable: 'n', value: '1', outputs: ROW }, 'set_variable'))).toEqual([]);
    expect(outputsOf(node('w', { variable: 'n', value: '1' }, 'set_variable'))).toEqual([]);
  });
});

describe('save rules', () => {
  const validate = (nodes: Node[], edges: Edge[] = [], containers: Container[] = []) =>
    validatePipelineDoc({
      params: PARAMS,
      nodes: lowerPipelineNodes(nodes),
      edges,
      containers,
      variables: VARS,
    });
  const ok = (rows: Row[]) => validate([ret('r', rows)]);

  it('accepts every type, a template string, and an absent value for Null and String', () => {
    expect(
      ok([
        { key: 'a', type: 'string', value: 'n=${params.x}' },
        { key: 'b', type: 'string' },
        { key: 'c', type: 'number', value: '${params.x}' },
        { key: 'd', type: 'boolean', value: 'false' },
        { key: 'e', type: 'array', value: '[1, 2]' },
        { key: 'f', type: 'object', value: '${params.j}' },
        { key: 'g', type: 'null' },
      ]),
    ).toEqual([]);
  });

  it.each<[string, Row[] | unknown, string]>([
    ['no rows', [], 'nodes.r.returnValues: add at least one return value'],
    ['no table', undefined, 'nodes.r.returnValues: add at least one return value'],
    ['an empty key', [{ key: '', type: 'string' }], "nodes.r.returnValues[0].key"],
    ['a dotted key', [{ key: 'a.b', type: 'string' }], 'nodes.r.returnValues[0].key'],
    ['__proto__', [{ key: '__proto__', type: 'string' }], 'nodes.r.returnValues[0].key'],
    ['a ${} key', [{ key: '${params.x}', type: 'string' }], 'nodes.r.returnValues[0].key'],
    [
      'a duplicate key',
      [
        { key: 'k', type: 'string' },
        { key: 'k', type: 'number', value: '1' },
      ],
      "nodes.r.returnValues[1].key: 'k' is already returned",
    ],
    ['an unknown type', [{ key: 'k', type: 'int', value: '1' }], 'nodes.r.returnValues[0].type'],
    ['a number with no value', [{ key: 'k', type: 'number' }], 'nodes.r.returnValues[0].value'],
    ['a value on Null', [{ key: 'k', type: 'null', value: 'x' }], 'nodes.r.returnValues[0].value'],
    ['a non-text value', [{ key: 'k', type: 'number', value: 5 }], 'nodes.r.returnValues[0].value'],
    ['a bad number literal', [{ key: 'k', type: 'number', value: 'five' }], 'nodes.r.returnValues[0].value'],
    ['a bad array literal', [{ key: 'k', type: 'array', value: '{"a":1}' }], 'nodes.r.returnValues[0].value'],
    ['a template object', [{ key: 'k', type: 'object', value: 'a${params.x}' }], 'nodes.r.returnValues[0].value'],
    ['a number expression for a string', [{ key: 'k', type: 'string', value: '${params.x}' }], 'nodes.r.returnValues[0].value'],
    ['a number expression for an object', [{ key: 'k', type: 'object', value: '${params.x}' }], 'nodes.r.returnValues[0].value'],
  ])('refuses %s', (_label, rows, message) => {
    expect(validate([ret('r', rows)]).some((e) => e.includes(message))).toBe(true);
  });

  it('refuses a variable or value on a return node, and a table on a Set', () => {
    const errs = validate([
      node('r', { operation: 'return', variable: 'n', value: '1', returnValues: [{ key: 'k', type: 'null' }] }, 'set_variable'),
      node('w', { variable: 'n', value: '1', returnValues: [{ key: 'k', type: 'null' }] }, 'set_variable'),
    ], [edge('r', 'w')]);
    expect(errs).toContain('node.r.variable: Pipeline return value has no variable — remove it');
    expect(errs).toContain('node.r.value: Pipeline return value has no value — its values are in Return values');
    expect(errs).toContain('node.w.returnValues: only Pipeline return value has return values — remove it');
  });

  it('names the third operation when the Operation is unknown', () => {
    const errs = validate([node('w', { variable: 'n', value: '1', operation: 'prepend' }, 'set_variable')]);
    expect(errs).toContain(
      "node.w.operation: must be Set, Append or Pipeline return value ('set', 'append' or 'return')",
    );
  });

  it('refuses a return node inside a ForEach, at any depth', () => {
    const fe = (children: string[]): Container => ({
      id: 'fe',
      kind: 'foreach',
      children,
      items: '${createArray(1, 2)}',
    });
    const r = ret('r', [{ key: 'k', type: 'null' }]);
    const direct = validate([r], [], [fe(['r'])]);
    const nested = validate(
      [r],
      [],
      [fe(['st']), { id: 'st', kind: 'stage', children: ['r'] } as Container],
    );
    for (const errs of [direct, nested]) {
      expect(errs.some((e) => e.includes('node.r.operation: Pipeline return value cannot run inside a ForEach'))).toBe(true);
    }
  });

  it('refuses the secure flags, in return-value terms', () => {
    const errs = validate([{ ...ret('r', [{ key: 'k', type: 'null' }]), policy: { secureOutput: true } }]);
    expect(errs.some((e) => e.includes('policy.secureOutput is not supported') && e.includes('calling pipeline'))).toBe(true);
  });

  it('counts a row’s variable read for the determinism guard', () => {
    // A return node reads `vars.n` while an unordered Set writes it: the guard sees the read.
    const errs = validate([
      ret('r', [{ key: 'k', type: 'number', value: '${vars.n}' }]),
      node('w', { variable: 'n', value: '1' }, 'set_variable'),
    ]);
    expect(errs.some((e) => e.includes("variable 'n'"))).toBe(true);
  });
});
