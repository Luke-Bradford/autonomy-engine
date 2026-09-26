import { describe, expect, it } from 'vitest';
import type {
  CancelSource,
  Container,
  Edge,
  EdgeOn,
  EngineCommand,
  EngineEvent,
  FailureKind,
  Node,
  OperationalEdge,
  RunState,
} from '../types.js';
import {
  EngineEventSchema,
  RunLifecycleStatusSchema,
  RunOutcomeSchema,
  TERMINAL_RUN_EVENT,
  TERMINAL_RUN_STATUS,
  terminalStatusOf,
} from '../types.js';
import { RunStatusSchema, TERMINAL_RUN_ROW_STATUS } from '../../schemas/run.js';
import type { NodePolicy } from '../../schemas/pipeline.js';
import { createEngine, UNPARK_EVENTS, type Engine, type EngineDoc } from '../reduce.js';

/**
 * CX1 (#1320) — run cancellation, the reducer + schema half. Spec:
 * `studio/docs/2026-09-26-foundation-run-cancellation.md` D1-D5. A cancel is
 * `run.cancelRequested`; from then on `settle` STARTS no work (no dispatch, no
 * child, no timer, no retry, no round), keeps the pure fixpoint (skip
 * propagation, container exits), and finishes the run once nothing is in
 * flight — `cancelled` only if the cancel actually stopped work (D3).
 */

let seq = 0;
function node(id: string, policy?: NodePolicy): Node {
  seq += 1;
  return {
    id,
    type: 'agent_task',
    config: {},
    position: { x: seq, y: 0 },
    ...(policy && { policy }),
  };
}
function waitNode(id: string): Node {
  seq += 1;
  return { id, type: 'wait', config: { seconds: 60 }, position: { x: seq, y: 0 } };
}
function callNode(id: string): Node {
  seq += 1;
  return {
    id,
    type: 'call_pipeline',
    config: {},
    call: { pipelineVersionId: 'child-pv', params: {} },
    position: { x: seq, y: 0 },
  } as Node;
}
function edge(
  from: string,
  to: string,
  on: EdgeOn,
  extra: Partial<Omit<OperationalEdge, 'on'>> = {},
): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on, ...extra };
}
function engine(nodes: Node[], edges: Edge[] = [], containers: Container[] = []): Engine {
  return createEngine({ nodes, edges, containers } satisfies EngineDoc);
}

const RUN = 'r1';
const OPERATOR: CancelSource = { kind: 'operator' };

function started(params: Record<string, unknown> = {}): EngineEvent {
  return { type: 'run.started', runId: RUN, pipelineVersionId: 'pv1', params };
}
function dispatched(nodeId: string, attemptId = `${nodeId}#0`): EngineEvent {
  return { type: 'node.dispatched', runId: RUN, nodeId, attemptId, idempotent: true };
}
function succeeded(nodeId: string, attemptId = `${nodeId}#0`): EngineEvent {
  return { type: 'node.succeeded', runId: RUN, nodeId, attemptId, outputs: {} };
}
function failed(nodeId: string, kind: FailureKind, attemptId = `${nodeId}#0`): EngineEvent {
  return { type: 'node.failed', runId: RUN, nodeId, attemptId, error: 'boom', kind };
}
function cancel(source: CancelSource = OPERATOR): EngineEvent {
  return { type: 'run.cancelRequested', runId: RUN, source };
}
function finished(outcome: 'success' | 'failure' | 'cancelled', reason?: string): EngineEvent {
  return { type: 'run.finished', runId: RUN, outcome, ...(reason !== undefined && { reason }) };
}

/** Fold `events` in order; return the last result and every command emitted. */
function fold(eng: Engine, events: EngineEvent[], from?: RunState) {
  let state = from ?? eng.seedState();
  const all: EngineCommand[] = [];
  let last: EngineCommand[] = [];
  for (const e of events) {
    const r = eng.reduce(state, e);
    state = r.state;
    last = r.commands;
    all.push(...r.commands);
  }
  return { state, last, all };
}
const finishes = (cmds: EngineCommand[]) => cmds.filter((c) => c.type === 'finishRun');
/** Commands that START work — none may appear after a cancel is folded. */
const STARTING = new Set<EngineCommand['type']>([
  'dispatchNode',
  'startChild',
  'scheduleRetry',
  'evaluateControl',
  'failNode',
  'succeedControl',
  'scheduleWait',
  'scheduleExternalWait',
  'scheduleContainerTimeout',
]);
const starting = (cmds: EngineCommand[]) => cmds.filter((c) => STARTING.has(c.type));

