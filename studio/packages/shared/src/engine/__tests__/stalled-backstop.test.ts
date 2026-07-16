/**
 * #491 — the STALLED backstop: the general liveness answer under the reducer.
 *
 * The class, not a shape. `settle` reaches a fixpoint where nothing is terminal
 * and nothing can ever become ready — a forward cycle is the canonical way in,
 * but the backstop's condition names no cycle. It asks the only question that
 * matters: can any event still arrive? If not, the run can never finish, so it
 * is terminalized as `failure{reason:'stalled'}` instead of wedging `running`
 * forever and holding a concurrency slot until an operator intervenes.
 *
 * WHY THIS IS NOT DEAD CODE NOW THAT #444 GATES THE WRITE PATH. The gate closed
 * the DOOR (`createPipelineVersion` refuses a doc `validateDoc` rejects), so no
 * NEW row can carry a cycle. It did not clean the house: rows written before it
 * were never validated, are IMMUTABLE (DB triggers `RAISE(ABORT)`, so they can
 * only be re-authored, never repaired), and still reach `createEngine`/`reduce`.
 *
 * THE NEGATIVE PINS ARE THE POINT. A backstop that fires one state too eagerly
 * tears down HEALTHY runs, which is far worse than the hang it replaces — so the
 * predicate is deliberately CONSERVATIVE: if any node anywhere awaits an event,
 * the run is never called stalled. The four negatives below (`ready`,
 * `dispatched`, `waiting`, `retry_pending`) are the four ways a run legitimately
 * sits at a fixpoint with nothing terminal, and each one is a state where firing
 * would be a regression. `retry_pending` is the sharpest: F2b's HOLD has nothing
 * in flight and waits on an external `node.retryDue` alarm, so a naive
 * "converged + not terminal + no commands" condition would tear down every
 * retrying run — the exact opposite of what F2b landed.
 */
import { describe, expect, it } from 'vitest';
import type { EngineCommand, EngineEvent, Node } from '../types.js';
import type { NodePolicy } from '../../schemas/pipeline.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';

let seq = 0;
function node(id: string, extra: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: seq, y: 0 }, ...extra };
}

const RUN = 'r1';
const PV = 'pv1';
const started: EngineEvent = {
  type: 'run.started',
  runId: RUN,
  pipelineVersionId: PV,
  params: {},
};

/** The stall diagnostic's stable prefix. Nothing in production reads it yet. */
const STALL = 'run stalled';

/**
 * Drive a run to completion, resolving each dispatched node from `outcomes`.
 * Same command-QUEUE shape as `malformed-doc.test.ts`'s and `reduce.test.ts`'s
 * `runAll`, and the `guard` is decorative here for the same reason it is there:
 * no doc in this file can make it fire (every `finishRun` folds to a terminal
 * run, after which `reduce` returns early, and each node yields exactly two
 * events). What actually catches a regression is the assertions — a stall that
 * fails to fire leaves `finish === undefined`, which every positive pin asserts
 * against. It is kept for parity with its three siblings.
 *
 * `finishes` counts terminals rather than keeping only the first, and that is
 * load-bearing rather than bookkeeping: it is the ONLY thing that can catch the
 * `else if` → `if` regression, which the driver's pump would otherwise swallow
 * silently (it folds the first terminal and breaks).
 */
