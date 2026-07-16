/**
 * Direct test of the shared synchronous run driver (`driveRun`) — the loop
 * mechanic that #499 extracted from the four (really five) hand-rolled copies in
 * the sibling engine tests.
 *
 * WHY THIS FILE EXISTS. The objection to sharing a driver is that a bug in it
 * would hide across the whole suite — every reducer test folds the same wrong
 * model, so none of them notices. This file is the answer: it pins the driver's
 * OWN behaviour (the exact event sequence it folds, the `finish`/`finishes`
 * accounting, the guard) against the real reducer directly, so a mechanic bug is
 * VISIBLE here rather than silently absorbed by a downstream assertion. It is the
 * thing that lets the sharing be safe.
 */
import { describe, expect, it } from 'vitest';
import type { EngineCommand, EngineEvent, RunState } from '../../types.js';
import type { Engine, EngineDoc } from '../../reduce.js';
import { createEngine } from '../../reduce.js';
import { driveRun, simpleResolve } from './run-driver.js';

let seq = 0;
function node(id: string): EngineDoc['nodes'][number] {
  seq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: seq, y: 0 } };
}
function edge(from: string, to: string): EngineDoc['edges'][number] {
  return { id: `${from}->${to}`, from, to, on: 'success' };
}

describe('driveRun — the shared run-driver mechanic', () => {
  it('folds the exact event sequence for a linear two-node run', () => {
    const eng = createEngine({ nodes: [node('a'), node('b')], edges: [edge('a', 'b')] });
    const { log, finish, finishes, order, diagnostics, state } = driveRun(eng, {
      resolve: simpleResolve({}),
    });

    expect(order).toEqual(['a', 'b']);
    expect(finish).toEqual({ outcome: 'success', reason: undefined });
    expect(finishes).toBe(1);
    expect(diagnostics).toEqual([]);
    expect(state.status).toBe('success');

    // The full applied-event log, in fold order — this is what reduce.test.ts's
    // replay-determinism pin feeds back through `projectRunState`.
    expect(log.map((e) => e.type)).toEqual([
      'run.started',
      'node.dispatched',
      'node.succeeded',
      'node.dispatched',
      'node.succeeded',
      'run.finished',
    ]);
    // The driver's log replays to the identical projected state.
    expect(eng.projectRunState(log)).toEqual(state);
  });

  it('resolves a node to failure via the simple resolver', () => {
    const eng = createEngine({ nodes: [node('x')], edges: [] });
    const { finish, log } = driveRun(eng, { resolve: simpleResolve({ x: 'failure' }) });
    expect(finish?.outcome).toBe('failure');
    expect(log.map((e) => e.type)).toContain('node.failed');
  });

  it('drains a fan-out that dispatches several nodes from one reduce', () => {
    // a --success--> b and a --success--> c: settling a emits two dispatchNodes
    // at once, so the driver must DRAIN a queue, not take the first command.
    const eng = createEngine({
      nodes: [node('a'), node('b'), node('c')],
      edges: [edge('a', 'b'), edge('a', 'c')],
    });
    const { order, finish } = driveRun(eng, { resolve: simpleResolve({}) });
    expect(order).toEqual(['a', 'b', 'c']);
    expect(finish?.outcome).toBe('success');
  });

  it('passes the runId through to the resolver', () => {
    const eng = createEngine({ nodes: [node('a')], edges: [] });
    const seen: string[] = [];
    driveRun(eng, {
      runId: 'custom-run',
      resolve: (nodeId, attemptId, runId) => {
        seen.push(runId);
        return { type: 'node.succeeded', runId, nodeId, attemptId, outputs: {} };
      },
    });
    expect(seen).toEqual(['custom-run']);
  });

  it('a healthy many-node run stays well under the guard threshold', () => {
    const nodes = Array.from({ length: 50 }, (_, i) => node(`n${i}`));
    const eng = createEngine({ nodes, edges: [] });
    expect(() => driveRun(eng, { resolve: simpleResolve({}) })).not.toThrow();
  });

  it('THROWS when the command queue never drains (the guard actually fires)', () => {
    // A stub engine whose every reduce emits a fresh dispatchNode — the queue
    // can never empty, so a real convergence backstop must throw rather than
    // hang the process. This is the negative the 50-node test cannot reach: it
    // exercises `guard > 2000` directly, not just "a healthy run stays under it".
    const emptyState = { status: 'running' } as unknown as RunState;
    const runawayEngine = {
      seedState: () => emptyState,
      reduce: (): { state: RunState; commands: EngineCommand[]; diagnostics: string[] } => ({
        state: emptyState,
        commands: [
          { type: 'dispatchNode', nodeId: 'loop', attemptId: 'loop#0', preparedInput: {} },
        ],
        diagnostics: [],
      }),
      projectRunState: () => emptyState,
      resume: () => ({ state: emptyState, commands: [], diagnostics: [] }),
    } as unknown as Engine;
    const neverTerminates = (nodeId: string, attemptId: string, runId: string): EngineEvent => ({
      type: 'node.succeeded',
      runId,
      nodeId,
      attemptId,
      outputs: {},
    });
    expect(() => driveRun(runawayEngine, { resolve: neverTerminates })).toThrow(/did not converge/);
  });
});
