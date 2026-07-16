import { describe, expect, it } from 'vitest';
import {
  buildDedupeKey,
  CATALOG_VERSION,
  type Edge,
  type EdgeOn,
  type EngineEvent,
  type Node,
  type NewPipelineVersion,
} from '@autonomy-studio/shared';
import { pipelineVersions, scheduledWakeups } from '../../db/schema.js';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun, listRuns, updateRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import {
  armWakeup,
  getWakeupByKey,
  listPendingWakeups,
  settleWakeup,
} from '../../repo/scheduled-wakeups.js';
import { buildEngine, startRun, type DocResolver, type RetryAlarms } from '../driver.js';
import { appendEngineEvent, loadEngineEvents } from '../events.js';
import { ReconcileInvariantError, reconcileOnBoot, refuseToExecute } from '../reconcile.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';

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
 * `resolveDocFor` with ONE version made unresolvable — the shape every
 * doc-can't-resolve test needs (#443's terminal case, #479's non-terminal one).
 * A wrapper, not a copy: the base resolver's behaviour for every OTHER id is the
 * half these tests must not accidentally vary.
 */
function resolveDocExcept(
  db: Db,
  deadPvId: string,
  err: Error = new Error('version deleted'),
): DocResolver {
  const base = resolveDocFor(db);
  return (id) => {
    if (id === deadPvId) throw err;
    return base(id);
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
  await startRun(
    {
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(hangPlan),
      alarms: stubAlarms(),
    },
    run,
  );
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
    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: recovery,
      alarms: stubAlarms(),
    });

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
      alarms: stubAlarms(),
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
    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: recovery,
      alarms: stubAlarms(),
    });

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
      alarms: stubAlarms(),
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
    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      alarms: stubAlarms(),
    });

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
    await startRun(
      { db, resolveDoc: resolveDocFor(db), executor: makeStubExecutor(), alarms: stubAlarms() },
      run,
    );
    expect(getRun(db, run.id)!.status).toBe('success');

    // Simulate a crash AFTER the terminal event was appended but BEFORE the
    // lifecycle sync committed: the row is stuck `running`, the log says success.
    updateRun(db, run.id, { status: 'running', finishedAt: null });

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
      alarms: stubAlarms(),
    });
    expect(report.resynced).toEqual([run.id]);
    expect(report.resumed).toEqual([]);
    expect(report.interrupted).toEqual([]);
    expect(getRun(db, run.id)!.status).toBe('success');
  });

  /**
   * Pins the `state.status === 'pending'` branch: a `running` row whose log has
   * no `run.started` (the projection is then the `pending` seed). Unreachable
   * via the real callers, which is exactly why it is pinned here rather than
   * left to bit-rot — and why it is a re-sync and NOT an assertion: the boot
   * loop has no per-run try/catch, so throwing on one malformed row would
   * strand every run AFTER it, the same fail-safety property #443 established
   * by hoisting `terminalFactFromLog` above `buildEngine`.
   */
  it('re-syncs a running row whose log has no `run.started`, appending nothing', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);

    // A `running` row with an EMPTY log: the projection seeds to `pending`.
    updateRun(db, run.id, { status: 'running', finishedAt: null });
    expect(loadEngineEvents(db, run.id)).toEqual([]);

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
      alarms: stubAlarms(),
    });

    expect(report.resynced).toEqual([run.id]);
    expect(report.resumed).toEqual([]);
    expect(getRun(db, run.id)!.status).toBe('pending');
    // The load-bearing half: NO `run.resumed` appended to a log with no
    // `run.started` — the corruption the branch exists to prevent.
    expect(loadEngineEvents(db, run.id)).toEqual([]);
  });

  it('a `run.started`-less row does not strand the runs after it in the loop', async () => {
    const { db } = freshDb();

    // Ordered so the malformed row is reconciled BEFORE the healthy one.
    const bad = seedRun(db, seedVersion(db, [node('a')]));
    updateRun(db, bad.id, { status: 'running', finishedAt: null });

    const good = seedRun(db, seedVersion(db, [node('b')]));
    await startRun(
      { db, resolveDoc: resolveDocFor(db), executor: makeStubExecutor(), alarms: stubAlarms() },
      good,
    );
    updateRun(db, good.id, { status: 'running', finishedAt: null });

    // This test's whole value is the EARLY-EXIT shape (a `continue` that became
    // a `break`/throw strands `good`), which only bites when `bad` is reconciled
    // first. `listRuns` has no ORDER BY, so that order is SQLite's scan order,
    // not a guarantee — assert it, or adding one silently voids this test.
    expect(listRuns(db, { status: 'running' }).map((r) => r.id)).toEqual([bad.id, good.id]);

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
      alarms: stubAlarms(),
    });

    // Both reconciled: the malformed row is survivable, not fatal to the loop.
    expect(report.resynced).toContain(bad.id);
    expect(report.resynced).toContain(good.id);
    expect(getRun(db, good.id)!.status).toBe('success');
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
    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor,
      alarms: stubAlarms(),
    });

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
    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor,
      alarms: stubAlarms(),
    });

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
    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor,
      alarms: stubAlarms(),
    });

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
    // A `run.resumed` AFTER the interrupt — the shape a pre-#443 reconcile pass
    // would itself have appended. Without it this test is pure characterization
    // (the old projection also folded to `interrupted` and took its own fast
    // path); with it, only reading back PAST the resume to the terminal fact keeps
    // the run frozen. Nothing else covers interrupted-under-a-resume.
    appendEngineEvent(db, { type: 'run.resumed', runId: run.id, reason: 'boot_reconcile' });
    updateRun(db, run.id, { status: 'running', finishedAt: null });

    const executor = makeStubExecutor();
    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor,
      alarms: stubAlarms(),
    });

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
      alarms: stubAlarms(),
      resolveDoc: resolveDocExcept(db, run.pipelineVersionId),
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
    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor,
      alarms: stubAlarms(),
    });

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

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      alarms: stubAlarms(),
    });

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
      {
        db,
        resolveDoc: resolveDocFor(db),
        executor: makeStubExecutor({ child: { hang: true } }),
        alarms: stubAlarms(),
      },
      run,
    );
    let state = buildEngine(getPipelineVersion(db, pvId)!).projectRunState(
      loadEngineEvents(db, run.id),
    );
    expect(state.nodes.call!.status).toBe('waiting');

    const recovery = makeStubExecutor({ child: { childOutcome: 'success' } });
    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: recovery,
      alarms: stubAlarms(),
    });

    expect(report.resumed).toEqual([run.id]);
    expect(recovery.startedChildren.length).toBe(1);
    state = buildEngine(getPipelineVersion(db, pvId)!).projectRunState(
      loadEngineEvents(db, run.id),
    );
    expect(state.status).toBe('success');
    expect(getRun(db, run.id)!.status).toBe('success');
  });
});

