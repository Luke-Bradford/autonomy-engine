import { describe, expect, it } from 'vitest';
import type { Edge, EngineCommand, EngineEvent, Node } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';

// --- helpers ---------------------------------------------------------------

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 } };
}

function edge(from: string, to: string, on: Edge['on']): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}

function engine(nodes: Node[], edges: Edge[] = []): Engine {
  return createEngine({ nodes, edges } satisfies EngineDoc);
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
function attempt(nodeId: string, n = 0): string {
  return `${nodeId}#${n}`;
}

interface Plan {
  [nodeId: string]: {
    outcome: 'success' | 'failure';
    outputs?: Record<string, unknown>;
    error?: string;
  };
}

/**
 * Drive a whole run to quiescence, folding every command's resulting event
 * exactly as a P2d driver would (node.dispatched → planned outcome, finishRun →
 * run.finished). Returns the final projected state + the full event log.
 */
function runAll(eng: Engine, params: Record<string, unknown>, plan: Plan) {
  let state = eng.seedState();
  const log: EngineEvent[] = [];
  const pending: EngineCommand[] = [];
  const apply = (ev: EngineEvent) => {
    const r = eng.reduce(state, ev);
    state = r.state;
    log.push(ev);
    for (const c of r.commands) pending.push(c);
  };
  apply(started(params));
  let guard = 0;
  while (pending.length) {
    if (guard++ > 2000) throw new Error('driver did not converge');
    const c = pending.shift()!;
    if (c.type === 'finishRun') {
      apply({ type: 'run.finished', runId: RUN, outcome: c.outcome, reason: c.reason });
      continue;
    }
    apply(dispatched(c.nodeId, c.attemptId));
    const p = plan[c.nodeId] ?? { outcome: 'success' };
    apply(
      p.outcome === 'success'
        ? succeeded(c.nodeId, c.attemptId, p.outputs ?? {})
        : failed(c.nodeId, c.attemptId, p.error ?? 'boom'),
    );
  }
  return { state, log };
}

function dispatchIds(cmds: EngineCommand[]): string[] {
  return cmds.filter((c) => c.type === 'dispatchNode').map((c) => (c as { nodeId: string }).nodeId);
}

// ===========================================================================
// Replay determinism (event-sourcing invariant)
// ===========================================================================

describe('replay determinism', () => {
  it('folding an event log twice yields the identical RunState', () => {
    const eng = engine(
      [node('a'), node('b'), node('c'), node('d')],
      [
        edge('a', 'b', 'success'),
        edge('a', 'c', 'success'),
        edge('b', 'd', 'success'),
        edge('c', 'd', 'success'),
      ],
    );
    const { state, log } = runAll(eng, {}, {});
    const p1 = eng.projectRunState(log);
    const p2 = eng.projectRunState(log);
    expect(p1).toEqual(p2);
    expect(p1).toEqual(state);
    expect(state.status).toBe('success');
  });
});

// ===========================================================================
// Deterministic attemptId + stale-rejection (the pre-restart-result fix)
// ===========================================================================

describe('attemptId + stale-rejection', () => {
  it('mints attemptId `${nodeId}#${attempts}` from state, not randomly', () => {
    const eng = engine([node('a')]);
    const r = eng.reduce(eng.seedState(), started());
    expect(dispatchIds(r.commands)).toEqual(['a']);
    const cmd = r.commands.find((c) => c.type === 'dispatchNode') as { attemptId: string };
    expect(cmd.attemptId).toBe('a#0');
    expect(r.state.nodes.a!.attempts).toBe(1);
    expect(r.state.nodes.a!.currentAttemptId).toBe('a#0');
  });

  it('ignores a node.succeeded carrying a STALE (prior) attemptId', () => {
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state; // dispatch a#0
    s = eng.reduce(s, dispatched('a', 'a#0')).state;

    // A retry mints a#1 (the boot-reconcile ENGINE decision).
    const retry = eng.reduce(s, {
      type: 'node.retryRequested',
      runId: RUN,
      nodeId: 'a',
      previousAttemptId: 'a#0',
      reason: 'boot_reconcile',
    });
    s = retry.state;
    expect(s.nodes.a!.currentAttemptId).toBe('a#1');
    expect(dispatchIds(retry.commands)).toEqual(['a']);

    // The STALE pre-restart result (a#0) must NOT fold into the re-dispatched node.
    const stale = eng.reduce(s, succeeded('a', 'a#0', { leaked: true }));
    expect(stale.state).toEqual(s); // no-op
    expect(stale.commands).toEqual([]);
    expect(stale.diagnostics).toEqual([]);
    expect(s.outputs.a).toBeUndefined();

    // The fresh result (a#1) succeeds normally.
    const fresh = eng.reduce(s, succeeded('a', 'a#1', { ok: true }));
    expect(fresh.state.nodes.a!.status).toBe('success');
    expect(fresh.state.outputs.a).toEqual({ ok: true });
    expect(fresh.commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });
});

// ===========================================================================
// Join truth table — all/any × satisfied/unsatisfied-terminal/pending/impossible
// ===========================================================================

describe('join truth table', () => {
  it('join:all diamond — D ready only when BOTH incoming edges satisfied', () => {
    const eng = engine(
      [node('a'), node('b'), node('c'), node('d')],
      [
        edge('a', 'b', 'success'),
        edge('a', 'c', 'success'),
        edge('b', 'd', 'success'),
        edge('c', 'd', 'success'),
      ],
    );
    const { state } = runAll(eng, {}, {});
    expect(state.nodes.d!.status).toBe('success');
    expect(state.status).toBe('success');
  });

  it('join:all — an unsatisfied-terminal incoming edge SKIPS the node', () => {
    // b fails (handled by b->catch on failure); d(join:all) needs a AND b on success.
    const eng = engine(
      [node('a'), node('b'), node('d', { join: 'all' }), node('catch')],
      [edge('a', 'd', 'success'), edge('b', 'd', 'success'), edge('b', 'catch', 'failure')],
    );
    const { state } = runAll(eng, {}, { b: { outcome: 'failure' } });
    expect(state.nodes.d!.status).toBe('skipped'); // b->d unsatisfied-terminal
    expect(state.nodes.catch!.status).toBe('success');
    expect(state.status).toBe('success'); // b's failure was handled
  });

  it('join:any — one satisfied edge is enough to run', () => {
    const eng = engine(
      [node('a'), node('b'), node('d', { join: 'any' }), node('catch')],
      [edge('a', 'd', 'success'), edge('b', 'd', 'success'), edge('b', 'catch', 'failure')],
    );
    const { state } = runAll(eng, {}, { b: { outcome: 'failure' } });
    expect(state.nodes.d!.status).toBe('success'); // a->d satisfied
    expect(state.status).toBe('success');
  });

  it('join:any — SKIPS only when ALL incoming edges are impossible (skip propagation)', () => {
    // x succeeds → its failure-edges to a,b are unsatisfied-terminal → a,b skipped
    // → a->d, b->d impossible → d(join:any) skipped.
    const eng = engine(
      [node('x'), node('a'), node('b'), node('d', { join: 'any' })],
      [
        edge('x', 'a', 'failure'),
        edge('x', 'b', 'failure'),
        edge('a', 'd', 'success'),
        edge('b', 'd', 'success'),
      ],
    );
    const { state } = runAll(eng, {}, {});
    expect(state.nodes.a!.status).toBe('skipped');
    expect(state.nodes.b!.status).toBe('skipped');
    expect(state.nodes.d!.status).toBe('skipped');
    expect(state.status).toBe('success');
  });

  it('pending — join:all waits while any incoming edge is still pending', () => {
    const eng = engine(
      [node('a'), node('b'), node('c'), node('d')],
      [
        edge('a', 'b', 'success'),
        edge('a', 'c', 'success'),
        edge('b', 'd', 'success'),
        edge('c', 'd', 'success'),
      ],
    );
    let s = eng.reduce(eng.seedState(), started()).state; // dispatch a
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    s = eng.reduce(s, succeeded('a', attempt('a'))).state; // b, c ready
    s = eng.reduce(s, dispatched('b', attempt('b'))).state;
    const r = eng.reduce(s, succeeded('b', attempt('b'))); // c not done yet
    expect(r.state.nodes.d!.status).toBe('pending'); // b->d satisfied, c->d pending
    expect(dispatchIds(r.commands)).toEqual([]); // nothing new ready
  });
});

// ===========================================================================
// Outcome routing — success / failure / completion
// ===========================================================================

describe('outcome routing', () => {
  it('routes a failure down an on:failure edge (handled failure, run succeeds)', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'failure')]);
    const { state } = runAll(eng, {}, { a: { outcome: 'failure' } });
    expect(state.nodes.a!.status).toBe('failure');
    expect(state.nodes.b!.status).toBe('success');
    expect(state.status).toBe('success');
  });

  it('an on:completion edge fires on BOTH success and failure', () => {
    const onSuccess = engine([node('a'), node('b')], [edge('a', 'b', 'completion')]);
    expect(runAll(onSuccess, {}, {}).state.nodes.b!.status).toBe('success');

    const onFailure = engine([node('a'), node('b')], [edge('a', 'b', 'completion')]);
    const r = runAll(onFailure, {}, { a: { outcome: 'failure' } });
    expect(r.state.nodes.a!.status).toBe('failure');
    expect(r.state.nodes.b!.status).toBe('success'); // completion caught the failure
    expect(r.state.status).toBe('success');
  });

  it('an UNHANDLED failure fails the whole run', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const r = eng.reduce(s, failed('a', attempt('a')));
    expect(r.commands).toContainEqual({
      type: 'finishRun',
      outcome: 'failure',
      reason: 'node_failed:a',
    });
    expect(dispatchIds(r.commands)).toEqual([]); // b never dispatched
    const final = eng.reduce(r.state, {
      type: 'run.finished',
      runId: RUN,
      outcome: 'failure',
      reason: 'node_failed:a',
    });
    expect(final.state.status).toBe('failure');
  });
});

