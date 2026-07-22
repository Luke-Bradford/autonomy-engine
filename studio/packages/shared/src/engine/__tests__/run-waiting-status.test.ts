import { describe, expect, it } from 'vitest';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import {
  RunLifecycleStatusSchema,
  RunStateSchema,
  WaitingReasonSchema,
  type EngineEvent,
  type WaitingReason,
} from '../types.js';

/**
 * #5 S3 — the run-lifecycle `waiting` sub-state + the `run.waiting` durable
 * event. The status MODEL slice (fold is FORWARD-ONLY running → waiting) shipped
 * first; #619 wired the PRODUCER (`settle` emits `parkRun` → the driver appends
 * `run.waiting` when a run parks) and the REVERSE EDGE (waiting → running on the
 * resolving event's own fold). This file covers the MODEL + the reducer half of
 * the producer/reverse-edge (the `parkRun` command + the un-park). The end-to-end
 * park→row=waiting→alarm→resume is covered server-side (`scheduler/__tests__`).
 */

const RUN = 'r1';
const PV = 'pv1';

function engine(): Engine {
  return createEngine({
    nodes: [{ id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } }],
    edges: [],
  } satisfies EngineDoc);
}
function started(): EngineEvent {
  return { type: 'run.started', runId: RUN, pipelineVersionId: PV, params: {} };
}
function waiting(reason: WaitingReason): EngineEvent {
  return { type: 'run.waiting', runId: RUN, reason };
}

describe('#5 S3 — run-lifecycle status model', () => {
  it('`waiting` is a member of the lifecycle vocabulary, non-terminal', () => {
    expect(RunLifecycleStatusSchema.options).toContain('waiting');
    // Terminal set is {success, failure, interrupted}; `waiting` is not one.
    expect(['success', 'failure', 'interrupted']).not.toContain('waiting');
  });

  it('`WaitingReasonSchema` is exactly the four run-park reasons', () => {
    expect([...WaitingReasonSchema.options].sort()).toEqual([
      'waiting_concurrency',
      'waiting_dependency',
      'waiting_external',
      'waiting_timer',
    ]);
  });

  it('the seed and a freshly-started run carry `waitingReason: null`', () => {
    const eng = engine();
    expect(eng.seedState().waitingReason).toBeNull();
    const s = eng.reduce(eng.seedState(), started()).state;
    expect(s.status).toBe('running');
    expect(s.waitingReason).toBeNull();
  });

  it('folds `run.waiting` on a running run → status `waiting` + the reason', () => {
    const eng = engine();
    const running = eng.reduce(eng.seedState(), started()).state;
    for (const reason of WaitingReasonSchema.options) {
      const r = eng.reduce(running, waiting(reason));
      expect(r.state.status).toBe('waiting');
      expect(r.state.waitingReason).toBe(reason);
      // FORWARD-ONLY: no command, no clock — the run just stops advancing.
      expect(r.commands).toEqual([]);
    }
  });

  it('the fold is forward-only: it touches only status + waitingReason, nothing else', () => {
    const eng = engine();
    const running = eng.reduce(eng.seedState(), started()).state;
    const parked = eng.reduce(running, waiting('waiting_external')).state;
    // Every other field is carried through untouched.
    expect({ ...parked, status: running.status, waitingReason: running.waitingReason }).toEqual(
      running,
    );
  });

  it('a projection over [started, waiting] is deterministic on replay', () => {
    const eng = engine();
    const log: EngineEvent[] = [started(), waiting('waiting_timer')];
    const a = eng.projectRunState(log);
    const b = eng.projectRunState(log);
    expect(a).toEqual(b);
    expect(a.status).toBe('waiting');
    expect(a.waitingReason).toBe('waiting_timer');
    // And the projection is a valid RunState (waitingReason is a real field).
    expect(RunStateSchema.parse(a).status).toBe('waiting');
  });

  it('`run.waiting` before `run.started` is ignored — a park has no meaning pre-run', () => {
    const eng = engine();
    const r = eng.reduce(eng.seedState(), waiting('waiting_external'));
    expect(r.state.status).toBe('pending');
    expect(r.state.waitingReason).toBeNull();
  });

  it('a second `run.waiting` on an already-waiting run is ignored (status guard)', () => {
    const eng = engine();
    const running = eng.reduce(eng.seedState(), started()).state;
    const parked = eng.reduce(running, waiting('waiting_external')).state;
    const again = eng.reduce(parked, waiting('waiting_timer'));
    // The reducer only advances a `running` run; a `waiting` run ignores it, so
    // the first reason stands (no silent reason-flip without a producer).
    expect(again.state.status).toBe('waiting');
    expect(again.state.waitingReason).toBe('waiting_external');
  });

  it('a foreign run’s `run.waiting` cannot park this run', () => {
    const eng = engine();
    const running = eng.reduce(eng.seedState(), started()).state;
    const r = eng.reduce(running, { type: 'run.waiting', runId: 'other', reason: 'waiting_timer' });
    expect(r.state.status).toBe('running');
    expect(r.state.waitingReason).toBeNull();
  });
});

