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
  RunState,
} from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { docNodeIdOf, instanceKey, parseInstanceKey } from '../instance-key.js';

// ===========================================================================
// #566 slice 2 / #4 A4b — PARALLEL foreach (`batchCount >= 2`) via per-item
// instance namespacing. Each in-flight item i's body-node state lives under
// `<nodeId>@<i>` in state.nodes/outputs/branches; events carry instance keys in
// their existing nodeId field (NO event-schema change); sequential mode
// (batchCount absent / 1) keeps the A4a round machinery byte-identical.
// Fixture style follows reduce-p2c.test.ts.
// ===========================================================================

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

const pfe = (id: string, children: string[], items: string, batchCount = 2): Container => ({
  id,
  kind: 'foreach',
  children,
  items,
  batchCount,
});
/** SEQUENTIAL foreach — batchCount genuinely ABSENT (a default-parameter `= 2`
 * would also fire on an explicitly-passed `undefined`, so this is its own fn). */
const sfe = (id: string, children: string[], items: string): Container => ({
  id,
  kind: 'foreach',
  children,
  items,
});

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

interface DriveOpts {
  /** Outcome keyed by the DISPATCHED nodeId (an instance key under parallel). */
  outcomeFor?: (
    nodeId: string,
    idx: number,
  ) => { outcome: 'success' | 'failure'; outputs?: Record<string, unknown>; kind?: FailureKind };
  childFor?: (
    callNodeId: string,
    idx: number,
  ) => { childOutcome: 'success' | 'failure'; outputs?: Record<string, unknown> };
  /** Called after EVERY fold with the new state (state-history probes). */
  onFold?: (state: RunState) => void;
}
/** FIFO auto-driver (the reduce-p2c `drive` shape, instance-key aware). */
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
    opts.onFold?.(state);
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
    if (c.type === 'evaluateControl') {
      apply({
        type: c.event,
        runId: RUN,
        nodeId: c.nodeId,
        attemptId: c.attemptId,
        branch: c.branch,
      });
      continue;
    }
    if (c.type !== 'dispatchNode') {
      throw new Error(`a4b drive: unexpected command '${c.type}'`);
    }
    apply(dispatched(c.nodeId, c.attemptId));
    const idx = attempts[c.nodeId] ?? 0;
    attempts[c.nodeId] = idx + 1;
    const res = opts.outcomeFor?.(c.nodeId, idx) ?? { outcome: 'success' as const };
    apply(
      res.outcome === 'success'
        ? succeeded(c.nodeId, c.attemptId, res.outputs ?? {})
        : failed(c.nodeId, c.attemptId, 'boom', res.kind ?? 'permanent'),
    );
  }
  return { state, log, commandsSeen };
}

const dispatchIds = (cs: EngineCommand[]): string[] =>
  cs
    .filter((c): c is Extract<EngineCommand, { type: 'dispatchNode' }> => c.type === 'dispatchNode')
    .map((c) => c.nodeId);

// ===========================================================================
// instance-key helper
// ===========================================================================

describe('instance-key helpers', () => {
  it('round-trips instanceKey through parseInstanceKey', () => {
    expect(instanceKey('work', 3)).toBe('work@3');
    expect(parseInstanceKey('work@3')).toEqual({ docId: 'work', itemIndex: 3 });
    expect(parseInstanceKey('work')).toBeNull();
    expect(parseInstanceKey('work@')).toBeNull();
    expect(parseInstanceKey('work@x')).toBeNull();
    // greedy doc id: only the LAST @<digits> is the instance suffix
    expect(parseInstanceKey('a@2@5')).toEqual({ docId: 'a@2', itemIndex: 5 });
  });

  it('docNodeIdOf strips an instance suffix and passes a bare id through', () => {
    expect(docNodeIdOf('work@3')).toBe('work');
    expect(docNodeIdOf('work')).toBe('work');
  });
});

// ===========================================================================
// parallel dispatch + cap (plan tests 2, 3, 16)
// ===========================================================================