// ===========================================================================
// Implicit success-chain (edge-less docs)
// ===========================================================================

describe('implicit success-chain', () => {
  it('runs an edge-less doc as a strict success sequence', () => {
    const eng = engine([node('n1'), node('n2'), node('n3')], []);
    const { state } = runAll(eng, {}, {});
    expect(state.nodes.n1!.status).toBe('success');
    expect(state.nodes.n2!.status).toBe('success');
    expect(state.nodes.n3!.status).toBe('success');
    expect(state.status).toBe('success');
  });

  it('an implicit-chain failure is unhandled → run fails', () => {
    const eng = engine([node('n1'), node('n2')], []);
    const { state } = runAll(eng, {}, { n1: { outcome: 'failure' } });
    expect(state.nodes.n2!.status).toBe('pending'); // never reached
    expect(state.status).toBe('failure');
  });
});

// ===========================================================================
// Terminal run.finished
// ===========================================================================

describe('terminal run.finished', () => {
  it('emits finishRun{success} once every node is terminal', () => {
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const r = eng.reduce(s, succeeded('a', attempt('a')));
    expect(r.commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });

  it('an empty pipeline finishes success immediately', () => {
    const eng = engine([]);
    const r = eng.reduce(eng.seedState(), started());
    expect(r.commands).toEqual([{ type: 'finishRun', outcome: 'success' }]);
  });
});

// ===========================================================================
// Typed-output validation
// ===========================================================================

describe('typed-output validation', () => {
  it('a bad-typed output FAILS the node (unvalidated data never crosses)', () => {
    const eng = engine([node('a', { outputs: [{ name: 'count', type: 'number' }] })]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const r = eng.reduce(s, succeeded('a', attempt('a'), { count: 'not-a-number' }));
    expect(r.state.nodes.a!.status).toBe('failure');
    expect(r.state.outputs.a).toBeUndefined(); // outputs never recorded
    expect(r.diagnostics.join(' ')).toContain('invalid outputs');
    expect(r.commands).toContainEqual({
      type: 'finishRun',
      outcome: 'failure',
      reason: 'node_failed:a',
    });
  });

  it('a well-typed output succeeds and is recorded', () => {
    const eng = engine([node('a', { outputs: [{ name: 'count', type: 'number' }] })]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const r = eng.reduce(s, succeeded('a', attempt('a'), { count: 7 }));
    expect(r.state.nodes.a!.status).toBe('success');
    expect(r.state.outputs.a).toEqual({ count: 7 });
  });
});

// ===========================================================================
// preparedInput substitution (uses the P2a `substitute`)
// ===========================================================================

describe('preparedInput substitution', () => {
  it('substitutes params and terminally-succeeded upstream outputs into dispatch input', () => {
    const eng = engine(
      [node('a'), node('b', { msg: '${nodes.a.output.greeting}', topic: '${params.topic}' })],
      [edge('a', 'b', 'success')],
    );
    let s = eng.reduce(eng.seedState(), started({ topic: 'launch' })).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const r = eng.reduce(s, succeeded('a', attempt('a'), { greeting: 'hi' }));
    const b = r.commands.find((c) => c.type === 'dispatchNode' && c.nodeId === 'b') as
      { preparedInput: Record<string, unknown> } | undefined;
    expect(b).toBeDefined();
    expect(b!.preparedInput).toEqual({ msg: 'hi', topic: 'launch' });
  });

  it('the root node dispatch substitutes ${run.id} and ${params.*}', () => {
    const eng = engine([node('a', { rid: '${run.id}', t: '${params.topic}' })]);
    const r = eng.reduce(eng.seedState(), started({ topic: 'x' }));
    const a = r.commands.find((c) => c.type === 'dispatchNode') as {
      preparedInput: Record<string, unknown>;
    };
    expect(a.preparedInput).toEqual({ rid: RUN, t: 'x' });
  });
});

// ===========================================================================
// Reducer totality (CP1)
// ===========================================================================

describe('reducer totality', () => {
  it('an event for a DIFFERENT run is a silent no-op', () => {
    const eng = engine([node('a')]);
    const s = eng.reduce(eng.seedState(), started()).state;
    const r = eng.reduce(s, {
      type: 'node.succeeded',
      runId: 'OTHER',
      nodeId: 'a',
      attemptId: 'a#0',
      outputs: {},
    });
    expect(r.state).toEqual(s);
    expect(r.commands).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it('an event for a node NOT in the doc is a silent no-op', () => {
    const eng = engine([node('a')]);
    const s = eng.reduce(eng.seedState(), started()).state;
    const r = eng.reduce(s, succeeded('ghost', 'ghost#0'));
    expect(r.state).toEqual(s);
    expect(r.diagnostics).toEqual([]);
  });

  it('an IMPOSSIBLE same-run event (result before dispatch) → diagnostic + invalid_event', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const s = eng.reduce(eng.seedState(), started()).state; // b is pending
    const r = eng.reduce(s, succeeded('b', 'b#0'));
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.commands).toContainEqual({
      type: 'finishRun',
      outcome: 'failure',
      reason: 'invalid_event',
    });
  });

  it('a duplicate result on an already-terminal node → diagnostic, no run failure', () => {
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    s = eng.reduce(s, succeeded('a', attempt('a'))).state; // a terminal (success)
    const r = eng.reduce(s, succeeded('a', attempt('a')));
    expect(r.diagnostics.join(' ')).toContain('duplicate');
    expect(r.commands).toEqual([]);
    expect(r.state.nodes.a!.status).toBe('success');
  });
});

// ===========================================================================
// Fold-to-fixpoint — all newly-ready nodes dispatched in STABLE sorted order
// ===========================================================================

describe('fold-to-fixpoint', () => {
  it('emits every newly-ready node in sorted-by-nodeId order (not insertion order)', () => {
    const eng = engine(
      [node('root'), node('c_task'), node('a_task'), node('b_task')],
      [
        edge('root', 'c_task', 'success'),
        edge('root', 'a_task', 'success'),
        edge('root', 'b_task', 'success'),
      ],
    );
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('root', attempt('root'))).state;
    const r = eng.reduce(s, succeeded('root', attempt('root')));
    expect(dispatchIds(r.commands)).toEqual(['a_task', 'b_task', 'c_task']);
  });

  it('dispatches multiple roots at run.started in sorted order', () => {
    const eng = engine(
      [node('root_z'), node('root_a'), node('sink')],
      [edge('root_z', 'sink', 'success'), edge('root_a', 'sink', 'success')],
    );
    const r = eng.reduce(eng.seedState(), started());
    expect(dispatchIds(r.commands)).toEqual(['root_a', 'root_z']);
  });
});