function runAll(
  eng: Engine,
  opts: { outcomes?: Record<string, 'success' | 'failure'> } = {},
): {
  finish: { outcome: 'success' | 'failure'; reason?: string } | undefined;
  finishes: number;
  diagnostics: string[];
} {
  const { outcomes = {} } = opts;
  let state = eng.seedState();
  const pending: EngineCommand[] = [];
  const diagnostics: string[] = [];
  let finish: { outcome: 'success' | 'failure'; reason?: string } | undefined;
  let finishes = 0;

  const apply = (ev: EngineEvent): void => {
    const r = eng.reduce(state, ev);
    state = r.state;
    diagnostics.push(...r.diagnostics);
    pending.push(...r.commands);
  };

  apply(started);
  let guard = 0;
  while (pending.length) {
    if (guard++ > 2000) throw new Error('driver did not converge');
    const c = pending.shift()!;
    if (c.type === 'finishRun') {
      finishes += 1;
      if (finish === undefined) finish = { outcome: c.outcome, reason: c.reason };
      apply({ type: 'run.finished', runId: RUN, outcome: c.outcome, reason: c.reason });
      continue;
    }
    if (c.type !== 'dispatchNode') continue;
    apply({
      type: 'node.dispatched',
      runId: RUN,
      nodeId: c.nodeId,
      attemptId: c.attemptId,
      idempotent: true,
    });
    apply(
      (outcomes[c.nodeId] ?? 'success') === 'failure'
        ? {
            type: 'node.failed',
            runId: RUN,
            nodeId: c.nodeId,
            attemptId: c.attemptId,
            error: 'boom',
            kind: 'permanent',
          }
        : {
            type: 'node.succeeded',
            runId: RUN,
            nodeId: c.nodeId,
            attemptId: c.attemptId,
            outputs: {},
          },
    );
  }
  return { finish, finishes, diagnostics };
}

const cycleDoc = (): EngineDoc =>
  ({
    nodes: [node('a'), node('b')],
    edges: [
      { id: 'e1', from: 'a', to: 'b', on: 'success' },
      { id: 'e2', from: 'b', to: 'a', on: 'success' },
    ],
    containers: [],
  }) as unknown as EngineDoc;