describe('CX1 D1 — the schemas', () => {
  it('`cancelled` is a terminal lifecycle status, a run outcome and a terminal ROW status', () => {
    expect(RunOutcomeSchema.options).toContain('cancelled');
    expect(RunLifecycleStatusSchema.options).toContain('cancelled');
    expect(RunStatusSchema.options).toContain('cancelled');
    expect(TERMINAL_RUN_STATUS.has('cancelled')).toBe(true);
    expect(TERMINAL_RUN_ROW_STATUS.has('cancelled')).toBe(true);
    expect(terminalStatusOf(finished('cancelled', 'cancelled:operator'))).toBe('cancelled');
  });

  it('`run.cancelRequested` is NOT itself a terminal event — the run finishes when its work drains', () => {
    expect(TERMINAL_RUN_EVENT.has('run.cancelRequested')).toBe(false);
    expect(terminalStatusOf(cancel())).toBeNull();
  });

  it('the source is a CLOSED machine-set union — no free-text reason, no unknown kind', () => {
    expect(EngineEventSchema.safeParse(cancel()).success).toBe(true);
    expect(
      EngineEventSchema.safeParse(cancel({ kind: 'parent_terminal', parentRunId: 'p1' })).success,
    ).toBe(true);
    const unknownKind = { type: 'run.cancelRequested', runId: RUN, source: { kind: 'whim' } };
    expect(EngineEventSchema.safeParse(unknownKind).success).toBe(false);
    const parentless = {
      type: 'run.cancelRequested',
      runId: RUN,
      source: { kind: 'parent_cancelled' },
    };
    expect(EngineEventSchema.safeParse(parentless).success).toBe(false);
    const withText = {
      type: 'run.cancelRequested',
      runId: RUN,
      source: { kind: 'operator' },
      reason: '<img src=x onerror=alert(1)>',
    };
    const parsed = EngineEventSchema.safeParse(withText);
    // Zod strips unknown keys: the text never reaches the log's parsed shape.
    expect(parsed.success && 'reason' in parsed.data).toBe(false);
  });

  it('the seed carries `cancelRequested: null`, never absent', () => {
    const eng = engine([node('a')]);
    expect(eng.seedState().cancelRequested).toBeNull();
    expect(fold(eng, [started()]).state.cancelRequested).toBeNull();
  });
});

