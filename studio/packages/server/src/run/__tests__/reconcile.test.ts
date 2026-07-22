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
import {
  buildEngine,
  DocUnparseableError,
  DocUnresolvableError,
  externalWaitArmInput,
  makeDocResolver,
  startRun,
  waitArmInput,
  type DocResolver,
  type Executor,
  type RetryAlarms,
} from '../driver.js';
import { appendEngineEvent, loadEngineEvents } from '../events.js';
import { deriveExternalWaitToken } from '../../webhooks/external-wait-token.js';
import { ReconcileInvariantError, reconcileOnBoot, refuseToExecute } from '../reconcile.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';

type Db = ReturnType<typeof freshDb>['db'];

let seq = 0;
function node(id: string, extra: Partial<Node> = {}): Node {
  seq += 1;
  // Uncatalogued on purpose — see the same factory in `driver.test.ts`. Keeps the
  // node's output contract `absent` so the stub's ad-hoc outputs (e.g. the
  // `{ v: 'fresh' }` stale-attempt fixture below) pass through unfiltered, as they
  // did before F13b/#456 lowered a catalog default into KNOWN types.
  return { id, type: 'test_activity', config: {}, position: { x: seq, y: 0 }, ...extra };
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
 * `resolveDocFor` with ONE version made to throw — the shape every
 * doc-can't-resolve test needs (#443's terminal case, #479's TRANSIENT one,
 * #508's PERMANENT one). A wrapper, not a copy: the base resolver's behaviour for
 * every OTHER id is the half these tests must not accidentally vary.
 *
 * The DEFAULT `err` is a TRANSIENT fault (a DB blip), not a deleted version:
 * since #508 the deleted-version case is `DocUnresolvableError` and terminalizes
 * `interrupted`, so a test wanting the "faulted run stays `running`/`failed`"
 * behaviour (#479's fault boundary) must throw something that is NOT a
 * `DocUnresolvableError`. The permanent case passes `new DocUnresolvableError(…)`
 * explicitly.
 */
function resolveDocExcept(
  db: Db,
  deadPvId: string,
  err: Error = new Error('db read timed out'),
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

  /**
   * An executor that throws ON CALL — the shape `refuseToExecute` uses, and the
   * only way to fault `pump` itself: every `makeStubExecutor` plan resolves to
   * EVENTS (`node.failed` is an outcome the reducer folds, not a fault).
   */
  function throwOnPerform(err: Error): Executor {
    return {
      perform(): AsyncIterable<EngineEvent> {
        throw err;
      },
    };
  }

  it('reports a run as BOTH `held` and `failed` when the fault lands AFTER the hold', async () => {
    // `failed`'s docblock CLAIMS this ("NOT exclusive of held/rearmed — those are
    // pushed BEFORE the loop"), which is prevention-log #25's exact shape: the
    // rule a comment argues for is the one with no test behind it.
    //
    // It is a REAL path, and one #479's catch newly created: `recoverHeld` pushes
    // `held` at the top of `reconcileOne`, then this run falls through to `pump`
    // (it has live work in `b`). A throw there is caught by the per-run boundary
    // and filed under `failed` — with `held` already pushed and NOT unwound.
    const { db } = freshDb();
    const alarms = realAlarms(db);
    const run = await seedHeldPlusInFlight(db, alarms);

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: throwOnPerform(new Error('executor died mid-resume')),
      alarms,
    });

    // BOTH, and neither is wrong: the hold was RECOVERED (durably — the alarm is
    // armed and `node.retryScheduled` is appended) before the fault, so un-pushing
    // `held` would erase a committed fact. The run genuinely is held AND faulted.
    expect(report.held).toEqual([run.id]);
    expect(report.failed).toEqual([{ runId: run.id, reason: 'executor died mid-resume' }]);

    // Still exclusive of the VERDICT buckets — `resumed` is pushed at the loop
    // tail, which the throw never reached. This is the line that makes the
    // docblock's distinction (verdicts vs work-already-committed) testable.
    expect(report.resumed).toEqual([]);
    expect(report.interrupted).toEqual([]);

    // The hold's durable half survived the fault, which is WHY `held` stands.
    expect(listPendingWakeups(db)).toHaveLength(1);
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
   * reaches `buildEngine`, and a resolver fault threw straight out of
   * `reconcileOnBoot` — aborting the whole boot reconcile and stranding every
   * run after the bad one in the scan. Boot reconcile IS the recovery path; it
   * is the worst place for an all-or-nothing failure mode.
   *
   * The fault here is TRANSIENT (a DB blip): since #508 a PERMANENTLY
   * unresolvable version (`DocUnresolvableError`) terminalizes `interrupted`
   * rather than landing in `failed`, so it is no longer the fault that pins this
   * boundary — see the `#508` block below. The boundary itself is fault-class
   * agnostic (the catch wraps the whole body), so a transient fault proves it.
   */
  /** Two crashed non-terminal runs; `bad`'s resolver throws a TRANSIENT fault. */
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

  it('a non-terminal run whose resolver throws transiently does not strand the runs after it', async () => {
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
    expect(report.failed).toEqual([{ runId: bad.id, reason: 'db read timed out' }]);

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

    // Pinned so it cannot change silently: a run faulted by a TRANSIENT throw is
    // left `running`, to be retried on the next boot. Terminalizing a healthy run
    // on a passing DB blip would be fail-open in the other direction. The
    // PERMANENT counterpart (`DocUnresolvableError`) does terminalize — that is
    // #508, pinned in its own block below; here the two must stay distinct.
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
    //
    // A REAL `dispatchNode` command, not a cast: this asserts the guard refuses
    // the exact shape that reaches it (a `finishRun` whose fold emits a dispatch),
    // and `{} as never` would let the command type drift out from under the test.
    expect(() =>
      refuseToExecute.perform(
        { type: 'dispatchNode', nodeId: 'a', attemptId: 'a#0', preparedInput: {} },
        'run-1',
      ),
    ).toThrow(ReconcileInvariantError);
  });
});

describe('reconcileOnBoot — #508 a permanently unresolvable doc terminalizes, not re-fails forever', () => {
  /**
   * A `running` run whose immutable pipeline version is GONE can never be driven
   * again — versions never come back (DB `RAISE(ABORT)` on any mutation). Pre-#508
   * the resolver threw a plain Error into #479's per-run catch → `failed`, leaving
   * the row `running`, so it re-`failed` on EVERY boot and held its concurrency
   * slot forever. Now the resolver throws `DocUnresolvableError`, which the
   * reconciler reads as PERMANENT and terminalizes `interrupted` (needs-attention):
   * the slot is freed and the reason is a durable fact in the log + boot report.
   * This is the derive-a-verdict shape #491 established, not an exception guess —
   * the resolver's TYPE is the verdict.
   */
  it('terminalizes the run `interrupted` with a `doc_unresolvable:<pvId>` reason', async () => {
    const { db } = freshDb();
    // A crashed, non-terminal run (`run.started` + a hung node): it gets PAST the
    // terminal fast path and reaches `buildEngine` — the resolve (throw) site.
    const run = await seedCrashedRun(db, [node('a')], [], {
      nodes: { a: { hang: true, idempotent: true } },
    });

    const report = await reconcileOnBoot({
      db,
      alarms: stubAlarms(),
      resolveDoc: resolveDocExcept(
        db,
        run.pipelineVersionId,
        new DocUnresolvableError('version deleted'),
      ),
      executor: makeStubExecutor(),
    });

    // Terminalized, not failed: the slot is freed and the run is visibly over.
    expect(report.interrupted).toEqual([run.id]);
    expect(report.failed).toEqual([]);
    for (const bucket of [report.resumed, report.finalized, report.resynced, report.deferred]) {
      expect(bucket).not.toContain(run.id);
    }

    const frozen = getRun(db, run.id)!;
    expect(frozen.status).toBe('interrupted');
    expect(frozen.finishedAt).not.toBeNull();

    // The verdict is a durable, doc-free FACT in the log (not just a row patch),
    // so the P6 monitor and a replay both see WHY the run ended.
    const interrupted = loadEngineEvents(db, run.id).find((e) => e.type === 'run.interrupted');
    expect(interrupted).toMatchObject({
      type: 'run.interrupted',
      reason: `doc_unresolvable:${run.pipelineVersionId}`,
    });
  });

  it('is idempotent across a torn write: a second boot resyncs from the log, appending nothing', async () => {
    const { db } = freshDb();
    const run = await seedCrashedRun(db, [node('a')], [], {
      nodes: { a: { hang: true, idempotent: true } },
    });
    const resolveDoc = resolveDocExcept(
      db,
      run.pipelineVersionId,
      new DocUnresolvableError('version deleted'),
    );

    await reconcileOnBoot({ db, alarms: stubAlarms(), resolveDoc, executor: makeStubExecutor() });
    const afterFirst = loadEngineEvents(db, run.id).length;
    expect(types(loadEngineEvents(db, run.id))).toContain('run.interrupted');

    // Simulate a crash BETWEEN the durable append and the lifecycle sync: the
    // `run.interrupted` fact is in the log but the row is stuck `running`, so the
    // next boot re-scans it. The `terminalFactFromLog` fast path (hoisted above
    // `buildEngine`, #443) reads the terminal fact and resyncs — WITHOUT reaching
    // the now-unresolvable doc and WITHOUT appending a second `run.interrupted`.
    updateRun(db, run.id, { status: 'running', finishedAt: null });

    const report = await reconcileOnBoot({
      db,
      alarms: stubAlarms(),
      resolveDoc,
      executor: makeStubExecutor(),
    });

    expect(report.resynced).toEqual([run.id]);
    expect(report.interrupted).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(getRun(db, run.id)!.status).toBe('interrupted');
    expect(loadEngineEvents(db, run.id).length).toBe(afterFirst);
  });
});

describe('makeDocResolver — the production resolver classifies a gone version as permanent', () => {
  /**
   * The half that actually closes the leak: `index.ts`'s real resolver must throw
   * `DocUnresolvableError` (not a plain Error) when the version is gone, or the
   * reconciler's classification above never fires in production. Pinned directly —
   * a mutation reverting it to `throw new Error(...)` would otherwise survive with
   * green reconciler tests (the mutation-survives-a-comment shape, prevention-log
   * #25). One production `DocResolver` exists (`index.ts`, fanned out to
   * executor/retry-alarm/reconcile), so this single pin covers every consumer.
   */
  it('throws DocUnresolvableError for a missing version and returns the row for a present one', () => {
    const { db } = freshDb();
    const resolve = makeDocResolver(db);

    expect(() => resolve('pv_does_not_exist')).toThrow(DocUnresolvableError);

    const pvId = seedVersion(db, [node('a')]);
    expect(resolve(pvId).id).toBe(pvId);
  });

  /**
   * #515 gap 1 — a PRESENT row that no longer PARSES is ALSO permanent (the row
   * is immutable, the schema is fixed for the process, so `.parse` never succeeds
   * on a later boot). Pre-#515 it threw a `ZodError` — a non-`DocUnresolvableError`
   * — so the reconciler read it as transient and re-`failed` the run forever. Now
   * it is reclassified to `DocUnparseableError`, a SUBTYPE of `DocUnresolvableError`
   * so every `instanceof DocUnresolvableError` consumer terminalizes it unchanged.
   * `createPipelineVersion` cannot produce this row (it validates on write); it is
   * inserted raw, which is exactly the real case — a row valid under an older
   * schema, immutable across the tightening.
   */
  it('throws DocUnparseableError (a DocUnresolvableError) for a present-but-unparseable row', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const pvId = 'pv_unparseable';
    db.insert(pipelineVersions)
      .values({
        id: pvId,
        pipelineId: pipeline.id,
        version: 1,
        params: [],
        outputs: [],
        // `z.array(NodeSchema)` on read rejects a non-array — a deterministic
        // parse failure independent of NodeSchema's internals.
        nodes: 'not-an-array' as unknown as Node[],
        edges: [],
        containers: [],
        catalogVersion: CATALOG_VERSION,
        createdAt: 1,
      })
      .run();

    const resolve = makeDocResolver(db);
    expect(() => resolve(pvId)).toThrow(DocUnparseableError);
    // The SUBTYPE relationship is load-bearing: it is what routes this through the
    // existing `instanceof DocUnresolvableError` terminalize/suppress branches.
    try {
      resolve(pvId);
      expect.unreachable('resolve should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DocUnresolvableError);
    }
  });

  /**
   * The SIBLING permanent shape: a stored json column that is not valid JSON. It
   * throws a `SyntaxError` from Drizzle's codec (before the schema is reached),
   * NOT a `ZodError` — but an immutable row's malformed JSON never repairs either,
   * so it is the same permanent class and must reclassify identically. Written
   * with the RAW `sqlite` handle (Drizzle serializes valid JSON on write, so this
   * corrupt row cannot be produced through the ORM).
   */
  it('throws DocUnparseableError for a present row whose stored JSON is malformed', () => {
    const { db, sqlite } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const pvId = 'pv_bad_json';
    sqlite
      .prepare(
        `INSERT INTO pipeline_versions
           (id, pipeline_id, version, params, outputs, nodes, edges, containers, catalog_version, created_at)
         VALUES (?, ?, 1, '[]', '[]', ?, '[]', '[]', ?, 1)`,
      )
      // A deliberately malformed `nodes` JSON text — `JSON.parse` throws before
      // the schema runs.
      .run(pvId, pipeline.id, '{not valid json', CATALOG_VERSION);

    const resolve = makeDocResolver(db);
    expect(() => resolve(pvId)).toThrow(DocUnparseableError);
    try {
      resolve(pvId);
      expect.unreachable('resolve should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DocUnresolvableError);
    }
  });

  /**
   * The other side of the same coin: only a decode failure (`ZodError` /
   * `SyntaxError`) is reclassified permanent. A DB *read* fault is a genuine
   * transient blip and must stay transient — otherwise a passing DB error would
   * strand a healthy run as `interrupted` (fail-open the other way). A stub `db`
   * whose read throws a plain Error pins the propagation.
   */
  it('propagates a non-decode error (a transient DB fault) unchanged — not reclassified', () => {
    const boom = new Error('db read timed out');
    const brokenDb = {
      select: () => {
        throw boom;
      },
    } as unknown as Db;
    const resolve = makeDocResolver(brokenDb);
    expect(() => resolve('pv_x')).toThrow(boom);
    expect(() => resolve('pv_x')).not.toThrow(DocUnresolvableError);
  });
});

describe('reconcileOnBoot — #515 a present-but-unparseable version terminalizes, not re-fails forever', () => {
  /**
   * End-to-end companion to the resolver unit test: a `running` run whose
   * immutable version row no longer parses must terminalize `interrupted`
   * (`doc_unresolvable:<pvId>`) via the SAME path #508's gone-version case uses —
   * the `DocUnparseableError` subtype flows through the existing `instanceof
   * DocUnresolvableError` catch, so the fix needs no reconcile change. The run is
   * hand-seeded (not `seedCrashedRun`, which drives through `resolveDocFor` and
   * would itself throw on the bad row): a raw bad version + `run.started` +
   * `running`, which reaches the resolve site directly.
   */
  it('terminalizes the run `interrupted` using the production resolver', async () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const pvId = 'pv_unparseable_run';
    db.insert(pipelineVersions)
      .values({
        id: pvId,
        pipelineId: pipeline.id,
        version: 1,
        params: [],
        outputs: [],
        nodes: 'not-an-array' as unknown as Node[],
        edges: [],
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

    const report = await reconcileOnBoot({
      db,
      alarms: stubAlarms(),
      resolveDoc: makeDocResolver(db),
      executor: makeStubExecutor(),
    });

    // Terminalized, not failed — the production resolver's `DocUnparseableError`
    // was read as permanent.
    expect(report.interrupted).toEqual([run.id]);
    expect(report.failed).toEqual([]);
    expect(getRun(db, run.id)!.status).toBe('interrupted');

    // The shared reason label: the remedy is the same as a gone version.
    const interrupted = loadEngineEvents(db, run.id).find((e) => e.type === 'run.interrupted');
    expect(interrupted).toMatchObject({
      type: 'run.interrupted',
      reason: `doc_unresolvable:${pvId}`,
    });
  });
});

describe('reconcileOnBoot — a run PARKED on a wait (#4 A6)', () => {
  const realAlarms = (db: Db): RetryAlarms => ({
    arm: (input) => armWakeup(db, input),
    find: (input) => getWakeupByKey(db, input.kind, buildDedupeKey(input)),
  });

  function waitNode(id: string, seconds: string): Node {
    seq += 1;
    return { id, type: 'wait', config: { seconds }, position: { x: seq, y: 0 } };
  }

  async function seedParkedRun(db: Db, alarms: RetryAlarms) {
    const pvId = seedVersion(db, [waitNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    await startRun(
      { db, resolveDoc: resolveDocFor(db), executor: makeStubExecutor(), alarms },
      run,
    );
    return run;
  }

  it('a genuinely-`waiting` run is INVISIBLE to reconcile — its durable alarm recovers it', async () => {
    // #5 S3 (#619) — the producer now parks the whole run `waiting` (its row is
    // `waiting`, not `running`), so the running-only boot scan never sees it. That
    // is CORRECT: its alarm was armed BEFORE the park, so it always has a live row,
    // and the clock's boot tick fires it independently — un-parking it back to
    // `running` and driving it. Scanning it here would append a redundant
    // `run.resumed`. Reconcile must leave a waiting run exactly as it found it.
    const { db } = freshDb();
    const alarms = realAlarms(db);
    const run = await seedParkedRun(db, alarms);
    expect(getRun(db, run.id)!.status).toBe('waiting');
    const before = loadEngineEvents(db, run.id);
    expect(before.map((e) => e.type)).toContain('run.waiting');
    expect(listPendingWakeups(db)).toHaveLength(1);
    const armedBefore = listPendingWakeups(db)[0];

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
      alarms,
    });

    // Not in ANY bucket — the scan never selected it.
    expect(report.held).toEqual([]);
    expect(report.resumed).toEqual([]);
    expect(report.finalized).toEqual([]);
    expect(report.interrupted).toEqual([]);
    // Untouched: log, row, and the live alarm all exactly as before.
    expect(loadEngineEvents(db, run.id)).toEqual(before);
    expect(getRun(db, run.id)!.status).toBe('waiting');
    expect(listPendingWakeups(db)).toEqual([armedBefore]);
  });

  it('the CRASH-GAP run (row still `running`, `run.waiting` append lost) is reported HELD', async () => {
    // The one parked-run case reconcile DOES see: a crash between the
    // `timer.waitScheduled` fold and the `parkRun` → `run.waiting` append leaves the
    // row `running` with a `wait_pending` node and no `run.waiting` in the log. On
    // resume the reducer re-derives a lone `parkRun` (the producer) — a DRIVER-OWN
    // command that EXECUTES nothing — so the held-park branch (which excludes
    // `parkRun`) still catches it: report `held`, append nothing, leave its live
    // alarm to recover it. Built by hand (the run_events log is append-only) as the
    // exact pre-`run.waiting` state: `run.started` + an armed alarm + the
    // `timer.waitScheduled` that parks the node, with the row still `running`.
    const { db } = freshDb();
    const alarms = realAlarms(db);
    const pvId = seedVersion(db, [waitNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    appendEngineEvent(db, {
      type: 'run.started',
      runId: run.id,
      pipelineVersionId: pvId,
      params: {},
    });
    const row = alarms.arm(
      waitArmInput(
        { now: () => 1_000 },
        { runId: run.id, nodeId: 'w', attemptId: 'w#0', seconds: 30 },
      ),
    );
    appendEngineEvent(db, {
      type: 'timer.waitScheduled',
      runId: run.id,
      nodeId: 'w',
      attemptId: 'w#0',
      dueAt: row.dueAt,
    });
    updateRun(db, run.id, { status: 'running' });
    const before = loadEngineEvents(db, run.id);
    expect(before.map((e) => e.type)).not.toContain('run.waiting');
    const armedBefore = listPendingWakeups(db);
    expect(armedBefore).toHaveLength(1);

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
      alarms,
    });

    expect(report.held).toEqual([run.id]);
    expect(report.resumed).toEqual([]);
    expect(report.finalized).toEqual([]);
    expect(report.interrupted).toEqual([]);
    // Untouched: no `run.resumed`, no second alarm, still `running` on its live row.
    expect(loadEngineEvents(db, run.id)).toEqual(before);
    expect(getRun(db, run.id)!.status).toBe('running');
    expect(listPendingWakeups(db)).toEqual(armedBefore);
  });
});

describe('reconcileOnBoot — a run PARKED on a webhook external wait (#4 A13)', () => {
  const MASTER_KEY = new Uint8Array(32).fill(9);
  const sign = (a: { runId: string; nodeId: string; attemptId: string }) =>
    deriveExternalWaitToken(MASTER_KEY, a);
  const realAlarms = (db: Db): RetryAlarms => ({
    arm: (input) => armWakeup(db, input),
    find: (input) => getWakeupByKey(db, input.kind, buildDedupeKey(input)),
  });

  function webhookNode(id: string): Node {
    seq += 1;
    return { id, type: 'webhook', config: { timeoutSeconds: '${30}' }, position: { x: seq, y: 0 } };
  }

  async function seedParkedWebhook(db: Db, alarms: RetryAlarms) {
    const pvId = seedVersion(db, [webhookNode('w')]);
    const run = seedRun(db, pvId);
    await startRun(
      {
        db,
        resolveDoc: resolveDocFor(db),
        executor: makeStubExecutor(),
        alarms,
        signExternalWaitToken: sign,
      },
      run,
    );
    return run;
  }

  it('a genuinely-`waiting` webhook run is INVISIBLE to reconcile (the normal restart-while-parked case)', async () => {
    // #5 S3 (#619) — the webhook counterpart of the wait case. The producer parked
    // the run `waiting`, so the running-only boot scan never selects it. A webhook
    // typically parks for a long time awaiting a human/external callback, so a
    // restart while parked is its COMMON boot state; its expiry alarm (armed BEFORE
    // the park) recovers it, un-parking it on `externalWait.completed`/`expired`.
    const { db } = freshDb();
    const alarms = realAlarms(db);
    const run = await seedParkedWebhook(db, alarms);
    expect(getRun(db, run.id)!.status).toBe('waiting');
    const before = loadEngineEvents(db, run.id);
    expect(before.map((e) => e.type)).toContain('run.waiting');
    expect(listPendingWakeups(db)).toHaveLength(1);
    const armedBefore = listPendingWakeups(db)[0];

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
      alarms,
      signExternalWaitToken: sign,
    });

    expect(report.held).toEqual([]);
    expect(report.finalized).toEqual([]);
    expect(report.resumed).toEqual([]);
    expect(report.interrupted).toEqual([]);
    // Untouched: no `run.resumed`, no second alarm, still `waiting` on its live row.
    expect(loadEngineEvents(db, run.id)).toEqual(before);
    expect(getRun(db, run.id)!.status).toBe('waiting');
    expect(listPendingWakeups(db)).toEqual([armedBefore]);
  });

  it('the CRASH-GAP webhook run (row still `running`, `run.waiting` lost) is reported HELD', async () => {
    // As for the wait crash-gap: the row is `running`, the node is
    // `external_wait_pending`, and there is no `run.waiting` in the log. Resume
    // re-derives a lone `parkRun` (excluded by the held-park branch), so it is
    // reported `held` and left for its live expiry alarm. Built by hand as the exact
    // pre-`run.waiting` state (the log is append-only).
    const { db } = freshDb();
    const alarms = realAlarms(db);
    const pvId = seedVersion(db, [webhookNode('w')]);
    const run = seedRun(db, pvId);
    appendEngineEvent(db, {
      type: 'run.started',
      runId: run.id,
      pipelineVersionId: pvId,
      params: {},
    });
    const row = alarms.arm(
      externalWaitArmInput(
        { now: () => 1_000 },
        {
          runId: run.id,
          nodeId: 'w',
          attemptId: 'w#0',
          timeoutSeconds: 30,
        },
      ),
    );
    appendEngineEvent(db, {
      type: 'externalWait.created',
      runId: run.id,
      nodeId: 'w',
      attemptId: 'w#0',
      dueAt: row.dueAt,
    });
    updateRun(db, run.id, { status: 'running' });
    const before = loadEngineEvents(db, run.id);
    expect(before.map((e) => e.type)).not.toContain('run.waiting');
    const armedBefore = listPendingWakeups(db);
    expect(armedBefore).toHaveLength(1);

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor(),
      alarms,
      signExternalWaitToken: sign,
    });

    expect(report.held).toEqual([run.id]);
    expect(report.resumed).toEqual([]);
    expect(report.finalized).toEqual([]);
    expect(report.interrupted).toEqual([]);
    expect(loadEngineEvents(db, run.id)).toEqual(before);
    expect(getRun(db, run.id)!.status).toBe('running');
    expect(listPendingWakeups(db)).toEqual(armedBefore);
  });
});

