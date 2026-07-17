import { describe, expect, it } from 'vitest';
import type {
  Container,
  Edge,
  EdgeOn,
  EngineCommand,
  EngineEvent,
  FailureKind,
  Node,
  OperationalEdge,
} from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { driveRun, simpleResolve } from './helpers/run-driver.js';

// --- helpers ---------------------------------------------------------------

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}, extra: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 }, ...extra };
}

function callNode(
  id: string,
  pipelineVersionId: string,
  params: Record<string, unknown> = {},
): Node {
  return node(id, {}, { type: 'call_pipeline', call: { pipelineVersionId, params } });
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
const PV = 'pv1';

function started(params: Record<string, unknown> = {}): EngineEvent {
  return { type: 'run.started', runId: RUN, pipelineVersionId: PV, params };
}
function dispatched(nodeId: string, attemptId: string): EngineEvent {
  return { type: 'node.dispatched', runId: RUN, nodeId, attemptId, idempotent: true };
}
function succeeded(
  nodeId: string,
  attemptId: string,
  outputs: Record<string, unknown> = {},
): EngineEvent {
  return { type: 'node.succeeded', runId: RUN, nodeId, attemptId, outputs };
}
/** `kind` (#1 F0) defaults to `permanent` — the pre-F0 parse default, so these
 *  container/walk cases assert unchanged behaviour. */
function failed(
  nodeId: string,
  attemptId: string,
  error = 'boom',
  kind: FailureKind = 'permanent',
): EngineEvent {
  return { type: 'node.failed', runId: RUN, nodeId, attemptId, error, kind };
}
function returned(
  callNodeId: string,
  attemptId: string,
  childOutcome: 'success' | 'failure',
  outputs: Record<string, unknown> = {},
  childRunId = 'child_x',
): EngineEvent {
  return {
    type: 'call.returned',
    runId: RUN,
    callNodeId,
    attemptId,
    childRunId,
    childOutcome,
    outputs,
  };
}

/**
 * A driver that folds each command's resulting event, where a node's outcome is
 * decided by `outcomeFor(nodeId, attemptIndex)` (so loops can vary a check node
 * across rounds) and a call node's child result by `childFor(nodeId, idx)`.
 */
interface DriveOpts {
  outcomeFor?: (
    nodeId: string,
    idx: number,
  ) => { outcome: 'success' | 'failure'; outputs?: Record<string, unknown> };
  childFor?: (
    nodeId: string,
    idx: number,
  ) => { childOutcome: 'success' | 'failure'; outputs?: Record<string, unknown> };
}
function drive(eng: Engine, params: Record<string, unknown>, opts: DriveOpts = {}) {
  let state = eng.seedState();
  const log: EngineEvent[] = [];
  const commandsSeen: EngineCommand[] = [];
  const pending: EngineCommand[] = [];
  const attempts: Record<string, number> = {};
  const apply = (ev: EngineEvent) => {
    const r = eng.reduce(state, ev);
    state = r.state;
    log.push(ev);
    for (const c of r.commands) {
      pending.push(c);
      commandsSeen.push(c);
    }
  };
  apply(started(params));
  let guard = 0;
  while (pending.length) {
    if (guard++ > 5000) throw new Error('driver did not converge');
    const c = pending.shift()!;
    if (c.type === 'finishRun') {
      apply({ type: 'run.finished', runId: RUN, outcome: c.outcome, reason: c.reason });
      continue;
    }
    if (c.type === 'scheduleRetry') {
      // Unreachable in this file: F2b only emits `scheduleRetry` for a node whose
      // `policy.retry` gives it budget, and no doc here declares a policy. This
      // driver has no clock, so serving it would mean inventing retry timing —
      // fail loud instead of silently dropping a command (the same rule
      // `reconcile.ts`'s `refuseToExecute` follows). F2b's own retry tests drive
      // the real path.
      throw new Error(
        `p2c drive: unexpected scheduleRetry for '${c.nodeId}' — no doc here retries`,
      );
    }
    if (c.type === 'startChild') {
      const idx = attempts[c.callNodeId] ?? 0;
      attempts[c.callNodeId] = idx + 1;
      const res = opts.childFor?.(c.callNodeId, idx) ?? { childOutcome: 'success' as const };
      apply(returned(c.callNodeId, c.attemptId, res.childOutcome, res.outputs ?? {}, c.childRunId));
      continue;
    }
    if (c.type === 'scheduleContainerTimeout') {
      // #4 A17 — this clockless harness simulates the driver's `armContainerTimeout`:
      // append `container.timeoutScheduled` (stamping the loop's `timeoutDueAt`
      // marker) but do NOT fire the timeout — a loop timing out is driven separately
      // by applying `container.timedOut` directly. A synthetic deterministic `dueAt`
      // keeps the replay stable (no real clock in this harness).
      apply({
        type: 'container.timeoutScheduled',
        runId: RUN,
        containerId: c.containerId,
        dueAt: 1_700_000_000_000 + c.seconds * 1000,
      });
      continue;
    }
    apply(dispatched(c.nodeId, c.attemptId));
    const idx = attempts[c.nodeId] ?? 0;
    attempts[c.nodeId] = idx + 1;
    const res = opts.outcomeFor?.(c.nodeId, idx) ?? { outcome: 'success' as const };
    apply(
      res.outcome === 'success'
        ? succeeded(c.nodeId, c.attemptId, res.outputs ?? {})
        : failed(c.nodeId, c.attemptId),
    );
  }
  return { state, log, commandsSeen };
}

function reasonsOf(log: EngineEvent[]): (string | undefined)[] {
  return log.filter((e) => e.type === 'run.finished').map((e) => (e as { reason?: string }).reason);
}

// ===========================================================================
// Back-edges
// ===========================================================================

describe('back-edges', () => {
  it('a loop re-runs its body (states reset, outputs cleared) until an exit condition', () => {
    // gen -> check (success); check -> gen (BACK, on failure, cap 5); check -> exit (success).
    const eng = engine(
      [node('gen'), node('check'), node('exit')],
      [
        edge('gen', 'check', 'success'),
        edge('check', 'gen', 'failure', { back: true, maxBounces: 5 }),
        edge('check', 'exit', 'success'),
      ],
    );
    // check fails twice (bounce), then succeeds → exit.
    const { state, log } = drive(
      eng,
      {},
      { outcomeFor: (id, idx) => ({ outcome: id === 'check' && idx < 2 ? 'failure' : 'success' }) },
    );
    expect(state.status).toBe('success');
    expect(state.nodes.exit!.status).toBe('success');
    expect(Object.values(state.bounces)).toEqual([2]); // two back-edge traversals
    expect(state.nodes.gen!.attempts).toBe(3); // re-run each round (monotonic)
    expect(state.nodes.check!.attempts).toBe(3);
    expect(reasonsOf(log)).not.toContain('capped');
  });

  it('resets the loop body to pending and clears its outputs on a bounce (mid-loop observation)', () => {
    const eng = engine(
      [node('gen', { outputs: [{ name: 'v', type: 'number' }] }), node('check')],
      [
        edge('gen', 'check', 'success'),
        edge('check', 'gen', 'failure', { back: true, maxBounces: 5 }),
      ],
    );
    let s = eng.reduce(eng.seedState(), started()).state; // dispatch gen#0
    s = eng.reduce(s, dispatched('gen', 'gen#0')).state;
    s = eng.reduce(s, succeeded('gen', 'gen#0', { v: 1 })).state; // gen success, output stored
    expect(s.outputs.gen).toEqual({ v: 1 });
    s = eng.reduce(s, dispatched('check', 'check#0')).state;
    const r = eng.reduce(s, failed('check', 'check#0')); // back-edge fires
    // body {gen, check} reset to pending; gen's output cleared; gen re-dispatched.
    expect(r.state.nodes.gen!.status).toBe('ready'); // re-dispatched this pass
    expect(r.state.nodes.check!.status).toBe('pending');
    expect(r.state.outputs.gen).toBeUndefined(); // outputs cleared
    expect(Object.values(r.state.bounces)).toEqual([1]);
    // A fresh attempt was minted (monotonic) so the prior round's result can't fold.
    expect(r.state.nodes.gen!.currentAttemptId).toBe('gen#1');
  });

  it('a bounce cap is enforced → finishRun{failure,"capped"}', () => {
    const eng = engine(
      [node('gen'), node('check')],
      [
        edge('gen', 'check', 'success'),
        edge('check', 'gen', 'failure', { back: true, maxBounces: 2 }),
      ],
    );
    const { state, log } = drive(
      eng,
      {},
      { outcomeFor: (id) => ({ outcome: id === 'check' ? 'failure' : 'success' }) },
    );
    expect(state.status).toBe('failure');
    expect(reasonsOf(log)).toContain('capped');
    expect(Object.values(state.bounces)).toEqual([3]); // the 3rd exceeded cap 2
  });

  it('does NOT fire while a parallel body sibling is still in-flight (no spurious invalid_event)', () => {
    // gen fans out to fast + slow, both feed check (join:any). A back-edge
    // check -> gen resets body {gen, fast, slow, check}. When check FAILS via the
    // fast branch while `slow` is still dispatched, firing on the source alone
    // would reset the in-flight `slow`; its late result would then fold onto a
    // `pending` node → a spurious finishRun{invalid_event}. The whole-body gate
    // holds the bounce until `slow` is terminal.
    const eng = engine(
      [node('gen'), node('fast'), node('slow'), node('check', { join: 'any' }), node('done')],
      [
        edge('gen', 'fast', 'success'),
        edge('gen', 'slow', 'success'),
        edge('fast', 'check', 'success'),
        edge('slow', 'check', 'success'),
        edge('check', 'gen', 'failure', { back: true, maxBounces: 3 }),
        edge('check', 'done', 'success'),
      ],
    );
    let s = eng.reduce(eng.seedState(), started()).state; // dispatch gen#0
    s = eng.reduce(s, dispatched('gen', 'gen#0')).state;
    s = eng.reduce(s, succeeded('gen', 'gen#0')).state; // fast#0 + slow#0 dispatched
    s = eng.reduce(s, dispatched('fast', 'fast#0')).state;
    s = eng.reduce(s, succeeded('fast', 'fast#0')).state; // check ready (join:any) → check#0
    s = eng.reduce(s, dispatched('slow', 'slow#0')).state; // slow accepted, still in-flight
    s = eng.reduce(s, dispatched('check', 'check#0')).state;
    const atFail = eng.reduce(s, failed('check', 'check#0')); // back-edge satisfied but slow live
    s = atFail.state;
    expect(s.status).toBe('running');
    expect(s.nodes.slow!.status).toBe('dispatched'); // NOT reset out from under the driver
    expect(atFail.commands).toEqual([]); // held: waiting for slow to finish
    expect(atFail.diagnostics.join(' ')).not.toContain('invalid_event');
    expect(Object.keys(s.bounces)).toHaveLength(0); // no bounce fired yet

    // slow's LATE result folds cleanly (slow terminal), THEN the back-edge fires.
    const afterSlow = eng.reduce(s, succeeded('slow', 'slow#0'));
    s = afterSlow.state;
    expect(afterSlow.diagnostics.join(' ')).not.toContain('invalid');
    expect(Object.values(s.bounces)).toEqual([1]); // fired exactly once, post-terminal
    expect(s.nodes.gen!.status).toBe('ready'); // round 2 re-dispatched
    expect(s.nodes.gen!.currentAttemptId).toBe('gen#1'); // fresh monotonic attempt
  });

  it('edgeKey is STABLE across a doc edge reorder (same bounces key both ways)', () => {
    const fwd = edge('gen', 'check', 'success');
    const back = edge('check', 'gen', 'failure', { back: true, maxBounces: 2 });
    const a = engine([node('gen'), node('check')], [fwd, back]);
    const b = engine([node('gen'), node('check')], [back, fwd]); // reversed order
    const oc = (id: string) => ({
      outcome: id === 'check' ? ('failure' as const) : ('success' as const),
    });
    const ra = drive(a, {}, { outcomeFor: oc });
    const rb = drive(b, {}, { outcomeFor: oc });
    // One back-edge → one stable key, identical regardless of edge array order.
    expect(Object.keys(ra.state.bounces)).toHaveLength(1);
    expect(Object.keys(rb.state.bounces)).toEqual(Object.keys(ra.state.bounces));
    expect(rb.state.bounces).toEqual(ra.state.bounces);
  });
});

// ===========================================================================
// Containers (loop | stage)
// ===========================================================================

const stage = (id: string, children: string[]): Container => ({ id, kind: 'stage', children });
const loop = (id: string, children: string[], exitWhen: string, maxRounds?: number): Container => ({
  id,
  kind: 'loop',
  children,
  exitWhen,
  ...(maxRounds !== undefined ? { maxRounds } : {}),
});
const foreach = (id: string, children: string[], items: string): Container => ({
  id,
  kind: 'foreach',
  children,
  items,
});

describe('containers — stage', () => {
  it('a stage exits SUCCESS when all children are terminal, then fires its outer edge', () => {
    const eng = engine(
      [node('c1'), node('c2'), node('after')],
      [edge('c1', 'c2', 'success'), edge('stg', 'after', 'success')],
      [stage('stg', ['c1', 'c2'])],
    );
    const { state } = drive(eng, {});
    expect(state.containers.stg!.status).toBe('success');
    expect(state.nodes.c1!.status).toBe('success');
    expect(state.nodes.c2!.status).toBe('success');
    expect(state.nodes.after!.status).toBe('success'); // outer edge fired
    expect(state.status).toBe('success');
  });

  it('a child SKIP does not fail the container', () => {
    // a succeeds → a->b(failure) unsatisfied-terminal → b skipped; a->c(success) runs.
    const eng = engine(
      [node('a'), node('b'), node('c'), node('after')],
      [edge('a', 'b', 'failure'), edge('a', 'c', 'success'), edge('stg', 'after', 'success')],
      [stage('stg', ['a', 'b', 'c'])],
    );
    const { state } = drive(eng, {});
    expect(state.nodes.b!.status).toBe('skipped');
    expect(state.containers.stg!.status).toBe('success'); // skip did NOT fail it
    expect(state.nodes.after!.status).toBe('success');
    expect(state.status).toBe('success');
  });

  it('an unhandled child failure fails the container, firing its outer completion edge', () => {
    const eng = engine(
      [node('a'), node('recover')],
      [edge('stg', 'recover', 'completion')],
      [stage('stg', ['a'])],
    );
    const { state } = drive(
      eng,
      {},
      { outcomeFor: (id) => ({ outcome: id === 'a' ? 'failure' : 'success' }) },
    );
    expect(state.nodes.a!.status).toBe('failure');
    expect(state.containers.stg!.status).toBe('failure'); // unhandled child failure
    expect(state.containers.stg!.reason).toBe('child_failed:a'); // reason recorded
    expect(state.nodes.recover!.status).toBe('success'); // outer completion caught it
    expect(state.status).toBe('success');
  });
});

describe('containers — loop', () => {
  it('a loop re-rounds until exitWhen is true, then exits SUCCESS', () => {
    const eng = engine(
      [
        node('work'),
        node('check', { outputs: [{ name: 'done', type: 'boolean' }] }),
        node('final'),
      ],
      [edge('work', 'check', 'success'), edge('lp', 'final', 'success')],
      [loop('lp', ['work', 'check'], '${nodes.check.output.done}', 5)],
    );
    // check.done is false for rounds 0,1 then true at round 2.
    const { state } = drive(
      eng,
      {},
      {
        outcomeFor: (id, idx) =>
          id === 'check'
            ? { outcome: 'success', outputs: { done: idx >= 2 } }
            : { outcome: 'success' },
      },
    );
    expect(state.containers.lp!.status).toBe('success');
    expect(state.containers.lp!.round).toBe(2); // two re-rounds
    expect(state.nodes.final!.status).toBe('success'); // outer edge fired
    expect(state.status).toBe('success');
  });

  it('a loop that never satisfies exitWhen is CAPPED at maxRounds (container failure)', () => {
    const eng = engine(
      [
        node('work'),
        node('check', { outputs: [{ name: 'done', type: 'boolean' }] }),
        node('recover'),
      ],
      [edge('work', 'check', 'success'), edge('lp', 'recover', 'completion')],
      [loop('lp', ['work', 'check'], '${nodes.check.output.done}', 2)],
    );
    const { state, log } = drive(
      eng,
      {},
      {
        outcomeFor: (id) =>
          id === 'check'
            ? { outcome: 'success', outputs: { done: false } }
            : { outcome: 'success' },
      },
    );
    expect(state.containers.lp!.status).toBe('failure'); // capped
    expect(state.containers.lp!.reason).toBe('capped'); // reason recorded
    expect(state.containers.lp!.round).toBe(1); // round 0 then round 1 hit the cap
    expect(state.nodes.recover!.status).toBe('success'); // outer completion caught the cap
    expect(state.status).toBe('success');
    void log;
  });
});

// #4 A17 — a `loop`'s wall-clock `timeout`: armed ONCE at container-enter (consumes
// the S1 durable alarm, like `wait`), fires `container.timedOut` when it elapses
// while the loop is still active → the loop FAILS `timeout`, its live children are
// neutralized so a late result cannot re-animate them, and its outer failure edge
// routes. A lost arm (crash in the enter→arm window) is re-emitted by `onResumed`.
const loopT = (
  id: string,
  children: string[],
  exitWhen: string,
  timeout: number,
  maxRounds?: number,
): Container => ({
  id,
  kind: 'loop',
  children,
  exitWhen,
  timeout,
  ...(maxRounds !== undefined ? { maxRounds } : {}),
});

describe('containers — loop wall-clock timeout (#4 A17)', () => {
  it('arms scheduleContainerTimeout ONCE at enter and stamps timeoutDueAt (not per round)', () => {
    const eng = engine(
      [
        node('work'),
        node('check', { outputs: [{ name: 'done', type: 'boolean' }] }),
        node('final'),
      ],
      [edge('work', 'check', 'success'), edge('lp', 'final', 'success')],
      // exits at round 1, so the loop re-rounds ONCE — proving the arm does not
      // re-fire per round (it bounds the loop's TOTAL wall-clock).
      [loopT('lp', ['work', 'check'], '${nodes.check.output.done}', 3600, 5)],
    );
    const { state, commandsSeen } = drive(
      eng,
      {},
      {
        outcomeFor: (id, idx) =>
          id === 'check'
            ? { outcome: 'success', outputs: { done: idx >= 1 } }
            : { outcome: 'success' },
      },
    );
    const arms = commandsSeen.filter((c) => c.type === 'scheduleContainerTimeout');
    expect(arms).toHaveLength(1);
    expect(arms[0]).toMatchObject({ containerId: 'lp', seconds: 3600 });
    expect(state.containers.lp!.round).toBe(1); // it DID re-round once
    expect(state.containers.lp!.timeoutDueAt).toBeDefined(); // the scheduled fold stamped it
    expect(state.containers.lp!.status).toBe('success'); // timeout never fired in the harness
  });

  it('a timeout mid-flight FAILS the loop `timeout`, neutralizes children, routes the outer failure edge, and ignores the late child result', () => {
    const eng = engine(
      [node('work'), node('recover')],
      [edge('lp', 'recover', 'failure')],
      [loopT('lp', ['work'], '${nodes.work.output.done}', 3600, 100)],
    );
    let s = eng.seedState();
    const r0 = eng.reduce(s, started());
    s = r0.state;
    const disp = r0.commands.find((c) => c.type === 'dispatchNode') as Extract<
      EngineCommand,
      { type: 'dispatchNode' }
    >;
    expect(disp.nodeId).toBe('work');
    const workAttempt = disp.attemptId;
    expect(r0.commands.find((c) => c.type === 'scheduleContainerTimeout')).toBeDefined();

    // The driver armed the alarm and stamped the marker; the child is now in flight.
    s = eng.reduce(s, {
      type: 'container.timeoutScheduled',
      runId: RUN,
      containerId: 'lp',
      dueAt: 1_700_000_003_600_000,
    }).state;
    s = eng.reduce(s, dispatched('work', workAttempt)).state;
    expect(s.nodes.work!.status).toBe('dispatched'); // a running child

    // The wall-clock timeout fires.
    const t = eng.reduce(s, { type: 'container.timedOut', runId: RUN, containerId: 'lp' });
    s = t.state;
    expect(s.containers.lp!.status).toBe('failure');
    expect(s.containers.lp!.reason).toBe('timeout');
    // The in-flight child is neutralized to terminal `skipped` (NOT `pending` — a
    // late result on a pending node reads as an impossible log and fails the run),
    // with its attempt cleared, so a late result cannot fold against it.
    expect(s.nodes.work!.status).toBe('skipped');
    expect(s.nodes.work!.currentAttemptId).toBeUndefined();
    // The outer FAILURE edge routes.
    const rec = t.commands.find((c) => c.type === 'dispatchNode') as Extract<
      EngineCommand,
      { type: 'dispatchNode' }
    >;
    expect(rec.nodeId).toBe('recover');

    // A REDELIVERED timeout on the now-failed (but run still RUNNING) loop is a no-op
    // — the fold's `active` guard, exercised on a running run.
    const again = eng.reduce(s, { type: 'container.timedOut', runId: RUN, containerId: 'lp' });
    expect(again.state).toEqual(s);
    expect(again.commands).toEqual([]);

    // The LATE result of the cut-off child, at its stale attempt, folds to nothing.
    const late = eng.reduce(s, succeeded('work', workAttempt, { done: true }));
    expect(late.state.nodes.work!.status).toBe('skipped'); // not resurrected
    expect(late.state.containers.lp!.status).toBe('failure');
    expect(late.commands).toEqual([]);

    // The handled failure edge lets the run finish SUCCESS once recover completes
    // (the reducer emits the finishRun COMMAND; the driver makes it durable).
    s = eng.reduce(s, dispatched('recover', rec.attemptId)).state;
    const fin = eng.reduce(s, succeeded('recover', rec.attemptId));
    expect(fin.commands.find((c) => c.type === 'finishRun')).toMatchObject({ outcome: 'success' });
  });

  it('onResumed RE-EMITS scheduleContainerTimeout for an active loop whose arm was lost (no timeoutDueAt)', () => {
    const eng = engine(
      [node('work')],
      [],
      [loopT('lp', ['work'], '${nodes.work.output.done}', 3600, 100)],
    );
    const r0 = eng.reduce(eng.seedState(), started());
    // The crash landed BEFORE `container.timeoutScheduled`, so the loop is active
    // with no marker — its alarm was never durably armed.
    expect(r0.state.containers.lp!.status).toBe('active');
    expect(r0.state.containers.lp!.timeoutDueAt).toBeUndefined();
    const resumed = eng.reduce(r0.state, { type: 'run.resumed', runId: RUN, reason: 'boot' });
    expect(resumed.commands.find((c) => c.type === 'scheduleContainerTimeout')).toMatchObject({
      containerId: 'lp',
      seconds: 3600,
    });
  });

  it('onResumed does NOT re-arm a loop that already recorded its timeout (timeoutDueAt set)', () => {
    const eng = engine(
      [node('work')],
      [],
      [loopT('lp', ['work'], '${nodes.work.output.done}', 3600, 100)],
    );
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, {
      type: 'container.timeoutScheduled',
      runId: RUN,
      containerId: 'lp',
      dueAt: 999,
    }).state;
    expect(s.containers.lp!.timeoutDueAt).toBe(999);
    const resumed = eng.reduce(s, { type: 'run.resumed', runId: RUN, reason: 'boot' });
    expect(resumed.commands.find((c) => c.type === 'scheduleContainerTimeout')).toBeUndefined();
  });
});

