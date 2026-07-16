import { describe, expect, it } from 'vitest';
import {
  buildDedupeKey,
  CATALOG_VERSION,
  DEFAULT_RETRY_INTERVAL_SECONDS,
  type Edge,
  type EngineEvent,
  type NewPipelineVersion,
  type Node,
  type NodePolicy,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { getWakeupByKey, listPendingWakeups } from '../../repo/scheduled-wakeups.js';
import type { Db } from '../../repo/types.js';
import {
  buildEngine,
  startRun,
  type DocResolver,
  type DriveDeps,
  type DriverDeps,
} from '../../run/driver.js';
import { createRunDrives } from '../../run/drives.js';
import { appendEngineEvent, loadEngineEvents } from '../../run/events.js';
import {
  makeStubExecutor,
  type NodePlan,
  type RecordingExecutor,
  type StubExecutorOptions,
} from '../../run/__tests__/stub-executor.js';
import { createAlarmClock, type AlarmClock } from '../alarms.js';
import { createRetryAlarmHandler } from '../retry-alarm.js';

/**
 * #1 F2c — the DRIVER + CLOCK half of D4's retry, against a real DB, real
 * transactions, real alarm rows and the real reducer. Nothing is mocked but the
 * clock (`now`) and the activity executor, both of which are seams the
 * production code already exposes.
 *
 * F2b (the pure eligibility decision) is pinned in the engine's
 * `retry-state-machine.test.ts`. What is under test HERE is everything that
 * cannot be pure: arming a durable alarm, the `arm`-before-`append` ordering a
 * crash depends on, the freshness re-check, and the loop actually closing —
 * a transient failure ending in a re-dispatched node and a green run.
 */

const RETRY_KIND = 'node_retry';

let seq = 0;
function node(id: string, policy?: NodePolicy): Node {
  seq += 1;
  return {
    id,
    type: 'agent_task',
    config: {},
    position: { x: seq, y: 0 },
    ...(policy && { policy }),
  };
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

const NOW = 1_700_000_000_000;

/**
 * The real production wiring in miniature: a driver whose `alarms` IS the clock,
 * and a clock whose retry handler drives through that same driver. The mutual
 * recursion is real (an armed retry re-dispatches a node, whose next failure
 * arms attempt-2), so the test builds it the same lazy way `index.ts` does.
 */
function harness(db: Db, executorOpts: StubExecutorOptions = {}, now: () => number = () => NOW) {
  const resolveDoc: DocResolver = (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
  const drives = createRunDrives();
  const deps: DriveDeps = {
    db,
    resolveDoc,
    executor: makeStubExecutor(executorOpts),
    // Referenced before its declaration, exactly as `index.ts` does it: `arm` is
    // only called at run time, so the TDZ window is closed by then.
    alarms: {
      arm: (input) => clock.arm(input),
      // Backed by the same table `arm` writes — the production pairing.
      find: (input) => getWakeupByKey(db, input.kind, buildDedupeKey(input)),
    },
    // ONE registry shared by every drive entry point, as `index.ts` does it. Two
    // registries here would serialize nothing and quietly restore B1.
    drives,
    now,
  };
  const clock: AlarmClock = createAlarmClock({
    db,
    handlers: [createRetryAlarmHandler(deps)],
    now,
  });
  return { deps, clock, drives, resolveDoc };
}

/**
 * A node that is READY as soon as ANY incoming edge is satisfied. `join` is a
 * CONFIG value (`nodeJoin` reads `node.config['join']`), not a `Node` field.
 */
function joinAny(id: string): Node {
  return { ...node(id), config: { join: 'any' } };
}

const transientOnce = (nodeId: string): StubExecutorOptions => ({
  nodes: { [nodeId]: { outcome: 'failure', kind: 'transient' } },
});

/**
 * A plan the test can FLIP between attempts. The stub reads its plan at each
 * dispatch, so mutating the object is how "fail once, then succeed" is
 * expressed without teaching the shared stub a per-attempt API it has no other
 * caller for.
 */
function flippablePlan(nodeId: string) {
  const plan: NodePlan = { outcome: 'failure', kind: 'transient' };
  return {
    opts: { nodes: { [nodeId]: plan } } satisfies StubExecutorOptions,
    succeedFromNowOn: () => {
      plan.outcome = 'success';
    },
  };
}

describe("F2c — arming a retry (the driver half of D4's split)", () => {
  it('arms a durable alarm and records nextAttemptAt in the log', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { retry: 1, retryIntervalSeconds: 60 })]);
    const run = seedRun(db, pvId);
    const { deps } = harness(db, transientOnce('a'));

    const state = await startRun(deps, run);

    // The node is HELD, and the run is deliberately NOT finished.
    expect(state.nodes.a!.status).toBe('retry_pending');
    expect(state.status).toBe('running');
    expect(getRun(db, run.id)!.status).toBe('running');

    const pending = listPendingWakeups(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: RETRY_KIND,
      ref: { runId: run.id, nodeId: 'a', attemptId: 'a#0' },
      dueAt: NOW + 60_000,
    });

    const scheduled = loadEngineEvents(db, run.id).find((e) => e.type === 'node.retryScheduled');
    expect(scheduled).toMatchObject({ nodeId: 'a', attemptId: 'a#0', nextAttemptAt: NOW + 60_000 });
  });

  it('falls back to DEFAULT_RETRY_INTERVAL_SECONDS when the policy names no interval', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { retry: 1 })]);
    const run = seedRun(db, pvId);
    const { deps } = harness(db, transientOnce('a'));

    await startRun(deps, run);

    expect(listPendingWakeups(db)[0]!.dueAt).toBe(NOW + DEFAULT_RETRY_INTERVAL_SECONDS * 1000);
  });

  it('ARMS BEFORE it appends — a crash between them must leave a live alarm, not a hung run', async () => {
    // The asymmetry that makes the order load-bearing: arm-then-append loses only
    // a log line to a crash, because the alarm still fires and recovers the node.
    // Append-then-arm would leave a log PROMISING a retry with nothing to deliver
    // it, and `retry_pending` has no other recovery path (§A.5).
    //
    // Simulated by an `arm` that throws: if the append came first, the
    // `node.retryScheduled` event would already be durable. It must not be.
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { retry: 1 })]);
    const run = seedRun(db, pvId);
    const resolveDoc: DocResolver = (id) => getPipelineVersion(db, id)!;
    const deps: DriverDeps = {
      db,
      resolveDoc,
      executor: makeStubExecutor(transientOnce('a')),
      alarms: {
        arm: () => {
          throw new Error('arm exploded');
        },
        find: () => null,
      },
      now: () => NOW,
    };

    await expect(startRun(deps, run)).rejects.toThrow('arm exploded');

    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('node.retryScheduled');
  });

  it('a REPLAYED scheduleRetry does not double-arm, and logs the ORIGINAL due time', async () => {
    // `arm` is idempotent by (kind, dedupeKey), so a re-arm returns the EXISTING
    // row. `nextAttemptAt` is stamped from that row rather than recomputed, so a
    // replay records when the alarm will really fire — not a fresh, fictional
    // time. Driven here by arming the same command twice through a moving clock.
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { retry: 1, retryIntervalSeconds: 30 })]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, transientOnce('a'), () => t);

    await startRun(deps, run);
    const first = listPendingWakeups(db);
    expect(first).toHaveLength(1);

    // The same alarm, armed again an hour later (a replayed command).
    t = NOW + 3_600_000;
    const rearmed = clock.arm({
      kind: RETRY_KIND,
      ref: { runId: run.id, nodeId: 'a', attemptId: 'a#0' },
      dueAt: t + 30_000,
      discriminator: 'attempt-a#0',
    });

    expect(listPendingWakeups(db)).toHaveLength(1);
    expect(rearmed.dueAt).toBe(first[0]!.dueAt);
  });
});