describe('reconcileOnBoot — #646 stored-state corruption is PERMANENT, filed `corrupt`, and cannot abort boot', () => {
  it('a corrupt RUN ROW no longer aborts the whole boot — the healthy sibling still reconciles', async () => {
    const { db, sqlite } = freshDb();
    // Two crashed runs: one healthy, one whose row is then corrupted.
    const healthy = await seedCrashedRun(db, [node('a')], [], {
      nodes: { a: { hang: true, idempotent: true } },
    });
    const bad = await seedCrashedRun(db, [node('a')], [], {
      nodes: { a: { hang: true, idempotent: true } },
    });
    // The hand-edit/legacy-drift vector: invalid stored JSON in a codec column.
    // Pre-#646 this threw SyntaxError out of the strict scan's `.all()` — ABOVE
    // the #479 per-run catch — and the server FAILED TO BOOT.
    sqlite.prepare('UPDATE runs SET params = ? WHERE id = ?').run('not json', bad.id);

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor({ nodes: { a: { outcome: 'success' } } }),
      alarms: stubAlarms(),
    });

    expect(report.resumed).toEqual([healthy.id]);
    expect(report.corrupt).toEqual([
      { runId: bad.id, reason: expect.stringMatching(/^run_row_unparseable:/) as string },
    ]);
    // NOT misfiled as transient, and deliberately NOT terminalized (a terminal
    // fact for an unreadable row would be manufactured — repair-then-resume).
    expect(report.failed).toEqual([]);
  });

  it('a corrupt run LOG is filed `corrupt` (permanent), never `failed` (transient-only)', async () => {
    const { db, sqlite } = freshDb();
    const run = await seedCrashedRun(db, [node('a')], [], {
      nodes: { a: { hang: true, idempotent: true } },
    });
    // The log is APPEND-ONLY (UPDATE is trigger-blocked): the corruption vector
    // is a poison appended row (the #642 test precedent).
    sqlite
      .prepare(
        'INSERT INTO run_events (id, run_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('evt_poison', run.id, 999, 'x', 'not json', 1_700_000_000_000);

    const report = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor({}),
      alarms: stubAlarms(),
    });

    expect(report.corrupt).toEqual([
      { runId: run.id, reason: expect.stringMatching(/^run_log_unparseable:/) as string },
    ]);
    expect(report.failed).toEqual([]);
    // Left running — visible, repairable, deliberately occupying its slot as
    // the needs-attention signal (see the `corrupt` bucket doc for the cost).
    expect(getRun(db, run.id)!.status).toBe('running');
    // And the verdict is STABLE across boots: the same report, not an
    // accumulating `failed` re-fail.
    const again = await reconcileOnBoot({
      db,
      resolveDoc: resolveDocFor(db),
      executor: makeStubExecutor({}),
      alarms: stubAlarms(),
    });
    expect(again.corrupt.map((c) => c.runId)).toEqual([run.id]);
    expect(again.failed).toEqual([]);
  });
});
