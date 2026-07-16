import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  DEFAULT_RETRY_INTERVAL_SECONDS,
  type NewPipelineVersion,
  type Node,
  type NodePolicy,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { listPendingWakeups } from '../../repo/scheduled-wakeups.js';
import type { Db } from '../../repo/types.js';
import { startRun, type DocResolver, type DriverDeps } from '../../run/driver.js';
import { appendEngineEvent, loadEngineEvents } from '../../run/events.js';
import {
  makeStubExecutor,
  type NodePlan,
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

function seedVersion(db: Db, nodes: Node[]): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes,
    edges: [],
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
  const deps: DriverDeps = {
    db,
    resolveDoc,
    executor: makeStubExecutor(executorOpts),
    // Referenced before its declaration, exactly as `index.ts` does it: `arm` is
    // only called at run time, so the TDZ window is closed by then.
    alarms: { arm: (input) => clock.arm(input) },
    now,
  };
  const clock: AlarmClock = createAlarmClock({
    db,
    handlers: [createRetryAlarmHandler(deps)],
    now,
  });
  return { deps, clock, resolveDoc };
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
    expect((await getRunState(db, deps, run.id)).nodes.a!.status).toBe('retry_pending');

    // Not due yet: the clock must not fire it early.
    clock.tick();
    await settle();
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('node.retryDue');

    // Time passes; the alarm comes due.
    plan.succeedFromNowOn();
    t = NOW + 30_000;
    clock.tick();
    await settle();

    const state = await getRunState(db, deps, run.id);
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

    const state = await getRunState(db, deps, run.id);
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
    const deps: DriverDeps = {
      db,
      resolveDoc,
      executor: makeStubExecutor(transientOnce('a')),
      alarms: { arm: (i) => clock.arm(i) },
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
async function getRunState(db: Db, deps: DriverDeps, runId: string) {
  const run = getRun(db, runId)!;
  const { buildEngine } = await import('../../run/driver.js');
  const engine = buildEngine(deps.resolveDoc(run.pipelineVersionId));
  return engine.projectRunState(loadEngineEvents(db, runId));
}

/** Let the clock's `afterCommit` pump (deliberately not awaited) run to rest. */
const settle = () => new Promise((r) => setTimeout(r, 20));
