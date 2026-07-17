/**
 * #4 A5 + A6 — the durable-wait scheduler primitive (`timer.waitScheduled`/
 * `timer.due`) and the `wait` control activity built on it.
 *
 * A `wait` node is engine-evaluated like `if`/`switch`/`fail`/`filter`
 * (`kind:'control'`, never dispatched), but — unlike those four synchronous
 * activities — it is DURABLE: it PARKS on S1's alarm. A ready `wait` resolves its
 * whole-value `${}` `seconds` PURELY, holds `ready`, and the driver emits the
 * reducer's own `scheduleWait` command → arms the alarm → appends
 * `timer.waitScheduled` (which folds the node `ready` → the NON-terminal
 * `wait_pending`). When the alarm's `dueAt` passes, the clock appends `timer.due`,
 * which folds `wait_pending` → `success` (no output). Downstream nodes then route
 * off the wait's `success` edge.
 *
 * Run-time assertions go through the shared `driveRun` harness against the REAL
 * reducer (no mocks); the harness folds `scheduleWait` by firing
 * `timer.waitScheduled`+`timer.due` synchronously (it has no clock), exactly as the
 * server driver's `pump`+alarm clock do over wall time. Save-time assertions call
 * the real `validateDoc`/`validateRefs`. The alarm's real timing/freshness is
 * covered server-side in `scheduler/__tests__/wait-alarm.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { Container, Edge, Node, Param, PipelineVersion } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { validateDoc, validateRefs, validatePipelineDoc } from '../params.js';
import { getActivity } from '../../catalog/registry.js';
import { CATALOG_VERSION } from '../../schemas/version.js';
import { driveRun, simpleResolve } from './helpers/run-driver.js';

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 } };
}
function waitNode(id: string, seconds: unknown, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'wait', config: { seconds, ...config }, position: { x: seq, y: 0 } };
}
function edge(
  from: string,
  to: string,
  on: 'success' | 'failure' | 'completion' | 'skipped' = 'success',
): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}
function eng(nodes: Node[], edges: Edge[] = [], containers: Container[] = []): Engine {
  return createEngine({ nodes, edges, containers } satisfies EngineDoc);
}
function doc(
  nodes: Node[],
  edges: Edge[] = [],
  containers: Container[] = [],
  params: Param[] = [],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'> {
  return { params, nodes, edges, containers };
}
const foreach = (id: string, children: string[], items: string): Container => ({
  id,
  kind: 'foreach',
  children,
  items,
});
const loop = (id: string, children: string[], exitWhen: string, maxRounds?: number): Container => ({
  id,
  kind: 'loop',
  children,
  exitWhen,
  ...(maxRounds !== undefined ? { maxRounds } : {}),
});

describe('wait parks then completes on timer.due (#4 A6)', () => {
  it('resolves seconds, holds ready → wait_pending → success (never dispatched)', () => {
    const e = eng([waitNode('w', '${5}')]);
    const { state, order, finish, log } = driveRun(e, { resolve: simpleResolve() });

    expect(state.nodes.w!.status).toBe('success');
    // A wait produces no data.
    expect(state.outputs.w).toBeUndefined();
    expect(finish?.outcome).toBe('success');
    // Engine-evaluated: never handed to the executor.
    expect(order).not.toContain('w');
    expect(log.some((ev) => ev.type === 'node.dispatched' && ev.nodeId === 'w')).toBe(false);
    // The two durable timer facts are in the log, in order.
    const timerTypes = log.filter((ev) => ev.type.startsWith('timer.')).map((ev) => ev.type);
    expect(timerTypes).toEqual(['timer.waitScheduled', 'timer.due']);
  });

  it('a resolved ${} number over run state parks correctly', () => {
    const e = eng(
      [node('a'), waitNode('w', '${nodes.a.output.delay}')],
      [edge('a', 'w', 'success')],
    );
    const { state, finish } = driveRun(e, {
      resolve: (nodeId, attemptId, runId) =>
        nodeId === 'a'
          ? { type: 'node.succeeded', runId, nodeId, attemptId, outputs: { delay: 3 } }
          : { type: 'node.succeeded', runId, nodeId, attemptId, outputs: {} },
    });
    expect(state.nodes.w!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  it('zero seconds is allowed (an immediate wake)', () => {
    const e = eng([waitNode('w', '${0}')]);
    const { state, finish } = driveRun(e, { resolve: simpleResolve() });
    expect(state.nodes.w!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  it('a downstream node routes off the wait success edge', () => {
    const e = eng([waitNode('w', '${1}'), node('after')], [edge('w', 'after', 'success')]);
    const { state, order } = driveRun(e, { resolve: simpleResolve() });
    expect(state.nodes.after!.status).toBe('success');
    // `after` is a real activity (dispatched); the wait is not.
    expect(order).toEqual(['after']);
  });

  it('the scheduleWait command carries the resolved numeric seconds', () => {
    const e = eng([waitNode('w', '${5}')]);
    const projected = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: {} },
    ]);
    const { commands } = e.resume(projected);
    expect(commands).toContainEqual({
      type: 'scheduleWait',
      nodeId: 'w',
      attemptId: 'w#0',
      seconds: 5,
    });
  });
});

describe('a parked wait keeps the run alive (does NOT stall/finish) (#4 A5)', () => {
  it('a run whose sole live node is wait_pending stays running, not stalled', () => {
    const e = eng([waitNode('w', '${5}'), node('after')], [edge('w', 'after', 'success')]);
    // Fold up to (and including) the park, but NOT the timer.due.
    const state = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: {} },
      { type: 'timer.waitScheduled', runId: 'r1', nodeId: 'w', attemptId: 'w#0', dueAt: 999 },
    ]);
    expect(state.nodes.w!.status).toBe('wait_pending');
    expect(state.nodes.after!.status).toBe('pending');
    // The stalled-backstop (#491) must NOT terminalize a waiting run.
    expect(state.status).toBe('running');
  });

  it('timer.due then completes the parked node and the run', () => {
    const e = eng([waitNode('w', '${5}')]);
    const parked = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: {} },
      { type: 'timer.waitScheduled', runId: 'r1', nodeId: 'w', attemptId: 'w#0', dueAt: 999 },
    ]);
    const { state, commands } = e.reduce(parked, {
      type: 'timer.due',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#0',
    });
    expect(state.nodes.w!.status).toBe('success');
    expect(commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });
});

describe('timer.due freshness — at-least-once delivery is a no-op (#4 A5)', () => {
  it('a duplicate timer.due for an already-succeeded wait folds inertly', () => {
    const e = eng([waitNode('w', '${5}')]);
    const done = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: {} },
      { type: 'timer.waitScheduled', runId: 'r1', nodeId: 'w', attemptId: 'w#0', dueAt: 1 },
      { type: 'timer.due', runId: 'r1', nodeId: 'w', previousAttemptId: 'w#0' },
    ]);
    expect(done.nodes.w!.status).toBe('success');
    const { state, commands, diagnostics } = e.reduce(done, {
      type: 'timer.due',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#0',
    });
    expect(state.nodes.w!.status).toBe('success');
    expect(commands).toEqual([]);
    // A no-op, not a malformed-log diagnostic (an expected redelivery).
    expect(diagnostics).toEqual([]);
  });

  it('a timer.due naming a stale attempt is a no-op', () => {
    const e = eng([waitNode('w', '${5}')]);
    const parked = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: {} },
      { type: 'timer.waitScheduled', runId: 'r1', nodeId: 'w', attemptId: 'w#0', dueAt: 1 },
    ]);
    const { state, commands } = e.reduce(parked, {
      type: 'timer.due',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#999',
    });
    // Still parked — the stale alarm did not resolve it.
    expect(state.nodes.w!.status).toBe('wait_pending');
    expect(commands).toEqual([]);
  });
});

describe('wait with a malformed config fails the run LOUD (#4 A6)', () => {
  it('seconds resolving to a non-finite value → invalid_event (never a silent default)', () => {
    const e = eng([waitNode('w', '${params.bad}')]);
    const { finish, finishes } = driveRun(e, {
      params: { bad: 'not-a-number' },
      resolve: simpleResolve(),
    });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
    expect(finishes).toBe(1);
  });

  it('seconds resolving to a NEGATIVE number → invalid_event (never a backwards timer)', () => {
    const e = eng([waitNode('w', '${params.neg}')]);
    const { finish } = driveRun(e, { params: { neg: -5 }, resolve: simpleResolve() });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
  });

  it('a bad ${} ref in seconds → invalid_event', () => {
    const e = eng([waitNode('w', '${nodes.missing.output.x}')]);
    const { finish } = driveRun(e, { resolve: simpleResolve() });
    expect(finish?.reason).toBe('invalid_event');
  });

  it('a numeric STRING resolved value is coerced (not a failure)', () => {
    const e = eng([waitNode('w', '${params.n}')]);
    const { state, finish } = driveRun(e, { params: { n: '7' }, resolve: simpleResolve() });
    expect(state.nodes.w!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  // The `Number()` coercion holes: `Number([])`/`Number(false)`/`Number(null)`/
  // `Number('')` all yield 0 and `Number([5])` yields 5 — so a non-number,
  // non-numeric-string whole-value must fail LOUD, never park for a manufactured 0.
  it.each([
    ['an empty array', []],
    ['a single-element array (Number([5]) === 5)', [5]],
    ['a boolean', true],
    ['null', null],
    ['an empty string', ''],
    ['an object', { x: 1 }],
  ])('seconds resolving to %s → invalid_event (no silent coercion)', (_label, value) => {
    const e = eng([waitNode('w', '${params.v}')]);
    const { finish } = driveRun(e, { params: { v: value }, resolve: simpleResolve() });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
  });
});

describe('wait inside a loop re-parks each round (back-edge reset) (#4 A6)', () => {
  it('a wait child parks+completes every round; the reset re-arms it until exitWhen', () => {
    // A `loop`/`until` container re-runs its children each round, resetting them via
    // `resetNodes` (which returns any status — incl. `wait_pending`/`success` — to
    // `pending` and clears `currentAttemptId`). This proves the wait re-parks on
    // each round rather than staying `success` from round 0, and that the loop's
    // exit still fires. (A wait can never be reset MID-park: a `wait_pending` child
    // is non-terminal, so the round's `children.every(TERMINAL_NODE)` gate blocks
    // the round until the wait completes — the generic gate `awaitsExternalEvent`
    // keeps alive.)
    const e = eng(
      [waitNode('w', '${5}'), node('check', { outputs: [{ name: 'done', type: 'boolean' }] })],
      [edge('w', 'check', 'success')],
      [loop('lp', ['w', 'check'], '${nodes.check.output.done}', 5)],
    );
    const { state, log } = driveRun(e, {
      // `check.done` is false for rounds 0,1 then true at round 2 — keyed off the
      // per-round attemptId (`check#0`/`#1`/`#2`).
      resolve: (nodeId, attemptId, runId) =>
        nodeId === 'check'
          ? {
              type: 'node.succeeded',
              runId,
              nodeId,
              attemptId,
              outputs: { done: Number(attemptId.split('#')[1]) >= 2 },
            }
          : { type: 'node.succeeded', runId, nodeId, attemptId, outputs: {} },
    });
    // Rounds 0,1,2 → the wait parked+completed THREE times (re-armed each round).
    expect(log.filter((ev) => ev.type === 'timer.due').length).toBe(3);
    expect(state.containers.lp!.status).toBe('success');
    expect(state.containers.lp!.round).toBe(2);
    expect(state.status).toBe('success');
  });

  it('a wait_pending child blocks its loop round from advancing', () => {
    // The container child-terminal gate must treat `wait_pending` as NON-terminal.
    const e = eng(
      [waitNode('w', '${5}'), node('check', { outputs: [{ name: 'done', type: 'boolean' }] })],
      [edge('w', 'check', 'success')],
      [loop('lp', ['w', 'check'], '${nodes.check.output.done}', 5)],
    );
    // Fold only up to the wait's park in round 0 — the round must NOT have advanced.
    const parked = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: {} },
      { type: 'timer.waitScheduled', runId: 'r1', nodeId: 'w', attemptId: 'w#0', dueAt: 999 },
    ]);
    expect(parked.nodes.w!.status).toBe('wait_pending');
    expect(parked.nodes.check!.status).toBe('pending');
    expect(parked.containers.lp!.round).toBe(0);
    expect(parked.status).toBe('running');
  });
});

describe('wait binds the foreach ${item} in seconds (#4 A6)', () => {
  it('inside a foreach body: seconds sees the current ${item}', () => {
    const e = eng([waitNode('w', '${item}')], [], [foreach('fe', ['w'], '${params.delays}')]);
    const { state, log } = driveRun(e, {
      params: { delays: [1, 2, 3] },
      resolve: simpleResolve(),
    });
    // Three rounds → three park/resume pairs → the container succeeds.
    const dues = log.filter((ev) => ev.type === 'timer.due');
    expect(dues.length).toBe(3);
    expect(state.containers.fe!.status).toBe('success');
  });
});

describe('wait crash recovery re-emits scheduleWait (#4 A6)', () => {
  it('resume re-derives the scheduleWait a projection discarded, never re-dispatching', () => {
    const e = eng([waitNode('w', '${5}')]);
    const projected = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: {} },
    ]);
    // The command was discarded by the projection; the node is `ready`, not parked.
    expect(projected.nodes.w!.status).toBe('ready');
    const { commands } = e.resume(projected);
    expect(commands).toContainEqual({
      type: 'scheduleWait',
      nodeId: 'w',
      attemptId: 'w#0',
      seconds: 5,
    });
    // A control node must NEVER be re-dispatched to the executor on resume.
    expect(commands.some((c) => c.type === 'dispatchNode' && c.nodeId === 'w')).toBe(false);
  });

  it('a wait_pending node is NOT re-emitted on resume (its alarm is durable)', () => {
    // The crucial "no boot re-arm" property: once parked, resume re-derives NOTHING
    // for the wait node — the alarm row (armed BEFORE the timer.waitScheduled append)
    // is the sole resolver. Re-emitting scheduleWait here would double-arm.
    const e = eng([waitNode('w', '${5}')]);
    const parked = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: {} },
      { type: 'timer.waitScheduled', runId: 'r1', nodeId: 'w', attemptId: 'w#0', dueAt: 999 },
    ]);
    expect(parked.nodes.w!.status).toBe('wait_pending');
    const { commands } = e.resume(parked);
    expect(commands.some((c) => c.type === 'scheduleWait')).toBe(false);
  });

  it('re-derives scheduleWait for a wait INSIDE a foreach, threading the foreach ${item} (#569)', () => {
    const e = eng([waitNode('w', '${item}')], [], [foreach('fe', ['w'], '${params.delays}')]);
    const projected = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: { delays: [4, 5] } },
    ]);
    expect(projected.nodes.w!.status).toBe('ready');
    const { commands } = e.resume(projected);
    // Item 0's delay = 4 reached `seconds`; the recovery fork passed `foreachItemOf`
    // so `${item}` resolves rather than throwing (the #569 shape).
    expect(commands).toContainEqual({
      type: 'scheduleWait',
      nodeId: 'w',
      attemptId: 'w#0',
      seconds: 4,
    });
    expect(commands.some((c) => c.type === 'finishRun')).toBe(false);
  });
});

describe('wait save-time validation (#4 A6)', () => {
  it('accepts a well-formed wait', () => {
    const d = doc([waitNode('w', '${5}')]);
    expect(validatePipelineDoc(d)).toEqual([]);
  });

  it('accepts a ${} seconds referencing an upstream output', () => {
    const d = doc(
      [node('a'), waitNode('w', '${nodes.a.output.delay}')],
      [edge('a', 'w', 'success')],
    );
    expect(validateRefs(d)).toEqual([]);
  });

  it('rejects a missing seconds', () => {
    const d = doc([waitNode('w', undefined)]);
    expect(validateDoc(d).join(' ')).toMatch(/seconds/);
  });

  it('rejects an empty seconds', () => {
    const d = doc([waitNode('w', '   ')]);
    expect(validateDoc(d).join(' ')).toMatch(/seconds/);
  });

  it('rejects a non-whole-value seconds (embedded template) → whole-value error', () => {
    // `"wait ${x}s"` can only ever resolve to a STRING, never a duration.
    const d = doc(
      [waitNode('w', 'wait ${params.n} sec')],
      [],
      [],
      [{ name: 'n', type: 'number', required: true }],
    );
    expect(validateDoc(d).join(' ')).toContain('whole-value');
  });

  it('rejects a bad ${} ref in seconds at SAVE', () => {
    const d = doc([waitNode('w', '${nodes.ghost.output.y}')]);
    expect(validateRefs(d).join(' ')).toMatch(/ghost/);
  });

  it('a branch edge off a wait is invalid (a wait declares no branches)', () => {
    const d = doc(
      [waitNode('w', '${5}'), node('after')],
      [{ id: 'w->after:branch', from: 'w', to: 'after', on: 'branch', branch: 'x' }],
    );
    expect(validateDoc(d).length).toBeGreaterThan(0);
  });
});

describe('wait catalog entry (#4 A5+A6)', () => {
  it('is a control activity with no connection and no outputs', () => {
    const entry = getActivity('wait');
    expect(entry?.kind).toBe('control');
    expect(entry?.connectionKinds).toEqual([]);
    expect(entry?.outputs).toEqual([]);
  });

  it('cataloguing the wait type bumped CATALOG_VERSION to 7', () => {
    expect(CATALOG_VERSION).toBe(7);
  });
});