describe('#491 — a run that can never finish is terminalized, not wedged', () => {
  it('a top-level forward cycle finishes as failure{stalled} instead of hanging', () => {
    const { finish } = runAll(createEngine(cycleDoc()));
    expect(finish).toEqual({ outcome: 'failure', reason: 'stalled' });
  });

  it('the diagnostic names the entities that can never terminalize', () => {
    const { diagnostics } = runAll(createEngine(cycleDoc()));
    const stall = diagnostics.find((d) => d.startsWith(STALL));
    expect(stall).toBeDefined();
    expect(stall).toContain('a');
    expect(stall).toContain('b');
  });

  it('a cycle among a CONTAINER CHILD set stalls (the child-dispatch path)', () => {
    const eng = createEngine({
      nodes: [node('n1'), node('n2')],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', on: 'success' },
        { id: 'e2', from: 'n2', to: 'n1', on: 'success' },
      ],
      containers: [{ id: 'c1', kind: 'stage', children: ['n1', 'n2'] }],
    } as unknown as EngineDoc);
    const { finish, diagnostics } = runAll(eng);
    expect(finish).toEqual({ outcome: 'failure', reason: 'stalled' });
    // The container is ACTIVE, so its stuck children are named — an operator
    // reading only the top level would see `c1` and learn nothing.
    const stall = diagnostics.find((d) => d.startsWith(STALL));
    expect(stall).toContain('n1');
    expect(stall).toContain('n2');
  });

  it('reports a GHOST child inside an active container without throwing (#487 parity)', () => {
    // The stuck set reads `state.nodes[ch]` for the children of every ACTIVE
    // container, and it reads them UNGUARDED. That read is only sound because
    // `containerById` is built from the #487-FILTERED containers (`kept =
    // children.filter(ch => nodeById.has(ch))`), so a ghost id is gone before
    // the reporter ever sees it — the same reason `stepContainers` may index
    // `state.nodes[ch]!`. Pinned HERE because the guarantee lives in a
    // constructor this file never touches: were the filter narrowed to the
    // dispatch path alone, this reporter would throw a TypeError on exactly the
    // unvalidated pre-#444 rows the backstop exists to terminalize, converting a
    // wedged run into a crashed reduce.
    const eng = createEngine({
      nodes: [node('n1'), node('n2')],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', on: 'success' },
        { id: 'e2', from: 'n2', to: 'n1', on: 'success' },
      ],
      containers: [{ id: 'c1', kind: 'stage', children: ['ghost', 'n1', 'n2'] }],
    } as unknown as EngineDoc);
    const { finish, diagnostics } = runAll(eng);
    expect(finish).toEqual({ outcome: 'failure', reason: 'stalled' });
    const stall = diagnostics.find((d) => d.startsWith(STALL))!;
    // The REAL children are still named...
    expect(stall).toContain('n1');
    expect(stall).toContain('n2');
    // ...and the ghost is not: it is treated as if it were not authored (#480's
    // posture), so it cannot be "never-terminal" — it has no state to terminalize.
    const named = /never-terminal: \{([^}]*)\}/.exec(stall)![1]!.split(', ');
    expect(named).not.toContain('ghost');
  });

  it('names a child listed by TWO active containers exactly ONCE (#492 shape)', () => {
    // The stuck set is a REPORTER over a doc nothing validated, so it must not
    // assume disjoint children. `childToContainer` is last-wins over this doc
    // (#492, open) — that divergence is not settled here; this only pins that the
    // report does not say `n1` twice.
    const eng = createEngine({
      nodes: [node('n1'), node('n2')],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', on: 'success' },
        { id: 'e2', from: 'n2', to: 'n1', on: 'success' },
      ],
      containers: [
        { id: 'c1', kind: 'stage', children: ['n1', 'n2'] },
        { id: 'c2', kind: 'stage', children: ['n1', 'n2'] },
      ],
    } as unknown as EngineDoc);
    const { finish, diagnostics } = runAll(eng);
    expect(finish).toEqual({ outcome: 'failure', reason: 'stalled' });
    const stall = diagnostics.find((d) => d.startsWith(STALL))!;
    const named = /never-terminal: \{([^}]*)\}/.exec(stall)![1]!.split(', ');
    expect(named).toEqual([...new Set(named)]);
    expect(named.filter((n) => n === 'n1')).toHaveLength(1);
  });

  it('CAPS the named set on an attacker-shaped doc, and says it truncated', () => {
    // `children`/`nodes` have no schema max and a pre-#444 row was never
    // validated, so the count is attacker-shaped. Truncation must be STATED —
    // an absent fact is never manufactured as "that was all of them" (F13a/#473).
    const many = Array.from({ length: 60 }, (_, i) => node(`z${String(i).padStart(2, '0')}`));
    const eng = createEngine({
      nodes: [...many, node('a'), node('b')],
      edges: [
        // The cycle wedges the run; every `z*` node is then stuck behind it.
        { id: 'e1', from: 'a', to: 'b', on: 'success' },
        { id: 'e2', from: 'b', to: 'a', on: 'success' },
        ...many.map((n, i) => ({ id: `ez${i}`, from: 'a', to: n.id, on: 'success' as const })),
      ],
      containers: [],
    } as unknown as EngineDoc);
    const { finish, diagnostics } = runAll(eng);
    expect(finish).toEqual({ outcome: 'failure', reason: 'stalled' });
    const stall = diagnostics.find((d) => d.startsWith(STALL))!;
    const named = /never-terminal: \{([^}]*)\}/.exec(stall)![1]!;
    // 62 entities are stuck; 50 are named and the remainder is declared, not dropped.
    expect(named.split(', ').filter((s) => !s.startsWith('…'))).toHaveLength(50);
    expect(named).toContain('…and 12 more');
  });

  it('a cycle between top-level CONTAINERS stalls (the container-readiness path)', () => {
    // A DIFFERENT path from the child cycle above: `computeReadiness` over
    // `topIncoming` for container endpoints, not `tryDispatchNode`.
    const eng = createEngine({
      nodes: [node('n1'), node('n2')],
      edges: [
        { id: 'e1', from: 'c1', to: 'c2', on: 'success' },
        { id: 'e2', from: 'c2', to: 'c1', on: 'success' },
      ],
      containers: [
        { id: 'c1', kind: 'stage', children: ['n1'] },
        { id: 'c2', kind: 'stage', children: ['n2'] },
      ],
    } as unknown as EngineDoc);
    const { finish, diagnostics } = runAll(eng);
    expect(finish).toEqual({ outcome: 'failure', reason: 'stalled' });
    const stall = diagnostics.find((d) => d.startsWith(STALL));
    expect(stall).toContain('c1');
    expect(stall).toContain('c2');
  });

  it('the stall is DELAYED until the last in-flight node resolves (the conservative bias)', () => {
    // `x` is independent and healthy; {a,b} is a cycle. While `x` is in flight
    // the run is NOT stalled — the backstop waits for it, then fires. This is
    // the entire cost of the conservative bias, so it is pinned.
    const eng = createEngine({
      nodes: [node('x'), node('a'), node('b')],
      edges: [
        { id: 'e1', from: 'a', to: 'b', on: 'success' },
        { id: 'e2', from: 'b', to: 'a', on: 'success' },
      ],
      containers: [],
    } as unknown as EngineDoc);

    let state = eng.seedState();
    const r1 = eng.reduce(state, started);
    state = r1.state;
    // `x` is `ready` (its dispatchNode was just emitted) — nothing may finish yet.
    expect(r1.commands.filter((c) => c.type === 'finishRun')).toEqual([]);
    expect(r1.diagnostics.filter((d) => d.startsWith(STALL))).toEqual([]);

    const d = eng.reduce(state, {
      type: 'node.dispatched',
      runId: RUN,
      nodeId: 'x',
      attemptId: 'x#0',
      idempotent: true,
    });
    state = d.state;
    expect(d.commands.filter((c) => c.type === 'finishRun')).toEqual([]);

    const s = eng.reduce(state, {
      type: 'node.succeeded',
      runId: RUN,
      nodeId: 'x',
      attemptId: 'x#0',
      outputs: {},
    });
    // Now nothing is in flight and {a,b} can never become ready.
    expect(s.commands).toEqual([{ type: 'finishRun', outcome: 'failure', reason: 'stalled' }]);
  });
});

