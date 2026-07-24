/**
 * RS3 — container/loop reseed rules (completed = copy, mid-flight/failed = re-run),
 * proven END-TO-END through a REAL container run + a real rerun-from-failed.
 *
 * The RULE itself is delivered by RS1 (the `run.reseeded` fold seeds a copied
 * container only if it is a TERMINAL unit) + RS2 (`reseedFrontier` includes a
 * container iff it reached terminal `success`; a mid-flight/`failure` container is
 * excluded → re-runs whole). RS2 explicitly deferred the "loop-round /
 * foreach-instance copiability NUANCES" to RS3 — and those nuances turn out to be
 * a SOUNDNESS property, not new code: a completed container is copied WHOLE via
 * `copiedContainers`, but its internal body/instance-key node states are NOT
 * seeded into R2's `state.nodes`. This suite proves that copying a terminal
 * container of every drivable kind (stage, foreach sequential, foreach parallel)
 * and NOT seeding its children resumes soundly — R2 re-runs the downstream, never
 * re-dispatches the copied body, and converges with no diagnostic/throw — and that
 * a NON-terminal (failed) container re-runs its whole body in R2.
 *
 * Unlike `reseed-frontier.test.ts` (which fabricates R1's `RunState` directly to
 * unit-test the pure algorithm), these tests DRIVE a real R1 to quiescence against
 * the real reducer, then drive R2 with the reseed manifest `reseedFrontier`
 * produced — the copy-vs-re-run behaviour end to end, no mocks.
 */
import { describe, expect, it } from 'vitest';
import type { Container, Edge, EngineEvent, Node } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { docNodeIdOf } from '../instance-key.js';
import { driveRun, simpleResolve, type OutcomeResolver } from './helpers/run-driver.js';

let seq = 0;
function node(id: string): Node {
  seq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: seq, y: 0 } };
}
function edge(from: string, to: string, on: Edge['on'] = 'success'): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on } as Edge;
}
function engine(nodes: Node[], edges: Edge[] = [], containers: Container[] = []): Engine {
  return createEngine({ nodes, edges, containers } satisfies EngineDoc);
}

/**
 * Drive R1 to quiescence, compute the reseed manifest `reseedFrontier` produces,
 * then drive R2 from it. R2 reuses R1's params EXACTLY (RS2 forbids override), so
 * the same `params` seed both runs.
 */
function rerunFromFailed(
  eng: Engine,
  r1Outcomes: Record<string, 'success' | 'failure'>,
  opts: { params?: Record<string, unknown>; r2Resolve?: OutcomeResolver } = {},
): {
  r1: ReturnType<typeof driveRun>;
  manifest: ReturnType<Engine['reseedFrontier']>;
  r2: ReturnType<typeof driveRun>;
} {
  const params = opts.params ?? {};
  const r1 = driveRun(eng, { runId: 'R1', params, resolve: simpleResolve(r1Outcomes) });
  const manifest = eng.reseedFrontier(r1.state);
  const r2 = driveRun(eng, {
    runId: 'R2',
    params,
    resolve: opts.r2Resolve ?? simpleResolve({}),
    reseed: { sourceRunId: 'R1', ...manifest },
  });
  return { r1, manifest, r2 };
}