// #6 E2 — `exitWhen` mode enforcement at RUN time. The write path refuses such a
// doc as of #444, but rows written before that gate were never validated and are
// immutable, so the reducer is the ONLY place an embedded exitWhen in an
// ALREADY-STORED doc can be stopped.
describe('containers — loop exitWhen interpolation mode (E2)', () => {
  it('a PADDED lone exitWhen exits the loop — the trim decides the mode (I1)', () => {
    // Pre-E2 this resolved to the STRING "true" and only exited by way of a
    // `out === 'true'` coercion hack. Now it is genuinely a boolean.
    const eng = engine(
      [node('check', { outputs: [{ name: 'done', type: 'boolean' }] }), node('final')],
      [edge('lp', 'final', 'success')],
      [loop('lp', ['check'], ' ${nodes.check.output.done} ', 5)],
    );
    const { state } = drive(
      eng,
      {},
      { outcomeFor: () => ({ outcome: 'success', outputs: { done: true } }) },
    );
    expect(state.containers.lp!.status).toBe('success');
    expect(state.containers.lp!.round).toBe(0); // exited on the FIRST round
    expect(state.nodes.final!.status).toBe('success');
  });

  it('an EMBEDDED exitWhen fails LOUDLY instead of silently spinning to maxRounds', () => {
    // The bug this closes: `"done=${x}"` resolves to the string "done=true",
    // which is never boolean-true, so the loop burned every round and then
    // reported `capped` — a misleading reason for what is an authoring error.
    const eng = engine(
      [node('check', { outputs: [{ name: 'done', type: 'boolean' }] }), node('after')],
      [edge('lp', 'after', 'completion')],
      [loop('lp', ['check'], 'done=${nodes.check.output.done}', 3)],
    );
    const { state } = drive(
      eng,
      {},
      { outcomeFor: () => ({ outcome: 'success', outputs: { done: true } }) },
    );
    expect(state.containers.lp!.status).toBe('failure');
    expect(state.containers.lp!.reason).toBe('exitWhen_error'); // NOT 'capped'
    expect(state.containers.lp!.round).toBe(0); // failed immediately, burned no rounds
  });

  it('a LITERAL exitWhen fails loudly (deliberate change: it used to exit via coercion)', () => {
    // BREAKING, deliberate: `exitWhen: 'true'` is not an expression, and
    // `validateDoc` has always rejected it — but it silently "worked" at run
    // time via the `out === 'true'` string coercion, exiting after round one.
    // A doc that only ran by accident now says so.
    const eng = engine(
      [node('check'), node('after')],
      [edge('lp', 'after', 'completion')],
      [loop('lp', ['check'], 'true', 3)],
    );
    const { state } = drive(eng, {});
    expect(state.containers.lp!.status).toBe('failure');
    expect(state.containers.lp!.reason).toBe('exitWhen_error');
  });

  it('an UNTERMINATED exitWhen reports the grammar error, not a mode error', () => {
    // The mode check stays silent on an open brace and falls through to
    // `substitute`, which raises the precise diagnostic. Pins the fall-through.
    const eng = engine(
      [node('check', { outputs: [{ name: 'done', type: 'boolean' }] }), node('after')],
      [edge('lp', 'after', 'completion')],
      [loop('lp', ['check'], '${nodes.check.output.done', 3)],
    );
    const { state } = drive(
      eng,
      {},
      { outcomeFor: () => ({ outcome: 'success', outputs: { done: true } }) },
    );
    expect(state.containers.lp!.status).toBe('failure');
    expect(state.containers.lp!.reason).toBe('exitWhen_error');
  });

  // #6 E6 — the RUN-TIME half of the boolean-condition rule. Was: a string-typed
  // "true" exited the loop via an `out === 'true'` coercion. E6 removes it, per
  // the promise the shipped code carried ("#6 E6 removes this line in the same
  // ticket that adds the static boolean-condition check").
  //
  // The save-time half alone cannot close this: the write path refuses such a
  // doc now (#444), but rows written before that gate were never validated and
  // still reach the reducer. Same both-halves rule E2 set for the MODE check,
  // for the same reason.
  it('a string-typed "true" output FAILS LOUDLY — the E6 coercion is removed', () => {
    // BREAKING, deliberate. A `string`-typed output carrying "true" is common
    // from an LLM/CLI activity, and the coercion made it silently work — so the
    // author never learned their `exitWhen` was not a boolean, and the identical
    // node emitting "yes" (or " true") burned every round and reported the
    // misleading `capped`. The authored fix is explicit: `${equals(x, 'true')}`.
    const eng = engine(
      [node('check', { outputs: [{ name: 'done', type: 'string' }] }), node('final')],
      [edge('lp', 'final', 'completion')],
      [loop('lp', ['check'], '${nodes.check.output.done}', 5)],
    );
    const { state } = drive(
      eng,
      {},
      { outcomeFor: () => ({ outcome: 'success', outputs: { done: 'true' } }) },
    );
    expect(state.containers.lp!.status).toBe('failure');
    expect(state.containers.lp!.reason).toBe('exitWhen_error');
    expect(state.containers.lp!.round).toBe(0); // failed immediately, burned no rounds
  });

  it('the explicit `equals` form is how a string-typed output exits', () => {
    // The migration path for the test above — and what E6's save-time check
    // steers the author to before the run ever happens.
    const eng = engine(
      [node('check', { outputs: [{ name: 'done', type: 'string' }] }), node('final')],
      [edge('lp', 'final', 'success')],
      [loop('lp', ['check'], "${equals(nodes.check.output.done, 'true')}", 5)],
    );
    const { state } = drive(
      eng,
      {},
      { outcomeFor: () => ({ outcome: 'success', outputs: { done: 'true' } }) },
    );
    expect(state.containers.lp!.status).toBe('success');
    expect(state.containers.lp!.round).toBe(0);
  });
});