describe('F2c — the event-sourcing invariant survives a retry', () => {
  it("a RETRIED run's log replays to the identical final state", async () => {
    // The invariant the whole engine rests on (`state = fold(run_events)`), across
    // the event sequence F2b/F2c introduces. It is what proves the new `retries`
    // counter folds deterministically from the log rather than being live-only
    // bookkeeping, and that `node.retryScheduled`'s no-op fold is genuinely inert
    // on replay. The existing pin in `driver.test.ts` only covers a plain chain.
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { retry: 2, retryIntervalSeconds: 30 })]);
    const run = seedRun(db, pvId);
    const plan = flippablePlan('a');
    let t = NOW;
    const { deps, clock, resolveDoc } = harness(db, plan.opts, () => t);

    await startRun(deps, run);
    t = NOW + 30_000;
    plan.succeedFromNowOn();
    clock.tick();
    await settle();

    const live = getRunState(db, deps, run.id);
    const replayed = buildEngine(resolveDoc(pvId)).projectRunState(loadEngineEvents(db, run.id));

    expect(replayed).toEqual(live);
    expect(replayed.status).toBe('success');
    // The retry really happened — otherwise this asserts nothing interesting.
    expect(replayed.nodes.a).toMatchObject({ status: 'success', retries: 1, attempts: 2 });
  });
});

