/**
 * #4 A0 (branch/outcome model) + A1 (`if` control activity) — the run-time half.
 *
 * `edge-model.test.ts` pins the STATIC edge rules; this file pins that an `if`
 * node actually ROUTES at run time: it evaluates its `${}` boolean condition,
 * the driver makes the chosen branch durable (`condition.evaluated` → folded into
 * `state.branches`), `edgeState` satisfies exactly the taken arm, and the other
 * arm skips. All against the REAL reducer via the shared `driveRun` harness — no
 * mocks; the harness folds the reducer's own `evaluateControl` command exactly as
 * the server driver's `pump` does.
 *
 * The codex-hardened rule it enforces (spec #4): the branch is a FACT in the log
 * before the walk depends on it, so replay reads the logged label — the reducer
 * never re-evaluates the condition against drifted state.
 */
import { describe, expect, it } from 'vitest';
import type { Edge, EngineEvent, Node } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { driveRun, simpleResolve } from './helpers/run-driver.js';

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 } };
}
function ifNode(id: string, condition: unknown): Node {
  seq += 1;
  return { id, type: 'if', config: { condition }, position: { x: seq, y: 0 } };
}
function branchEdge(from: string, to: string, branch: string): Edge {
  return { id: `${from}->${to}:branch:${branch}`, from, to, on: 'branch', branch };
}
function eng(nodes: Node[], edges: Edge[] = []): Engine {
  return createEngine({ nodes, edges } satisfies EngineDoc);
}

const started = (params: Record<string, unknown> = {}): EngineEvent => ({
  type: 'run.started',
  runId: 'r1',
  pipelineVersionId: 'pv1',
  params,
});

describe('if routes the taken branch, skips the others (#4 A1)', () => {
  it('a true condition runs the true arm and skips the false arm', () => {
    const e = eng(
      [ifNode('c', '${true}'), node('a'), node('b')],
      [branchEdge('c', 'a', 'true'), branchEdge('c', 'b', 'false')],
    );
    const { state, order, finish, finishes } = driveRun(e, { resolve: simpleResolve() });
    expect(state.nodes.c!.status).toBe('success');
    expect(state.branches['c']).toBe('true');
    expect(order).toContain('a');
    expect(state.nodes.a!.status).toBe('success');
    // The un-taken arm is DEAD (skipped), not failed — the run still succeeds.
    expect(state.nodes.b!.status).toBe('skipped');
    expect(finish?.outcome).toBe('success');
    expect(finishes).toBe(1);
  });

  it('a false condition runs the false arm and skips the true arm', () => {
    const e = eng(
      [ifNode('c', '${false}'), node('a'), node('b')],
      [branchEdge('c', 'a', 'true'), branchEdge('c', 'b', 'false')],
    );
    const { state, order, finish } = driveRun(e, { resolve: simpleResolve() });
    expect(state.branches['c']).toBe('false');
    expect(order).toContain('b');
    expect(state.nodes.b!.status).toBe('success');
    expect(state.nodes.a!.status).toBe('skipped');
    expect(finish?.outcome).toBe('success');
  });

  it('routes on a condition read from run state (params)', () => {
    const build = (): Edge[] => [branchEdge('c', 'a', 'true'), branchEdge('c', 'b', 'false')];
    const go = driveRun(
      eng([ifNode('c', "${equals(params.mode, 'go')}"), node('a'), node('b')], build()),
      { params: { mode: 'go' }, resolve: simpleResolve() },
    );
    expect(go.state.branches['c']).toBe('true');
    expect(go.state.nodes.a!.status).toBe('success');

    const stop = driveRun(
      eng([ifNode('c', "${equals(params.mode, 'go')}"), node('a'), node('b')], build()),
      { params: { mode: 'stop' }, resolve: simpleResolve() },
    );
    expect(stop.state.branches['c']).toBe('false');
    expect(stop.state.nodes.b!.status).toBe('success');
  });

  it('the if node is never dispatched to the executor', () => {
    const e = eng([ifNode('c', '${true}'), node('a')], [branchEdge('c', 'a', 'true')]);
    const { order } = driveRun(e, { resolve: simpleResolve() });
    // `order` records every `dispatchNode` the harness drove; the if is engine-
    // evaluated (`evaluateControl`), so it must NOT appear there.
    expect(order).not.toContain('c');
    expect(order).toEqual(['a']);
  });
});