describe('#491 — the four states a run legitimately waits in are NEVER stalled', () => {
  /**
   * A `root` fanning out to `keep` and `other`, so the two branches are genuinely
   * PARALLEL: `keep` is parked in the state under test while `other` completes
   * and drives `settle`. That is the only way to reach a fixpoint whose ONLY
   * live entity is `keep`.
   *
   * The fan-out is authored EXPLICITLY, and it has to be. `effectiveEdges`
   * (`params.ts`) synthesizes an implicit SEQUENTIAL chain when a doc declares
   * no edges, so `edges: []` over `[keep, other]` is `keep → other` — a chain in
   * which `other` can never be in flight beside `keep`. A first draft of these
   * pins did exactly that and they failed for that reason, not because the
   * backstop misfired.
   */
  const parallelBranches = (keep: Node): Engine =>
    createEngine({
      nodes: [node('root'), keep, node('other')],
      edges: [
        { id: 'e1', from: 'root', to: keep.id, on: 'success' },
        { id: 'e2', from: 'root', to: 'other', on: 'success' },
      ],
      containers: [],
    } as unknown as EngineDoc);

  /** Fold `run.started` → root dispatched → root succeeded; both branches now live. */
  function afterRoot(eng: Engine): ReturnType<Engine['seedState']> {
    let state = eng.seedState();
    for (const ev of [
      started,
      {
        type: 'node.dispatched',
        runId: RUN,
        nodeId: 'root',
        attemptId: 'root#0',
        idempotent: true,
      },
      { type: 'node.succeeded', runId: RUN, nodeId: 'root', attemptId: 'root#0', outputs: {} },
    ] as EngineEvent[]) {
      state = eng.reduce(state, ev).state;
    }
    return state;
  }

  it('a just-dispatched (`ready`) node — the first settle of EVERY healthy run', () => {
    // The sharpest false-positive risk: `settle` emits `dispatchNode` and leaves
    // the node `ready`, NOT `dispatched`. A backstop excluding only `dispatched`
    // would fire here and tear down every run on its very first fold.
    const eng = createEngine({
      nodes: [node('a'), node('b')],
      edges: [{ id: 'e1', from: 'a', to: 'b', on: 'success' }],
      containers: [],
    } as unknown as EngineDoc);
    const r = eng.reduce(eng.seedState(), started);
    expect(r.state.nodes.a!.status).toBe('ready');
    expect(r.commands.filter((c) => c.type === 'finishRun')).toEqual([]);
    expect(r.diagnostics.filter((d) => d.startsWith(STALL))).toEqual([]);
  });

  it('a `dispatched` node awaiting its result', () => {
    const eng = parallelBranches(node('a'));
    let state = afterRoot(eng);
    for (const ev of [
      { type: 'node.dispatched', runId: RUN, nodeId: 'a', attemptId: 'a#0', idempotent: true },
      {
        type: 'node.dispatched',
        runId: RUN,
        nodeId: 'other',
        attemptId: 'other#0',
        idempotent: true,
      },
    ] as EngineEvent[]) {
      state = eng.reduce(state, ev).state;
    }
    expect(state.nodes.a!.status).toBe('dispatched');
    // `other` settling must not finish the run while `a` is still out there.
    const r = eng.reduce(state, {
      type: 'node.succeeded',
      runId: RUN,
      nodeId: 'other',
      attemptId: 'other#0',
      outputs: {},
    });
    expect(r.commands.filter((c) => c.type === 'finishRun')).toEqual([]);
    expect(r.diagnostics.filter((d) => d.startsWith(STALL))).toEqual([]);
  });

  it('a HELD (`retry_pending`) node awaiting its S1 alarm — F2b must not be torn down', () => {
    const policy: NodePolicy = { retry: 1, retryIntervalSeconds: 30 };
    const eng = parallelBranches(node('a', { policy }));
    let state = afterRoot(eng);
    for (const ev of [
      { type: 'node.dispatched', runId: RUN, nodeId: 'a', attemptId: 'a#0', idempotent: true },
      {
        type: 'node.dispatched',
        runId: RUN,
        nodeId: 'other',
        attemptId: 'other#0',
        idempotent: true,
      },
      {
        type: 'node.failed',
        runId: RUN,
        nodeId: 'a',
        attemptId: 'a#0',
        error: 'flaky',
        kind: 'transient',
      },
    ] as EngineEvent[]) {
      state = eng.reduce(state, ev).state;
    }
    expect(state.nodes.a!.status).toBe('retry_pending');

    // `other` settling drives `settle` while `a` is HELD. Nothing is in flight —
    // `a` waits on an EXTERNAL `node.retryDue` — so a naive "converged + not
    // terminal + no commands" predicate would fire right here.
    const r = eng.reduce(state, {
      type: 'node.succeeded',
      runId: RUN,
      nodeId: 'other',
      attemptId: 'other#0',
      outputs: {},
    });
    expect(r.commands.filter((c) => c.type === 'finishRun')).toEqual([]);
    expect(r.diagnostics.filter((d) => d.startsWith(STALL))).toEqual([]);
  });

  it('a `waiting` call_pipeline node awaiting `call.returned`', () => {
    const eng = parallelBranches(
      node('a', { call: { pipelineVersionId: 'pv-child', params: {} } }),
    );
    let state = afterRoot(eng);
    for (const ev of [
      {
        type: 'node.dispatched',
        runId: RUN,
        nodeId: 'other',
        attemptId: 'other#0',
        idempotent: true,
      },
    ] as EngineEvent[]) {
      state = eng.reduce(state, ev).state;
    }
    expect(state.nodes.a!.status).toBe('waiting');
    const r = eng.reduce(state, {
      type: 'node.succeeded',
      runId: RUN,
      nodeId: 'other',
      attemptId: 'other#0',
      outputs: {},
    });
    expect(r.commands.filter((c) => c.type === 'finishRun')).toEqual([]);
    expect(r.diagnostics.filter((d) => d.startsWith(STALL))).toEqual([]);
  });
});