// #4 A3 — the `until` contract: a `loop` container is a DO-WHILE. These pin the
// four facets the ticket names — expr-after-each-round (→ ≥1 iteration, never
// zero), cap-failure reason (`capped`, already pinned at 'a loop that never
// satisfies exitWhen is CAPPED' above), output projection (LAST round only), and
// the zero-iteration/termination edge (a loop with no way to ever exit).
describe('containers — loop do-while semantics (A3)', () => {
  it('is a DO-WHILE: the body runs once even when exitWhen is true from round 0', () => {
    // `stepContainers` only evaluates `exitWhen` once the round is fully TERMINAL,
    // so the body ALWAYS runs at least once — the exit is checked AFTER the round,
    // never before it. A loop can never iterate zero times.
    const eng = engine(
      [
        node('work'),
        node('check', { outputs: [{ name: 'done', type: 'boolean' }] }),
        node('final'),
      ],
      [edge('work', 'check', 'success'), edge('lp', 'final', 'success')],
      [loop('lp', ['work', 'check'], '${nodes.check.output.done}', 5)],
    );
    // exitWhen is satisfiable on the very FIRST round.
    const { state } = drive(
      eng,
      {},
      {
        outcomeFor: (id) =>
          id === 'check' ? { outcome: 'success', outputs: { done: true } } : { outcome: 'success' },
      },
    );
    expect(state.nodes.work!.status).toBe('success'); // the body RAN (≥1 iteration)
    expect(state.nodes.check!.status).toBe('success');
    expect(state.containers.lp!.status).toBe('success');
    expect(state.containers.lp!.round).toBe(0); // exactly once — no re-round
    expect(state.nodes.final!.status).toBe('success'); // outer edge fired
    expect(state.status).toBe('success');
  });

  it("projects the LAST round's child outputs — prior rounds are cleared", () => {
    // A round resets its children and CLEARS their outputs (`resetNodes`), so the
    // container's projected output reflects only the FINAL round. A child emitting
    // a round-varying value must project the value from the round it exited on.
    const eng = engine(
      [
        node('counter', { outputs: [{ name: 'n', type: 'number' }] }),
        node('check', { outputs: [{ name: 'done', type: 'boolean' }] }),
      ],
      [edge('counter', 'check', 'success')],
      [loop('lp', ['counter', 'check'], '${nodes.check.output.done}', 9)],
    );
    // Rounds 0,1 keep going; round 2 exits. counter.n = the round index (0,1,2).
    const { state } = drive(
      eng,
      {},
      {
        outcomeFor: (id, idx) =>
          id === 'counter'
            ? { outcome: 'success', outputs: { n: idx } }
            : { outcome: 'success', outputs: { done: idx >= 2 } },
      },
    );
    expect(state.containers.lp!.status).toBe('success');
    expect(state.containers.lp!.round).toBe(2);
    // ONLY the final round's value — not 0 (round 0) nor an accumulation.
    expect(state.containers.lp!.outputs).toEqual({ done: true, n: 2 });
    expect(state.outputs.lp).toEqual({ done: true, n: 2 }); // ${nodes.lp.output.n}
  });

  it('a loop with NEITHER exitWhen NOR maxRounds fails `no_exit_condition` (not an unbounded spin)', () => {
    // `validateDoc` refuses such a doc at write time (#444: a loop needs an
    // exitWhen), but an IMMUTABLE row written before that gate reaches the reducer
    // unchecked — and with no exit condition and no cap it would re-round FOREVER
    // (`evalExitWhen` returns false for an undefined exitWhen; no `maxRounds` cap
    // ever fires). The reducer is the last line of defense: it runs the mandatory
    // first round (do-while) then fails CLOSED rather than spin.
    const noExit: Container = { id: 'lp', kind: 'loop', children: ['work'] };
    const eng = engine(
      [node('work'), node('recover')],
      [edge('lp', 'recover', 'completion')],
      [noExit],
    );
    const { state } = drive(eng, {});
    expect(state.nodes.work!.status).toBe('success'); // the body ran ONCE (do-while)
    expect(state.containers.lp!.status).toBe('failure');
    expect(state.containers.lp!.reason).toBe('no_exit_condition');
    expect(state.containers.lp!.round).toBe(0); // failed after round 0, did not re-round
    expect(state.nodes.recover!.status).toBe('success'); // outer completion caught it
    expect(state.status).toBe('success');
  });
});

