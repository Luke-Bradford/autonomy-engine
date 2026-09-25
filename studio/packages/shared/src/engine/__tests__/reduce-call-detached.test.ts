import { describe, expect, it } from 'vitest';
import type { Container, EngineCommand, EngineEvent, Node } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';

// #796 item 2 — `call.wait: false`, the fire-and-forget call. The node leaves
// `waiting` on `call.detached` (the child exists and was kicked), never on the
// child's own result, and records NO outputs.

const RUN = 'r1';

function callNode(id: string, wait?: boolean, config: Record<string, unknown> = {}): Node {
  return {
    id,
    type: 'call_pipeline',
    config,
    position: { x: 0, y: 0 },
    call: { pipelineVersionId: 'pv_child', params: {}, ...(wait === undefined ? {} : { wait }) },
  };
}

function engine(nodes: Node[], containers: Container[] = []): Engine {
  return createEngine({ nodes, edges: [], containers } satisfies EngineDoc);
}

type StartChild = Extract<EngineCommand, { type: 'startChild' }>;

function begin(eng: Engine) {
  const r = eng.reduce(eng.seedState(), {
    type: 'run.started',
    runId: RUN,
    pipelineVersionId: 'pv',
    params: {},
  });
  const start = r.commands.find((c): c is StartChild => c.type === 'startChild');
  if (start === undefined) throw new Error('no startChild');
  return { state: r.state, start };
}

function detached(start: StartChild, over: Partial<StartChild> = {}): EngineEvent {
  const s = { ...start, ...over };
  return {
    type: 'call.detached',
    runId: RUN,
    callNodeId: s.callNodeId,
    attemptId: s.attemptId,
    childRunId: s.childRunId,
  };
}

describe('call_pipeline wait: false (#796 item 2)', () => {
  it('startChild carries the wait flag — absent reads as WAIT, false as detach', () => {
    expect(begin(engine([callNode('c')])).start.wait).toBe(true);
    expect(begin(engine([callNode('c', true)])).start.wait).toBe(true);
    expect(begin(engine([callNode('c', false)])).start.wait).toBe(false);
  });

  it('a detached call node succeeds on call.detached with EMPTY outputs, and the run completes', () => {
    const eng = engine([callNode('c', false)]);
    const { state, start } = begin(eng);
    expect(state.nodes.c!.status).toBe('waiting');
    const r = eng.reduce(state, detached(start));
    expect(r.state.nodes.c!.status).toBe('success');
    expect(r.state.outputs.c).toEqual({});
    expect(r.commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });

  it('a late call.returned for the detached child is a no-op — its outcome never reaches the node', () => {
    const eng = engine([callNode('c', false)]);
    const { state, start } = begin(eng);
    const r1 = eng.reduce(state, detached(start));
    const r2 = eng.reduce(r1.state, {
      type: 'call.returned',
      runId: RUN,
      callNodeId: 'c',
      attemptId: start.attemptId,
      childRunId: start.childRunId,
      childOutcome: 'failure',
      outputs: { leaked: 1 },
    });
    expect(r2.state.nodes.c!.status).toBe('success');
    expect(r2.state.outputs.c).toEqual({});
  });

  it('a spawn refusal still FAILS a detached node (call.returned{failure} while waiting)', () => {
    const eng = engine([callNode('c', false)]);
    const { state, start } = begin(eng);
    const r = eng.reduce(state, {
      type: 'call.returned',
      runId: RUN,
      callNodeId: 'c',
      attemptId: start.attemptId,
      childRunId: start.childRunId,
      childOutcome: 'failure',
      outputs: {},
      reason: 'not found',
    });
    expect(r.state.nodes.c!.status).toBe('failure');
  });

  it('a WAITING call node ignores call.detached — only its child result resolves it', () => {
    const eng = engine([callNode('c')]);
    const { state, start } = begin(eng);
    const r = eng.reduce(state, detached(start));
    expect(r.state.nodes.c!.status).toBe('waiting');
    expect(r.commands).toEqual([]);
    expect(r.diagnostics.join(' ')).toContain('does not detach');
  });

  it('ignores a call.detached naming a stale attempt or a foreign child', () => {
    const eng = engine([callNode('c', false)]);
    const { state, start } = begin(eng);
    for (const bad of [
      detached(start, { attemptId: 'c#9' }),
      detached(start, { childRunId: 'child_deadbeef' }),
    ]) {
      const r = eng.reduce(state, bad);
      expect(r.state.nodes.c!.status).toBe('waiting');
      expect(r.commands).toEqual([]);
    }
  });

  it('a duplicate call.detached (a restart re-announcing) is a no-op', () => {
    const eng = engine([callNode('c', false)]);
    const { state, start } = begin(eng);
    const r1 = eng.reduce(state, detached(start));
    const r2 = eng.reduce(r1.state, detached(start));
    expect(r2.state).toEqual(r1.state);
    expect(r2.commands).toEqual([]);
  });

  it('a call.detached for a never-dispatched node is an invalid event', () => {
    // `c` sits behind `a`, so after run.started it is still `pending`.
    const a: Node = { id: 'a', type: 'agent_task', config: {}, position: { x: 1, y: 0 } };
    const eng = createEngine({
      nodes: [a, callNode('c', false)],
      edges: [{ id: 'a->c', from: 'a', to: 'c', on: 'success' }],
      containers: [],
    } satisfies EngineDoc);
    const r0 = eng.reduce(eng.seedState(), {
      type: 'run.started',
      runId: RUN,
      pipelineVersionId: 'pv',
      params: {},
    });
    expect(r0.state.nodes.c!.status).toBe('pending');
    const r = eng.reduce(r0.state, {
      type: 'call.detached',
      runId: RUN,
      callNodeId: 'c',
      attemptId: 'c#0',
      childRunId: 'child_x',
    });
    expect(r.commands).toContainEqual({
      type: 'finishRun',
      outcome: 'failure',
      reason: 'invalid_event',
    });
  });

  it('a detached node that (via a stored doc) declares a REQUIRED output fails with a config diagnostic', () => {
    const eng = engine([callNode('c', false, { outputs: [{ name: 'x', type: 'string' }] })]);
    const { state, start } = begin(eng);
    const r = eng.reduce(state, detached(start));
    expect(r.state.nodes.c!.status).toBe('failure');
    expect(r.diagnostics.join(' ')).toContain("call node 'c'");
  });

  it('a detached call inside a foreach body detaches per item instance', () => {
    const body = callNode('c', false);
    const fe: Container = {
      id: 'fe',
      kind: 'foreach',
      children: ['c'],
      items: '${params.xs}',
    } as Container;
    const eng = createEngine({ nodes: [body], edges: [], containers: [fe] } satisfies EngineDoc);
    let r = eng.reduce(eng.seedState(), {
      type: 'run.started',
      runId: RUN,
      pipelineVersionId: 'pv',
      params: { xs: [1, 2] },
    });
    const starts = r.commands.filter((c): c is StartChild => c.type === 'startChild');
    expect(starts.length).toBeGreaterThan(0);
    let state = r.state;
    const queue = [...starts];
    const all: EngineCommand[] = [];
    let seen = 0;
    while (queue.length) {
      const s = queue.shift()!;
      seen += 1;
      expect(s.wait).toBe(false);
      r = eng.reduce(state, detached(s));
      state = r.state;
      all.push(...r.commands);
      queue.push(...r.commands.filter((c): c is StartChild => c.type === 'startChild'));
    }
    expect(seen).toBe(2); // one detach per item
    expect(state.containers.fe!.status).toBe('success');
    expect(all).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });
});
