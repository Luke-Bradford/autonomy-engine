/**
 * #844 V5 — WRITING pipeline variables at run time (spec
 * `2026-09-27-foundation-pipeline-variables.md` V-D4/V-D7): `set_variable` and
 * `append_variable` are engine-evaluated control nodes. The reducer evaluates and
 * checks the value at dispatch, the driver appends `variable.set`/`.append` (the
 * write and the node's success, one event), and the fold trusts the recorded
 * value. All against the REAL reducer via the shared `driveRun` harness, which
 * folds `writeVariable`/`failNode` exactly as the server driver's `pump` does.
 */
import { describe, expect, it } from 'vitest';
import type { VariableDef } from '../../schemas/pipeline.js';
import type { Container, Edge, EngineCommand, EngineEvent, Node, VariableWrite } from '../types.js';
import { VARIABLE_MAX_BYTES } from '../types.js';
import { createEngine, type Engine } from '../reduce.js';
import { copiedVariableWritesOf } from '../variable-guard.js';
import { driveRun, simpleResolve } from './helpers/run-driver.js';

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}, type = 'agent_task'): Node {
  seq += 1;
  return { id, type, config, position: { x: seq, y: 0 } };
}
const set = (id: string, variable: string, value: string): Node =>
  node(id, { variable, value }, 'set_variable');
const append = (id: string, variable: string, value: string): Node =>
  node(id, { variable, value }, 'append_variable');
function edge(from: string, to: string, on: 'success' | 'failure' = 'success'): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}
function branch(from: string, to: string, b: string): Edge {
  return { id: `${from}->${to}:${b}`, from, to, on: 'branch', branch: b };
}