describe('F2c — the alarm fires: the retry loop closes', () => {
  it('re-dispatches the held node and finishes the run GREEN (the whole point)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { retry: 1, retryIntervalSeconds: 30 })]);
    const run = seedRun(db, pvId);
    // Fail transiently ONCE, then succeed — the canonical retry.
    const plan = flippablePlan('a');
    let t = NOW;
    const { deps, clock } = harness(db, plan.opts, () => t);

    await startRun(deps, run);
    expect(getRunState(db, deps, run.id).nodes.a!.status).toBe('retry_pending');

    // Not due yet: the clock must not fire it early.
    clock.tick();
    await settle();
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('node.retryDue');

    // Time passes; the alarm comes due.
    plan.succeedFromNowOn();
    t = NOW + 30_000;
    clock.tick();
    await settle();

    const state = getRunState(db, deps, run.id);
    expect(state.nodes.a!.status).toBe('success');
    expect(state.status).toBe('success');
    expect(getRun(db, run.id)!.status).toBe('success');

    const types = loadEngineEvents(db, run.id).map((e) => e.type);
    expect(types).toEqual([
      'run.started',
      'node.dispatched',
      'node.failed',
      'node.retryScheduled',
      'node.retryDue',
      'node.dispatched',
      'node.succeeded',
      'run.finished',
    ]);
    // The alarm is spent, not left to re-fire.
    expect(listPendingWakeups(db)).toHaveLength(0);
  });

  it('exhausts the budget: retry, fail again, and the run finally FAILS', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { retry: 1, retryIntervalSeconds: 30 })]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, transientOnce('a'), () => t);

    await startRun(deps, run);
    t = NOW + 30_000;
    clock.tick();
    await settle();

    const state = getRunState(db, deps, run.id);
    expect(state.nodes.a!.status).toBe('failure');
    expect(state.status).toBe('failure');
    expect(getRun(db, run.id)!.status).toBe('failure');
    // Exactly TWO dispatches: the original + the one retry the policy allows.
    expect(loadEngineEvents(db, run.id).filter((e) => e.type === 'node.dispatched')).toHaveLength(
      2,
    );
  });

  it('SUPPRESSES an alarm whose run already finished (#443 — the log is authoritative)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { retry: 1 })]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, transientOnce('a'), () => t);
    await startRun(deps, run);
    t = NOW + 60_000;

    // The run is terminalized behind the alarm's back (the shape
    // `terminalizeInterrupted` produces when a drive throws after arming).
    appendEngineEvent(db, { type: 'run.interrupted', runId: run.id, reason: 'drive_failed' });

    clock.tick();
    await settle();

    // The alarm settled rather than resurrecting a finished run.
    expect(listPendingWakeups(db)).toHaveLength(0);
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('node.retryDue');
  });

  it('SUPPRESSES an alarm whose node is no longer held at that attempt', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { retry: 2 })]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, transientOnce('a'), () => t);
    await startRun(deps, run);
    t = NOW + 60_000;

    // The retry already dispatched (its alarm delivered once); the clock now
    // re-delivers the SAME alarm — at-least-once is the contract.
    appendEngineEvent(db, {
      type: 'node.retryDue',
      runId: run.id,
      nodeId: 'a',
      previousAttemptId: 'a#0',
    });

    clock.tick();
    await settle();

    // Only the one `node.retryDue` we appended — the stale alarm added none.
    expect(loadEngineEvents(db, run.id).filter((e) => e.type === 'node.retryDue')).toHaveLength(1);
    expect(listPendingWakeups(db)).toHaveLength(0);
  });

  it('SUPPRESSES rather than re-delivering forever when the pipeline version is gone', async () => {
    // A throw inside the clock's transaction rolls back the settle, so the row
    // stays pending and is retried on EVERY tick — an infinite error loop for a
    // run that can never be driven again. It must settle instead.
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { retry: 1 })]);
    const run = seedRun(db, pvId);
    let t = NOW;
    let deleted = false;
    const resolveDoc: DocResolver = (id) => {
      if (deleted) throw new Error('version deleted');
      const pv = getPipelineVersion(db, id);
      if (pv === null) throw new Error(`no pv ${id}`);
      return pv;
    };
    const deps: DriveDeps = {
      db,
      resolveDoc,
      executor: makeStubExecutor(transientOnce('a')),
      alarms: {
        arm: (i) => clock.arm(i),
        find: (i) => getWakeupByKey(db, i.kind, buildDedupeKey(i)),
      },
      drives: createRunDrives(),
      now: () => t,
    };
    const clock: AlarmClock = createAlarmClock({
      db,
      handlers: [createRetryAlarmHandler(deps)],
      now: () => t,
    });

    await startRun(deps, run);
    expect(listPendingWakeups(db)).toHaveLength(1);

    deleted = true;
    t = NOW + 60_000;
    clock.tick();
    await settle();

    expect(listPendingWakeups(db)).toHaveLength(0);
  });
});

