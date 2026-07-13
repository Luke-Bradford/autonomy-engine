import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type Edge,
  type EngineEvent,
  type Node,
  type NewPipelineVersion,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun, updateRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { buildEngine, startRun, type DocResolver } from '../driver.js';
import { appendEngineEvent, loadEngineEvents } from '../events.js';
import { reconcileOnBoot } from '../reconcile.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';

type Db = ReturnType<typeof freshDb>['db'];

let seq = 0;
function node(id: string, extra: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: seq, y: 0 }, ...extra };
}
function edge(from: string, to: string, on: Edge['on'] = 'success'): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}

function seedVersion(db: Db, nodes: Node[], edges: Edge[] = []): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes,
    edges,
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input).id;
}

function seedRun(db: Db, pvId: string) {
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId: pvId,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
}

function resolveDocFor(db: Db): DocResolver {
  return (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
}

/**
 * Simulate a server crash mid-run: drive the run with an executor that HANGS
 * the named nodes (emits `node.dispatched` but no terminal), leaving them
 * `dispatched` and the run `running` — exactly what the reconciler finds on
 * boot. `idempotent` is persisted into each hung node's `node.dispatched`.
 */
async function seedCrashedRun(db: Db, nodes: Node[], edges: Edge[], hangPlan: StubExecutorOptions) {
  const pvId = seedVersion(db, nodes, edges);
  const run = seedRun(db, pvId);
  await startRun({ db, resolveDoc: resolveDocFor(db), executor: makeStubExecutor(hangPlan) }, run);
  return run;
}

function types(events: EngineEvent[]): string[] {
  return events.map((e) => e.type);
}

describe('reconcileOnBoot — idempotent resume', () => {
  it('resumes an idempotent in-flight node under a NEW attempt and drives it to success', async () => {
    const { db } = freshDb();
    const run = await seedCrashedRun(db, [node('a')], [], {
      nodes: { a: { hang: true, idempotent: true } },
    });

    // Precondition: crashed mid-dispatch at attempt a#0.
    let state = buildEngine(getPipelineVersion(db, run.pipelineVersionId)!).projectRunState(
      loadEngineEvents(db, run.id),
    );
    expect(state.status).toBe('running');
    expect(state.nodes.a!.status).toBe('dispatched');
    expect(state.nodes.a!.currentAttemptId).toBe('a#0');

    const recovery = makeStubExecutor({ nodes: { a: { outcome: 'success' } } });
    const report = await reconcileOnBoot({ db, resolveDoc: resolveDocFor(db), executor: recovery });

    expect(report.resumed).toEqual([run.id]);
    expect(report.interrupted).toEqual([]);

    // A fresh attempt (a#1) was minted — any late a#0 result is now stale.
    expect(recovery.dispatched).toEqual(['a#1']);
    const log = loadEngineEvents(db, run.id);
    expect(types(log)).toContain('run.resumed');
    expect(types(log)).toContain('node.retryRequested');

    state = buildEngine(getPipelineVersion(db, run.pipelineVersionId)!).projectRunState(log);
    expect(state.status).toBe('success');
    expect(state.nodes.a!.currentAttemptId).toBe('a#1');
    expect(getRun(db, run.id)!.status).toBe('success');
  });

  it('a stale pre-crash result for the OLD attempt does not corrupt the resumed run', async () => {
    const { db } = freshDb();
    const run = await seedCrashedRun(db, [node('a')], [], {
      nodes: { a: { hang: true, idempotent: true } },
    });
    await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor({ nodes: { a: { outcome: 'success', outputs: { v: 'fresh' } } } }),
    });

    // The pre-crash executor's late result for a#0 lands after recovery.
    const engine = buildEngine(getPipelineVersion(db, run.pipelineVersionId)!);
    const stale: EngineEvent = {
      type: 'node.succeeded',
      runId: run.id,
      nodeId: 'a',
      attemptId: 'a#0',
      outputs: { v: 'STALE' },
    };
    const state = engine.projectRunState([...loadEngineEvents(db, run.id), stale]);
    // Unchanged: the fresh a#1 result stands, the stale a#0 is ignored.
    expect(state.status).toBe('success');
    expect(state.outputs.a).toEqual({ v: 'fresh' });
  });
});