describe('parallel foreach — concurrent item dispatch (#4 A4b)', () => {
  it('dispatches items 0 and 1 concurrently under batchCount=2; item 2 waits for a slot', () => {
    const eng = engine([node('w', { x: '${item}' })], [], [pfe('fe', ['w'], '${params.list}')]);
    const r0 = eng.reduce(eng.seedState(), started({ list: ['a', 'b', 'c'] }));
    // Both instance dispatches emitted BEFORE either terminal — genuinely in flight
    // together. Item 2 must NOT start (cap 2).
    expect(dispatchIds(r0.commands)).toEqual(['w@0', 'w@1']);
    let s = r0.state;
    s = eng.reduce(s, dispatched('w@0', 'w@0#0')).state;
    s = eng.reduce(s, dispatched('w@1', 'w@1#0')).state;
    // Complete item 1 FIRST — the freed slot starts item 2.
    const r1 = eng.reduce(s, succeeded('w@1', 'w@1#0', { v: 1 }));
    expect(dispatchIds(r1.commands)).toEqual(['w@2']);
    s = r1.state;
    s = eng.reduce(s, dispatched('w@2', 'w@2#0')).state;
    s = eng.reduce(s, succeeded('w@0', 'w@0#0', { v: 0 })).state;
    const last = eng.reduce(s, succeeded('w@2', 'w@2#0', { v: 2 }));
    s = last.state;
    // results are ORDER-STABLE despite item 1 completing before item 0.
    expect(s.containers.fe!.status).toBe('success');
    expect(s.containers.fe!.outputs).toEqual({ results: [{ v: 0 }, { v: 1 }, { v: 2 }] });
    expect(last.commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });

  it('never seeds BARE-id child entries — instance entries only, deleted on item completion', () => {
    const eng = engine(
      [node('w'), node('after')],
      [edge('fe', 'after', 'success')],
      [pfe('fe', ['w'], '${params.list}')],
    );
    let sawBare = false;
    const { state } = drive(
      eng,
      { list: ['a', 'b'] },
      {
        onFold: (s) => {
          if ('w' in s.nodes) sawBare = true;
        },
      },
    );
    expect(sawBare).toBe(false);
    expect(state.status).toBe('success');
    // completed items' instance entries are deleted (state hygiene) — only the
    // outer node remains.
    expect(Object.keys(state.nodes).sort()).toEqual(['after']);
    expect(Object.keys(state.outputs).sort()).toEqual(['after', 'fe']);
  });

  it('a zero-item parallel foreach succeeds immediately with results: []', () => {
    const eng = engine(
      [node('w'), node('after')],
      [edge('fe', 'after', 'success')],
      [pfe('fe', ['w'], '${params.list}')],
    );
    const { state, commandsSeen } = drive(eng, { list: [] });
    expect(state.containers.fe!.status).toBe('success');
    expect(state.containers.fe!.outputs).toEqual({ results: [] });
    expect(commandsSeen.some((c) => c.type === 'dispatchNode' && c.nodeId.startsWith('w'))).toBe(
      false,
    );
    expect(state.status).toBe('success');
  });
});

// ===========================================================================
// per-item ${item} + sibling refs (plan tests 4, 5)
// ===========================================================================

describe('parallel foreach — per-item bindings', () => {
  it('binds ${item} per-instance for CONCURRENTLY in-flight items', () => {
    const eng = engine([node('w', { x: '${item}' })], [], [pfe('fe', ['w'], '${params.list}')]);
    const r0 = eng.reduce(eng.seedState(), started({ list: ['x', 'y'] }));
    const prepared = r0.commands
      .filter(
        (c): c is Extract<EngineCommand, { type: 'dispatchNode' }> => c.type === 'dispatchNode',
      )
      .map((c) => ({ nodeId: c.nodeId, input: c.preparedInput }));
    expect(prepared).toEqual([
      { nodeId: 'w@0', input: { x: 'x' } },
      { nodeId: 'w@1', input: { x: 'y' } },
    ]);
  });

  it('resolves ${nodes.<sibling>.output.*} to the SAME item instance', () => {
    const eng = engine(
      [node('a'), node('b', { got: '${nodes.a.output.v}' })],
      [edge('a', 'b', 'success')],
      [pfe('fe', ['a', 'b'], '${params.list}')],
    );
    const { state, commandsSeen } = drive(
      eng,
      { list: ['p', 'q'] },
      {
        outcomeFor: (nodeId) =>
          docNodeIdOf(nodeId) === 'a'
            ? { outcome: 'success', outputs: { v: `from-${nodeId}` } }
            : { outcome: 'success' },
      },
    );
    const bPreps = commandsSeen
      .filter(
        (c): c is Extract<EngineCommand, { type: 'dispatchNode' }> =>
          c.type === 'dispatchNode' && docNodeIdOf(c.nodeId) === 'b',
      )
      .map((c) => ({ nodeId: c.nodeId, input: c.preparedInput }));
    expect(bPreps).toEqual([
      { nodeId: 'b@0', input: { got: 'from-a@0' } },
      { nodeId: 'b@1', input: { got: 'from-a@1' } },
    ]);
    expect(state.status).toBe('success');
  });

  it('routes a branch (if) PER ITEM — instance branches never cross items', () => {
    const eng = engine(
      [node('route', { condition: '${item}' }, { type: 'if' }), node('yes'), node('no')],
      [
        { id: 'e1', from: 'route', to: 'yes', on: 'branch', branch: 'true' },
        { id: 'e2', from: 'route', to: 'no', on: 'branch', branch: 'false' },
      ],
      [pfe('fe', ['route', 'yes', 'no'], '${params.list}')],
    );
    const { state, log } = drive(eng, { list: [true, false] });
    // item 0 routes true → yes@0 ran, no@0 skipped; item 1 the reverse.
    const dispatchedIds = log
      .filter(
        (e): e is Extract<EngineEvent, { type: 'node.dispatched' }> => e.type === 'node.dispatched',
      )
      .map((e) => e.nodeId);
    expect(dispatchedIds).toContain('yes@0');
    expect(dispatchedIds).toContain('no@1');
    expect(dispatchedIds).not.toContain('no@0');
    expect(dispatchedIds).not.toContain('yes@1');
    expect(state.status).toBe('success');
  });
});

// ===========================================================================
// fail-fast drain + results shapes (plan tests 6, 7)
// ===========================================================================

describe('parallel foreach — fail-fast drain', () => {
  it('drains in-flight items, starts no new ones, exits child_failed:<instance>, keeps null holes', () => {
    const eng = engine(
      [node('w'), node('recover')],
      [edge('fe', 'recover', 'completion')],
      [pfe('fe', ['w'], '${params.list}')],
    );
    const r0 = eng.reduce(eng.seedState(), started({ list: ['a', 'b', 'c'] }));
    expect(dispatchIds(r0.commands)).toEqual(['w@0', 'w@1']);
    let s = r0.state;
    s = eng.reduce(s, dispatched('w@0', 'w@0#0')).state;
    s = eng.reduce(s, dispatched('w@1', 'w@1#0')).state;
    // item 1 FAILS while item 0 is still in flight → doomed: no new items start,
    // the container stays active until item 0 drains.
    const atFail = eng.reduce(s, failed('w@1', 'w@1#0'));
    expect(dispatchIds(atFail.commands)).toEqual([]); // w@2 never starts
    s = atFail.state;
    expect(s.containers.fe!.status).toBe('active'); // draining, not yet failed
    expect(s.status).toBe('running');
    // item 0 drains to terminal → container exits failure, blaming the instance.
    const afterDrain = eng.reduce(s, succeeded('w@0', 'w@0#0', { v: 0 }));
    s = afterDrain.state;
    expect(s.containers.fe!.status).toBe('failure');
    expect(s.containers.fe!.reason).toBe('child_failed:w@1');
    // FULL-LENGTH, index-aligned results with null holes (parallel contract —
    // deliberately different from sequential's prefix shape).
    expect(s.containers.fe!.outputs).toEqual({ results: [{ v: 0 }, null, null] });
    // outer completion edge catches the failure; the run continues.
    expect(dispatchIds(afterDrain.commands)).toEqual(['recover']);
    s = eng.reduce(s, dispatched('recover', 'recover#0')).state;
    const done = eng.reduce(s, succeeded('recover', 'recover#0'));
    expect(done.commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });

  it('sequential failure keeps the PREFIX results shape (divergence pinned both ways)', () => {
    // Same doc, batchCount ABSENT → sequential A4a: results hold only the items
    // COMPLETED before the failing one — no null holes.
    const eng = engine(
      [node('w'), node('recover')],
      [edge('fe', 'recover', 'completion')],
      [sfe('fe', ['w'], '${params.list}')],
    );
    const { state } = drive(
      eng,
      { list: ['a', 'b', 'c'] },
      {
        outcomeFor: (id, idx) =>
          id === 'w' && idx === 1
            ? { outcome: 'failure' }
            : { outcome: 'success', outputs: { v: idx } },
      },
    );
    expect(state.containers.fe!.status).toBe('failure');
    expect(state.containers.fe!.reason).toBe('child_failed:w');
    expect(state.containers.fe!.outputs).toEqual({ results: [{ v: 0 }] });
    expect(state.status).toBe('success');
  });
});

// ===========================================================================
// replay invariance + stale isolation (plan tests 9, 11)
// ===========================================================================

describe('parallel foreach — event-sourcing invariants', () => {
  it('replays the persisted log to the identical driven state', () => {
    const eng = engine(
      [node('a'), node('b', { got: '${nodes.a.output.v}' }), node('after')],
      [edge('a', 'b', 'success'), edge('fe', 'after', 'success')],
      [pfe('fe', ['a', 'b'], '${params.list}')],
    );
    const { state, log } = drive(
      eng,
      { list: ['p', 'q', 'r'] },
      {
        outcomeFor: (nodeId) =>
          docNodeIdOf(nodeId) === 'a'
            ? { outcome: 'success', outputs: { v: nodeId } }
            : { outcome: 'success' },
      },
    );
    expect(state.status).toBe('success');
    expect(eng.projectRunState(log)).toEqual(state);
  });

  it('a late terminal for a COMPLETED item (entries deleted) is a benign no-op', () => {
    const eng = engine([node('w')], [], [pfe('fe', ['w'], '${params.list}')]);
    const r0 = eng.reduce(eng.seedState(), started({ list: ['a', 'b'] }));
    let s = r0.state;
    s = eng.reduce(s, dispatched('w@0', 'w@0#0')).state;
    s = eng.reduce(s, dispatched('w@1', 'w@1#0')).state;
    s = eng.reduce(s, succeeded('w@0', 'w@0#0', { v: 0 })).state;
    expect(s.nodes['w@0']).toBeUndefined(); // item 0 complete, entries deleted
    // A duplicate/stale terminal for the deleted instance folds to NOTHING.
    const stale = eng.reduce(s, succeeded('w@0', 'w@0#0', { v: 99 }));
    expect(stale.state).toEqual(s);
    expect(stale.commands).toEqual([]);
    // ... and the run still finishes normally.
    const done = eng.reduce(s, succeeded('w@1', 'w@1#0', { v: 1 }));
    expect(done.state.containers.fe!.outputs).toEqual({ results: [{ v: 0 }, { v: 1 }] });
    expect(done.commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });
});

// ===========================================================================
// retry inside a parallel body (plan test 10)
// ===========================================================================

describe('parallel foreach — F2b retry on an instance key', () => {
  it('holds one item retry_pending without blocking the sibling; the retry completes the item', () => {
    const eng = engine(
      [node('w', {}, { policy: { retry: 1 } })],
      [],
      [pfe('fe', ['w'], '${params.list}')],
    );
    const r0 = eng.reduce(eng.seedState(), started({ list: ['a', 'b'] }));
    let s = r0.state;
    s = eng.reduce(s, dispatched('w@0', 'w@0#0')).state;
    s = eng.reduce(s, dispatched('w@1', 'w@1#0')).state;
    // item 1 fails TRANSIENTLY → held on the INSTANCE key, retry scheduled.
    const atFail = eng.reduce(s, failed('w@1', 'w@1#0', 'flaky', 'transient'));
    expect(atFail.commands).toEqual([
      { type: 'scheduleRetry', nodeId: 'w@1', failedAttemptId: 'w@1#0' },
    ]);
    s = atFail.state;
    expect(s.nodes['w@1']!.status).toBe('retry_pending');
    // the sibling item is NOT blocked by the hold — it completes normally.
    s = eng.reduce(s, succeeded('w@0', 'w@0#0', { v: 0 })).state;
    expect(s.nodes['w@0']).toBeUndefined(); // item 0 completed + cleaned
    // the alarm fires → a fresh attempt on the instance key.
    const due = eng.reduce(s, {
      type: 'node.retryDue',
      runId: RUN,
      nodeId: 'w@1',
      previousAttemptId: 'w@1#0',
    });
    expect(dispatchIds(due.commands)).toEqual(['w@1']);
    s = due.state;
    expect(s.nodes['w@1']!.currentAttemptId).toBe('w@1#1');
    s = eng.reduce(s, dispatched('w@1', 'w@1#1')).state;
    const done = eng.reduce(s, succeeded('w@1', 'w@1#1', { v: 1 }));
    expect(done.state.containers.fe!.status).toBe('success');
    expect(done.state.containers.fe!.outputs).toEqual({ results: [{ v: 0 }, { v: 1 }] });
    expect(done.commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });
});

// ===========================================================================
// crash recovery (plan test 12) + call_pipeline instances (plan test 13)
// ===========================================================================

describe('parallel foreach — crash recovery re-emits BOTH in-flight instances (#569 parity)', () => {
  it('resume re-derives per-item dispatches with the correct ${item} each', () => {
    const eng = engine([node('w', { x: '${item}' })], [], [pfe('fe', ['w'], '${params.list}')]);
    // A log that ends the instant both items started (dispatch commands LOST).
    const projected = eng.projectRunState([started({ list: ['p', 'q'] })]);
    expect(projected.nodes['w@0']!.status).toBe('ready');
    expect(projected.nodes['w@1']!.status).toBe('ready');
    const { commands } = eng.resume(projected);
    const dispatches = commands
      .filter(
        (c): c is Extract<EngineCommand, { type: 'dispatchNode' }> => c.type === 'dispatchNode',
      )
      .map((c) => ({ nodeId: c.nodeId, attemptId: c.attemptId, input: c.preparedInput }));
    expect(dispatches).toEqual([
      { nodeId: 'w@0', attemptId: 'w@0#0', input: { x: 'p' } },
      { nodeId: 'w@1', attemptId: 'w@1#0', input: { x: 'q' } },
    ]);
    expect(commands.some((c) => c.type === 'finishRun')).toBe(false);
  });
});

describe('parallel foreach — call_pipeline instances (plan test 13)', () => {
  it('mints DISTINCT deterministic childRunIds per item instance', () => {
    const eng = engine(
      [callNode('call', 'child_pv', { sku: '${item}' })],
      [],
      [pfe('fe', ['call'], '${params.list}')],
    );
    const r0 = eng.reduce(eng.seedState(), started({ list: ['p', 'q'] }));
    const starts = r0.commands.filter(
      (c): c is Extract<EngineCommand, { type: 'startChild' }> => c.type === 'startChild',
    );
    expect(starts.map((c) => c.callNodeId)).toEqual(['call@0', 'call@1']);
    expect(starts.map((c) => c.params)).toEqual([{ sku: 'p' }, { sku: 'q' }]);
    expect(starts[0]!.childRunId).not.toBe(starts[1]!.childRunId);
    // both children return → items complete, results aggregate.
    let s = r0.state;
    s = eng.reduce(
      s,
      returned('call@0', 'call@0#0', 'success', { out: 'p' }, starts[0]!.childRunId),
    ).state;
    const done = eng.reduce(
      s,
      returned('call@1', 'call@1#0', 'success', { out: 'q' }, starts[1]!.childRunId),
    );
    expect(done.state.containers.fe!.outputs).toEqual({
      results: [{ out: 'p' }, { out: 'q' }],
    });
    expect(done.commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });
});

// ===========================================================================
// batchCount: 1 — explicit sequential (plan test 14)
// ===========================================================================

describe('foreach batchCount: 1 — byte-identical sequential behaviour', () => {
  it('drives to the SAME state as an absent batchCount (round machinery, prefix results)', () => {
    const mk = (bc: number | undefined) =>
      engine(
        [node('w'), node('recover')],
        [edge('fe', 'recover', 'completion')],
        [
          bc === undefined
            ? sfe('fe', ['w'], '${params.list}')
            : pfe('fe', ['w'], '${params.list}', bc),
        ],
      );
    const opts: DriveOpts = {
      outcomeFor: (id, idx) =>
        id === 'w' && idx === 1
          ? { outcome: 'failure' }
          : { outcome: 'success', outputs: { v: idx } },
    };
    const explicit = drive(mk(1), { list: ['a', 'b', 'c'] }, opts);
    const absent = drive(mk(undefined), { list: ['a', 'b', 'c'] }, opts);
    expect(explicit.state).toEqual(absent.state);
    expect(explicit.log).toEqual(absent.log);
    // and it IS the round machinery: bare ids, no instance keys anywhere.
    expect(explicit.log.every((e) => !('nodeId' in e) || !e.nodeId.includes('@'))).toBe(true);
    expect(explicit.state.containers.fe!.outputs).toEqual({ results: [{ v: 0 }] });
  });
});