const VARS: VariableDef[] = [
  { name: 'n', type: 'number', default: 0 },
  { name: 's', type: 'string', default: '' },
  { name: 'list', type: 'array', default: [] },
];
function eng(nodes: Node[], edges: Edge[] = [], containers: Container[] = []): Engine {
  return createEngine({ nodes, edges, containers, variables: VARS });
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
    Extract<EngineEvent, { type: 'node.failed' }> | undefined;

describe('set_variable writes the value, and a later node reads it', () => {
  it('a literal is coerced to the declared type; the node succeeds without dispatch', () => {
    const { state, log, order, finish } = driveRun(eng([set('w', 'n', '5')]), {
      resolve: simpleResolve(),
    });
    expect(state.variables['n']).toBe(5);
    expect(state.nodes.w!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
    expect(order).not.toContain('w');
    expect(log).toContainEqual({
      type: 'variable.set',
      runId: RUN,
      nodeId: 'w',
      attemptId: 'w#0',
      name: 'n',
      value: 5,
    });
  });

  it('a whole-value ${} keeps its native type, and a downstream if routes on the write', () => {
    const e = eng(
      [
        set('w', 'n', '${add(params.x, 1)}'),
        node('gate', { condition: '${equals(vars.n, 3)}' }, 'if'),
        node('yes'),
        node('no'),
      ],
      [edge('w', 'gate'), branch('gate', 'yes', 'true'), branch('gate', 'no', 'false')],
    );
    const { state, order } = driveRun(e, { params: { x: 2 }, resolve: simpleResolve() });
    expect(state.variables['n']).toBe(3);
    expect(order).toContain('yes');
    expect(order).not.toContain('no');
  });

  it('an interpolated template writes a string variable', () => {
    const { state } = driveRun(eng([set('w', 's', 'tier-${params.t}')]), {
      params: { t: 'gold' },
      resolve: simpleResolve(),
    });
    expect(state.variables['s']).toBe('tier-gold');
  });
});

describe('append_variable appends ONE element to the current array', () => {
  it('appends in order; a literal element is a string, a whole-value one keeps its type', () => {
    const { state, log } = driveRun(
      eng([append('a', 'list', 'x'), append('b', 'list', '${params.k}')], [edge('a', 'b')]),
      { params: { k: 7 }, resolve: simpleResolve() },
    );
    expect(state.variables['list']).toEqual(['x', 7]);
    // The event carries the ELEMENT, never the whole array.
    const appends = log.filter((e) => e.type === 'variable.append');
    expect(appends.map((e) => (e as { value: unknown }).value)).toEqual(['x', 7]);
  });

  it('binds ${item} in a sequential foreach, and the value persists across its rounds', () => {
    const { state, finish } = driveRun(
      eng(
        [append('a', 'list', '${item}')],
        [],
        [{ id: 'fe', kind: 'foreach', children: ['a'], items: '${createArray(1, 2, 3)}' }],
      ),
      { resolve: simpleResolve() },
    );
    expect(finish?.outcome).toBe('success');
    expect(state.variables['list']).toEqual([1, 2, 3]);
  });
});

describe('a value that cannot be WRITTEN fails the node permanently; one that cannot be EVALUATED fails the run', () => {
  it('a whole-value of the wrong type is a type mismatch, handled by a failure edge', () => {
    const e = eng(
      [set('w', 'n', "${concat('a', 'b')}"), node('handler')],
      [edge('w', 'handler', 'failure')],
    );
    const { state, log, finish, order } = driveRun(e, { resolve: simpleResolve() });
    const f = failedOf(log, 'w');
    expect(f?.kind).toBe('permanent');
    expect(f?.code).toBe('variable_type_mismatch');
    expect(f?.error).toContain("variable 'n'");
    expect(state.variables['n']).toBe(0); // not written
    expect(order).toContain('handler');
    expect(finish?.outcome).toBe('success');
    expect(log.some((ev) => ev.type === 'variable.set')).toBe(false);
  });

  it.each([
    ['a literal the coercion refuses', 'n', 'abc'],
    ['text around the braces for a number', 'n', 'n=${params.x}'],
    ['a literal for an array', 'list', '[1]'],
  ])('%s is a type mismatch at run time too', (_label, variable, value) => {
    const { log } = driveRun(eng([set('w', variable, value)]), {
      params: { x: 1 },
      resolve: simpleResolve(),
    });
    expect(failedOf(log, 'w')?.code).toBe('variable_type_mismatch');
  });

  it('a non-finite appended element is refused as not replay-safe', () => {
    const { log, state } = driveRun(eng([append('a', 'list', '${params.big}')]), {
      params: { big: Infinity },
      resolve: simpleResolve(),
    });
    expect(failedOf(log, 'a')?.code).toBe('variable_not_replay_safe');
    expect(state.variables['list']).toEqual([]);
  });

  it('a value over VARIABLE_MAX_BYTES is not written (never truncated)', () => {
    const big = 'x'.repeat(VARIABLE_MAX_BYTES);
    const { log, state } = driveRun(eng([set('w', 's', '${params.big}')]), {
      params: { big },
      resolve: simpleResolve(),
    });
    const f = failedOf(log, 'w');
    expect(f?.code).toBe('variable_too_large');
    expect(f?.kind).toBe('permanent');
    expect(state.variables['s']).toBe('');
  });

  it('a value exactly at the bound is written', () => {
    // JSON adds the two quotes, so this string serialises to exactly the bound.
    const big = 'x'.repeat(VARIABLE_MAX_BYTES - 2);
    const { state } = driveRun(eng([set('w', 's', '${params.big}')]), {
      params: { big },
      resolve: simpleResolve(),
    });
    expect(state.variables['s']).toBe(big);
  });

  it('an evaluation that throws ends the run invalid_event, as for every control node', () => {
    const { finish, log } = driveRun(eng([set('w', 'n', '${nodes.ghost.output.x}')]), {
      resolve: simpleResolve(),
    });
    expect(finish).toEqual({ outcome: 'failure', reason: 'invalid_event' });
    expect(log.some((ev) => ev.type === 'variable.set' || ev.type === 'node.failed')).toBe(false);
  });
});

describe('the fold', () => {
  function readyState(nodes: Node[]) {
    const e = eng(nodes);
    const r = e.reduce(e.seedState(), started());
    return { e, state: r.state, commands: r.commands };
  }
  const written = (over: Partial<Extract<EngineEvent, { type: 'variable.set' }>> = {}) =>
    ({
      type: 'variable.set',
      runId: RUN,
      nodeId: 'w',
      attemptId: 'w#0',
      name: 'n',
      value: 9,
      ...over,
    }) as EngineEvent;

  it('trusts the recorded value — it never evaluates again', () => {
    const { e, state } = readyState([set('w', 'n', '5')]);
    const r = e.reduce(state, written({ value: 9 }));
    expect(r.state.variables['n']).toBe(9);
    expect(r.state.nodes.w!.status).toBe('success');
  });

  it('a duplicate or stale event is a no-op', () => {
    const { e, state } = readyState([set('w', 'n', '5')]);
    const once = e.reduce(state, written()).state;
    const again = e.reduce(once, written({ value: 42 }));
    expect(again.state.variables['n']).toBe(9);
    expect(again.commands).toEqual([]);
    const stale = e.reduce(state, written({ attemptId: 'w#7' }));
    expect(stale.state).toEqual(state);
    expect(stale.commands).toEqual([]);
  });

  it.each([
    ['names another variable', { name: 's', value: 'x' }],
    ['is the other op', { type: 'variable.append' as const }],
    ['targets a node that is not a variable writer', { nodeId: 'other', attemptId: 'other#0' }],
  ])('an event that %s is an impossible log, never applied', (_label, over) => {
    const { e, state } = readyState([set('w', 'n', '5'), node('other')]);
    const r = e.reduce(state, written(over as never));
    expect(r.commands).toEqual([
      { type: 'finishRun', outcome: 'failure', reason: 'invalid_event' },
    ]);
    expect(r.state.variables).toEqual(state.variables);
  });

  it('an event for a node a loop timeout abandoned folds as a no-op', () => {
    const e = eng(
      [set('w', 'n', '5')],
      [],
      [{ id: 'lp', kind: 'loop', children: ['w'], exitWhen: '${true}', timeout: 60 }],
    );
    let s = e.reduce(e.seedState(), started()).state;
    expect(s.nodes.w!.status).toBe('ready'); // its writeVariable is in flight
    s = e.reduce(s, {
      type: 'container.timeoutScheduled',
      runId: RUN,
      containerId: 'lp',
      dueAt: 1,
    }).state;
    s = e.reduce(s, { type: 'container.timedOut', runId: RUN, containerId: 'lp' }).state;
    expect(s.nodes.w!.status).toBe('skipped');
    const late = e.reduce(s, written({ value: 5 }));
    expect(late.state).toEqual(s);
    expect(late.commands).toEqual([]);
  });
});

describe('crash resume re-runs the SAME evaluation and checks', () => {
  it('re-emits the write a projection discarded', () => {
    const e = eng([set('w', 'n', '${params.x}')]);
    const projected = e.projectRunState([started({ x: 4 })]);
    expect(projected.nodes.w!.status).toBe('ready');
    const { commands } = e.resume(projected);
    expect(commands).toContainEqual<EngineCommand>({
      type: 'writeVariable',
      nodeId: 'w',
      attemptId: 'w#0',
      op: 'set',
      name: 'n',
      value: 4,
    });
    expect(commands.some((c) => c.type === 'dispatchNode')).toBe(false);
  });

  it('routes a value that fails its check to failNode, never a blind write', () => {
    const e = eng([set('w', 'n', '${params.x}')]);
    const { commands } = e.resume(e.projectRunState([started({ x: 'four' })]));
    expect(commands).toEqual([
      expect.objectContaining({ type: 'failNode', nodeId: 'w', code: 'variable_type_mismatch' }),
    ]);
  });
});

describe('rerun-from-failed carries the copied nodes’ writes (V-D7)', () => {
  const nodes = () => [set('a', 'n', '5'), append('b', 'list', 'p'), node('c')];
  const edges = () => [edge('a', 'b'), edge('b', 'c')];

  it('applies copiedVariableWrites in order over the defaults', () => {
    const writes: VariableWrite[] = [
      { nodeId: 'a', op: 'set', name: 'n', value: 5 },
      { nodeId: 'b', op: 'append', name: 'list', value: 'p' },
      { nodeId: 'b', op: 'append', name: 'list', value: 'q' },
    ];
    const { state } = driveRun(eng(nodes(), edges()), {
      resolve: simpleResolve(),
      reseed: {
        sourceRunId: 'r0',
        frontier: ['a', 'b'],
        copiedOutputs: {},
        copiedContainers: {},
        copiedVariableWrites: writes,
      },
    });
    expect(state.variables).toEqual({ n: 5, s: '', list: ['p', 'q'] });
    expect(state.nodes.c!.status).toBe('success');
  });

  it('an old reseed without the field starts from the defaults', () => {
    const { state } = driveRun(eng(nodes(), edges()), {
      resolve: simpleResolve(),
      reseed: { sourceRunId: 'r0', frontier: ['a'], copiedOutputs: {}, copiedContainers: {} },
    });
    expect(state.variables['n']).toBe(0);
  });

  it('a carried write that cannot apply is reported and skipped', () => {
    const { state, diagnostics } = driveRun(eng(nodes(), edges()), {
      resolve: simpleResolve(),
      reseed: {
        sourceRunId: 'r0',
        frontier: ['a'],
        copiedOutputs: {},
        copiedContainers: {},
        copiedVariableWrites: [
          { nodeId: 'a', op: 'set', name: 'ghost', value: 1 },
          { nodeId: 'a', op: 'set', name: 'n', value: 5 },
        ],
      },
    });
    expect(state.variables['n']).toBe(5);
    expect(diagnostics.some((d) => d.includes("'ghost'"))).toBe(true);
  });

  it('copiedVariableWritesOf equals what the fold applied, a duplicate re-append included', () => {
    const e = eng(nodes(), edges());
    const r1 = driveRun(e, { resolve: simpleResolve() });
    // A driver re-append after a crash: the same attempt's event, logged twice.
    const dup = r1.log.find((ev) => ev.type === 'variable.append')!;
    const log = [...r1.log, dup];
    const replayed = e.projectRunState(log);
    expect(replayed.variables).toEqual(r1.state.variables);

    const carried = copiedVariableWritesOf(log, new Set(['a', 'b', 'c']));
    const r2 = driveRun(eng(nodes(), edges()), {
      resolve: simpleResolve(),
      reseed: {
        sourceRunId: 'r1',
        frontier: ['a', 'b', 'c'],
        copiedOutputs: {},
        copiedContainers: {},
        copiedVariableWrites: carried,
      },
    });
    expect(r2.state.variables).toEqual(replayed.variables);
  });

  it('a rerun of a rerun: the source’s carried writes, then its own', () => {
    // R2 copied `a` from R1 and re-ran `b`; R3 copies both from R2.
    const r2 = driveRun(eng(nodes(), edges()), {
      resolve: simpleResolve(),
      reseed: {
        sourceRunId: 'r1',
        frontier: ['a'],
        copiedOutputs: {},
        copiedContainers: {},
        copiedVariableWrites: [{ nodeId: 'a', op: 'set', name: 'n', value: 11 }],
      },
    });
    const carried = copiedVariableWritesOf(r2.log, new Set(['a', 'b']));
    expect(carried).toEqual([
      { nodeId: 'a', op: 'set', name: 'n', value: 11 },
      { nodeId: 'b', op: 'append', name: 'list', value: 'p' },
    ]);
    const r3 = driveRun(eng(nodes(), edges()), {
      resolve: simpleResolve(),
      reseed: {
        sourceRunId: 'r2',
        frontier: ['a', 'b'],
        copiedOutputs: {},
        copiedContainers: {},
        copiedVariableWrites: carried,
      },
    });
    expect(r3.state.variables).toEqual(r2.state.variables);
  });
});