describe('CX1 D2/D3 — in-flight work drains, then the run finishes', () => {
  it('an aborted in-flight node finishes the run `cancelled`, and its failure edge never runs', () => {
    const eng = engine([node('a'), node('h')], [edge('a', 'h', 'failure')]);
    const atCancel = fold(eng, [started(), dispatched('a'), cancel()]);
    expect(atCancel.last).toEqual([]); // `a` is still in flight
    expect(atCancel.state.status).toBe('running');
    expect(atCancel.state.cancelRequested).toEqual({ source: OPERATOR, stoppedWork: false });

    const r = eng.reduce(atCancel.state, failed('a', 'cancelled'));
    expect(starting(r.commands)).toEqual([]);
    expect(r.commands).toEqual([
      { type: 'finishRun', outcome: 'cancelled', reason: 'cancelled:operator' },
    ]);
    expect(r.state.nodes.h!.status).toBe('pending');
  });

  it('D3 race: the last in-flight node SUCCEEDS after the cancel → the run really completed, `success`', () => {
    const eng = engine([node('a')]);
    const r = fold(eng, [started(), dispatched('a'), cancel(), succeeded('a')]);
    expect(r.last).toEqual([{ type: 'finishRun', outcome: 'success' }]);
  });

  it('D3: a success after the cancel keeps its success, but its successors never start → `cancelled`', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const r = fold(eng, [started(), dispatched('a'), cancel(), succeeded('a')]);
    expect(r.state.nodes.a!.status).toBe('success');
    expect(r.state.nodes.b!.status).toBe('pending');
    expect(starting(r.all.slice(1))).toEqual([]);
    expect(finishes(r.last)).toEqual([
      { type: 'finishRun', outcome: 'cancelled', reason: 'cancelled:operator' },
    ]);
  });

  it('D3: a non-cancel failure after the cancel, with nothing prevented, reports the pipeline outcome', () => {
    const eng = engine([node('a')]);
    const r = fold(eng, [started(), dispatched('a'), cancel(), failed('a', 'permanent')]);
    expect(r.last).toEqual([{ type: 'finishRun', outcome: 'failure', reason: 'node_failed:a' }]);
  });

  it('the run waits for EVERY in-flight node before finishing — exactly one finish', () => {
    // Explicit edges: an edgeless doc gets an implicit chain, which would make
    // `b` a successor of `a` rather than its parallel sibling.
    const eng = engine(
      [node('a'), node('b'), node('c')],
      [edge('a', 'c', 'success'), edge('b', 'c', 'success')],
    );
    const s = fold(eng, [started(), dispatched('a'), dispatched('b'), cancel()]);
    const one = eng.reduce(s.state, failed('a', 'cancelled'));
    expect(one.commands).toEqual([]);
    const two = eng.reduce(one.state, failed('b', 'cancelled'));
    expect(finishes(two.commands)).toHaveLength(1);
    expect(two.commands[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it('skip propagation still runs under cancel — a failure-only target of a success is `skipped`, not left pending', () => {
    const eng = engine(
      [node('a'), node('b'), node('h')],
      [edge('a', 'b', 'success'), edge('a', 'h', 'failure')],
    );
    const r = fold(eng, [started(), dispatched('a'), cancel(), succeeded('a')]);
    expect(r.state.nodes.h!.status).toBe('skipped');
    expect(r.state.nodes.b!.status).toBe('pending');
  });

  it('the fold is total over replay: projecting the log equals the incremental fold', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const events = [
      started(),
      dispatched('a'),
      cancel(),
      succeeded('a'),
      finished('cancelled', 'cancelled:operator'),
    ];
    const inc = fold(eng, events).state;
    expect(inc.status).toBe('cancelled');
    expect(eng.projectRunState(events)).toEqual(inc);
  });
});

describe('CX1 D4 — retry holds', () => {
  it('a `retry_pending` hold folds to failure at the cancel, and the run finishes `cancelled` at once', () => {
    const eng = engine([node('a', { retry: 2 })]);
    const held = fold(eng, [started(), dispatched('a'), failed('a', 'transient')]);
    expect(held.state.nodes.a!.status).toBe('retry_pending');
    const r = eng.reduce(held.state, cancel());
    expect(r.state.nodes.a!.status).toBe('failure');
    expect(r.state.nodes.a!.currentAttemptId).toBeUndefined();
    expect(r.commands).toEqual([
      { type: 'finishRun', outcome: 'cancelled', reason: 'cancelled:operator' },
    ]);
    // The alarm, arriving later, finds nothing to retry.
    const due = eng.reduce(r.state, {
      type: 'node.retryDue',
      runId: RUN,
      nodeId: 'a',
      previousAttemptId: 'a#0',
    });
    expect(starting(due.commands)).toEqual([]);
  });

  it('a TRANSIENT failure after the cancel schedules no retry — the retry it would have run is prevented', () => {
    const eng = engine([node('a', { retry: 2 })]);
    const r = fold(eng, [started(), dispatched('a'), cancel(), failed('a', 'transient')]);
    expect(starting(r.last)).toEqual([]);
    expect(r.state.nodes.a!.status).toBe('failure');
    expect(r.last).toEqual([
      { type: 'finishRun', outcome: 'cancelled', reason: 'cancelled:operator' },
    ]);
  });

  it('a `node.retryRequested` under cancel folds the node to failure instead of re-dispatching it', () => {
    const eng = engine([node('a')]);
    const s = fold(eng, [started(), dispatched('a'), cancel()]);
    const r = eng.reduce(s.state, {
      type: 'node.retryRequested',
      runId: RUN,
      nodeId: 'a',
      previousAttemptId: 'a#0',
    });
    expect(starting(r.commands)).toEqual([]);
    expect(r.state.nodes.a!.status).toBe('failure');
    expect(finishes(r.commands)).toEqual([
      { type: 'finishRun', outcome: 'cancelled', reason: 'cancelled:operator' },
    ]);
  });
});

describe('CX1 D4 — containers and back-edges start no new round', () => {
  it('a loop mid-round does not re-round: the container stays active and the run finishes `cancelled`', () => {
    const eng = engine(
      [node('w')],
      [],
      [{ id: 'L', kind: 'loop', exitWhen: '${false}', maxRounds: 5, children: ['w'] }],
    );
    const r = fold(eng, [started(), dispatched('w'), cancel(), succeeded('w')]);
    expect(r.state.containers.L!.status).toBe('active');
    expect(r.state.containers.L!.round).toBe(0);
    expect(starting(r.last)).toEqual([]);
    expect(finishes(r.last)).toEqual([
      { type: 'finishRun', outcome: 'cancelled', reason: 'cancelled:operator' },
    ]);
  });

  it('a loop whose round EXITS after the cancel still exits — the pure fixpoint is not suppressed', () => {
    const eng = engine(
      [node('w')],
      [],
      [{ id: 'L', kind: 'loop', exitWhen: '${true}', children: ['w'] }],
    );
    const r = fold(eng, [started(), dispatched('w'), cancel(), succeeded('w')]);
    expect(r.state.containers.L!.status).toBe('success');
    expect(r.last).toEqual([{ type: 'finishRun', outcome: 'success' }]);
  });

  it('a sequential foreach starts no next item', () => {
    const eng = engine(
      [node('w')],
      [],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${params.list}' }],
    );
    const r = fold(eng, [
      started({ list: [1, 2, 3] }),
      dispatched('w'),
      cancel(),
      succeeded('w'),
    ]);
    expect(r.state.containers.fe!.round).toBe(0);
    expect(r.state.containers.fe!.status).toBe('active');
    expect(starting(r.last)).toEqual([]);
    expect(finishes(r.last)).toHaveLength(1);
    expect(r.last[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it('a parallel foreach starts no new item once cancelled', () => {
    const eng = engine(
      [node('w')],
      [],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${params.list}', batchCount: 2 }],
    );
    const r = fold(eng, [
      started({ list: [1, 2, 3] }),
      dispatched('w@0', 'w@0#0'),
      dispatched('w@1', 'w@1#0'),
      cancel(),
      succeeded('w@0', 'w@0#0'),
    ]);
    // Item 0's slot freed, but item 2 never starts; item 1 still drains.
    expect(r.state.containers.fe!.nextItem).toBe(2);
    expect(r.last).toEqual([]); // no dispatch for item 2, and item 1 still in flight
    const last = eng.reduce(r.state, succeeded('w@1', 'w@1#0'));
    expect(last.commands).toEqual([
      { type: 'finishRun', outcome: 'cancelled', reason: 'cancelled:operator' },
    ]);
  });

  it('a container that never became ready is not entered — no loop timeout is armed', () => {
    const eng = engine(
      [node('a'), node('w')],
      [edge('a', 'L', 'success')],
      [{ id: 'L', kind: 'loop', exitWhen: '${true}', timeout: 60, children: ['w'] }],
    );
    const r = fold(eng, [started(), dispatched('a'), cancel(), succeeded('a')]);
    expect(r.state.containers.L!.status).toBe('pending');
    expect(starting(r.last)).toEqual([]);
    expect(r.last[0]).toMatchObject({ type: 'finishRun', outcome: 'cancelled' });
  });

  it('a back-edge bounce is suppressed, persists nothing, and the prevented round reports `cancelled`', () => {
    const eng = engine(
      [node('a'), node('b')],
      [edge('a', 'b', 'success'), edge('b', 'a', 'success', { back: true, maxBounces: 3 })],
    );
    const s = fold(eng, [started(), dispatched('a'), succeeded('a'), dispatched('b'), cancel()]);
    const r = eng.reduce(s.state, succeeded('b'));
    expect(r.state.bounces).toEqual({});
    expect(r.state.nodes.a!.status).toBe('success');
    expect(starting(r.commands)).toEqual([]);
    expect(r.commands).toEqual([
      { type: 'finishRun', outcome: 'cancelled', reason: 'cancelled:operator' },
    ]);
  });
});

describe('CX1 D5 — legality', () => {
  it('a PENDING run (seeded, never started) finishes `cancelled` with no `run.started`', () => {
    const eng = engine([node('a')]);
    const seeded = fold(eng, [
      { type: 'run.triggerContext', runId: RUN, triggerId: 't1' } as EngineEvent,
    ]);
    const r = eng.reduce(seeded.state, cancel());
    expect(r.state.status).toBe('pending');
    expect(r.commands).toEqual([
      { type: 'finishRun', outcome: 'cancelled', reason: 'cancelled:operator' },
    ]);
    const done = eng.reduce(r.state, finished('cancelled', 'cancelled:operator'));
    expect(done.state.status).toBe('cancelled');
  });

  it('a pending run with an EMPTY log (no seed yet) adopts the cancel’s runId', () => {
    const eng = engine([node('a')]);
    const r = eng.reduce(eng.seedState(), cancel());
    expect(r.state.runId).toBe(RUN);
    expect(r.commands).toHaveLength(1);
  });

  it('a pending run never accepts a `run.finished{cancelled}` it did not ask for', () => {
    const eng = engine([node('a')]);
    const seeded = fold(eng, [
      { type: 'run.triggerContext', runId: RUN, triggerId: 't1' } as EngineEvent,
    ]);
    expect(eng.reduce(seeded.state, finished('cancelled')).state.status).toBe('pending');
  });

  it('a `run.started` after a pending cancel carries it, and the run finishes `cancelled` without dispatching', () => {
    const eng = engine([node('a')]);
    const r = fold(eng, [cancel(), started()]);
    expect(r.state.cancelRequested).toEqual({ source: OPERATOR, stoppedWork: false });
    expect(starting(r.last)).toEqual([]);
    expect(r.last).toEqual([
      { type: 'finishRun', outcome: 'cancelled', reason: 'cancelled:operator' },
    ]);
  });

  it('a WAITING run unparks and finishes `cancelled` in the same fold', () => {
    expect(UNPARK_EVENTS.has('run.cancelRequested')).toBe(true);
    const eng = engine([waitNode('w')]);
    const s = fold(eng, [
      started(),
      { type: 'timer.waitScheduled', runId: RUN, nodeId: 'w', attemptId: 'w#0', dueAt: 1 },
      { type: 'run.waiting', runId: RUN, reason: 'waiting_timer' },
    ]);
    expect(s.state.status).toBe('waiting');
    const r = eng.reduce(s.state, cancel());
    expect(r.state.status).toBe('running');
    expect(r.commands).toEqual([
      { type: 'finishRun', outcome: 'cancelled', reason: 'cancelled:operator' },
    ]);
  });

  it('a duplicate cancel is ignored — no second finish, and the FIRST source stands', () => {
    const eng = engine([node('a')]);
    const s = fold(eng, [started(), dispatched('a'), cancel()]);
    const dup = eng.reduce(s.state, cancel({ kind: 'parent_terminal', parentRunId: 'p' }));
    expect(dup.commands).toEqual([]);
    expect(dup.state).toEqual(s.state);
  });

  it('a cancel on a terminal run is ignored', () => {
    const eng = engine([node('a')]);
    const s = fold(eng, [started(), dispatched('a'), succeeded('a'), finished('success')]);
    const r = eng.reduce(s.state, cancel());
    expect(r.state).toEqual(s.state);
    expect(r.commands).toEqual([]);
  });

  it('a `run.finished{cancelled}` on a running run that was never cancelled is impossible', () => {
    const eng = engine([node('a')]);
    const s = fold(eng, [started(), dispatched('a')]);
    const r = eng.reduce(s.state, finished('cancelled'));
    expect(r.state.status).toBe('running');
    expect(r.commands).toEqual([{ type: 'finishRun', outcome: 'failure', reason: 'invalid_event' }]);
  });
});

describe('CX1 — resume and children under a cancel', () => {
  it('resume under cancel re-derives no lost dispatch: a `ready` node is prevented work', () => {
    const eng = engine([node('a')]);
    // `a` is `ready` (its dispatchNode was emitted) when the cancel folds; the
    // process then dies before the command is accepted.
    const s = fold(eng, [started(), cancel()]);
    expect(s.state.nodes.a!.status).toBe('ready');
    const r = eng.resume(s.state);
    expect(starting(r.commands)).toEqual([]);
    expect(r.state.nodes.a!.status).toBe('failure');
    expect(r.commands).toEqual([
      { type: 'finishRun', outcome: 'cancelled', reason: 'cancelled:operator' },
    ]);
  });

  it('a `call.returned{cancelled}` fails the call node (a child cancelled directly)', () => {
    const eng = engine([callNode('c')]);
    const s = fold(eng, [started()]);
    const start = eng.reduce(eng.seedState(), started()).commands[0]!;
    expect(start.type).toBe('startChild');
    const childRunId = start.type === 'startChild' ? start.childRunId : '';
    const r = eng.reduce(s.state, {
      type: 'call.returned',
      runId: RUN,
      callNodeId: 'c',
      attemptId: 'c#0',
      childRunId,
      childOutcome: 'cancelled',
      outputs: {},
    });
    expect(r.state.nodes.c!.status).toBe('failure');
    expect(r.commands).toEqual([{ type: 'finishRun', outcome: 'failure', reason: 'node_failed:c' }]);
  });
});