describe('if condition failures terminalize invalid_event (#4 A1)', () => {
  it('a non-boolean condition fails the run invalid_event', () => {
    // `params.mode` resolves to the STRING 'go', not a boolean → `evalIfBranch`
    // throws → prepFailure → finishRun{invalid_event}. (The write gate warns at
    // save; this is the run-time half for a pre-gate row.)
    const e = eng([ifNode('c', '${params.mode}'), node('a')], [branchEdge('c', 'a', 'true')]);
    const { finish } = driveRun(e, { params: { mode: 'go' }, resolve: simpleResolve() });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
  });

  it('a missing condition fails the run invalid_event', () => {
    const badIf: Node = { id: 'c', type: 'if', config: {}, position: { x: 0, y: 0 } };
    const e = eng([badIf, node('a')], [branchEdge('c', 'a', 'true')]);
    const { finish } = driveRun(e, { resolve: simpleResolve() });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
  });
});

describe('if inside a container routes identically (#4 A0 container parity)', () => {
  it('the taken child runs, the sibling skips, the stage succeeds', () => {
    const e = createEngine({
      nodes: [ifNode('c', '${true}'), node('a'), node('b')],
      edges: [branchEdge('c', 'a', 'true'), branchEdge('c', 'b', 'false')],
      containers: [{ id: 'stg', kind: 'stage', children: ['c', 'a', 'b'] }],
    });
    const { state, finish } = driveRun(e, { resolve: simpleResolve() });
    expect(state.branches['c']).toBe('true');
    expect(state.nodes.a!.status).toBe('success');
    expect(state.nodes.b!.status).toBe('skipped');
    expect(state.containers.stg!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });
});

describe('condition.evaluated folding — attempt guards + back-compat (#4 A0)', () => {
  it('a run with no if node projects empty branches (pre-A0 back-compat)', () => {
    const e = eng([node('a')]);
    const { state } = driveRun(e, { resolve: simpleResolve() });
    expect(state.branches).toEqual({});
  });

  it('ignores a stale condition.evaluated (wrong attempt)', () => {
    const e = eng([ifNode('c', '${true}'), node('a')], [branchEdge('c', 'a', 'true')]);
    let s = e.seedState();
    s = e.reduce(s, started()).state; // if is a root → immediately `ready`, attempt c#0
    expect(s.nodes.c!.status).toBe('ready');
    const stale = e.reduce(s, {
      type: 'condition.evaluated',
      runId: 'r1',
      nodeId: 'c',
      attemptId: 'c#99',
      branch: 'true',
    });
    expect(stale.state.nodes.c!.status).toBe('ready'); // unchanged
    expect(stale.state.branches['c']).toBeUndefined();
  });

  it('rejects a condition.evaluated for a node that never evaluated (pending)', () => {
    // `c`'s predecessor `p` has not run, so `c` is still `pending`; a
    // condition.evaluated for it is impossible → invalid_event.
    const e = eng(
      [node('p'), ifNode('c', '${true}'), node('a')],
      [{ id: 'p->c', from: 'p', to: 'c', on: 'success' }, branchEdge('c', 'a', 'true')],
    );
    let s = e.seedState();
    s = e.reduce(s, started()).state; // p dispatched (ready), c pending
    expect(s.nodes.c!.status).toBe('pending');
    const r = e.reduce(s, {
      type: 'condition.evaluated',
      runId: 'r1',
      nodeId: 'c',
      attemptId: 'c#0',
      branch: 'true',
    });
    expect(r.commands).toContainEqual({
      type: 'finishRun',
      outcome: 'failure',
      reason: 'invalid_event',
    });
    expect(r.diagnostics.join(' ')).toMatch(/impossible condition\.evaluated/);
  });
});

describe('if crash recovery re-emits evaluateControl (#4 A1)', () => {
  it('resume re-derives the evaluateControl a projection discarded', () => {
    const e = eng([ifNode('c', '${true}'), node('a')], [branchEdge('c', 'a', 'true')]);
    // A log that ends the instant the if became `ready`: the reducer emitted
    // `evaluateControl`, but `projectRunState` keeps STATE not COMMANDS, so a
    // crash here loses it.
    const projected = e.projectRunState([started()]);
    expect(projected.nodes.c!.status).toBe('ready');
    const { commands } = e.resume(projected);
    expect(commands).toContainEqual({
      type: 'evaluateControl',
      nodeId: 'c',
      attemptId: 'c#0',
      branch: 'true',
    });
  });
});