describe('#491 — the backstop changes no run that could already finish', () => {
  it('a SKIP-PROPAGATED cycle still finishes success, with EXACTLY ONE finishRun', () => {
    // The joint F1b/F2b spec (§P4, build-time correction) probed this: a forward
    // cycle whose skip enters from OUTSIDE terminalizes every node WITHOUT
    // running it, so `allTopLevelTerminal` HOLDS and the run legitimately
    // succeeds. A cycle does NOT imply a stall.
    //
    // This is the ordering pin. The stall branch must be `else if` on
    // `allTopLevelTerminal`: as a bare `if` it would push a SECOND
    // finishRun{failure,'stalled'} after the success — and the driver's pump
    // folds the first, hits its terminal guard and breaks, so the bug would be
    // SILENT at runtime and visible only here.
    const eng = createEngine({
      nodes: [node('x'), node('a'), node('b'), node('c')],
      edges: [
        { id: 'e1', from: 'x', to: 'a', on: 'failure' },
        { id: 'e2', from: 'a', to: 'b', on: 'success' },
        { id: 'e3', from: 'b', to: 'a', on: 'success' },
        { id: 'e4', from: 'b', to: 'c', on: 'success' },
      ],
      containers: [],
    } as unknown as EngineDoc);
    const { finish, finishes, diagnostics } = runAll(eng);
    expect(finish).toEqual({ outcome: 'success', reason: undefined });
    expect(finishes).toBe(1);
    expect(diagnostics.filter((d) => d.startsWith(STALL))).toEqual([]);
  });

  it('an ordinary run still succeeds, and an empty doc still finishes', () => {
    const ok = runAll(
      createEngine({
        nodes: [node('a'), node('b')],
        edges: [{ id: 'e1', from: 'a', to: 'b', on: 'success' }],
        containers: [],
      } as unknown as EngineDoc),
    );
    expect(ok.finish).toEqual({ outcome: 'success', reason: undefined });
    expect(ok.finishes).toBe(1);

    const empty = runAll(
      createEngine({ nodes: [], edges: [], containers: [] } as unknown as EngineDoc),
    );
    expect(empty.finish).toEqual({ outcome: 'success', reason: undefined });
    expect(empty.diagnostics.filter((d) => d.startsWith(STALL))).toEqual([]);
  });

  it('an ordinary FAILING run still reports its blamed node, not `stalled`', () => {
    const { finish } = runAll(
      createEngine({
        nodes: [node('a'), node('b')],
        edges: [{ id: 'e1', from: 'a', to: 'b', on: 'success' }],
        containers: [],
      } as unknown as EngineDoc),
      { outcomes: { a: 'failure' } },
    );
    expect(finish).toEqual({ outcome: 'failure', reason: 'node_failed:a' });
  });
});

