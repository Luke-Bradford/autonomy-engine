/**
 * RS2 — the rerun-from-failed FRONTIER algorithm (`Engine.reseedFrontier`).
 *
 * Pure over R1's projected `RunState` + the doc's graph: computes the strict
 * successful PREFIX (Open-Q1 settled) — the maximal set of top-level entities
 * that (a) reached terminal `success` in R1 AND (b) every incoming edge that was
 * SATISFIED in R1 comes from an already-included entity. It mirrors the reducer's
 * OWN `edgeState` (so a not-taken branch / dead failure edge does NOT block a
 * downstream join — the correctness property a naive "all predecessors" rule gets
 * wrong), and treats nodes and containers uniformly as endpoints.
 *
 * These tests construct the R1 `RunState` DIRECTLY (the algorithm is a pure
 * function of it) and assert against the REAL engine — no mocks. The end-to-end
 * live producer (append the reseed pair atomically + drive) is exercised in the
 * server-side `run/__tests__/reseed.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type {
  Container,
  ContainerRunState,
  Edge,
  Node,
  NodeRunState,
  NodeRunStatus,
  RunState,
} from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';

let seq = 0;
function node(id: string): Node {
  seq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: seq, y: 0 } };
}
function edge(
  from: string,
  to: string,
  on: 'success' | 'failure' | 'completion' | 'skipped',
): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}
function branchEdge(from: string, to: string, branch: string): Edge {
  return { id: `${from}->${to}:branch:${branch}`, from, to, on: 'branch', branch };
}
/** A back-edge (loop): `to` must be an ancestor of `from`. */
function backEdge(from: string, to: string): Edge {
  return { id: `${from}->${to}:back`, from, to, on: 'success', back: true };
}
function engine(nodes: Node[], edges: Edge[] = [], containers: Container[] = []): Engine {
  return createEngine({ nodes, edges, containers } satisfies EngineDoc);
}

/** A terminal node-run state (copied nodes carry no live attempt). */
function ns(status: NodeRunStatus): NodeRunState {
  return { status, attempts: status === 'pending' ? 0 : 1, retries: 0 };
}
function cs(
  status: ContainerRunState['status'],
  outputs: Record<string, unknown> = {},
): ContainerRunState {
  return { status, round: 0, outputs };
}

/** Build an R1 projection directly: node statuses, per-node outputs, container
 * states, and business branches. Everything else is a valid empty projection. */
function state(fields: {
  nodes: Record<string, NodeRunStatus>;
  outputs?: Record<string, Record<string, unknown>>;
  containers?: Record<string, ContainerRunState>;
  branches?: Record<string, string>;
  status?: RunState['status'];
}): RunState {
  const nodes: Record<string, NodeRunState> = {};
  for (const [id, s] of Object.entries(fields.nodes)) nodes[id] = ns(s);
  return {
    runId: 'R1',
    pipelineVersionId: 'pv1',
    startedAt: null,
    params: {},
    status: fields.status ?? 'failure',
    waitingReason: null,
    nodes,
    outputs: fields.outputs ?? {},
    containers: fields.containers ?? {},
    bounces: {},
    branches: fields.branches ?? {},
    sessions: {},
    triggerContext: null,
  };
}