describe('reconcileOnBoot — non-idempotent interrupt', () => {
  it('freezes a run whose non-idempotent node was in flight, without resuming', async () => {
    const { db } = freshDb();
    const run = await seedCrashedRun(db, [node('a')], [], {
      nodes: { a: { hang: true, idempotent: false } },
    });

    const recovery = makeStubExecutor({ nodes: { a: { outcome: 'success' } } });
    const report = await reconcileOnBoot({ db, resolveDoc: resolveDocFor(db), executor: recovery });

    expect(report.interrupted).toEqual([run.id]);
    expect(report.resumed).toEqual([]);
    // Never re-dispatched.
    expect(recovery.dispatched).toEqual([]);

    const log = loadEngineEvents(db, run.id);
    expect(types(log)).toContain('run.interrupted');
    expect(types(log)).not.toContain('run.resumed');

    const state = buildEngine(getPipelineVersion(db, run.pipelineVersionId)!).projectRunState(log);
    expect(state.status).toBe('interrupted');
    // The node stays dispatched/needs-attention — NOT terminalized.
    expect(state.nodes.a!.status).toBe('dispatched');
    expect(getRun(db, run.id)!.status).toBe('interrupted');
    expect(getRun(db, run.id)!.finishedAt).not.toBeNull();
  });

  it('interrupts when ANY in-flight node is non-idempotent (mixed fleet is fail-safe)', async () => {
    const { db } = freshDb();
    // Two roots dispatched in PARALLEL (explicit edges to a shared sink — an
    // edge-less doc would instead synthesise an implicit a→b success-chain).
    // Only b is non-idempotent.
    const run = await seedCrashedRun(
      db,
      [node('a'), node('b'), node('sink')],
      [edge('a', 'sink'), edge('b', 'sink')],
      { nodes: { a: { hang: true, idempotent: true }, b: { hang: true, idempotent: false } } },
    );

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
    });
    expect(report.interrupted).toEqual([run.id]);
    const state = buildEngine(getPipelineVersion(db, run.pipelineVersionId)!).projectRunState(
      loadEngineEvents(db, run.id),
    );
    expect(state.status).toBe('interrupted');
  });
});

describe('reconcileOnBoot — no executor defers resume', () => {
  it('interrupts non-idempotent but DEFERS an idempotent-resumable run (no events appended)', async () => {
    const { db } = freshDb();
    const idem = await seedCrashedRun(db, [node('a')], [], {
      nodes: { a: { hang: true, idempotent: true } },
    });
    const nonIdem = await seedCrashedRun(db, [node('a')], [], {
      nodes: { a: { hang: true, idempotent: false } },
    });

    const before = loadEngineEvents(db, idem.id).length;
    const report = await reconcileOnBoot({ db, resolveDoc: resolveDocFor(db) });

    expect(report.deferred).toEqual([idem.id]);
    expect(report.interrupted).toEqual([nonIdem.id]);
    // The deferred run is untouched: still running, no new events.
    expect(getRun(db, idem.id)!.status).toBe('running');
    expect(loadEngineEvents(db, idem.id).length).toBe(before);
    // The interrupted run IS frozen.
    expect(getRun(db, nonIdem.id)!.status).toBe('interrupted');
  });
});

describe('reconcileOnBoot — resync a torn terminal write', () => {
  it('re-syncs a running row whose log already ended terminal', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    await startRun({ db, resolveDoc: resolveDocFor(db), executor: makeStubExecutor() }, run);
    expect(getRun(db, run.id)!.status).toBe('success');

    // Simulate a crash AFTER the terminal event was appended but BEFORE the
    // lifecycle sync committed: the row is stuck `running`, the log says success.
    updateRun(db, run.id, { status: 'running', finishedAt: null });

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
    });
    expect(report.resynced).toEqual([run.id]);
    expect(report.resumed).toEqual([]);
    expect(report.interrupted).toEqual([]);
    expect(getRun(db, run.id)!.status).toBe('success');
  });
});