describe('#491 — the terminal fact is durable and replay-safe', () => {
  it('run.finished{failure,stalled} folds to `failure` without an invalid_event rejection', () => {
    // Only `run.finished{success}` sits behind the impossibility check, so the
    // driver's append of this terminal must fold cleanly. If it did not, the
    // reducer would call its own command impossible and strand the run.
    const eng = createEngine(cycleDoc());
    const r1 = eng.reduce(eng.seedState(), started);
    expect(r1.commands).toEqual([{ type: 'finishRun', outcome: 'failure', reason: 'stalled' }]);
    const r2 = eng.reduce(r1.state, {
      type: 'run.finished',
      runId: RUN,
      outcome: 'failure',
      reason: 'stalled',
    });
    expect(r2.state.status).toBe('failure');
    expect(r2.commands).toEqual([]);
    expect(r2.diagnostics.filter((d) => d.includes('impossible'))).toEqual([]);
  });

  it('REPLAYING a historical stalled log does not retro-finish it (#443)', () => {
    // `projectRunState` DISCARDS commands, so folding an old log through the new
    // reducer cannot append a terminal that never happened. The row's outcome is
    // the LOG's business (#443); this backstop only ever adds a finishRun via a
    // live `reduce`/`driveRun`, never via replay.
    const eng = createEngine(cycleDoc());
    expect(eng.projectRunState([started]).status).toBe('running');
  });
});