// ===========================================================================
// foreach container (#4 A4) — item-based iteration
// ===========================================================================

describe('foreach container (#4 A4)', () => {
  it('iterates the body once per item, aggregating order-stable results', () => {
    const eng = engine(
      [node('work'), node('after')],
      [edge('fe', 'after', 'success')],
      [foreach('fe', ['work'], '${params.list}')],
    );
    const { state, commandsSeen } = drive(
      eng,
      { list: ['a', 'b', 'c'] },
      {
        outcomeFor: (id, idx) =>
          id === 'work' ? { outcome: 'success', outputs: { v: idx } } : { outcome: 'success' },
      },
    );
    expect(state.containers.fe!.status).toBe('success');
    expect(state.containers.fe!.round).toBe(2); // 0-based index of the LAST item
    // order-stable aggregate, index-aligned with items
    expect(state.containers.fe!.outputs).toEqual({ results: [{ v: 0 }, { v: 1 }, { v: 2 }] });
    expect(state.outputs.fe).toEqual({ results: [{ v: 0 }, { v: 1 }, { v: 2 }] });
    expect(state.nodes.after!.status).toBe('success'); // outer success edge fired
    expect(state.status).toBe('success');
    const workDispatches = commandsSeen.filter(
      (c) => c.type === 'dispatchNode' && c.nodeId === 'work',
    );
    expect(workDispatches.length).toBe(3); // the body ran exactly once per item
  });

  it('binds ${item} to each element in a body-node config', () => {
    const eng = engine(
      [node('work', { x: '${item}' })],
      [],
      [foreach('fe', ['work'], '${params.list}')],
    );
    const { commandsSeen } = drive(eng, { list: ['x', 'y', 'z'] });
    const prepared = commandsSeen
      .filter(
        (c): c is Extract<EngineCommand, { type: 'dispatchNode' }> =>
          c.type === 'dispatchNode' && c.nodeId === 'work',
      )
      .map((c) => c.preparedInput);
    expect(prepared).toEqual([{ x: 'x' }, { x: 'y' }, { x: 'z' }]);
  });

  it('binds ${item} in a call_pipeline body child (params path)', () => {
    const eng = engine(
      [callNode('call', 'child_pv', { sku: '${item}' })],
      [],
      [foreach('fe', ['call'], '${params.list}')],
    );
    const { commandsSeen } = drive(eng, { list: ['p', 'q'] });
    const params = commandsSeen
      .filter((c): c is Extract<EngineCommand, { type: 'startChild' }> => c.type === 'startChild')
      .map((c) => c.params);
    expect(params).toEqual([{ sku: 'p' }, { sku: 'q' }]);
  });

  it('binds ${item} in a switch `on` inside a foreach body (control path)', () => {
    // The switch routes per item on ${item}; the log accumulates one
    // switch.evaluated per item (state.branches is cleared each item, the log is
    // not), proving ${item} reached the control-branch evaluator per iteration.
    const eng = engine(
      [node('route', { on: '${item}', cases: ['a', 'b'] }, { type: 'switch' })],
      [],
      [foreach('fe', ['route'], '${params.list}')],
    );
    const { state, log } = driveRun(eng, {
      params: { list: ['a', 'b', 'c'] },
      resolve: simpleResolve(),
    });
    const branches = log
      .filter(
        (e): e is Extract<EngineEvent, { type: 'switch.evaluated' }> =>
          e.type === 'switch.evaluated',
      )
      .map((e) => e.branch);
    expect(branches).toEqual(['a', 'b', 'default']); // 'c' matches no case → default
    expect(state.containers.fe!.status).toBe('success');
  });

  it('a zero-item foreach succeeds immediately with results:[] and never runs the body', () => {
    const eng = engine(
      [node('work'), node('after')],
      [edge('fe', 'after', 'success')],
      [foreach('fe', ['work'], '${params.list}')],
    );
    const { state, commandsSeen } = drive(eng, { list: [] });
    expect(state.containers.fe!.status).toBe('success');
    expect(state.containers.fe!.round).toBe(0);
    expect(state.containers.fe!.outputs).toEqual({ results: [] });
    expect(state.nodes.work!.status).toBe('pending'); // body never dispatched
    expect(commandsSeen.some((c) => c.type === 'dispatchNode' && c.nodeId === 'work')).toBe(false);
    expect(state.nodes.after!.status).toBe('success'); // outer success still fires
    expect(state.status).toBe('success');
  });

  it('fails fast on a child failure, exposing the PARTIAL results completed so far', () => {
    const eng = engine(
      [node('work'), node('recover')],
      [edge('fe', 'recover', 'completion')],
      [foreach('fe', ['work'], '${params.list}')],
    );
    // item 0 succeeds, item 1 (attempt idx 1) fails → the foreach fails fast, item 2 never runs.
    const { state } = drive(
      eng,
      { list: ['a', 'b', 'c'] },
      {
        outcomeFor: (id, idx) =>
          id === 'work' && idx === 1
            ? { outcome: 'failure' }
            : { outcome: 'success', outputs: { v: idx } },
      },
    );
    expect(state.containers.fe!.status).toBe('failure');
    expect(state.containers.fe!.reason).toBe('child_failed:work');
    expect(state.containers.fe!.round).toBe(1); // failed on item index 1
    expect(state.containers.fe!.outputs).toEqual({ results: [{ v: 0 }] }); // only item 0 completed
    expect(state.nodes.recover!.status).toBe('success'); // outer completion caught it
    expect(state.status).toBe('success');
  });

  it('fails the run invalid_event when items does not resolve to an array', () => {
    const eng = engine([node('work')], [], [foreach('fe', ['work'], '${params.list}')]);
    const { state, log } = drive(eng, { list: 42 });
    expect(state.status).toBe('failure');
    expect(reasonsOf(log)).toContain('invalid_event');
    expect(state.nodes.work!.status).toBe('pending'); // body never ran
  });

  it('is BOUNDED — an over-cap items array fails invalid_event before any item runs', () => {
    // A data-controlled `items` is not unbounded: `substitute` charges the array
    // against the inert language's per-field element budget (MAX_ARRAY_ELEMENTS_TOTAL
    // = 100k), so an over-cap array throws at `evalForeachItems` → invalid_event.
    // This is the foreach's iteration ceiling (the counterpart to a loop's maxRounds).
    const huge = Array.from({ length: 100_001 }, (_, i) => i);
    const eng = engine([node('work')], [], [foreach('fe', ['work'], '${params.list}')]);
    const { state, log } = drive(eng, { list: huge });
    expect(state.status).toBe('failure');
    expect(reasonsOf(log)).toContain('invalid_event');
    expect(state.nodes.work!.status).toBe('pending'); // body never ran
  });

  it('exposes results to a downstream ${nodes.<foreach>.output.results} ref at run time', () => {
    const eng = engine(
      [node('work'), node('after', { got: '${nodes.fe.output.results}' })],
      [edge('fe', 'after', 'success')],
      [foreach('fe', ['work'], '${params.list}')],
    );
    const { commandsSeen } = drive(
      eng,
      { list: ['a', 'b'] },
      {
        outcomeFor: (id, idx) =>
          id === 'work' ? { outcome: 'success', outputs: { v: idx } } : { outcome: 'success' },
      },
    );
    const afterPrep = commandsSeen.find((c) => c.type === 'dispatchNode' && c.nodeId === 'after');
    expect(afterPrep?.type === 'dispatchNode' ? afterPrep.preparedInput : null).toEqual({
      got: [{ v: 0 }, { v: 1 }],
    });
  });
});