/** Project a run's CURRENT state from its durable log (never a cached handle). */
function getRunState(db: Db, deps: DriverDeps, runId: string) {
  const run = getRun(db, runId)!;
  const engine = buildEngine(deps.resolveDoc(run.pipelineVersionId));
  return engine.projectRunState(loadEngineEvents(db, runId));
}

/** Let the clock's `afterCommit` pump (deliberately not awaited) run to rest. */
const settle = () => new Promise((r) => setTimeout(r, 20));

/**
 * Wait until `check` holds, polling the durable log. Used to reach a precise
 * mid-drive moment WITHOUT betting on wall-clock timing: a fixed sleep that
 * assumed "by now the pump has reached node d" would pass on this machine and
 * flake on a loaded CI box — and a flaky concurrency test is worse than none,
 * because it gets retried until green.
 */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    // Tolerant by design: before `run.started` folds there are no nodes to look
    // at, so an early poll legitimately throws rather than returning false.
    // "Not there yet" and "cannot tell yet" are the same answer to this loop.
    try {
      if (check()) return;
    } catch {
      // keep waiting
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// ===========================================================================
// #1 F2c/B1 — EXACTLY ONE DRIVE PER RUN (the regression this branch stopped for)
// ===========================================================================

describe('F2c/B1 — two due alarms must not start two concurrent drives', () => {
  /**
   * The measured repro, kept in the shape it was measured in.
   *
   * Before the per-run drive lock, the alarm clock's `afterCommit` was a SECOND
   * pump source alongside the launcher, and nothing serialized them. Each `pump`
   * carries its own in-memory `RunState` (`driver.ts` — `let state =
   * initialState`) and never re-reads the log, so two drives diverged permanently
   * and BOTH wrote. With `a` and `b` retrying and both alarms due in ONE tick
   * (the clock does not await `afterCommit`), the measurement was:
   *
   *   DISPATCHED: [..., "a#1", "b#1", "d#0", "d#0"]   ← d dispatched TWICE
   *   RUN ROW: running        run.finished: absent    ← and then hung forever
   *
   * `d#0` twice under the SAME attemptId is a real LLM call billed twice: each
   * pump minted `d#0` from its OWN state, so attempt-id stale-rejection never saw
   * a mismatch and could not save it. The hang is the same divergence — neither
   * pump's state ever satisfied the run's terminal condition.
   *
   * `join: 'any'` is what makes `d` reachable from either drive at once; under
   * `join: 'all'` the same divergence instead dispatched `d` NEVER.
   */
  it('dispatches the shared successor ONCE and finishes the run', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('root'), node('a', { retry: 1 }), node('b', { retry: 1 }), joinAny('d')],
      [
        { id: 'root->a', from: 'root', to: 'a', on: 'success' },
        { id: 'root->b', from: 'root', to: 'b', on: 'success' },
        { id: 'a->d', from: 'a', to: 'd', on: 'success' },
        { id: 'b->d', from: 'b', to: 'd', on: 'success' },
      ],
    );
    const run = seedRun(db, pvId);

    // `a` and `b` fail transiently on their first attempt, then succeed — so both
    // hold, both arm, and both alarms come due together.
    const planA: NodePlan = { outcome: 'failure', kind: 'transient' };
    const planB: NodePlan = { outcome: 'failure', kind: 'transient' };
    let t = NOW;
    const { deps, clock, drives } = harness(db, { nodes: { a: planA, b: planB } }, () => t);
    const executor = deps.executor as RecordingExecutor;

    await startRun(deps, run);

    // Precondition: BOTH nodes held, BOTH alarms armed for the same instant.
    const held = getRunState(db, deps, run.id);
    expect(held.nodes.a!.status).toBe('retry_pending');
    expect(held.nodes.b!.status).toBe('retry_pending');
    expect(listPendingWakeups(db)).toHaveLength(2);
    expect(new Set(listPendingWakeups(db).map((w) => w.dueAt)).size).toBe(1);

    planA.outcome = 'success';
    planB.outcome = 'success';

    // ONE tick, BOTH alarms due: the clock fires them back to back and does not
    // await either `afterCommit`, so both drives are in flight at once.
    t = NOW + DEFAULT_RETRY_INTERVAL_SECONDS * 1000;
    clock.tick();
    await drives.whenIdle();
    await settle();

    // The retries both ran...
    expect(executor.dispatched).toContain('a#1');
    expect(executor.dispatched).toContain('b#1');
    // ...and `d` was dispatched EXACTLY ONCE. This is the assertion: a second
    // `d#0` is a duplicated real side effect, not a cosmetic log artefact.
    expect(executor.dispatched.filter((id: string) => id.startsWith('d#'))).toEqual(['d#0']);

    // ...and the run actually FINISHED rather than hanging.
    const log = loadEngineEvents(db, run.id);
    expect(log.filter((e) => e.type === 'run.finished')).toHaveLength(1);
    expect(getRunState(db, deps, run.id).status).toBe('success');
    expect(getRun(db, run.id)!.status).toBe('success');
  });

  it('an alarm firing while the LAUNCHER is still driving waits its turn', async () => {
    // The other half of B1, and the one that made it reachable with a SINGLE
    // retry: any parallel node outliving the retry interval leaves the launcher's
    // pump live when the alarm fires — i.e. essentially every real LLM pipeline.
    // The alarm's `fire()` transaction still commits mid-pump (better-sqlite3 is
    // synchronous, so it lands at one of the pump's `await` points), but its
    // DRIVE must queue behind the live one and re-project after it.
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('root'), node('a', { retry: 1 }), node('fast'), joinAny('d')],
      [
        { id: 'root->a', from: 'root', to: 'a', on: 'success' },
        { id: 'root->fast', from: 'root', to: 'fast', on: 'success' },
        { id: 'a->d', from: 'a', to: 'd', on: 'success' },
        { id: 'fast->d', from: 'fast', to: 'd', on: 'success' },
      ],
    );
    const run = seedRun(db, pvId);
    const planA: NodePlan = { outcome: 'failure', kind: 'transient' };
    let t = NOW;
    // `d` is the node that OUTLIVES the retry interval, and it has to be `d`
    // rather than a sibling: `pump` drains commands SEQUENTIALLY and pushes
    // `scheduleRetry` at the QUEUE TAIL, so a slow sibling merely delays the arm
    // instead of overlapping it (measured — the first draft of this test armed
    // nothing before it ticked, and proved nothing). Here `fast` succeeds, `d`
    // goes ready under `join:'any'`, the arm drains, and THEN `d` holds the pump
    // open — so the alarm fires into a genuinely live drive.
    const { deps, clock, drives } = harness(
      db,
      { nodes: { a: planA, d: { delayMs: 80 } } },
      () => t,
    );
    const executor = deps.executor as RecordingExecutor;

    // Drive in the BACKGROUND under the run's lock, exactly as the launcher does.
    const launcherDrive = drives.serialize(run.id, () => startRun(deps, run));

    // Wait for the exact moment the test needs: `a` held, its alarm ARMED, and
    // `d` still in flight — i.e. a genuinely live drive with a due-able alarm.
    await until(
      () => getRunState(db, deps, run.id).nodes.d!.status === 'dispatched',
      'd to be dispatched (the launcher drive is live)',
    );
    expect(getRunState(db, deps, run.id).nodes.a!.status).toBe('retry_pending');
    expect(listPendingWakeups(db)).toHaveLength(1);

    planA.outcome = 'success';
    t = NOW + DEFAULT_RETRY_INTERVAL_SECONDS * 1000;
    clock.tick();

    await launcherDrive;
    await drives.whenIdle();
    await settle();

    expect(executor.dispatched.filter((id: string) => id.startsWith('d#'))).toEqual(['d#0']);
    expect(loadEngineEvents(db, run.id).filter((e) => e.type === 'run.finished')).toHaveLength(1);
    expect(getRun(db, run.id)!.status).toBe('success');
  });
});

