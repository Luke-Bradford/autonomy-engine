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
 * event. This is the status MODEL slice: the fold is FORWARD-ONLY
 * (running → waiting), and the reverse edge (waiting → running) + the PRODUCER
 * that emits `run.waiting` when a run parks are deferred to #5 S4/S6. So no real
 * log reaches `waiting` yet — these tests drive the fold directly.
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