describe('RS2 — reseedFrontier: linear + basic prefix', () => {
  it('a→b→c with c failed copies {a,b} and their outputs, re-runs c', () => {
    const eng = engine(
      [node('a'), node('b'), node('c')],
      [edge('a', 'b', 'success'), edge('b', 'c', 'success')],
    );
    const r = eng.reseedFrontier(
      state({
        nodes: { a: 'success', b: 'success', c: 'failure' },
        outputs: { a: { x: 1 }, b: { y: 2 } },
      }),
    );
    expect(r.frontier).toEqual(['a', 'b']);
    expect(r.copiedOutputs).toEqual({ a: { x: 1 }, b: { y: 2 } });
    expect(r.copiedContainers).toEqual({});
  });

  it('a fully-failed root copies NOTHING (empty frontier = full re-run)', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const r = eng.reseedFrontier(state({ nodes: { a: 'failure', b: 'skipped' } }));
    expect(r.frontier).toEqual([]);
    expect(r.copiedOutputs).toEqual({});
  });

  it('a success node with NO recorded outputs copies {} for it', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const r = eng.reseedFrontier(state({ nodes: { a: 'success', b: 'failure' }, outputs: {} }));
    expect(r.frontier).toEqual(['a']);
    expect(r.copiedOutputs).toEqual({ a: {} });
  });

  it('a fully-successful run copies EVERY node (rerun-from-failed of a success run)', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const r = eng.reseedFrontier(
      state({
        nodes: { a: 'success', b: 'success' },
        outputs: { a: {}, b: {} },
        status: 'success',
      }),
    );
    expect(r.frontier).toEqual(['a', 'b']);
  });
});

describe('RS2 — reseedFrontier: satisfied-edge rule (the branch-join correctness property)', () => {
  it('a skipped SIBLING predecessor (dead failure edge) does NOT block a downstream join', () => {
    // a --success--> b, a --failure--> c; b,c --success--> d; d --success--> e.
    // a succeeds → b runs, c's failure edge is dead → c skipped; d runs via b; e fails.
    // A naive "all predecessors included" rule would exclude d (its pred c is not
    // copied). The satisfied-edge rule copies d — c did not contribute to d.
    const eng = engine(
      [node('a'), node('b'), node('c'), node('d'), node('e')],
      [
        edge('a', 'b', 'success'),
        edge('a', 'c', 'failure'),
        edge('b', 'd', 'success'),
        edge('c', 'd', 'success'),
        edge('d', 'e', 'success'),
      ],
    );
    const r = eng.reseedFrontier(
      state({
        nodes: { a: 'success', b: 'success', c: 'skipped', d: 'success', e: 'failure' },
        outputs: { a: { i: 1 }, b: { j: 2 }, d: { k: 3 } },
      }),
    );
    expect(r.frontier).toEqual(['a', 'b', 'd']);
    expect(r.copiedOutputs).toEqual({ a: { i: 1 }, b: { j: 2 }, d: { k: 3 } });
  });

  it('a not-taken BRANCH edge does not block, and the skipped branch node re-runs', () => {
    // if-node a: a --branch:x--> b (taken), a --branch:y--> c (not taken).
    const eng = engine(
      [node('a'), node('b'), node('c')],
      [branchEdge('a', 'b', 'x'), branchEdge('a', 'c', 'y')],
    );
    const r = eng.reseedFrontier(
      state({
        nodes: { a: 'success', b: 'success', c: 'skipped' },
        branches: { a: 'x' },
        outputs: { a: {}, b: {} },
      }),
    );
    expect(r.frontier).toEqual(['a', 'b']);
  });

  it('a node that ran via a predecessor FAILURE edge re-runs (its failed pred is not copiable)', () => {
    // a --completion--> b: a fails, b runs (completion satisfied), b succeeds.
    // b depends on a's outcome; a re-runs, so b must too — frontier is empty.
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'completion')]);
    const r = eng.reseedFrontier(
      state({ nodes: { a: 'failure', b: 'success' }, outputs: { b: {} } }),
    );
    expect(r.frontier).toEqual([]);
  });

  it('an INDEPENDENT successful chain is copied even when a disjoint chain failed', () => {
    // a→b succeeded; x→y where x failed, y skipped. Copy {a,b}; re-run x,y.
    const eng = engine(
      [node('a'), node('b'), node('x'), node('y')],
      [edge('a', 'b', 'success'), edge('x', 'y', 'success')],
    );
    const r = eng.reseedFrontier(
      state({
        nodes: { a: 'success', b: 'success', x: 'failure', y: 'skipped' },
        outputs: { a: {}, b: {} },
      }),
    );
    expect(r.frontier).toEqual(['a', 'b']);
  });
});

