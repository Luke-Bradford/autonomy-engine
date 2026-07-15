import { describe, expect, it } from 'vitest';
import type { EngineEvent, Node } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { outputContract } from '../outputs.js';

// --- helpers ---------------------------------------------------------------

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 } };
}

function engine(nodes: Node[]): Engine {
  return createEngine({ nodes, edges: [] } satisfies EngineDoc);
}

const RUN = 'r1';

function started(): EngineEvent {
  return { type: 'run.started', runId: RUN, pipelineVersionId: 'pv1', params: {} };
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

/** Drive one node from seed → dispatched → succeeded(outputs). */
function driveOne(n: Node, outputs: Record<string, unknown>) {
  const eng = engine([n]);
  let state = eng.seedState();
  const diagnostics: string[] = [];
  for (const ev of [started(), dispatched(n.id, 'a#0'), succeeded(n.id, 'a#0', outputs)]) {
    const res = eng.reduce(state, ev);
    state = res.state;
    diagnostics.push(...res.diagnostics);
  }
  return { state, diagnostics };
}

// --- the contract ----------------------------------------------------------

describe('outputContract — absent vs invalid vs declared (F13a)', () => {
  it('reports `absent` when the node declares no outputs', () => {
    expect(outputContract(node('a'))).toEqual({ kind: 'absent' });
  });

  it('reports `declared` with the parsed outputs', () => {
    const c = outputContract(node('a', { outputs: [{ name: 'text', type: 'string' }] }));
    expect(c).toEqual({ kind: 'declared', outputs: [{ name: 'text', type: 'string' }] });
  });

  // The heart of F13a: a MALFORMED contract is not the same fact as NO
  // contract. Collapsing them (the pre-F13a `null`) silently disabled every
  // output check — the fail-OPEN shape this engine's invariants forbid.
  it('reports `invalid` (NOT absent) for a malformed outputs declaration', () => {
    const c = outputContract(node('a', { outputs: [{ name: 'text', type: 'nonsense' }] }));
    expect(c.kind).toBe('invalid');
  });

  it('reports `invalid` when outputs is not an array', () => {
    expect(outputContract(node('a', { outputs: 'text' })).kind).toBe('invalid');
  });

  it('reports `invalid` for duplicate output names', () => {
    const c = outputContract(
      node('a', {
        outputs: [
          { name: 'text', type: 'string' },
          { name: 'text', type: 'number' },
        ],
      }),
    );
    expect(c.kind).toBe('invalid');
  });

  it('reports `invalid` for an output name the expression language cannot address', () => {
    // `refRoot` parses `${nodes.<id>.output.<name>}` with a SINGLE-segment name,
    // so `a.b` would silently alias output `a` + deep field `b` (E7).
    expect(outputContract(node('a', { outputs: [{ name: 'a.b', type: 'string' }] })).kind).toBe(
      'invalid',
    );
  });
});

// --- the runtime consequence ----------------------------------------------

describe('reducer — a malformed contract FAILS the node, never fails open (F13a)', () => {
  it('fails the node rather than storing the whole payload', () => {
    const n = node('a', { outputs: [{ name: 'text', type: 'nonsense' }] });
    const { state, diagnostics } = driveOne(n, { text: 'hi', secretish: 'leak' });

    expect(state.nodes['a']?.status).toBe('failure');
    expect(state.outputs['a']).toBeUndefined();
    expect(diagnostics.join(' ')).toContain('config.outputs is malformed');
  });

  it('still stores the whole payload when the contract is genuinely ABSENT', () => {
    // Absent = "no contract" stays fail-open BY DESIGN (documented in
    // outputs.ts). Only a CORRUPT contract is refused.
    const { state } = driveOne(node('a'), { anything: 1 });
    expect(state.nodes['a']?.status).toBe('success');
    expect(state.outputs['a']).toEqual({ anything: 1 });
  });

  it('keeps only declared keys when the contract is valid', () => {
    const n = node('a', { outputs: [{ name: 'text', type: 'string' }] });
    const { state } = driveOne(n, { text: 'hi', undeclared: 'dropped' });
    expect(state.nodes['a']?.status).toBe('success');
    expect(state.outputs['a']).toEqual({ text: 'hi' });
  });

  it('blames the CONFIG, not the node, for a corrupt contract', () => {
    const n = node('a', { outputs: [{ name: 'text', type: 'nonsense' }] });
    const { diagnostics } = driveOne(n, { text: 'hi' });
    // The node produced nothing wrong — its author mis-declared the contract.
    // Worded to match validateDoc's `config.outputs is malformed`.
    expect(diagnostics.join(' ')).toContain("node 'a' has invalid config");
    expect(diagnostics.join(' ')).toContain('config.outputs is malformed');
    expect(diagnostics.join(' ')).not.toContain('produced invalid outputs');
  });
});

// --- the call_pipeline path shares the same contract check ----------------

describe('call.returned — a malformed contract FAILS the call node (F13a)', () => {
  const CHILD_PV = 'pv_child';

  function callNode(id: string, config: Record<string, unknown> = {}): Node {
    seq += 1;
    return {
      id,
      type: 'call_pipeline',
      config,
      position: { x: seq, y: 0 },
      call: { pipelineVersionId: CHILD_PV, params: {} },
    };
  }

  /**
   * Drive a call node to `call.returned` with the given child outcome. The
   * `attemptId`/`childRunId` come from the engine's OWN `startChild` command —
   * the reducer ignores a `call.returned` that names either wrongly.
   */
  function driveCall(
    n: Node,
    childOutcome: 'success' | 'failure',
    outputs: Record<string, unknown>,
  ) {
    const eng = engine([n]);
    const diagnostics: string[] = [];
    const seeded = eng.reduce(eng.seedState(), started());
    diagnostics.push(...seeded.diagnostics);

    const start = seeded.commands.find((c) => c.type === 'startChild');
    if (start?.type !== 'startChild') throw new Error('expected a startChild command');

    const returned: EngineEvent = {
      type: 'call.returned',
      runId: RUN,
      callNodeId: n.id,
      attemptId: start.attemptId,
      childRunId: start.childRunId,
      childOutcome,
      outputs,
    };
    const res = eng.reduce(seeded.state, returned);
    diagnostics.push(...res.diagnostics);
    return { state: res.state, diagnostics };
  }

  // The call path's own comment makes the loudest claim in this area —
  // "mistyped outputs must never be stored regardless of outcome" — so a
  // corrupt contract must be refused on the FAILURE outcome too, where a failed
  // child still projects outputs (the findings loop).
  it.each(['success', 'failure'] as const)(
    'fails the call node and stores nothing on a %s child',
    (childOutcome) => {
      const n = callNode('c', { outputs: [{ name: 'text', type: 'nonsense' }] });
      const { state, diagnostics } = driveCall(n, childOutcome, { text: 'hi', extra: 'leak' });

      expect(state.nodes['c']?.status).toBe('failure');
      expect(state.outputs['c']).toBeUndefined();
      expect(diagnostics.join(' ')).toContain('config.outputs is malformed');
    },
  );

  it("never blames the CHILD PIPELINE for the call node's own config defect", () => {
    const n = callNode('c', { outputs: [{ name: 'text', type: 'nonsense' }] });
    const { diagnostics } = driveCall(n, 'success', { text: 'hi' });
    expect(diagnostics.join(' ')).toContain("call node 'c' has invalid config");
    expect(diagnostics.join(' ')).not.toContain('child returned invalid outputs');
  });

  it("still stores a valid contract's declared keys from a child", () => {
    const n = callNode('c', { outputs: [{ name: 'text', type: 'string' }] });
    const { state } = driveCall(n, 'success', { text: 'hi', undeclared: 'dropped' });
    expect(state.nodes['c']?.status).toBe('success');
    expect(state.outputs['c']).toEqual({ text: 'hi' });
  });
});
