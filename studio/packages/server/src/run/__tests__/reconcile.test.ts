import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type Edge,
  type EdgeOn,
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
function edge(from: string, to: string, on: EdgeOn = 'success'): Edge {
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

describe('reconcileOnBoot — #443 the LOG is authoritative over the projection', () => {
  /**
   * #443. Runs are event-sourced (`state = fold(run_events)`) with the CURRENT
   * reducer, so ANY reducer semantics change re-folds already-finished logs. When
   * the re-fold disagrees with a log that already recorded `run.finished`, the old
   * projection-based check here missed its fast path and RE-DROVE a finished run —
   * re-executing a node's side effect.
   *
   * The log below is HAND-AUTHORED (synthetic), and deliberately so: it pins the
   * MECHANISM — "the log records a terminal fact the current reducer would not
   * re-derive" — not any one reducer change's provenance. Today the current
   * reducer rejects this `run.finished{success}` (the `a --completion--> d` arm
   * rescues failed `a`, so `d` is `ready` and the run does not look finished),
   * which is exactly what makes the projection say `running`. F1b will make the
   * same shape reachable from logs an OLD reducer legitimately ACCEPTED (every
   * Do-If-Else doc), at scale. The reconciler cannot tell the two apart — and
   * under this rule it does not need to: it never re-derives a recorded terminal.
   */
  function seedTerminalLogTheReducerWontReDerive(db: Db) {
    const pvId = seedVersion(
      db,
      [node('a'), node('d')],
      [edge('a', 'd', 'success'), edge('a', 'd', 'completion')],
    );
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
      type: 'node.failed',
      runId: run.id,
      nodeId: 'a',
      attemptId: 'a#0',
      error: 'boom',
      kind: 'permanent',
    });
    // The durable terminal fact.
    appendEngineEvent(db, { type: 'run.finished', runId: run.id, outcome: 'success' });
    // The torn write: a crash between the terminal append and its lifecycle sync.
    updateRun(db, run.id, { status: 'running', finishedAt: null });

    // Precondition — the whole point: the CURRENT reducer re-folds this log to a
    // LIVE run that disagrees with its own recorded terminal fact.
    const state = buildEngine(getPipelineVersion(db, pvId)!).projectRunState(
      loadEngineEvents(db, run.id),
    );
    expect(state.status).toBe('running');
    expect(state.nodes.d!.status).toBe('ready');
    return run;
  }

  it('re-syncs from the log and NEVER re-executes a finished run’s side effect', async () => {
    const { db } = freshDb();
    const run = seedTerminalLogTheReducerWontReDerive(db);
    const before = loadEngineEvents(db, run.id).length;

    const executor = makeStubExecutor();
    const report = await reconcileOnBoot({ db, resolveDoc: resolveDocFor(db), executor });

    expect(report.resynced).toEqual([run.id]);
    expect(report.resumed).toEqual([]);
    expect(report.finalized).toEqual([]);
    // THE damage this ticket exists to prevent: before the fix this was ['d#0'].
    expect(executor.dispatched).toEqual([]);
    // The append-only log gains NOTHING — no `run.resumed`, no contradictory 2nd terminal.
    expect(loadEngineEvents(db, run.id).length).toBe(before);
    expect(getRun(db, run.id)!.status).toBe('success');
    expect(getRun(db, run.id)!.finishedAt).not.toBeNull();
  });

  it('takes the LAST terminal event: a rejected finish then its accepted replacement ⇒ failure', async () => {
    // `pump` appends `run.finished` BEFORE folding it (driver.ts:176-177), so a
    // finish the reducer REJECTS is durably in the log, followed by the
    // `finishRun{failure, invalid_event}` it returns instead. Reading the FIRST
    // terminal would resync the rejected `success` — fail-OPEN. The last terminal
    // event is the driver's actual conclusion.
    const { db } = freshDb();
    const run = seedTerminalLogTheReducerWontReDerive(db);
    appendEngineEvent(db, {
      type: 'run.finished',
      runId: run.id,
      outcome: 'failure',
      reason: 'invalid_event',
    });
    updateRun(db, run.id, { status: 'running', finishedAt: null });

    const executor = makeStubExecutor();
    const report = await reconcileOnBoot({ db, resolveDoc: resolveDocFor(db), executor });

    expect(report.resynced).toEqual([run.id]);
    expect(executor.dispatched).toEqual([]);
    expect(getRun(db, run.id)!.status).toBe('failure');
  });

  it('heals a log ALREADY corrupted by this bug (a resume appended after a terminal)', async () => {
    // Logs written before this fix can contain `run.resumed` AFTER a terminal —
    // that is precisely what the old code did. A rule keyed on "the log's LAST
    // event is terminal" would re-drive such a run forever; last-TERMINAL-wins
    // heals it. (`run.resumed` is not a terminal fact and cannot erase one.)
    const { db } = freshDb();
    const run = seedTerminalLogTheReducerWontReDerive(db);
    appendEngineEvent(db, { type: 'run.resumed', runId: run.id, reason: 'boot_reconcile' });
    updateRun(db, run.id, { status: 'running', finishedAt: null });
    const before = loadEngineEvents(db, run.id).length;

    const executor = makeStubExecutor();
    const report = await reconcileOnBoot({ db, resolveDoc: resolveDocFor(db), executor });

    expect(report.resynced).toEqual([run.id]);
    expect(executor.dispatched).toEqual([]);
    expect(loadEngineEvents(db, run.id).length).toBe(before);
    expect(getRun(db, run.id)!.status).toBe('success');
  });

  it('treats `run.interrupted` as a terminal fact too, and never resumes it', async () => {
    const { db } = freshDb();
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
    appendEngineEvent(db, { type: 'run.interrupted', runId: run.id, reason: 'drive_failed' });
    updateRun(db, run.id, { status: 'running', finishedAt: null });

    const executor = makeStubExecutor();
    const report = await reconcileOnBoot({ db, resolveDoc: resolveDocFor(db), executor });

    expect(report.resynced).toEqual([run.id]);
    expect(report.interrupted).toEqual([]);
    expect(executor.dispatched).toEqual([]);
    expect(getRun(db, run.id)!.status).toBe('interrupted');
  });

  it('re-syncs a terminal-log run whose DOC no longer resolves (the log needs no doc)', async () => {
    // Reading the log's terminal fact needs no pipeline version, so the check is
    // hoisted ABOVE `buildEngine`. Same reasoning as `launcher.ts`'s
    // `terminalizeInterrupted`: record/read the terminal fact where no doc is
    // needed, so an unresolvable doc cannot strand a finished run.
    const { db } = freshDb();
    const run = seedTerminalLogTheReducerWontReDerive(db);
    const healthy = seedTerminalLogTheReducerWontReDerive(db);

    const executor = makeStubExecutor();
    const report = await reconcileOnBoot({
      db,
      resolveDoc: (id) => {
        if (id === run.pipelineVersionId) throw new Error('version deleted');
        const pv = getPipelineVersion(db, id);
        if (pv === null) throw new Error(`no pv ${id}`);
        return pv;
      },
      executor,
    });

    // Both resynced — and the unresolvable one did not abort the loop for the other.
    expect(report.resynced.sort()).toEqual([run.id, healthy.id].sort());
    expect(getRun(db, run.id)!.status).toBe('success');
    expect(getRun(db, healthy.id)!.status).toBe('success');
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