describe('foreach crash recovery re-emits a control/call child WITH ${item} (#569)', () => {
  // A control (`if`/`switch`) or `call_pipeline` child inside a foreach body whose
  // decision references `${item}` can crash-recover while the round is live: the
  // reducer had pushed its command (`evaluateControl` / `startChild`) but
  // `projectRunState` keeps STATE not COMMANDS, so the command is lost and `resume`
  // must re-derive it. The re-derive MUST pass the round's item (as the dispatch
  // site does) — else `${item}` is unbound on recovery, `substitute` throws, and
  // the run fails LOUD (`invalid_event`) instead of routing the branch/spawning the
  // child it would have. Sibling of the A7 `fail` / A8 `filter` / A6 `wait` forks,
  // which already pass the item.

  it('re-derives a switch child branch with ${item} bound (control fork)', () => {
    const eng = engine(
      [node('route', { on: '${item}', cases: ['a', 'b'] }, { type: 'switch' })],
      [],
      [foreach('fe', ['route'], '${params.list}')],
    );
    // A log that ends the instant the foreach entered round 0 and `route` became
    // `ready` (evaluateControl pushed, switch.evaluated not yet durable).
    const projected = eng.projectRunState([started({ list: ['b', 'x'] })]);
    expect(projected.nodes.route!.status).toBe('ready');

    const { commands } = eng.resume(projected);
    expect(commands).toContainEqual({
      type: 'evaluateControl',
      nodeId: 'route',
      attemptId: 'route#0',
      branch: 'b', // ${item} === 'b' matches case 'b' (not `default`)
      event: 'switch.evaluated',
    });
    // No loud failure on resume, and never re-dispatched to the executor.
    expect(commands.some((c) => c.type === 'finishRun')).toBe(false);
    expect(commands.some((c) => c.type === 'dispatchNode' && c.nodeId === 'route')).toBe(false);
  });

  it('re-derives a call_pipeline child params with ${item} bound (call fork)', () => {
    const eng = engine(
      [callNode('call', 'child_pv', { sku: '${item}' })],
      [],
      [foreach('fe', ['call'], '${params.list}')],
    );
    // A log that ends the instant the foreach entered round 0 and the call child
    // went `waiting` (startChild pushed, child run not yet spawned).
    const projected = eng.projectRunState([started({ list: ['p', 'q'] })]);
    expect(projected.nodes.call!.status).toBe('waiting');

    const { commands } = eng.resume(projected);
    const startChild = commands.find((c) => c.type === 'startChild');
    expect(startChild?.type === 'startChild' ? startChild.params : null).toEqual({ sku: 'p' });
    expect(commands.some((c) => c.type === 'finishRun')).toBe(false);
  });
});