// --- #619 — the PRODUCER + REVERSE EDGE (reducer half) --------------------------

const wait = (id: string, seconds: unknown = '${5}') => ({
  id,
  type: 'wait',
  config: { seconds },
  position: { x: 0, y: 0 },
});
const webhook = (id: string, timeoutSeconds: unknown = '${30}') => ({
  id,
  type: 'webhook',
  config: { timeoutSeconds },
  position: { x: 0, y: 0 },
});
const task = (id: string) => ({ id, type: 'agent_task', config: {}, position: { x: 0, y: 0 } });
const fork = (from: string, to: string) => ({
  id: `${from}->${to}`,
  from,
  to,
  on: 'success' as const,
});
const succeed = (nodeId: string, attemptId: string): EngineEvent => ({
  type: 'node.succeeded',
  runId: RUN,
  nodeId,
  attemptId,
  outputs: {},
});
const waitScheduled = (nodeId: string, attemptId: string): EngineEvent => ({
  type: 'timer.waitScheduled',
  runId: RUN,
  nodeId,
  attemptId,
  dueAt: 1,
});
const extCreated = (nodeId: string, attemptId: string): EngineEvent => ({
  type: 'externalWait.created',
  runId: RUN,
  nodeId,
  attemptId,
  dueAt: 1,
});

describe('#5 S3 (#619) — the run.waiting PRODUCER (settle → parkRun)', () => {
  it('a run whose SOLE live node parks (wait) emits parkRun{waiting_timer}', () => {
    const eng = createEngine({ nodes: [wait('w')], edges: [] } satisfies EngineDoc);
    const started0 = eng.reduce(eng.seedState(), started());
    // The wait resolves + holds `ready`, and the driver is told to arm the alarm.
    expect(started0.commands).toContainEqual({
      type: 'scheduleWait',
      nodeId: 'w',
      attemptId: 'w#0',
      seconds: 5,
    });
    // Folding the arm parks the node — and NOW settle detects the run is fully
    // parked and emits the producer command.
    const parked = eng.reduce(started0.state, waitScheduled('w', 'w#0'));
    expect(parked.state.nodes.w!.status).toBe('wait_pending');
    expect(parked.commands).toEqual([{ type: 'parkRun', reason: 'waiting_timer' }]);
    // The reducer does NOT itself flip status — that is the driver's run.waiting fold.
    expect(parked.state.status).toBe('running');
  });

  it('a run whose sole live node parks (webhook) emits parkRun{waiting_external}', () => {
    const eng = createEngine({ nodes: [webhook('w')], edges: [] } satisfies EngineDoc);
    const started0 = eng.reduce(eng.seedState(), started());
    const parked = eng.reduce(started0.state, extCreated('w', 'w#0'));
    expect(parked.state.nodes.w!.status).toBe('external_wait_pending');
    expect(parked.commands).toEqual([{ type: 'parkRun', reason: 'waiting_external' }]);
  });

  it('a parallel wait + webhook parks once, reason `waiting_external` (external tie-break)', () => {
    // A FORK: root `r` fans out to a wait `t` and a webhook `h`, so both go live
    // simultaneously (a valid multi-branch graph, unlike two disconnected roots).
    const eng = createEngine({
      nodes: [task('r'), wait('t'), webhook('h')],
      edges: [fork('r', 't'), fork('r', 'h')],
    } satisfies EngineDoc);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, {
      type: 'node.dispatched',
      runId: RUN,
      nodeId: 'r',
      attemptId: 'r#0',
      idempotent: true,
    }).state;
    s = eng.reduce(s, succeed('r', 'r#0')).state; // t, h now both ready
    expect(s.nodes.t!.status).toBe('ready');
    expect(s.nodes.h!.status).toBe('ready');
    // First park (the wait) — the webhook is still `ready`, so NOT fully parked yet.
    const afterWait = eng.reduce(s, waitScheduled('t', 't#0'));
    expect(afterWait.commands).toEqual([]);
    expect(afterWait.state.nodes.h!.status).toBe('ready');
    // Second park (the webhook) — now both are parked → one parkRun, external wins.
    const afterHook = eng.reduce(afterWait.state, extCreated('h', 'h#0'));
    expect(afterHook.commands).toEqual([{ type: 'parkRun', reason: 'waiting_external' }]);
  });

  it('does NOT park while a sibling activity is still in flight (dispatched)', () => {
    // Fork: root `r` → a wait `w` and a task `a`.
    const eng = createEngine({
      nodes: [task('r'), wait('w'), task('a')],
      edges: [fork('r', 'w'), fork('r', 'a')],
    } satisfies EngineDoc);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, {
      type: 'node.dispatched',
      runId: RUN,
      nodeId: 'r',
      attemptId: 'r#0',
      idempotent: true,
    }).state;
    const forked = eng.reduce(s, succeed('r', 'r#0'));
    // `a` dispatches (a real activity), the wait `w` holds ready for its arm.
    expect(forked.commands.some((c) => c.type === 'dispatchNode' && c.nodeId === 'a')).toBe(true);
    s = eng.reduce(forked.state, {
      type: 'node.dispatched',
      runId: RUN,
      nodeId: 'a',
      attemptId: 'a#0',
      idempotent: true,
    }).state;
    // The wait parks — but `a` is `dispatched`, so the run is NOT parked → no parkRun.
    const afterWait = eng.reduce(s, waitScheduled('w', 'w#0'));
    expect(afterWait.state.nodes.a!.status).toBe('dispatched');
    expect(afterWait.commands).toEqual([]);
    // Once `a` completes with the wait still parked, THEN the run parks.
    const done = eng.reduce(afterWait.state, succeed('a', 'a#0'));
    expect(done.commands).toEqual([{ type: 'parkRun', reason: 'waiting_timer' }]);
  });
});

