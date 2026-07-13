import { describe, expect, it } from 'vitest';
import type { Container, Edge, EngineCommand, EngineEvent, Node } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';

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

function edge(from: string, to: string, on: Edge['on'], extra: Partial<Edge> = {}): Edge {
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
function failed(nodeId: string, attemptId: string, error = 'boom'): EngineEvent {
  return { type: 'node.failed', runId: RUN, nodeId, attemptId, error };
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
    if (c.type === 'startChild') {
      const idx = attempts[c.callNodeId] ?? 0;
      attempts[c.callNodeId] = idx + 1;
      const res = opts.childFor?.(c.callNodeId, idx) ?? { childOutcome: 'success' as const };
      apply(returned(c.callNodeId, c.attemptId, res.childOutcome, res.outputs ?? {}, c.childRunId));
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
    expect(idA).toMatch(/^child_[0-9a-f]{8}$/);
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