// ===========================================================================
// #1 F2b/F2c — a run HELD on a retry (§A.5)
// ===========================================================================

describe('reconcileOnBoot — a run held on a node retry', () => {
  /**
   * F2b creates a `running` row shape that did not exist before: one whose only
   * live node is `retry_pending`. It re-derives NOTHING here — `onResumed` skips
   * a held node deliberately, and `settle` cannot finish a run whose node is
   * non-terminal — so without its own branch it falls through to the resume path
   * and is reported `finalized` ("now terminalized"), which is simply false: it
   * is waiting on its alarm. It would also collect a fresh, pointless
   * `run.resumed` on EVERY boot.
   *
   * Whether leaving it alone is correct depends ENTIRELY on whether its alarm row
   * actually exists, so these tests seed and boot through ONE REAL db-backed
   * alarm store. They used to use two separate `stubAlarms()` — in-memory, and a
   * different instance for the drive than for the boot — which meant no durable
   * row ever existed and the "reports it HELD" case passed identically in the
   * world where the reconciler stranded every held run forever. A held-run test
   * that never looks at a real alarm row is not testing the hold.
   */
  const realAlarms = (db: Db): RetryAlarms => ({
    arm: (input) => armWakeup(db, input),
    find: (input) => getWakeupByKey(db, input.kind, buildDedupeKey(input)),
  });

  async function seedHeldRun(db: Db, alarms: RetryAlarms) {
    const pvId = seedVersion(db, [node('a', { policy: { retry: 1 } })]);
    const run = seedRun(db, pvId);
    await startRun(
      {
        db,
        resolveDoc: resolveDocFor(db),
        executor: makeStubExecutor({ nodes: { a: { outcome: 'failure', kind: 'transient' } } }),
        alarms,
      },
      run,
    );
    return run;
  }

  it('reports it HELD, appends nothing, and leaves its live alarm row alone', async () => {
    const { db } = freshDb();
    const alarms = realAlarms(db);
    const run = await seedHeldRun(db, alarms);
    const before = loadEngineEvents(db, run.id);
    expect(before.map((e) => e.type)).toContain('node.retryScheduled');
    // The premise of the whole branch: a REAL pending row survived the crash.
    expect(listPendingWakeups(db)).toHaveLength(1);
    const armedBefore = listPendingWakeups(db)[0];

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
      alarms,
    });

    expect(report.held).toEqual([run.id]);
    expect(report.rearmed).toEqual([]);
    expect(report.finalized).toEqual([]);
    expect(report.resumed).toEqual([]);
    expect(report.deferred).toEqual([]);
    // Untouched: no `run.resumed`, no second alarm, still live awaiting its row.
    expect(loadEngineEvents(db, run.id)).toEqual(before);
    expect(getRun(db, run.id)!.status).toBe('running');
    expect(listPendingWakeups(db)).toEqual([armedBefore]);
  });

  it('RE-ARMS a hold whose alarm the HOLD→ARM crash window lost (B2)', async () => {
    // The window is real and WIDE: `node.failed` folds to `retry_pending` and only
    // QUEUES `scheduleRetry`, which `pump` drains at the queue TAIL — so the hold
    // is durable for however long the intervening commands take (minutes of LLM
    // calls), with no alarm row yet. A crash in there leaves exactly this log.
    //
    // Reported `held` and left alone — the pre-B2 behaviour — this run is
    // `running` FOREVER, across every subsequent boot: nothing re-derives a
    // `scheduleRetry`, and the reconciler does not select a held node.
    const { db } = freshDb();
    const alarms = realAlarms(db);
    const run = await seedHeldRun(db, alarms);
    // Delete the row to reproduce the crash window (the hold is already durable).
    db.delete(scheduledWakeups).run();
    const before = loadEngineEvents(db, run.id);
    expect(listPendingWakeups(db)).toHaveLength(0);

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
      alarms,
      now: () => 5_000,
    });

    expect(report.rearmed).toEqual([run.id]);
    // Still held — re-armed is WHY it is still held, so it is reported as both.
    expect(report.held).toEqual([run.id]);
    expect(report.interrupted).toEqual([]);

    // A real, live, durable row keyed to the held attempt — the run can advance.
    const pending = listPendingWakeups(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: 'node_retry',
      ref: { runId: run.id, nodeId: 'a', attemptId: 'a#0' },
      status: 'pending',
    });
    // And the LOG says when it is now due — from the ARMED ROW, not a local
    // computation. `armRetry` arms before it appends, so "no row" implies no
    // `node.retryScheduled` either: this appends one rather than duplicating.
    const appended = loadEngineEvents(db, run.id).slice(before.length);
    expect(appended).toEqual([
      {
        type: 'node.retryScheduled',
        runId: run.id,
        nodeId: 'a',
        attemptId: 'a#0',
        nextAttemptAt: pending[0]!.dueAt,
      },
    ]);
    expect(getRun(db, run.id)!.status).toBe('running');
  });

  it('INTERRUPTS a hold whose alarm row is SPENT — re-arming cannot heal that', async () => {
    // The third arm, and the one a two-way present/absent check gets wrong.
    // `armWakeup` returns the EXISTING row whatever its status, so re-arming a
    // settled row changes nothing and the `node.retryScheduled` we would append
    // from it would record a due time in the PAST for an alarm that will never
    // fire again. The node is held, its alarm came and went, and nothing can
    // advance the run — so freeze it as needs-attention rather than report a hang
    // as a wait.
    const { db } = freshDb();
    const alarms = realAlarms(db);
    const run = await seedHeldRun(db, alarms);
    const armed = listPendingWakeups(db)[0]!;
    settleWakeup(db, armed.id, { status: 'suppressed', firedAt: 1_000 });

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
      alarms,
    });

    expect(report.interrupted).toEqual([run.id]);
    expect(report.held).toEqual([]);
    expect(report.rearmed).toEqual([]);
    expect(getRun(db, run.id)!.status).toBe('interrupted');
    // Event-sourced, and it names WHY — an operator reading the log needs to know
    // this was a spent alarm, not a failed activity.
    const last = loadEngineEvents(db, run.id).at(-1);
    expect(last).toMatchObject({ type: 'run.interrupted', reason: 'retry_alarm_spent:a' });
  });

  /** A run with BOTH a held node (`a`) and an independent in-flight one (`b`). */
  async function seedHeldPlusInFlight(db: Db, alarms: RetryAlarms) {
    // EXPLICIT edges, because a doc with none gets an IMPLICIT CHAIN — which
    // would make `b` a downstream of `a` (and so `pending` behind the hold)
    // rather than the independent in-flight node these tests need.
    const pvId = seedVersion(
      db,
      [node('root'), node('a', { policy: { retry: 1 } }), node('b')],
      [edge('root', 'a'), edge('root', 'b')],
    );
    const run = seedRun(db, pvId);
    await startRun(
      {
        db,
        resolveDoc: resolveDocFor(db),
        executor: makeStubExecutor({
          nodes: { a: { outcome: 'failure', kind: 'transient' }, b: { hang: true } },
        }),
        alarms,
      },
      run,
    );
    return run;
  }

  it('resumes a live idempotent node AND still reports the healthy hold', async () => {
    const { db } = freshDb();
    const alarms = realAlarms(db);
    const run = await seedHeldPlusInFlight(db, alarms);

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
      alarms,
    });

    // BOTH, and that is the point: `b`'s recoverable work resumes, and `a` is
    // still held on its (live) alarm. The two facts are independent, so the run
    // appears in both buckets rather than one masking the other.
    expect(report.resumed).toEqual([run.id]);
    expect(report.held).toEqual([run.id]);
    expect(report.rearmed).toEqual([]);
    expect(listPendingWakeups(db)).toHaveLength(1);
  });

  it('re-arms a hold on a run that ALSO has live work — the likeliest B2 case', async () => {
    // The gate this pins the removal of ("only check the alarm when the run has
    // no other commands — a run with live work resumes anyway, and its held node
    // is recovered by the alarm regardless") is B2's false premise wearing an
    // optimisation's clothes: if the row is MISSING there is no alarm.
    //
    // And the two conditions are POSITIVELY CORRELATED, so the gate skipped
    // exactly the likeliest B2 case. `pump` drains `scheduleRetry` at the QUEUE
    // TAIL, so the HOLD→ARM window IS the interval in which the sibling
    // `dispatchNode` commands drain — a crash there leaves a held node with no
    // alarm AND a sibling `dispatched`, which is precisely this shape.
    //
    // Measured under the gated version: `b` resumed and succeeded, `a` waited
    // forever on an alarm that did not exist, the run rested `running` for the
    // rest of the process's life, and the report called it `resumed` — nothing
    // surfaced it. Only an unrelated restart healed it.
    const { db } = freshDb();
    const alarms = realAlarms(db);
    const run = await seedHeldPlusInFlight(db, alarms);
    // The crash window: the hold is durable, the arm never ran.
    db.delete(scheduledWakeups).run();

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
      alarms,
      now: () => 5_000,
    });

    // The live node resumed AND the stranded hold was healed.
    expect(report.resumed).toEqual([run.id]);
    expect(report.rearmed).toEqual([run.id]);
    expect(report.held).toEqual([run.id]);

    const pending = listPendingWakeups(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: 'node_retry',
      ref: { runId: run.id, nodeId: 'a', attemptId: 'a#0' },
      status: 'pending',
    });
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).toContain('node.retryScheduled');
  });

  it('does NOT resume a run whose hold is unrecoverable, even with live work', async () => {
    // The interrupt must win over the resume: nothing can advance this run, so
    // re-dispatching `b` would bill an activity for a run that is already over.
    const { db } = freshDb();
    const alarms = realAlarms(db);
    const run = await seedHeldPlusInFlight(db, alarms);
    const armed = listPendingWakeups(db)[0]!;
    settleWakeup(db, armed.id, { status: 'fired', firedAt: 1_000 });

    const recovery = makeStubExecutor();
    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: recovery,
      alarms,
    });

    expect(report.interrupted).toEqual([run.id]);
    expect(report.resumed).toEqual([]);
    expect(report.held).toEqual([]);
    expect(recovery.dispatched).toEqual([]);
    expect(getRun(db, run.id)!.status).toBe('interrupted');
  });
});