describe('RS2 — reseedFrontier: containers', () => {
  it('a completed container is copied and its downstream node joins the frontier', () => {
    // loop --success--> after --success--> z; loop,after succeed; z fails.
    const eng = engine(
      [node('inner'), node('after'), node('z')],
      [edge('loop', 'after', 'success'), edge('after', 'z', 'success')],
      [{ id: 'loop', kind: 'foreach', children: ['inner'], items: '[1]' } as Container],
    );
    const r = eng.reseedFrontier(
      state({
        nodes: { inner: 'success', after: 'success', z: 'failure' },
        outputs: { after: { a: 1 } },
        containers: { loop: cs('success', { got: 'it' }) },
      }),
    );
    expect(r.frontier).toEqual(['after']);
    expect(r.copiedContainers).toEqual({ loop: cs('success', { got: 'it' }) });
    expect(r.copiedOutputs).toEqual({ after: { a: 1 } });
  });

  it('a MID-FLIGHT (active) container is not copied and its downstream re-runs', () => {
    const eng = engine(
      [node('inner'), node('after')],
      [edge('loop', 'after', 'success')],
      [{ id: 'loop', kind: 'foreach', children: ['inner'], items: '[1]' } as Container],
    );
    const r = eng.reseedFrontier(
      state({
        nodes: { inner: 'dispatched', after: 'pending' },
        containers: { loop: cs('active') },
        status: 'interrupted',
      }),
    );
    expect(r.frontier).toEqual([]);
    expect(r.copiedContainers).toEqual({});
  });

  it('a FAILED container is not copied and its downstream re-runs', () => {
    const eng = engine(
      [node('after')],
      [edge('loop', 'after', 'success')],
      [{ id: 'loop', kind: 'loop', children: [] } as unknown as Container],
    );
    const r = eng.reseedFrontier(
      state({ nodes: { after: 'skipped' }, containers: { loop: cs('failure') } }),
    );
    expect(r.frontier).toEqual([]);
    expect(r.copiedContainers).toEqual({});
  });
});

describe('RS2 — reseedFrontier: bare back-edge loops are conservatively excluded', () => {
  it('a completed bare loop re-runs (its members are NOT copied), but an UPSTREAM node is copied', () => {
    // pre → a → b → c, back-edge c→a (a bare loop), c → d. All of pre,a,b,c
    // succeeded; d failed. The loop members a,b,c must be EXCLUDED (a copied loop
    // member can freeze a back-edge ref at an obsolete iteration + a copied run
    // takes no bounce to reset it), but `pre` (upstream, not a loop member) copies.
    const eng = engine(
      [node('pre'), node('a'), node('b'), node('c'), node('d')],
      [
        edge('pre', 'a', 'success'),
        edge('a', 'b', 'success'),
        edge('b', 'c', 'success'),
        backEdge('c', 'a'),
        edge('c', 'd', 'success'),
      ],
    );
    const r = eng.reseedFrontier(
      state({
        nodes: { pre: 'success', a: 'success', b: 'success', c: 'success', d: 'failure' },
        outputs: { pre: { p: 1 }, a: {}, b: {}, c: {} },
      }),
    );
    expect(r.frontier).toEqual(['pre']);
    expect(r.copiedOutputs).toEqual({ pre: { p: 1 } });
  });
});

describe('RS2 — reseedFrontier: determinism', () => {
  it('the frontier is SORTED and reproducible', () => {
    const eng = engine(
      [node('b'), node('a'), node('c')],
      [edge('a', 'c', 'success'), edge('b', 'c', 'success')],
    );
    const s = state({
      nodes: { a: 'success', b: 'success', c: 'failure' },
      outputs: { a: {}, b: {} },
    });
    const r1 = eng.reseedFrontier(s);
    const r2 = eng.reseedFrontier(s);
    expect(r1.frontier).toEqual(['a', 'b']);
    expect(r1).toEqual(r2);
  });
});
