/**
 * RS1 — `run.reseeded` event + reducer fold (rerun-from-failed).
 *
 * RS1 delivers the MECHANISM that applies a reseed manifest: `run.started`
 * carries `rerunOf` (which DEFERS the start-time dispatch), and `run.reseeded`
 * then marks the copied `frontier` nodes terminal-success with their copied
 * outputs, seeds copied containers, and settles ONCE so dispatch proceeds from
 * the ready set BEYOND the frontier — the same walk as a normal run. The
 * frontier COMPUTATION (RS2), container copiability RULES (RS3), `call_pipeline`
 * childLinks (RS4), secureOutput exclusion (RS5) and the live producer (RS2)
 * are out of scope here; these tests fold hand-constructed logs against the
 * real reducer (no mocks).
 *
 * CRASH-SAFETY INVARIANT (pinned by the resume test below): a lone
 * `run.started{rerunOf}` folds to a `running`/all-pending half-state that is NOT
 * crash-safe — boot-reconcile's `resume` would re-dispatch the frontier. RS2's
 * producer MUST therefore append the reseed pair (`run.triggerContext?` +
 * `run.started{rerunOf}` + `run.reseeded`) in ONE transaction so that half-state
 * is never persisted.
 */
import { describe, expect, it } from 'vitest';
import type { Container, Edge, EngineCommand, EngineEvent, Node, RunState } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 } };
}
function edge(
  from: string,
  to: string,
  on: 'success' | 'failure' | 'completion' | 'skipped',
): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}
function engine(nodes: Node[], edges: Edge[] = [], containers: Container[] = []): Engine {
  return createEngine({ nodes, edges, containers } satisfies EngineDoc);
}

const RUN = 'R2';
const PV = 'pv1';

function started(params: Record<string, unknown> = {}): EngineEvent {
  return { type: 'run.started', runId: RUN, pipelineVersionId: PV, params };
}
function startedRerun(rerunOf = 'R1'): EngineEvent {
  return { type: 'run.started', runId: RUN, pipelineVersionId: PV, params: {}, rerunOf };
}
function reseeded(fields: {
  frontier?: string[];
  copiedOutputs?: Record<string, Record<string, unknown>>;
  copiedContainers?: Record<string, RunState['containers'][string]>;
  sourceRunId?: string;
}): EngineEvent {
  return {
    type: 'run.reseeded',
    runId: RUN,
    sourceRunId: fields.sourceRunId ?? 'R1',
    frontier: fields.frontier ?? [],
    copiedOutputs: fields.copiedOutputs ?? {},
    copiedContainers: fields.copiedContainers ?? {},
  };
}

/** Fold a log against the engine, returning the final state + the LAST event's
 * reduce result (commands/diagnostics), plus all accumulated diagnostics. */
function fold(eng: Engine, log: EngineEvent[]) {
  let state = eng.seedState();
  const allDiagnostics: string[] = [];
  let lastCommands: EngineCommand[] = [];
  let lastDiagnostics: string[] = [];
  for (const ev of log) {
    const r = eng.reduce(state, ev);
    state = r.state;
    lastCommands = r.commands;
    lastDiagnostics = r.diagnostics;
    allDiagnostics.push(...r.diagnostics);
  }
  return { state, lastCommands, lastDiagnostics, allDiagnostics };
}

const dispatchIds = (commands: EngineCommand[]): string[] =>
  commands
    .filter((c): c is Extract<EngineCommand, { type: 'dispatchNode' }> => c.type === 'dispatchNode')
    .map((c) => c.nodeId);

describe('RS1 — run.started{rerunOf} defers dispatch', () => {
  it('folds to running/all-pending and emits NO dispatch command', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const r = eng.reduce(eng.seedState(), startedRerun());
    expect(r.state.status).toBe('running');
    expect(r.state.nodes.a!.status).toBe('pending');
    expect(r.state.nodes.b!.status).toBe('pending');
    expect(r.commands).toEqual([]);
  });

  it('a NORMAL run.started (no rerunOf) still dispatches the root (back-compat)', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const r = eng.reduce(eng.seedState(), started());
    expect(dispatchIds(r.commands)).toEqual(['a']);
  });
});

describe('RS1 — run.reseeded fold', () => {
  it('marks frontier nodes success with copied outputs and dispatches BEYOND the frontier', () => {
    const eng = engine(
      [node('a'), node('b'), node('c')],
      [edge('a', 'b', 'success'), edge('b', 'c', 'success')],
    );
    const { state, lastCommands } = fold(eng, [
      startedRerun(),
      reseeded({ frontier: ['a', 'b'], copiedOutputs: { a: { out: 1 }, b: { out: 2 } } }),
    ]);
    expect(state.nodes.a!.status).toBe('success');
    expect(state.nodes.b!.status).toBe('success');
    expect(state.nodes.a!.currentAttemptId).toBeUndefined();
    expect(state.outputs.a).toEqual({ out: 1 });
    expect(state.outputs.b).toEqual({ out: 2 });
    // c re-runs; a/b are copied-success and must NOT re-dispatch.
    expect(dispatchIds(lastCommands)).toEqual(['c']);
  });

  it('seeds copiedContainers as a terminal unit and routes its outer edge', () => {
    const eng = engine(
      [node('inner'), node('after')],
      [edge('loop', 'after', 'success')],
      [{ id: 'loop', kind: 'foreach', children: ['inner'], items: '[1]' } as Container],
    );
    const copied: RunState['containers'][string] = {
      status: 'success',
      round: 1,
      outputs: { got: 'it' },
    };
    const { state, lastCommands } = fold(eng, [
      startedRerun(),
      reseeded({ copiedContainers: { loop: copied } }),
    ]);
    expect(state.containers.loop).toEqual(copied);
    // The container's outputs are mirrored into state.outputs — the sole source
    // for `${nodes.loop.output.*}` on a downstream re-running node.
    expect(state.outputs.loop).toEqual({ got: 'it' });
    // A copied-terminal container routes `loop --success--> after`: `after`
    // dispatches, its body child does NOT re-run.
    expect(dispatchIds(lastCommands)).toEqual(['after']);
  });

  it('a known frontier node with NO copiedOutputs entry stores {} (empty-outputs fallback)', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const { state } = fold(eng, [startedRerun(), reseeded({ frontier: ['a'], copiedOutputs: {} })]);
    expect(state.nodes.a!.status).toBe('success');
    expect(state.outputs.a).toEqual({});
  });

  it('an EMPTY frontier applies nothing and dispatches from the start (valid reseed)', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const { state, lastCommands } = fold(eng, [startedRerun(), reseeded({ frontier: [] })]);
    // Nothing copied; settle dispatches the root fresh (status → ready, command emitted).
    expect(state.nodes.a!.status).toBe('ready');
    expect(state.outputs).toEqual({});
    expect(dispatchIds(lastCommands)).toEqual(['a']);
  });
});