describe('reconcileOnBoot — #491: a run wedged by a PRE-GATE doc drains at boot', () => {
  /**
   * The row #491 actually exists for. #444's write gate refuses a cyclic doc, so
   * `createPipelineVersion` CANNOT produce this one — it is inserted raw, which
   * is exactly the real-world case: rows written before that gate landed were
   * never validated, are IMMUTABLE (DB triggers RAISE(ABORT)), and still resolve
   * and reach the reducer. That is why the reducer's backstop, not the gate, is
   * what rescues them.
   */
  function seedWedgedByCycle(db: Db) {
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const pvId = 'pv_pre_gate_cycle';
    db.insert(pipelineVersions)
      .values({
        id: pvId,
        pipelineId: pipeline.id,
        version: 1,
        params: [],
        outputs: [],
        nodes: [node('a'), node('b')],
        edges: [edge('a', 'b'), edge('b', 'a')],
        containers: [],
        catalogVersion: CATALOG_VERSION,
        createdAt: 1,
      })
      .run();

    const run = seedRun(db, pvId);
    appendEngineEvent(db, {
      type: 'run.started',
      runId: run.id,
      pipelineVersionId: pvId,
      params: {},
    });
    updateRun(db, run.id, { status: 'running', finishedAt: null });
    return run;
  }

  it('finalizes the wedged run to failure{stalled} — with NO executor', async () => {
    const { db } = freshDb();
    const run = seedWedgedByCycle(db);

    // Precondition: the run really is wedged — running, nothing terminal.
    const before = buildEngine(getPipelineVersion(db, run.pipelineVersionId)!).projectRunState(
      loadEngineEvents(db, run.id),
    );
    expect(before.status).toBe('running');
    expect(before.nodes.a!.status).toBe('pending');

    // No executor on purpose: a stalled run's only command is the driver's own
    // `finishRun`, so it must finalize without one rather than DEFER forever.
    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      alarms: stubAlarms(),
    });

    expect(report.finalized).toEqual([run.id]);
    expect(report.deferred).toEqual([]);
    expect(report.resumed).toEqual([]);
    expect(getRun(db, run.id)!.status).toBe('failure');

    const events = loadEngineEvents(db, run.id);
    expect(types(events)).toContain('run.finished');
    const finished = events.find((e) => e.type === 'run.finished');
    expect(finished).toMatchObject({ outcome: 'failure', reason: 'stalled' });
  });

  it('a second boot is a no-op — the terminal is appended once, not once per boot', async () => {
    const { db } = freshDb();
    const run = seedWedgedByCycle(db);
    const deps = { db, resolveDoc: resolveDocFor(db), alarms: stubAlarms() };

    await reconcileOnBoot(deps);
    const afterFirst = loadEngineEvents(db, run.id).length;

    // The run is terminal now, so it is no longer a `running` row to reconcile —
    // a second boot must not append a second terminal.
    const report = await reconcileOnBoot(deps);
    expect(report.finalized).toEqual([]);
    expect(loadEngineEvents(db, run.id).length).toBe(afterFirst);
    expect(getRun(db, run.id)!.status).toBe('failure');
  });
});