describe('reconcileOnBoot — finalize a crash-dropped finishRun', () => {
  // A run that reached its terminal NODE event but crashed before `run.finished`
  // (the driver appends them in separate transactions). The log ends at
  // node.succeeded with no terminal fact; the projection is stuck `running` with
  // NO live node (the node is `success`, not dispatched/ready/waiting) — so the
  // old resync/resume/interrupt branches all missed it and it hung forever.
  function seedTerminalButUnfinished(db: Db) {
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    appendEngineEvent(db, {
      type: 'run.started',
      runId: run.id,
      pipelineVersionId: pvId,
      params: {},
    });
    appendEngineEvent(db, {
      type: 'node.dispatched',
      runId: run.id,
      nodeId: 'a',
      attemptId: 'a#0',
      idempotent: true,
    });
    appendEngineEvent(db, {
      type: 'node.succeeded',
      runId: run.id,
      nodeId: 'a',
      attemptId: 'a#0',
      outputs: {},
    });
    updateRun(db, run.id, { status: 'running', finishedAt: null });
    // Precondition: projection is a terminal-node-yet-running zombie.
    const state = buildEngine(getPipelineVersion(db, pvId)!).projectRunState(
      loadEngineEvents(db, run.id),
    );
    expect(state.status).toBe('running');
    expect(state.nodes.a!.status).toBe('success');
    return run;
  }

  it('finalizes the zombie run to success (WITH an executor)', async () => {
    const { db } = freshDb();
    const run = seedTerminalButUnfinished(db);

    const executor = makeStubExecutor();
    const report = await reconcileOnBoot({ db, resolveDoc: resolveDocFor(db), executor });

    expect(report.finalized).toEqual([run.id]);
    expect(report.resumed).toEqual([]);
    // No node work — the executor is never invoked on the finalize path.
    expect(executor.dispatched).toEqual([]);
    expect(getRun(db, run.id)!.status).toBe('success');
    expect(types(loadEngineEvents(db, run.id))).toContain('run.finished');
  });

  it('finalizes WITHOUT an executor (finishRun needs none — was previously stuck forever)', async () => {
    const { db } = freshDb();
    const run = seedTerminalButUnfinished(db);

    const report = await reconcileOnBoot({ db, resolveDoc: resolveDocFor(db) });

    expect(report.finalized).toEqual([run.id]);
    expect(report.deferred).toEqual([]);
    const state = buildEngine(getPipelineVersion(db, run.pipelineVersionId)!).projectRunState(
      loadEngineEvents(db, run.id),
    );
    expect(state.status).toBe('success');
    expect(getRun(db, run.id)!.status).toBe('success');
  });
});

describe('reconcileOnBoot — waiting call node', () => {
  it('re-emits startChild for a waiting call node and drives it to completion', async () => {
    const { db } = freshDb();
    const callNode = node('call', {
      type: 'call_pipeline',
      call: { pipelineVersionId: 'pv-child', params: {} },
    });
    // Crash: startChild emitted, child never returned → node `waiting`.
    const pvId = seedVersion(db, [callNode]);
    const run = seedRun(db, pvId);
    await startRun(
      { db, resolveDoc: resolveDocFor(db), executor: makeStubExecutor({ child: { hang: true } }) },
      run,
    );
    let state = buildEngine(getPipelineVersion(db, pvId)!).projectRunState(
      loadEngineEvents(db, run.id),
    );
    expect(state.nodes.call!.status).toBe('waiting');

    const recovery = makeStubExecutor({ child: { childOutcome: 'success' } });
    const report = await reconcileOnBoot({ db, resolveDoc: resolveDocFor(db), executor: recovery });

    expect(report.resumed).toEqual([run.id]);
    expect(recovery.startedChildren.length).toBe(1);
    state = buildEngine(getPipelineVersion(db, pvId)!).projectRunState(
      loadEngineEvents(db, run.id),
    );
    expect(state.status).toBe('success');
    expect(getRun(db, run.id)!.status).toBe('success');
  });
});