describe('F2c — a retry drive that THROWS terminalizes, it does not hang silently', () => {
  it('freezes the run interrupted, the same way the launcher does', async () => {
    // Before this, the two drive entry points handled an identical fault
    // differently: the LAUNCHER caught it and froze the run needs-attention,
    // while the alarm's `afterCommit` let it escape to the clock's floating catch
    // — one log line, run left `running`, its alarm row now spent, nothing to
    // re-drive it until an unrelated restart. Same bug, visible one way and a
    // silent hang the other. That asymmetry is what produced B1.
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { retry: 1 })]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock, drives } = harness(db, transientOnce('a'), () => t);

    await startRun(deps, run);
    expect(getRunState(db, deps, run.id).nodes.a!.status).toBe('retry_pending');

    // The retry's re-dispatch throws OUT of the executor (a bug, not an expected
    // activity failure — those become `node.failed` events and never reach here).
    // Throws synchronously ON CALL rather than on iteration — the shape a real
    // adapter bug takes, and the one `reconcile.ts`'s `refuseToExecute` uses.
    deps.executor = {
      perform(): AsyncIterable<EngineEvent> {
        throw new Error('executor blew up on the retry');
      },
    };

    t = NOW + DEFAULT_RETRY_INTERVAL_SECONDS * 1000;
    clock.tick();
    await drives.whenIdle();
    await settle();

    // Durable, event-sourced, and visible — not a `running` row and a log line.
    const log = loadEngineEvents(db, run.id);
    expect(log.map((e) => e.type)).toContain('run.interrupted');
    expect(getRun(db, run.id)!.status).toBe('interrupted');
    expect(getRun(db, run.id)!.finishedAt).not.toBeNull();
  });
});
