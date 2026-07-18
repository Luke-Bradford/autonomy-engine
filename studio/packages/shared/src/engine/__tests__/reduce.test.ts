import { describe, expect, it } from 'vitest';
import type { Edge, EdgeOn, EngineCommand, EngineEvent, FailureKind, Node } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { BUILTIN_PRICE_TABLE_VERSION } from '../../pricing/price-table.js';
import { driveRun } from './helpers/run-driver.js';

// --- helpers ---------------------------------------------------------------

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 } };
}

function edge(from: string, to: string, on: EdgeOn): Edge {
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
/**
 * `kind` (#1 F0) defaults to `permanent` — the same value the parse boundary
 * gives a pre-F0 event, so these cases keep asserting exactly what they did
 * before the field existed. The reducer does not read `kind` yet (F2b does);
 * the scope-lock test below pins that.
 */
function failed(
  nodeId: string,
  attemptId: string,
  error = 'boom',
  kind: FailureKind = 'permanent',
): EngineEvent {
  return { type: 'node.failed', runId: RUN, nodeId, attemptId, error, kind };
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
 * exactly as a P2d driver would. A thin adapter over the shared `driveRun`
 * mechanic (`helpers/run-driver.ts`); this file keeps its OWN resolver rather than the
 * shared `simpleResolve`, because its per-node `plan` carries custom outputs and
 * error strings the simple form does not. Returns the shared `DriveResult` (its
 * `state` + full event `log` are what these tests read).
 */
function runAll(eng: Engine, params: Record<string, unknown>, plan: Plan) {
  return driveRun(eng, {
    params,
    // `succeeded`/`failed` hardcode the module `RUN`, which equals `driveRun`'s
    // default runId, so ignoring the passed `runId` here stays consistent.
    resolve: (nodeId, attemptId) => {
      const p = plan[nodeId] ?? { outcome: 'success' };
      return p.outcome === 'success'
        ? succeeded(nodeId, attemptId, p.outputs ?? {})
        : failed(nodeId, attemptId, p.error ?? 'boom');
    },
  });
}

function dispatchIds(cmds: EngineCommand[]): string[] {
  return cmds.filter((c) => c.type === 'dispatchNode').map((c) => (c as { nodeId: string }).nodeId);
}

/** Find + NARROW a `dispatchNode` command (optionally for a specific node) on
 * `.type`, so its `preparedInput` is read without an unchecked union cast. */
function dispatchCmd(cmds: EngineCommand[], nodeId?: string) {
  const cmd = cmds.find(
    (c) => c.type === 'dispatchNode' && (nodeId === undefined || c.nodeId === nodeId),
  );
  if (cmd?.type !== 'dispatchNode')
    throw new Error(`no dispatchNode command${nodeId === undefined ? '' : ` for ${nodeId}`}`);
  return cmd;
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
    // b fails (caught by b->catch on failure); d(join:all) needs a AND b on success.
    const eng = engine(
      [node('a'), node('b'), node('d', { join: 'all' }), node('catch')],
      [edge('a', 'd', 'success'), edge('b', 'd', 'success'), edge('b', 'catch', 'failure')],
    );
    const { state } = runAll(eng, {}, { b: { outcome: 'failure' } });
    expect(state.nodes.d!.status).toBe('skipped'); // b->d unsatisfied-terminal
    expect(state.nodes.catch!.status).toBe('success');
    // The READINESS assertions above are what this test is for, and they are
    // unchanged. The run OUTCOME flipped in F1b and the old comment here said
    // "b's failure was handled" — true, but no longer sufficient: `b` IS
    // absorbed by `catch`, yet the skipped leaf `d` recurses to its parents and
    // finds `b` failed. Every parent is evaluated and ANY evaluated failure
    // fails the run (§C.5.1), so an "ALL parents must fail" reading — under
    // which this would stay green — is explicitly NOT the rule.
    expect(state.status).toBe('failure');
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
    // `skipped`, not `pending`: F1b's drain lets the walk finish, so n2 reaches
    // its real verdict (its only incoming edge is unsatisfied-terminal) instead
    // of being frozen mid-walk by the old eager short-circuit. Observational —
    // n2 is not dispatched either way, and the run outcome is unchanged.
    expect(state.nodes.n2!.status).toBe('skipped');
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

  // #6 E6 — `number` means FINITE here too. `matchesType` used to accept any
  // `!isNaN` value, so a declared-`number` output could hold `Infinity` while
  // the fn-signature check (`matchesSig`) rejects exactly that — two definitions
  // of one word in one engine. E6 types `${nodes.a.output.count}` as `number`
  // from this very declaration, so the looser one had to go.
  it('a NON-FINITE number output FAILS the node (number means finite)', () => {
    const eng = engine([node('a', { outputs: [{ name: 'count', type: 'number' }] })]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const r = eng.reduce(s, succeeded('a', attempt('a'), { count: Number.POSITIVE_INFINITY }));
    expect(r.state.nodes.a!.status).toBe('failure');
    expect(r.state.outputs.a).toBeUndefined();
    expect(r.diagnostics.join(' ')).toContain('invalid outputs');
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

  it('the root node dispatch substitutes ${run.runId} and ${params.*}', () => {
    const eng = engine([node('a', { rid: '${run.runId}', t: '${params.topic}' })]);
    const r = eng.reduce(eng.seedState(), started({ topic: 'x' }));
    const a = r.commands.find((c) => c.type === 'dispatchNode') as {
      preparedInput: Record<string, unknown>;
    };
    expect(a.preparedInput).toEqual({ rid: RUN, t: 'x' });
  });
});

// ===========================================================================
// #6 E3 — ${run.startedAt} + ${nodes.<id>.status} resolve from LOGGED FACTS
// ===========================================================================

describe('run.startedAt — the seeded, replay-stable timestamp', () => {
  const STAMP = '2026-07-15T09:00:00.000Z';
  const stamped = (): EngineEvent => ({
    type: 'run.started',
    runId: RUN,
    pipelineVersionId: PV,
    startedAt: STAMP,
    params: {},
  });

  it('folds the stamp into state and substitutes it', () => {
    const eng = engine([node('a', { at: '${run.startedAt}' })]);
    const r = eng.reduce(eng.seedState(), stamped());
    expect(r.state.startedAt).toBe(STAMP);
    const a = r.commands.find((c) => c.type === 'dispatchNode') as {
      preparedInput: Record<string, unknown>;
    };
    expect(a.preparedInput).toEqual({ at: STAMP });
  });

  // The reducer reads no clock, so the ONLY input is the logged fact — folding
  // the same log twice must give the same answer, which is what makes
  // `${run.startedAt}` safe to use in a durable name (a commit path, a filename).
  it('is identical on replay', () => {
    const eng = engine([node('a', { at: '${run.startedAt}' })]);
    const first = eng.projectRunState([stamped()]);
    const second = eng.projectRunState([stamped()]);
    expect(second.startedAt).toBe(first.startedAt);
    expect(second).toEqual(first);
  });

  // A `run.started` row appended before E3 carries no stamp. It must still fold
  // (never throw), which is why the event field is optional.
  it('folds a pre-E3 log with no stamp to null', () => {
    const eng = engine([node('a', {})]);
    expect(eng.reduce(eng.seedState(), started()).state.startedAt).toBeNull();
  });
});

// ===========================================================================
// #5 S12 — ${trigger.*} resolves from the durable run.triggerContext seed
// ===========================================================================

describe('run.triggerContext — the fire-time trigger seed (#5 S12)', () => {
  const SCHED = '2026-07-17T09:00:00.000Z';
  const tctx = (
    over: Partial<Extract<EngineEvent, { type: 'run.triggerContext' }>> = {},
  ): EngineEvent => ({
    type: 'run.triggerContext',
    runId: RUN,
    triggerId: 'trg-1',
    ...over,
  });

  it('folds into the pending seed and is carried across run.started', () => {
    const eng = engine([
      node('a', { when: '${trigger.scheduledTime}', who: '${trigger.triggerId}' }),
    ]);
    const s = eng.reduce(eng.seedState(), tctx({ scheduledTime: SCHED })).state;
    expect(s.status).toBe('pending');
    expect(s.triggerContext).toEqual({ triggerId: 'trg-1', scheduledTime: SCHED, body: null });
    const r = eng.reduce(s, started());
    // Survives the started transition and is readable by the first dispatch.
    expect(r.state.triggerContext).toEqual({
      triggerId: 'trg-1',
      scheduledTime: SCHED,
      body: null,
    });
    expect(dispatchCmd(r.commands).preparedInput).toEqual({ when: SCHED, who: 'trg-1' });
  });

  it('closes the run.triggerId null-seed gap — ${run.triggerId} reads the fired trigger', () => {
    const eng = engine([node('a', { t: '${run.triggerId}' })]);
    const s = eng.reduce(eng.seedState(), tctx()).state;
    const r = eng.reduce(s, started());
    expect(dispatchCmd(r.commands).preparedInput).toEqual({ t: 'trg-1' });
  });

  it('deep-addresses ${trigger.body.x} as the runtime-validated json escape hatch', () => {
    const eng = engine([node('a', { msg: '${trigger.body.text}' })]);
    const s = eng.reduce(eng.seedState(), tctx({ body: { text: 'hello' } })).state;
    const r = eng.reduce(s, started());
    expect(dispatchCmd(r.commands).preparedInput).toEqual({ msg: 'hello' });
  });

  it('a run with NO trigger seed resolves ${trigger.scheduledTime} to null', () => {
    const eng = engine([node('a', { when: '${trigger.scheduledTime}' })]);
    const r = eng.reduce(eng.seedState(), started());
    expect(r.state.triggerContext).toBeNull();
    expect(dispatchCmd(r.commands).preparedInput).toEqual({ when: null });
  });

  it('a FOREIGN-run run.interrupted does NOT terminalize a seeded pending run (identity check)', () => {
    const eng = engine([node('a', {})]);
    const s = eng.reduce(eng.seedState(), tctx()).state; // seed establishes runId = RUN
    const r = eng.reduce(s, {
      type: 'run.interrupted',
      runId: 'other-run',
      reason: 'drive_failed',
    });
    expect(r.state.status).toBe('pending'); // untouched — the interrupt was for another run
  });

  it('a SECOND run.triggerContext on a still-pending run is a no-op + diagnostic (first wins)', () => {
    const eng = engine([node('a', {})]);
    const s = eng.reduce(eng.seedState(), tctx({ scheduledTime: SCHED })).state;
    const r = eng.reduce(
      s,
      tctx({ triggerId: 'other', scheduledTime: '2099-01-01T00:00:00.000Z' }),
    );
    // The first seed is untouched — a malformed log cannot rewrite run identity.
    expect(r.state.triggerContext).toEqual({
      triggerId: 'trg-1',
      scheduledTime: SCHED,
      body: null,
    });
    expect(r.diagnostics.join(' ')).toContain(
      'impossible run.triggerContext: the run is already seeded',
    );
  });

  it('a run.triggerContext after the run started is an impossible-log no-op + diagnostic', () => {
    const eng = engine([node('a', {})]);
    const s = eng.reduce(eng.seedState(), started()).state;
    const r = eng.reduce(s, tctx({ scheduledTime: SCHED }));
    expect(r.state.triggerContext).toBeNull(); // unchanged — never mutates a live run
    expect(r.diagnostics.join(' ')).toContain('impossible run.triggerContext');
  });

  it('is identical on replay (folds the same log to the same state)', () => {
    const eng = engine([node('a', { when: '${trigger.scheduledTime}' })]);
    const log: EngineEvent[] = [tctx({ scheduledTime: SCHED }), started()];
    expect(eng.projectRunState(log)).toEqual(eng.projectRunState(log));
  });

  // A run interrupted between the trigger seed and run.started (the driver
  // faulted) must terminalize in the PROJECTION, not just via a row patch — so a
  // re-fold of [run.triggerContext, run.interrupted] agrees with the persisted
  // row. Without this the fold would no-op on the pending state and diverge.
  it('run.interrupted on a pending seeded run folds to interrupted (row == projection)', () => {
    const eng = engine([node('a')]);
    const log: EngineEvent[] = [
      tctx(),
      { type: 'run.interrupted', runId: RUN, reason: 'drive_failed' },
    ];
    const state = eng.projectRunState(log);
    expect(state.status).toBe('interrupted');
    // The seed still survived the transition — the interrupt does not wipe it.
    expect(state.triggerContext).toEqual({ triggerId: 'trg-1', scheduledTime: null, body: null });
  });
});

describe('${nodes.<id>.status} — resolves from the run log (#6 E3 T6)', () => {
  it('reads an upstream FAILURE, where the output is unavailable', () => {
    // The ADF fan-in/OR shape: `b` runs only on a's failure and reports which
    // way a went. This is the case the status handle exists for — a's outputs do
    // not exist on this path, so nothing else could express it.
    const eng = engine(
      [node('a'), node('b', { saw: '${nodes.a.status}' })],
      [edge('a', 'b', 'failure')],
    );
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const r = eng.reduce(s, failed('a', attempt('a'), 'boom'));
    const b = r.commands.find((c) => c.type === 'dispatchNode' && c.nodeId === 'b') as {
      preparedInput: Record<string, unknown>;
    };
    expect(b.preparedInput).toEqual({ saw: 'failure' });
  });

  it('reads an upstream SUCCESS', () => {
    const eng = engine(
      [node('a'), node('b', { saw: '${nodes.a.status}' })],
      [edge('a', 'b', 'success')],
    );
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const r = eng.reduce(s, succeeded('a', attempt('a'), {}));
    const b = r.commands.find((c) => c.type === 'dispatchNode' && c.nodeId === 'b') as {
      preparedInput: Record<string, unknown>;
    };
    expect(b.preparedInput).toEqual({ saw: 'success' });
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

// ===========================================================================
// SECURITY — node.succeeded stores ONLY the node's declared output keys
// ===========================================================================

describe('declared-output filtering (security)', () => {
  it('drops an undeclared key an executor sneaks into node.succeeded outputs', () => {
    const eng = engine(
      [
        node('a', { outputs: [{ name: 'safe', type: 'string' }] }),
        node('b', {
          // References BOTH the declared and the undeclared key.
          safe: '${nodes.a.output.safe}',
          leaked: '${default(nodes.a.output.secret, "fallback")}',
        }),
      ],
      [edge('a', 'b', 'success')],
    );
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const r = eng.reduce(s, succeeded('a', attempt('a'), { safe: 'ok', secret: 'do-not-persist' }));

    // Only the declared key is stored — the undeclared one is dropped entirely.
    expect(r.state.outputs.a).toEqual({ safe: 'ok' });
    expect(r.state.outputs.a).not.toHaveProperty('secret');

    const b = r.commands.find((c) => c.type === 'dispatchNode' && c.nodeId === 'b') as
      { preparedInput: Record<string, unknown> } | undefined;
    expect(b).toBeDefined();
    // The undeclared ref resolves via default()'s MissingNodeOutput fallback,
    // never the leaked value — proving it never crossed into substitution.
    expect(b!.preparedInput).toEqual({ safe: 'ok', leaked: 'fallback' });
  });

  it('a node with NO declared outputs still passes its whole payload through (no contract to enforce)', () => {
    const eng = engine(
      [node('a'), node('b', { msg: '${nodes.a.output.greeting}' })],
      [edge('a', 'b', 'success')],
    );
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const r = eng.reduce(s, succeeded('a', attempt('a'), { greeting: 'hi' }));
    expect(r.state.outputs.a).toEqual({ greeting: 'hi' });
  });
});

// ===========================================================================
// `run.finished` totality guard — a `success` claim must be backed by reality
// ===========================================================================

describe('run.finished totality guard', () => {
  it('an early/forged run.finished{success} with a still-pending node is REJECTED, not silently applied', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const s = eng.reduce(eng.seedState(), started()).state; // b still pending
    const r = eng.reduce(s, { type: 'run.finished', runId: RUN, outcome: 'success' });
    expect(r.state.status).toBe('running'); // NOT silently terminalized
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.join(' ')).toContain('impossible run.finished');
    expect(r.commands).toContainEqual({
      type: 'finishRun',
      outcome: 'failure',
      reason: 'invalid_event',
    });
  });

  it('a genuine run.finished{success} once every node is terminal is accepted', () => {
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    s = eng.reduce(s, succeeded('a', attempt('a'))).state;
    const r = eng.reduce(s, { type: 'run.finished', runId: RUN, outcome: 'success' });
    expect(r.state.status).toBe('success');
  });

  it("a run.finished{failure} is always accepted (the reducer's own fail-safe escape valve)", () => {
    // Mirrors settle()'s own unhandled-failure exit: b never dispatched, yet
    // the correcting run.finished{failure} must still be able to terminalize.
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const failedResult = eng.reduce(s, failed('a', attempt('a')));
    const r = eng.reduce(failedResult.state, {
      type: 'run.finished',
      runId: RUN,
      outcome: 'failure',
      reason: 'node_failed:a',
    });
    expect(r.state.status).toBe('failure');
  });
});

// ===========================================================================
// `run.interrupted` — the boot-reconciler's "cannot safely resume" terminal
// ===========================================================================

describe('run.interrupted', () => {
  it('folds a running run to interrupted, leaving the in-flight node dispatched', () => {
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state; // dispatch a#0
    s = eng.reduce(s, dispatched('a', attempt('a'))).state; // a is `dispatched`
    const r = eng.reduce(s, { type: 'run.interrupted', runId: RUN, reason: 'non_idempotent' });
    expect(r.state.status).toBe('interrupted');
    // The node is NOT terminalized — it stays dispatched/needs-attention.
    expect(r.state.nodes.a!.status).toBe('dispatched');
    expect(r.commands).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it('is a benign no-op (no diagnostic) on an already-terminal run', () => {
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    s = eng.reduce(s, succeeded('a', attempt('a'))).state;
    s = eng.reduce(s, { type: 'run.finished', runId: RUN, outcome: 'success' }).state;
    const r = eng.reduce(s, { type: 'run.interrupted', runId: RUN, reason: 'late' });
    expect(r.state.status).toBe('success'); // unchanged
    expect(r.diagnostics).toEqual([]);
  });

  it('ignores a run.interrupted for a DIFFERENT run', () => {
    const eng = engine([node('a')]);
    const s = eng.reduce(eng.seedState(), started()).state;
    const r = eng.reduce(s, { type: 'run.interrupted', runId: 'other', reason: 'x' });
    expect(r.state.status).toBe('running');
    expect(r.diagnostics).toEqual([]);
  });
});

// ===========================================================================
// `run.resumed` reconstructs a crash-dropped `finishRun`
// ===========================================================================

describe('run.resumed reconstructs a dropped finishRun', () => {
  it('re-emits finishRun{success} for a run whose every node is terminal but run.finished never landed', () => {
    // Simulate a crash between the terminal node event and run.finished: fold up
    // to node.succeeded (taking only .state, so the emitted finishRun is dropped
    // exactly as a crash would drop it). The projection is stuck `running`.
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    s = eng.reduce(s, succeeded('a', attempt('a'))).state;
    expect(s.status).toBe('running');
    expect(s.nodes.a!.status).toBe('success');

    // A ready/waiting-only resume would emit NOTHING here (no live node); the
    // walk re-run is what regenerates the dropped terminal command.
    const r = eng.reduce(s, { type: 'run.resumed', runId: RUN, reason: 'boot_reconcile' });
    expect(r.commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });

  it('re-emits finishRun{failure} for a crash-dropped unhandled failure', () => {
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    s = eng.reduce(s, failed('a', attempt('a'))).state; // finishRun{failure} dropped
    expect(s.status).toBe('running');

    const r = eng.reduce(s, { type: 'run.resumed', runId: RUN, reason: 'boot_reconcile' });
    expect(r.commands).toContainEqual({
      type: 'finishRun',
      outcome: 'failure',
      reason: 'node_failed:a',
    });
  });

  it('still re-emits a ready node dispatch (mechanism 1) alongside the walk re-run', () => {
    // A chain a→b: a succeeded, b dispatch decided (ready) but node.dispatched
    // never landed. Resume must re-emit b's dispatch (not finishRun — b is live).
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    s = eng.reduce(s, succeeded('a', attempt('a'))).state; // emits dispatch b → b ready
    expect(s.nodes.b!.status).toBe('ready');

    const r = eng.reduce(s, { type: 'run.resumed', runId: RUN, reason: 'boot_reconcile' });
    expect(dispatchIds(r.commands)).toEqual(['b']);
    expect(r.commands.some((c) => c.type === 'finishRun')).toBe(false);
  });

  it('a READY node whose dispatch prep throws terminalizes — it must not silently hang', () => {
    // DEFENSIVE, and deliberately labelled as such: no log reaches this state
    // today. `tryDispatchNode` PREPS BEFORE it folds, so a node only becomes
    // `ready` once its prep has succeeded, and nothing later removes an upstream
    // output (`resetNodes` is gated behind a whole-body-terminal back-edge, which
    // a live `ready` node blocks). The state is therefore built by hand — the
    // reducer must be TOTAL over states, not only over the ones today's events
    // happen to produce.
    //
    // It is fixed anyway because of what F2c changes: `onResumed` was the ONLY
    // dispatch derivation that swallowed a prep throw (`tryDispatchNode`,
    // `onRetryDue` and `onRetryRequested` all terminalize with
    // `finishRun{invalid_event}`), and that asymmetry was survivable only while
    // resume ran once per boot. `driveRun` makes it the RUNTIME path for every
    // retry, and it discards `onRetryDue`'s terminalize in favour of this
    // derivation — so a swallowed throw here would be a permanent hang with a
    // spent alarm. Closing the class costs six lines; leaving it depends on an
    // unreachability argument holding forever.
    const eng = engine(
      [node('a'), node('b', { m: '${nodes.a.output.g}' })],
      [edge('a', 'b', 'success')],
    );
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    s = eng.reduce(s, succeeded('a', attempt('a'), { g: 'hi' })).state;
    expect(s.nodes.b!.status).toBe('ready');

    // Drop the output `b`'s prep depends on: `b` stays `ready`, its prep now throws.
    const r = eng.resume({ ...s, outputs: {} });

    expect(r.commands).toContainEqual({
      type: 'finishRun',
      outcome: 'failure',
      reason: 'invalid_event',
    });
    expect(r.diagnostics.some((d) => d.includes("dispatch prep failed for node 'b'"))).toBe(true);
  });
});

// ===========================================================================
// #1 F2c — `engine.resume()`: the PURE seam `driveRun` re-derives commands from
// ===========================================================================

describe('engine.resume — the pure re-derivation seam (F2c)', () => {
  it('yields exactly what folding run.resumed yields, without needing the event', () => {
    // The seam exists because `driveRun` must re-project from the log INSIDE the
    // per-run lock and recover the commands `projectRunState` discards — but it
    // must NOT append `run.resumed`, which is BOOT's durable fact and would be a
    // lie mid-run. Same derivation, no event: that equivalence is the contract,
    // so it is asserted rather than assumed.
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    s = eng.reduce(s, succeeded('a', attempt('a'))).state;

    const viaEvent = eng.reduce(s, { type: 'run.resumed', runId: RUN, reason: 'boot_reconcile' });
    const viaSeam = eng.resume(s);

    expect(viaSeam.commands).toEqual(viaEvent.commands);
    expect(viaSeam.state).toEqual(viaEvent.state);
  });

  it('is PURE — it appends nothing and leaves the input state untouched', () => {
    const eng = engine([node('a')]);
    const s = eng.reduce(eng.seedState(), started()).state;
    const before = JSON.parse(JSON.stringify(s)) as unknown;

    eng.resume(s);

    expect(s).toEqual(before);
  });

  it('emits NOTHING for a terminal run — a settled run must never be re-driven', () => {
    // `driveRun` already refuses a run whose LOG holds a terminal fact (#443);
    // this is the engine-side backstop, so a caller that skipped that check
    // cannot re-dispatch a finished run's nodes.
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    s = eng.reduce(s, succeeded('a', attempt('a'))).state;
    s = eng.reduce(s, { type: 'run.finished', runId: RUN, outcome: 'success' }).state;
    expect(s.status).toBe('success');

    expect(eng.resume(s).commands).toEqual([]);
  });

  it('emits NOTHING for a pending (pre-run.started) state', () => {
    const eng = engine([node('a')]);
    expect(eng.resume(eng.seedState()).commands).toEqual([]);
  });
});

// ===========================================================================
// `node.retryRequested` — only a dispatched/ready node may be retried
// ===========================================================================

describe('node.retryRequested status guard', () => {
  it('a retry for an already-SUCCESS node is a no-op + diagnostic (outputs kept, not resurrected)', () => {
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    s = eng.reduce(s, succeeded('a', attempt('a'), { ok: true })).state;

    const r = eng.reduce(s, {
      type: 'node.retryRequested',
      runId: RUN,
      nodeId: 'a',
      previousAttemptId: attempt('a'),
      reason: 'boot_reconcile',
    });
    expect(r.state).toEqual(s); // no state change at all
    expect(r.state.nodes.a!.status).toBe('success');
    expect(r.state.outputs.a).toEqual({ ok: true }); // outputs kept
    expect(r.commands).toEqual([]);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it('a retry for a still-PENDING node (never dispatched) is a no-op + diagnostic', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const s = eng.reduce(eng.seedState(), started()).state; // b pending
    const r = eng.reduce(s, {
      type: 'node.retryRequested',
      runId: RUN,
      nodeId: 'b',
      previousAttemptId: 'b#0',
      reason: 'boot_reconcile',
    });
    expect(r.state).toEqual(s);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it('a retry for a DISPATCHED node (the real boot-reconcile case) still mints a fresh attempt', () => {
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const r = eng.reduce(s, {
      type: 'node.retryRequested',
      runId: RUN,
      nodeId: 'a',
      previousAttemptId: attempt('a'),
      reason: 'boot_reconcile',
    });
    expect(r.state.nodes.a!.currentAttemptId).toBe('a#1');
    expect(dispatchIds(r.commands)).toEqual(['a']);
    expect(r.diagnostics).toEqual([]);
  });
});

// ===========================================================================
// `node.dispatched` — an impossible (never-ready) case is diagnosed, not
// silently swallowed as "stale"; the normal handshake keeps working
// ===========================================================================

describe('node.dispatched impossible-case diagnostic', () => {
  it('a node.dispatched for a never-ready PENDING node is diagnosed as impossible, not a silent stale no-op', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const s = eng.reduce(eng.seedState(), started()).state; // b is pending, never made ready
    const r = eng.reduce(s, dispatched('b', 'b#0'));
    expect(r.state).toEqual(s); // no state change
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.join(' ')).toContain('impossible');
  });

  it('the normal ready→dispatched handshake still works (deadlock-free)', () => {
    const eng = engine([node('a')]);
    const s = eng.reduce(eng.seedState(), started()).state; // a is ready, attemptId a#0
    expect(s.nodes.a!.status).toBe('ready');
    const r = eng.reduce(s, dispatched('a', 'a#0'));
    expect(r.state.nodes.a!.status).toBe('dispatched');
    expect(r.diagnostics).toEqual([]);
  });
});

// ===========================================================================
// Minor: run.started copies params (never aliases the event), and a
// same-attempt success→failed contradiction gets a distinct diagnostic
// ===========================================================================

describe('minor hardening', () => {
  it('run.started stores params via a COPY, never a reference to the event object', () => {
    const eng = engine([node('a')]);
    const eventParams = { topic: 'launch' };
    const ev = started(eventParams);
    const s = eng.reduce(eng.seedState(), ev).state;
    expect(s.params).toEqual({ topic: 'launch' });
    expect(s.params).not.toBe(eventParams); // not the same object reference
    // Mutating the original logged event's params object must never leak in.
    (eventParams as Record<string, unknown>)['topic'] = 'mutated';
    expect(s.params['topic']).toBe('launch');
  });

  it('a node.failed naming the SAME attempt as an already-success node is a CONTRADICTION, not a duplicate', () => {
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    s = eng.reduce(s, succeeded('a', attempt('a'))).state;
    const r = eng.reduce(s, failed('a', attempt('a')));
    expect(r.state.nodes.a!.status).toBe('success'); // stays terminal/safe
    expect(r.diagnostics.join(' ')).toContain('contradiction');
  });
});

describe('#1 F0/F2b — a failure kind alone never retries: policy is what opts a node in', () => {
  // This block was F0's SCOPE LOCK ("kind is carried, not yet acted on"). F2b has
  // now landed, so the old framing is stale — but the tests are NOT: they pin
  // what is arguably F2b's most important property, which is that adding retry
  // changed NOTHING for a node with no `policy`. None of these docs declare one,
  // so eligibility is `retries < 0` — false — and a `transient` failure settles
  // exactly as it did before F2b existed. Every doc written before this ticket is
  // unaffected, and these are the tests that say so.
  //
  // The retry path itself (a node WITH a policy) is `retry-state-machine.test.ts`.
  for (const kind of ['transient', 'permanent', 'cancelled'] as const) {
    it(`settles a '${kind}' failure with NO policy to terminal 'failure', no retry command`, () => {
      const eng = engine([node('a')]);
      let s = eng.reduce(eng.seedState(), started()).state;
      s = eng.reduce(s, dispatched('a', attempt('a'))).state;

      const r = eng.reduce(s, failed('a', attempt('a'), 'boom', kind));

      expect(r.state.nodes.a!.status).toBe('failure');
      expect(r.state.nodes.a!.attempts).toBe(1);
      // No dispatch command → the node is NOT re-attempted, whatever the kind.
      expect(r.commands.filter((c) => c.type === 'dispatchNode')).toEqual([]);
    });
  }

  it('a transient failure finishes the run as failure — identical to a permanent one, absent a policy', () => {
    const run = (kind: FailureKind): EngineCommand[] => {
      const eng = engine([node('a')]);
      let s = eng.reduce(eng.seedState(), started()).state;
      s = eng.reduce(s, dispatched('a', attempt('a'))).state;
      return eng.reduce(s, failed('a', attempt('a'), 'boom', kind)).commands;
    };

    expect(run('transient')).toEqual(run('permanent'));
    expect(run('transient')).toContainEqual(
      expect.objectContaining({ type: 'finishRun', outcome: 'failure' }),
    );
  });
});

// ===========================================================================
// #2 L2 — activity.metered is an inert observability fact
// ===========================================================================

describe('activity.metered is inert (#2 L2)', () => {
  it('folding activity.metered changes neither state nor commands, and does not terminalize the node', () => {
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const before = s;
    const r = eng.reduce(s, {
      type: 'activity.metered',
      runId: RUN,
      nodeId: 'a',
      attemptId: attempt('a'),
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      inputTokens: 1,
      outputTokens: 2,
      meteringStatus: 'metered',
    });
    // Inert like node.output: identical state, no commands, node still in flight.
    expect(r.state).toEqual(before);
    expect(r.commands).toEqual([]);
    expect(r.state.status).toBe('running');
  });

  it('stays inert with the #2 L5 price fields present (they ride the same event)', () => {
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const before = s;
    const r = eng.reduce(s, {
      type: 'activity.metered',
      runId: RUN,
      nodeId: 'a',
      attemptId: attempt('a'),
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      meteringStatus: 'metered',
      inUnitPrice: 5,
      outUnitPrice: 25,
      costEstimate: 17.5,
      priceTableVersion: BUILTIN_PRICE_TABLE_VERSION,
    });
    // The price fields are pure observability — folding them changes nothing.
    expect(r.state).toEqual(before);
    expect(r.commands).toEqual([]);
    expect(r.state.status).toBe('running');
  });
});

// ===========================================================================
// #2 L9a — activity.captured is an inert observability fact
// ===========================================================================

describe('activity.captured is inert (#2 L9a)', () => {
  it('folding activity.captured changes neither state nor commands, and does not terminalize the node', () => {
    const eng = engine([node('a')]);
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('a', attempt('a'))).state;
    const before = s;
    const r = eng.reduce(s, {
      type: 'activity.captured',
      runId: RUN,
      nodeId: 'a',
      attemptId: attempt('a'),
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      latencyMs: 123,
      request: {
        messageCount: 1,
        system: { chars: 4, contentHash: 'sh' },
        messages: [{ role: 'user', chars: 5, contentHash: 'mh' }],
      },
      completion: { chars: 3, contentHash: 'ch' },
    });
    // Inert like activity.metered / node.output: identical state, no commands,
    // node still in flight.
    expect(r.state).toEqual(before);
    expect(r.commands).toEqual([]);
    expect(r.state.status).toBe('running');
  });
});