describe('reconcileOnBoot — #479 a per-run fault degrades THAT run, not the loop', () => {
  /**
   * #443 hoisted `terminalFactFromLog` ABOVE `buildEngine`, so a FINISHED run
   * never depends on its doc. This is the same fail-safety property one layer
   * out, for the case that hoist does not cover: a NON-terminal run still
   * reaches `buildEngine`, and an unresolvable doc threw straight out of
   * `reconcileOnBoot` — aborting the whole boot reconcile and stranding every
   * run after the bad one in the scan. Boot reconcile IS the recovery path; it
   * is the worst place for an all-or-nothing failure mode.
   */
  /** Two crashed non-terminal runs; `bad`'s doc will not resolve. */
  async function seedBadThenGood(db: Db) {
    // Both crash mid-dispatch (`run.started` + a hung node), so each gets PAST
    // the terminal fast path and reaches `buildEngine` — the throw site.
    const bad = await seedCrashedRun(db, [node('a')], [], {
      nodes: { a: { hang: true, idempotent: true } },
    });
    const good = await seedCrashedRun(db, [node('b')], [], {
      nodes: { b: { hang: true, idempotent: true } },
    });

    // This test's whole value is the EARLY-EXIT shape (a throw that escapes the
    // loop strands `good`), which only bites when `bad` is reconciled FIRST.
    // `listRuns` has no ORDER BY, so that order is SQLite's scan order, not a
    // guarantee — assert it, or adding one silently voids these tests.
    expect(listRuns(db, { status: 'running' }).map((r) => r.id)).toEqual([bad.id, good.id]);
    return { bad, good };
  }

  it('a non-terminal run whose DOC will not resolve does not strand the runs after it', async () => {
    const { db } = freshDb();
    const { bad, good } = await seedBadThenGood(db);

    const report = await reconcileOnBoot({
      db,
      alarms: stubAlarms(),
      resolveDoc: resolveDocExcept(db, bad.pipelineVersionId),
      executor: makeStubExecutor({ nodes: { b: { outcome: 'success' } } }),
    });

    // The load-bearing half: the healthy run behind the bad one still recovered.
    expect(report.resumed).toEqual([good.id]);
    expect(getRun(db, good.id)!.status).toBe('success');
  });

  it('reports the faulted run in `failed` with its reason, and in NO verdict bucket', async () => {
    const { db } = freshDb();
    const { bad } = await seedBadThenGood(db);

    const report = await reconcileOnBoot({
      db,
      alarms: stubAlarms(),
      resolveDoc: resolveDocExcept(db, bad.pipelineVersionId),
      executor: makeStubExecutor({ nodes: { b: { outcome: 'success' } } }),
    });

    // The reason travels with the run id: `ReconcileReport` is the ONLY channel
    // this fault has (`index.ts` logs the report verbatim), so a bare id list
    // would drop the one fact an operator needs.
    expect(report.failed).toEqual([{ runId: bad.id, reason: 'version deleted' }]);

    // A fault is not a verdict. Each verdict bucket is pushed at a `continue` or
    // at the loop tail — i.e. only once that run's reconcile SUCCEEDED — so a
    // faulted run must appear in none of them.
    for (const bucket of [
      report.resumed,
      report.finalized,
      report.resynced,
      report.interrupted,
      report.deferred,
    ]) {
      expect(bucket).not.toContain(bad.id);
    }

    // The documented NON-GOAL, pinned so it cannot change silently: the faulted
    // run is left `running`. A caught throw cannot tell a PERMANENT fault (the
    // version is gone) from a TRANSIENT one, and terminalizing a healthy run on
    // a transient throw is fail-open in the other direction. See `failed`'s
    // docblock and the follow-up ticket it names.
    expect(getRun(db, bad.id)!.status).toBe('running');
  });
});