describe('#5 S3 (#619) — the REVERSE EDGE (waiting → running on resume)', () => {
  it('timer.due on a `waiting` run un-parks it (F1 regression: the guard must admit it)', () => {
    const eng = createEngine({ nodes: [wait('w')], edges: [] } satisfies EngineDoc);
    // Park for real: started → arm → run.waiting (the producer, applied by the driver).
    const s = eng.projectRunState([started(), waitScheduled('w', 'w#0'), waiting('waiting_timer')]);
    expect(s.status).toBe('waiting');
    expect(s.nodes.w!.status).toBe('wait_pending');
    // The alarm fires. WITHOUT the top-level admittance this event would be ignored
    // and the run would hang `waiting` forever.
    const resumed = eng.reduce(s, {
      type: 'timer.due',
      runId: RUN,
      nodeId: 'w',
      previousAttemptId: 'w#0',
    });
    expect(resumed.state.nodes.w!.status).toBe('success');
    // Single node → the run finishes; the intermediate un-park to running happened.
    expect(resumed.commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });

  it('a STALE timer.due (wrong attempt) on a `waiting` run does NOT un-park it', () => {
    // The load-bearing reason the un-park lives in the HANDLERS (behind the attempt
    // guard), not at the top-level admittance: an at-least-once redelivery for an
    // attempt the node has moved past must NOT resume the run. The guard admits the
    // event to `onWaitDue`, whose attempt check no-ops it — leaving the run
    // correctly `waiting`, NOT stranded `running` with nothing to re-park it.
    const eng = createEngine({ nodes: [wait('w')], edges: [] } satisfies EngineDoc);
    const s = eng.projectRunState([started(), waitScheduled('w', 'w#0'), waiting('waiting_timer')]);
    expect(s.status).toBe('waiting');
    const stale = eng.reduce(s, {
      type: 'timer.due',
      runId: RUN,
      nodeId: 'w',
      previousAttemptId: 'w#999',
    });
    expect(stale.state.nodes.w!.status).toBe('wait_pending');
    expect(stale.state.status).toBe('waiting');
    expect(stale.state.waitingReason).toBe('waiting_timer');
    expect(stale.commands).toEqual([]);
  });

  it('externalWait.completed on a `waiting` run un-parks + resolves it', () => {
    const eng = createEngine({ nodes: [webhook('w')], edges: [] } satisfies EngineDoc);
    const s = eng.projectRunState([started(), extCreated('w', 'w#0'), waiting('waiting_external')]);
    expect(s.status).toBe('waiting');
    const done = eng.reduce(s, {
      type: 'externalWait.completed',
      runId: RUN,
      nodeId: 'w',
      previousAttemptId: 'w#0',
    });
    expect(done.state.nodes.w!.status).toBe('success');
    expect(done.commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });

  it('externalWait.expired on a `waiting` run un-parks then fails it', () => {
    const eng = createEngine({ nodes: [webhook('w')], edges: [] } satisfies EngineDoc);
    const s = eng.projectRunState([started(), extCreated('w', 'w#0'), waiting('waiting_external')]);
    const done = eng.reduce(s, {
      type: 'externalWait.expired',
      runId: RUN,
      nodeId: 'w',
      previousAttemptId: 'w#0',
    });
    expect(done.state.nodes.w!.status).toBe('failure');
    expect(done.commands).toContainEqual({
      type: 'finishRun',
      outcome: 'failure',
      reason: 'node_failed:w',
    });
  });

  it('run.resumed un-parks a `waiting` run (matches deriveRunLifecycle)', () => {
    const eng = createEngine({ nodes: [wait('w')], edges: [] } satisfies EngineDoc);
    const s = eng.projectRunState([started(), waitScheduled('w', 'w#0'), waiting('waiting_timer')]);
    expect(s.status).toBe('waiting');
    const r = eng.reduce(s, { type: 'run.resumed', runId: RUN, reason: 'boot_reconcile' });
    // The parked wait re-parks (its alarm is durable), so the run returns to
    // `waiting` via a fresh parkRun — but it PASSED THROUGH running (un-parked).
    expect(r.commands).toEqual([{ type: 'parkRun', reason: 'waiting_timer' }]);
  });

  it('a two-wait run un-parks, resolves one, and re-parks on the other', () => {
    // Fork root `r` → two parallel waits `a`, `b`.
    const eng = createEngine({
      nodes: [task('r'), wait('a'), wait('b')],
      edges: [fork('r', 'a'), fork('r', 'b')],
    } satisfies EngineDoc);
    // Both parked (row=waiting after the second parkRun the driver appended).
    const s = eng.projectRunState([
      started(),
      { type: 'node.dispatched', runId: RUN, nodeId: 'r', attemptId: 'r#0', idempotent: true },
      succeed('r', 'r#0'),
      waitScheduled('a', 'a#0'),
      waitScheduled('b', 'b#0'),
      waiting('waiting_timer'),
    ]);
    expect(s.status).toBe('waiting');
    expect(s.nodes.b!.status).toBe('wait_pending');
    // Alarm A fires → un-park, A succeeds, but B is still parked → re-park.
    const afterA = eng.reduce(s, {
      type: 'timer.due',
      runId: RUN,
      nodeId: 'a',
      previousAttemptId: 'a#0',
    });
    expect(afterA.state.nodes.a!.status).toBe('success');
    expect(afterA.state.nodes.b!.status).toBe('wait_pending');
    expect(afterA.commands).toEqual([{ type: 'parkRun', reason: 'waiting_timer' }]);
  });

  it('replay of [started, fork, arms, run.waiting, timer.due, run.waiting] is deterministic', () => {
    const eng = createEngine({
      nodes: [task('r'), wait('a'), wait('b')],
      edges: [fork('r', 'a'), fork('r', 'b')],
    } satisfies EngineDoc);
    const log: EngineEvent[] = [
      started(),
      { type: 'node.dispatched', runId: RUN, nodeId: 'r', attemptId: 'r#0', idempotent: true },
      succeed('r', 'r#0'),
      waitScheduled('a', 'a#0'),
      waitScheduled('b', 'b#0'),
      waiting('waiting_timer'),
      { type: 'timer.due', runId: RUN, nodeId: 'a', previousAttemptId: 'a#0' },
      waiting('waiting_timer'), // the driver re-parked after A resolved, B still parked
    ];
    const a = eng.projectRunState(log);
    const b = eng.projectRunState(log);
    expect(a).toEqual(b);
    expect(a.status).toBe('waiting');
    expect(a.nodes.a!.status).toBe('success');
    expect(a.nodes.b!.status).toBe('wait_pending');
  });
});