describe('RS1 — impossible-log guards', () => {
  it('run.reseeded on a NORMAL (already-dispatched) run is a no-op + diagnostic', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    // A normal start dispatches 'a' → the run has progressed.
    const { state, lastCommands, lastDiagnostics } = fold(eng, [
      started(),
      reseeded({ frontier: ['a'], copiedOutputs: { a: { out: 1 } } }),
    ]);
    expect(state.outputs.a).toBeUndefined();
    expect(lastCommands).toEqual([]);
    expect(lastDiagnostics.join(' ')).toMatch(/impossible run\.reseeded/);
  });

  it('a DUPLICATE run.reseeded is a no-op + diagnostic', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const log: EngineEvent[] = [
      startedRerun(),
      reseeded({ frontier: ['a'], copiedOutputs: { a: { out: 1 } } }),
    ];
    const first = fold(eng, log);
    const second = eng.reduce(
      first.state,
      reseeded({ frontier: ['b'], copiedOutputs: { b: { out: 9 } } }),
    );
    expect(second.state.nodes.b!.status).not.toBe('success');
    expect(second.commands).toEqual([]);
    expect(second.diagnostics.join(' ')).toMatch(/impossible run\.reseeded/);
  });

  it('an UNKNOWN frontier node id is skipped with a diagnostic; known ones still copy', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const { state, allDiagnostics } = fold(eng, [
      startedRerun(),
      reseeded({ frontier: ['a', 'ghost'], copiedOutputs: { a: { out: 1 } } }),
    ]);
    expect(state.nodes.a!.status).toBe('success');
    expect(state.nodes.ghost).toBeUndefined();
    expect(allDiagnostics.join(' ')).toMatch(/unknown frontier node/);
  });

  it('an UNKNOWN container id is skipped with a diagnostic; known nodes still copy', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const ghostContainer: RunState['containers'][string] = {
      status: 'success',
      round: 0,
      outputs: {},
    };
    const { state, allDiagnostics } = fold(eng, [
      startedRerun(),
      reseeded({
        frontier: ['a'],
        copiedOutputs: { a: { out: 1 } },
        copiedContainers: { ghost: ghostContainer },
      }),
    ]);
    expect(state.nodes.a!.status).toBe('success');
    expect(state.containers.ghost).toBeUndefined();
    expect(allDiagnostics.join(' ')).toMatch(/unknown container/);
  });

  it('a NON-TERMINAL copiedContainers entry is refused (skip + diagnostic, no throw)', () => {
    const eng = engine(
      [node('inner'), node('after')],
      [edge('loop', 'after', 'success')],
      [{ id: 'loop', kind: 'foreach', children: ['inner'], items: '[1]' } as Container],
    );
    const active: RunState['containers'][string] = { status: 'active', round: 0, outputs: {} };
    const { state, allDiagnostics } = fold(eng, [
      startedRerun(),
      reseeded({ copiedContainers: { loop: active } }),
    ]);
    // The container is left at its seeded 'pending' (the active copy is skipped),
    // and the pure reducer did not throw.
    expect(state.containers.loop!.status).toBe('pending');
    expect(state.outputs.loop).toBeUndefined();
    expect(allDiagnostics.join(' ')).toMatch(/non-terminal container/);
  });
});

describe('RS1 — event-sourcing invariants', () => {
  it('projectRunState reproduces the reseeded state deterministically (CP1)', () => {
    const eng = engine(
      [node('a'), node('b'), node('c')],
      [edge('a', 'b', 'success'), edge('b', 'c', 'success')],
    );
    const log: EngineEvent[] = [
      startedRerun(),
      reseeded({ frontier: ['a', 'b'], copiedOutputs: { a: { out: 1 }, b: { out: 2 } } }),
    ];
    expect(eng.projectRunState(log)).toEqual(eng.projectRunState(log));
  });

  it('CRASH HAZARD: a lone run.started{rerunOf} half-state re-dispatches on resume', () => {
    // Documents WHY RS2 must append the reseed pair atomically: the deferred
    // running/all-pending state, resumed WITHOUT a following run.reseeded,
    // re-dispatches the frontier (re-executing copied work).
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const half = eng.projectRunState([startedRerun()]);
    expect(half.status).toBe('running');
    const resumed = eng.resume(half);
    expect(dispatchIds(resumed.commands)).toEqual(['a']);
  });
});