describe('containers — namespace isolation', () => {
  it('two containers projecting the SAME output name do not collide', () => {
    const eng = engine(
      [
        node('a1', { outputs: [{ name: 'result', type: 'string' }] }),
        node('b1', { outputs: [{ name: 'result', type: 'string' }] }),
      ],
      [],
      [stage('A', ['a1']), stage('B', ['b1'])],
    );
    const { state } = drive(
      eng,
      {},
      {
        outcomeFor: (id) => ({ outcome: 'success', outputs: { result: id === 'a1' ? 'A' : 'B' } }),
      },
    );
    expect(state.containers.A!.outputs).toEqual({ result: 'A' });
    expect(state.containers.B!.outputs).toEqual({ result: 'B' });
    expect(state.outputs.A).toEqual({ result: 'A' }); // referable as ${nodes.A.output.result}
    expect(state.outputs.B).toEqual({ result: 'B' });
    expect(state.status).toBe('success');
  });
});

// ===========================================================================
// call_pipeline
// ===========================================================================

describe('call_pipeline', () => {
  it('a call node goes WAITING (emitting startChild) then resolves on call.returned', () => {
    const eng = engine([callNode('caller', 'pv_child')]);
    const r0 = eng.reduce(eng.seedState(), started());
    const start = r0.commands.find((c) => c.type === 'startChild') as
      Extract<EngineCommand, { type: 'startChild' }> | undefined;
    expect(start).toBeDefined();
    expect(start!.pipelineVersionId).toBe('pv_child');
    expect(start!.attemptId).toBe('caller#0');
    expect(r0.state.nodes.caller!.status).toBe('waiting');

    const r1 = eng.reduce(
      r0.state,
      returned('caller', 'caller#0', 'success', {}, start!.childRunId),
    );
    expect(r1.state.nodes.caller!.status).toBe('success');
    expect(r1.commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });

  it('resolves the pipelineVersionId from a ${} param ref at dispatch time', () => {
    const eng = engine([callNode('caller', '${params.child}')]);
    const r = eng.reduce(eng.seedState(), started({ child: 'pv_dynamic' }));
    const start = r.commands.find((c) => c.type === 'startChild') as Extract<
      EngineCommand,
      { type: 'startChild' }
    >;
    expect(start.pipelineVersionId).toBe('pv_dynamic');
  });

  it('a FAILED child STILL returns its projected outputs (findings loop), routed on a completion edge', () => {
    const eng = engine(
      [
        callNode('caller', 'pv_child'),
        node('recover', { note: '${default(nodes.caller.output.findings, "none")}' }),
      ],
      [edge('caller', 'recover', 'completion')],
    );
    const { state, commandsSeen } = drive(
      eng,
      {},
      {
        childFor: () => ({ childOutcome: 'failure', outputs: { findings: 'bug-42' } }),
      },
    );
    expect(state.nodes.caller!.status).toBe('failure');
    expect(state.outputs.caller).toEqual({ findings: 'bug-42' }); // recorded despite failure
    const recover = commandsSeen.find(
      (c) => c.type === 'dispatchNode' && c.nodeId === 'recover',
    ) as Extract<EngineCommand, { type: 'dispatchNode' }>;
    expect(recover.preparedInput).toEqual({ note: 'bug-42' }); // the finding crossed
    expect(state.status).toBe('success'); // failure handled by the completion edge
  });

  it('a FAILED child with a MISTYPED declared output does not store the mistyped payload', () => {
    // The findings loop keeps a failed child's outputs — but declared-typed
    // outputs are still contract-checked so mistyped data can't enter ${}.
    const caller = node(
      'caller',
      { outputs: [{ name: 'findings', type: 'string' }] },
      { type: 'call_pipeline', call: { pipelineVersionId: 'pv_child', params: {} } },
    );
    const eng = engine([caller]);
    const r0 = eng.reduce(eng.seedState(), started());
    const child = (r0.commands.find((c) => c.type === 'startChild') as { childRunId: string })
      .childRunId;
    const r1 = eng.reduce(
      r0.state,
      returned('caller', 'caller#0', 'failure', { findings: 123 }, child),
    );
    expect(r1.state.nodes.caller!.status).toBe('failure');
    expect(r1.state.outputs.caller).toBeUndefined(); // mistyped output NOT stored
    expect(r1.diagnostics.join(' ')).toContain('invalid outputs');
  });

  it('a FAILED child with a CORRECTLY typed declared output DOES store it (findings loop)', () => {
    const caller = node(
      'caller',
      { outputs: [{ name: 'findings', type: 'string' }] },
      { type: 'call_pipeline', call: { pipelineVersionId: 'pv_child', params: {} } },
    );
    const eng = engine([caller]);
    const r0 = eng.reduce(eng.seedState(), started());
    const child = (r0.commands.find((c) => c.type === 'startChild') as { childRunId: string })
      .childRunId;
    const r1 = eng.reduce(
      r0.state,
      returned('caller', 'caller#0', 'failure', { findings: 'bug-42' }, child),
    );
    expect(r1.state.nodes.caller!.status).toBe('failure');
    expect(r1.state.outputs.caller).toEqual({ findings: 'bug-42' }); // well-typed → stored
  });

  it('mints a DETERMINISTIC childRunId (same run+node+attempt → same id; new attempt → new id)', () => {
    const eng = engine([callNode('caller', 'pv_child')]);
    const a = eng.reduce(eng.seedState(), started());
    const b = eng.reduce(eng.seedState(), started());
    const idA = (a.commands.find((c) => c.type === 'startChild') as { childRunId: string })
      .childRunId;
    const idB = (b.commands.find((c) => c.type === 'startChild') as { childRunId: string })
      .childRunId;
    expect(idA).toBe(idB); // deterministic
    expect(idA).toMatch(/^child_[0-9a-f]{32}$/); // 128-bit FNV-1a → 32 hex
  });

  it('ignores a call.returned naming an UNEXPECTED childRunId (foreign/misrouted child)', () => {
    // The event names the CURRENT attempt but the WRONG child — it must not
    // terminalize the call node or store its (untrusted) outputs.
    const eng = engine([callNode('caller', 'pv_child')]);
    const r0 = eng.reduce(eng.seedState(), started());
    const good = (r0.commands.find((c) => c.type === 'startChild') as { childRunId: string })
      .childRunId;
    const bad = eng.reduce(
      r0.state,
      returned('caller', 'caller#0', 'success', { leaked: 'x' }, 'child_deadbeef'),
    );
    expect(bad.state.nodes.caller!.status).toBe('waiting'); // NOT terminalized
    expect(bad.state.outputs.caller).toBeUndefined(); // foreign outputs NOT stored
    expect(bad.commands).toEqual([]);
    expect(bad.diagnostics.join(' ')).toContain('unexpected childRunId');
    // The genuine child (correct id) still resolves the call node.
    const ok = eng.reduce(r0.state, returned('caller', 'caller#0', 'success', {}, good));
    expect(ok.state.nodes.caller!.status).toBe('success');
  });

  it('run.resumed re-emits startChild for a WAITING call node (crash before child creation)', () => {
    const eng = engine([callNode('caller', 'pv_child')]);
    const r0 = eng.reduce(eng.seedState(), started());
    const childRunId = (r0.commands.find((c) => c.type === 'startChild') as { childRunId: string })
      .childRunId;
    expect(r0.state.nodes.caller!.status).toBe('waiting');

    const resumed = eng.reduce(r0.state, {
      type: 'run.resumed',
      runId: RUN,
      reason: 'boot_reconcile',
    });
    const start = resumed.commands.find((c) => c.type === 'startChild') as Extract<
      EngineCommand,
      { type: 'startChild' }
    >;
    expect(start).toBeDefined();
    expect(start.callNodeId).toBe('caller');
    expect(start.attemptId).toBe('caller#0'); // SAME attempt — not a new dispatch
    expect(start.childRunId).toBe(childRunId); // idempotent id → safe re-creation
    expect(start.pipelineVersionId).toBe('pv_child');
    expect(resumed.state).toEqual(r0.state); // resume emits commands; state unchanged
  });

  it('ignores a STALE call.returned (an attemptId that is not the node current attempt)', () => {
    // A loop container re-dispatches the call node, minting a fresh attempt; a
    // late return for the PRIOR attempt must not fold.
    const eng = engine(
      [
        callNode('caller', 'pv_child'),
        node('check', { outputs: [{ name: 'done', type: 'boolean' }] }),
      ],
      [edge('caller', 'check', 'success')],
      [loop('lp', ['caller', 'check'], '${nodes.check.output.done}', 5)],
    );
    const r0 = eng.reduce(eng.seedState(), started()); // lp active; caller waiting caller#0
    let s = r0.state;
    const child0 = (r0.commands.find((c) => c.type === 'startChild') as { childRunId: string })
      .childRunId;
    expect(s.nodes.caller!.currentAttemptId).toBe('caller#0');
    s = eng.reduce(s, returned('caller', 'caller#0', 'success', {}, child0)).state; // caller success round 0
    s = eng.reduce(s, dispatched('check', 'check#0')).state;
    s = eng.reduce(s, succeeded('check', 'check#0', { done: false })).state; // round 0 fails exit → reset
    // Round 1: caller re-dispatched with a NEW attempt.
    expect(s.nodes.caller!.currentAttemptId).toBe('caller#1');
    const stale = eng.reduce(s, returned('caller', 'caller#0', 'success', { leaked: true }));
    expect(stale.state).toEqual(s); // the old-attempt return is ignored
    expect(stale.commands).toEqual([]);
    expect(stale.diagnostics).toEqual([]);
  });
});

// ===========================================================================
// Regression — the P2b DAG walk + invariants still hold with the P2c reducer
// ===========================================================================

describe('P2b regression (container-free / loop-free / call-free)', () => {
  it('replay determinism: folding a DAG log twice yields the identical RunState', () => {
    const eng = engine(
      [node('a'), node('b'), node('c'), node('d')],
      [
        edge('a', 'b', 'success'),
        edge('a', 'c', 'success'),
        edge('b', 'd', 'success'),
        edge('c', 'd', 'success'),
      ],
    );
    const { state, log } = drive(eng, {});
    expect(eng.projectRunState(log)).toEqual(eng.projectRunState(log));
    expect(eng.projectRunState(log)).toEqual(state);
    expect(state.status).toBe('success');
  });

  it('an empty container-free pipeline still finishes success immediately', () => {
    const eng = engine([]);
    const r = eng.reduce(eng.seedState(), started());
    expect(r.commands).toEqual([{ type: 'finishRun', outcome: 'success' }]);
  });
});