describe("reconcileOnBoot — #479 the fault boundary does NOT swallow this loop's own invariants", () => {
  /**
   * The per-run catch is deliberately BROAD (it wraps the whole body, not just
   * the `resolveDoc` call that motivated #479). Its docblock argues that breadth
   * is safe *because* `ReconcileInvariantError` is re-thrown rather than filed
   * under `failed`.
   *
   * These two tests exist because the pre-PR correctness lens MUTATION-TESTED
   * that argument and found nothing behind it: deleting the re-throw passed
   * 474/474, and reverting `refuseToExecute` to a plain `Error` passed 474/474.
   * A guard defended only by a comment is one a future reader deletes as
   * ceremony — so the discrimination gets a test per class. See prevention-log
   * #25.
   */
  it('re-throws a ReconcileInvariantError instead of filing it under `failed`', async () => {
    const { db } = freshDb();
    const bad = await seedCrashedRun(db, [node('a')], [], {
      nodes: { a: { hang: true, idempotent: true } },
    });

    const boom = new ReconcileInvariantError('driver invariant violated');
    const call = reconcileOnBoot({
      db,
      alarms: stubAlarms(),
      // Thrown from INSIDE a run's reconcile — the exact position a per-run fault
      // occupies. The only difference is its CLASS, which is the whole point: a
      // plain Error here lands in `failed` (pinned by the sibling #479 block).
      resolveDoc: resolveDocExcept(db, bad.pipelineVersionId, boom),
      executor: makeStubExecutor(),
    });

    // Escapes the loop entirely: boot dies loudly rather than the fault being
    // demoted to one string inside the boot report's `fastify.log.info`.
    await expect(call).rejects.toThrow(boom);
  });

  it('`refuseToExecute` refuses with the SENTINEL, so the re-throw above can see it', async () => {
    // The finalize path passes this executor to `pump` when no real one exists.
    // It is REACHABLE despite the `needsExecutor` gate (that gate reads only the
    // INITIAL commands, while `pump` drains a queue that grows) — but not from a
    // natural fixture, so its contract is pinned directly: the class it throws is
    // load-bearing, not incidental. A plain `Error` here would be silently
    // absorbed into `failed` by the per-run catch.
    // Throws synchronously ON CALL, not on iteration — so a plain call is the
    // whole contract; there is no stream to drain.
    expect(() => refuseToExecute.perform({} as never, 'run-1')).toThrow(ReconcileInvariantError);
  });
});