describe('RS3 — a completed container is copied WHOLE and its children are not re-run', () => {
  it('stage: copies the terminal stage, re-runs only the downstream, seeds no child state', () => {
    // stg(child) --success--> after; after FAILS in R1 so the stage is on the frontier.
    const eng = engine(
      [node('child'), node('after')],
      [edge('stg', 'after')],
      [{ id: 'stg', kind: 'stage', children: ['child'] }],
    );
    const { r1, manifest, r2 } = rerunFromFailed(eng, { after: 'failure' });

    // R1: stage succeeded (child ran), after failed.
    expect(r1.state.containers.stg!.status).toBe('success');
    expect(r1.state.nodes.child!.status).toBe('success');
    expect(r1.finish?.outcome).toBe('failure');

    // The manifest copies the container whole; `frontier` is top-level NODE ids
    // only (a container is carried in `copiedContainers`, never `frontier`).
    expect(manifest.frontier).toEqual([]);
    expect(manifest.copiedContainers.stg?.status).toBe('success');

    // R2: the stage is COPIED (never re-entered), the downstream RE-RUNS.
    expect(r2.finish?.outcome).toBe('success');
    expect(r2.state.containers.stg!.status).toBe('success');
    expect(r2.order).not.toContain('child'); // body NOT re-dispatched
    expect(r2.order).toContain('after'); // downstream re-ran
    // SOUNDNESS: the copied container's body child is seeded `pending` at R2 start
    // (as every doc node is) and NEVER transitions — the copied-terminal container
    // is not re-entered, so its child is never dispatched — yet the run finishes
    // clean. The direct proof that nothing reads the child's state once the
    // container is copied-terminal.
    expect(r2.state.nodes.child!.status).toBe('pending');
    expect(r2.diagnostics).toEqual([]);
  });

  it('foreach (sequential): copies the terminal foreach, re-runs only the downstream', () => {
    // fe runs `inner` once per item (2 items) via the A4a round machinery.
    const eng = engine(
      [node('inner'), node('after')],
      [edge('fe', 'after')],
      // `items` is a ${...} expression over the OUTER scope (validateDoc rejects a
      // bare JSON literal), resolved once at enter — two elements ⇒ two rounds.
      [{ id: 'fe', kind: 'foreach', children: ['inner'], items: '${params.items}' }],
    );
    const { r1, manifest, r2 } = rerunFromFailed(
      eng,
      { after: 'failure' },
      { params: { items: [1, 2] } },
    );

    expect(r1.state.containers.fe!.status).toBe('success');
    expect(manifest.copiedContainers.fe?.status).toBe('success');

    expect(r2.finish?.outcome).toBe('success');
    expect(r2.state.containers.fe!.status).toBe('success');
    // No round of the body re-runs (docNodeIdOf collapses any round/instance key).
    expect(r2.order.filter((id) => docNodeIdOf(id) === 'inner')).toEqual([]);
    expect(r2.order).toContain('after');
    expect(r2.diagnostics).toEqual([]);
  });

  it('foreach (PARALLEL): copies the terminal foreach, seeds no instance-key node state', () => {
    // batchCount >= 2 → each item's body node lives under `inner@<i>` in R1; those
    // instance-key nodes are deleted on item completion, so a copied terminal
    // foreach legitimately carries none — this proves the copy resumes soundly.
    const eng = engine(
      [node('inner'), node('after')],
      [edge('fe', 'after')],
      [{ id: 'fe', kind: 'foreach', children: ['inner'], items: '${params.items}', batchCount: 2 }],
    );
    const { r1, manifest, r2 } = rerunFromFailed(
      eng,
      { after: 'failure' },
      { params: { items: [1, 2] } },
    );

    // Pin that R1 genuinely ran the body under PER-ITEM instance keys (`inner@0`,
    // `inner@1`) — otherwise a `batchCount:2` that silently degraded to sequential
    // would still pass every assertion below, and the "no instance-key state"
    // claim would be vacuous.
    expect(r1.order).toEqual(expect.arrayContaining(['inner@0', 'inner@1']));
    // …and none of those instance-key nodes survive into R1's terminal projection
    // (a completed parallel item deletes its instance nodes) — so a copied terminal
    // foreach legitimately carries none.
    expect(Object.keys(r1.state.nodes).filter((id) => docNodeIdOf(id) === 'inner')).toEqual([]);

    expect(manifest.copiedContainers.fe?.status).toBe('success');
    expect(r2.finish?.outcome).toBe('success');
    expect(r2.state.containers.fe!.status).toBe('success');
    expect(r2.order.filter((id) => docNodeIdOf(id) === 'inner')).toEqual([]);
    expect(r2.order).toContain('after');
    expect(r2.diagnostics).toEqual([]);
  });

  it('loop: copies the terminal loop (exitWhen/round state) whole, re-runs only the downstream', () => {
    // A loop re-rounds until `exitWhen` is true — a distinct internal shape
    // (round machinery) from stage/foreach, so its whole-copy is worth pinning.
    const eng = engine(
      [node('body'), node('after')],
      [edge('lp', 'after')],
      [
        {
          id: 'lp',
          kind: 'loop',
          children: ['body'],
          exitWhen: '${nodes.body.output.done}',
          maxRounds: 5,
        },
      ],
    );
    // R1: `body` succeeds with `done:true` (loop exits round 0), then `after` fails.
    const r1Resolve: OutcomeResolver = (nodeId, attemptId, runId) =>
      docNodeIdOf(nodeId) === 'after'
        ? { type: 'node.failed', runId, nodeId, attemptId, error: 'boom', kind: 'permanent' }
        : {
            type: 'node.succeeded',
            runId,
            nodeId,
            attemptId,
            outputs: docNodeIdOf(nodeId) === 'body' ? { done: true } : {},
          };
    const r1 = driveRun(eng, { runId: 'R1', resolve: r1Resolve });
    const manifest = eng.reseedFrontier(r1.state);
    const r2 = driveRun(eng, {
      runId: 'R2',
      resolve: simpleResolve({}),
      reseed: { sourceRunId: 'R1', ...manifest },
    });

    expect(r1.state.containers.lp!.status).toBe('success');
    expect(manifest.copiedContainers.lp?.status).toBe('success');
    expect(r2.finish?.outcome).toBe('success');
    expect(r2.state.containers.lp!.status).toBe('success');
    expect(r2.order.filter((id) => docNodeIdOf(id) === 'body')).toEqual([]); // no round re-runs
    expect(r2.order).toContain('after');
    expect(r2.diagnostics).toEqual([]);
  });

  it('durably carries the copy at its log head (CP1: no R1 re-read on replay)', () => {
    const eng = engine(
      [node('child'), node('after')],
      [edge('stg', 'after')],
      [{ id: 'stg', kind: 'stage', children: ['child'] }],
    );
    const { r2 } = rerunFromFailed(eng, { after: 'failure' });
    // The load-bearing check is the LOG SHAPE: R2's durable head is exactly
    // `run.started{rerunOf} + run.reseeded`, so a boot-reconcile / replay of R2's
    // OWN log reconstructs the reseeded state without ever re-reading R1 — the CP1
    // invariant behind a reseed being an EVENT, not a projection preload.
    expect(r2.log[0]!.type).toBe('run.started');
    expect((r2.log[0] as Extract<EngineEvent, { type: 'run.started' }>).rerunOf).toBe('R1');
    expect(r2.log[1]!.type).toBe('run.reseeded');
    // (`projectRunState(log) === state` is the driver's own fold restated, so it
    // only re-confirms `reduce` is deterministic — the log-head assertions above
    // are what pin the reseed-specific behaviour.)
    expect(eng.projectRunState(r2.log)).toEqual(r2.state);
  });
});

describe('RS3 — a non-terminal container re-runs its WHOLE body', () => {
  it('failed stage: excluded from the frontier, re-entered and re-run in R2', () => {
    // stg(child) is a root; child FAILS in R1 → stage failure → run failure.
    const eng = engine([node('child')], [], [{ id: 'stg', kind: 'stage', children: ['child'] }]);
    const { r1, manifest, r2 } = rerunFromFailed(eng, { child: 'failure' });

    expect(r1.state.containers.stg!.status).toBe('failure');
    expect(r1.finish?.outcome).toBe('failure');

    // A failed container is NOT copiable — an empty manifest, so R2 starts fresh.
    expect(manifest.frontier).toEqual([]);
    expect(manifest.copiedContainers).toEqual({});

    // R2: the stage RE-ENTERS and re-runs its body to success.
    expect(r2.state.containers.stg!.status).toBe('success');
    expect(r2.order).toContain('child'); // whole body re-ran
    expect(r2.finish?.outcome).toBe('success');
    expect(r2.diagnostics).toEqual([]);
  });
});
