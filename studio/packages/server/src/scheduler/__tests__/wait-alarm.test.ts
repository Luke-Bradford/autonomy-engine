import { describe, expect, it } from 'vitest';
import {
  buildDedupeKey,
  CATALOG_VERSION,
  type Edge,
  type NewPipelineVersion,
  type Node,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { getWakeupByKey, listPendingWakeups } from '../../repo/scheduled-wakeups.js';
import type { Db } from '../../repo/types.js';
import {
  buildEngine,
  DocUnresolvableError,
  startRun,
  type DocResolver,
  type DriveDeps,
  type DriverDeps,
} from '../../run/driver.js';
import { createRunDrives } from '../../run/drives.js';
import { appendEngineEvent, loadEngineEvents } from '../../run/events.js';
import { makeStubExecutor, type StubExecutorOptions } from '../../run/__tests__/stub-executor.js';
import { createAlarmClock, type AlarmClock } from '../alarms.js';
import { createWaitAlarmHandler } from '../wait-alarm.js';
import { silentLog } from './testLog.js';

/**
 * #4 A5/A6 — the DRIVER + CLOCK half of the durable `wait`, against a real DB, real
 * transactions, real alarm rows and the real reducer. Nothing is mocked but the
 * clock (`now`) and the activity executor (the wait itself is control, so the
 * executor is only exercised by any real downstream node).
 *
 * The pure park→resume state machine is pinned in the engine's
 * `wait-routing.test.ts`. What is under test HERE is everything that cannot be
 * pure: arming the durable timer, the `arm`-before-`append` ordering (which is what
 * removes the boot-reconcile burden), the freshness re-check, and the loop actually
 * closing — a parked wait ending in a completed node and a green run.
 */

const WAIT_KIND = 'node_wait';

let seq = 0;
function waitNode(id: string, seconds: string): Node {
  seq += 1;
  return { id, type: 'wait', config: { seconds }, position: { x: seq, y: 0 } };
}
function activity(id: string): Node {
  seq += 1;
  // Uncatalogued on purpose (same factory rationale as retry-alarm.test.ts): keeps
  // the output contract `absent` so the stub's `{}` payload is not failed.
  return { id, type: 'test_activity', config: {}, position: { x: seq, y: 0 } };
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

/** The production wiring in miniature: a driver whose `alarms` IS the clock, and a
 * clock whose wait handler drives through that same driver. */
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
    alarms: {
      arm: (input) => clock.arm(input),
      find: (input) => getWakeupByKey(db, input.kind, buildDedupeKey(input)),
    },
    drives,
    now,
  };
  const clock: AlarmClock = createAlarmClock({
    db,
    handlers: [createWaitAlarmHandler(deps)],
    now,
    log: silentLog(),
  });
  return { deps, clock, drives, resolveDoc };
}

describe('A6 — arming a wait (the driver half)', () => {
  it('arms a durable alarm, records timer.waitScheduled, and PARKS the node', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [waitNode('w', '${5}')]);
    const run = seedRun(db, pvId);
    const { deps } = harness(db);

    const state = await startRun(deps, run);

    // The node is PARKED, and the run is deliberately NOT finished.
    expect(state.nodes.w!.status).toBe('wait_pending');
    expect(state.status).toBe('running');
    expect(getRun(db, run.id)!.status).toBe('running');

    const pending = listPendingWakeups(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: WAIT_KIND,
      ref: { runId: run.id, nodeId: 'w', attemptId: 'w#0' },
      dueAt: NOW + 5_000,
    });

    const scheduled = loadEngineEvents(db, run.id).find((e) => e.type === 'timer.waitScheduled');
    expect(scheduled).toMatchObject({ nodeId: 'w', attemptId: 'w#0', dueAt: NOW + 5_000 });
  });

  it('ARMS BEFORE it appends — a crash between them leaves a live alarm, not a hung run', async () => {
    // arm-then-append loses only the log line to a crash (the node stays `ready`,
    // its scheduleWait re-emitted by resume). Append-then-arm would park the node
    // with no alarm to wake it. Simulated by an `arm` that throws: the
    // timer.waitScheduled must NOT already be durable.
    const { db } = freshDb();
    const pvId = seedVersion(db, [waitNode('w', '${5}')]);
    const run = seedRun(db, pvId);
    const resolveDoc: DocResolver = (id) => getPipelineVersion(db, id)!;
    const deps: DriverDeps = {
      db,
      resolveDoc,
      executor: makeStubExecutor(),
      alarms: {
        arm: () => {
          throw new Error('arm exploded');
        },
        find: () => null,
      },
      now: () => NOW,
    };

    await expect(startRun(deps, run)).rejects.toThrow('arm exploded');
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('timer.waitScheduled');
  });

  it('a FRACTIONAL ${} seconds arms an INTEGER dueAt (no non-integer-parse crash)', async () => {
    // `seconds` is `${}`-driven (unlike retry's integer-bounded interval), so it may
    // resolve to a fraction (a computed backoff, a `Retry-After: 2.5`). `armWait`
    // must round `now + seconds*1000` to integer ms — S1's `dueAt` is
    // `z.number().int()`, so an unrounded value throws inside `armWait` and turns the
    // run into a poison pill that re-throws every boot. This must PARK cleanly.
    const { db } = freshDb();
    const pvId = seedVersion(db, [waitNode('w', '${1.2345}')]);
    const run = seedRun(db, pvId);
    const { deps } = harness(db);

    const state = await startRun(deps, run);
    expect(state.nodes.w!.status).toBe('wait_pending');

    const pending = listPendingWakeups(db);
    expect(pending).toHaveLength(1);
    expect(Number.isInteger(pending[0]!.dueAt)).toBe(true);
    expect(pending[0]!.dueAt).toBe(Math.round(NOW + 1.2345 * 1000));
  });

  it('a REPLAYED scheduleWait does not double-arm and keeps the ORIGINAL due time', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [waitNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, {}, () => t);

    await startRun(deps, run);
    const first = listPendingWakeups(db);
    expect(first).toHaveLength(1);

    // The same alarm, armed again an hour later (a replayed command).
    t = NOW + 3_600_000;
    const rearmed = clock.arm({
      kind: WAIT_KIND,
      ref: { runId: run.id, nodeId: 'w', attemptId: 'w#0' },
      dueAt: t + 30_000,
      discriminator: 'wait-w#0',
    });

    expect(listPendingWakeups(db)).toHaveLength(1);
    expect(rearmed.dueAt).toBe(first[0]!.dueAt);
  });
});

describe('A6 — the alarm fires: the wait completes', () => {
  it('completes the parked node and finishes the run GREEN', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [waitNode('w', '${30}'), activity('after')],
      [{ id: 'w->after', from: 'w', to: 'after', on: 'success' }],
    );
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, {}, () => t);

    await startRun(deps, run);
    expect(getRunState(db, deps, run.id).nodes.w!.status).toBe('wait_pending');

    // Not due yet: the clock must not fire it early.
    clock.tick();
    await settle();
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('timer.due');

    // Time passes; the alarm comes due.
    t = NOW + 30_000;
    clock.tick();
    await settle();

    const state = getRunState(db, deps, run.id);
    expect(state.nodes.w!.status).toBe('success');
    expect(state.nodes.after!.status).toBe('success');
    expect(state.status).toBe('success');
    expect(getRun(db, run.id)!.status).toBe('success');

    const types = loadEngineEvents(db, run.id).map((e) => e.type);
    expect(types).toEqual([
      'run.started',
      'timer.waitScheduled',
      'timer.due',
      'node.dispatched',
      'node.succeeded',
      'run.finished',
    ]);
    // The alarm is spent, not left to re-fire.
    expect(listPendingWakeups(db)).toHaveLength(0);
  });

  it("a WAITED run's log replays to the identical final state (event-sourcing invariant)", async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [waitNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock, resolveDoc } = harness(db, {}, () => t);

    await startRun(deps, run);
    t = NOW + 30_000;
    clock.tick();
    await settle();

    const live = getRunState(db, deps, run.id);
    const replayed = buildEngine(resolveDoc(pvId)).projectRunState(loadEngineEvents(db, run.id));
    expect(replayed).toEqual(live);
    expect(replayed.status).toBe('success');
    expect(replayed.nodes.w).toMatchObject({ status: 'success' });
  });
});

describe('A6 — freshness: at-least-once + a stale-delivery check', () => {
  it('SUPPRESSES an alarm whose run already finished (#443 — the log is authoritative)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [waitNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, {}, () => t);
    await startRun(deps, run);
    t = NOW + 30_000;

    // Terminalized behind the alarm's back (the shape terminalizeInterrupted makes
    // when a drive throws after arming).
    appendEngineEvent(db, { type: 'run.interrupted', runId: run.id, reason: 'drive_failed' });

    clock.tick();
    await settle();

    expect(listPendingWakeups(db)).toHaveLength(0);
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('timer.due');
  });

  it('SUPPRESSES an alarm whose run does not exist (run_not_found)', async () => {
    // Parity with the retry handler's `run_not_found` branch: an alarm whose run row
    // is gone settles rather than re-delivering forever. No engine events, no run —
    // the handler suppresses after the terminal-log check finds nothing to drive.
    const { db } = freshDb();
    const { clock } = harness(db);
    clock.arm({
      kind: WAIT_KIND,
      ref: { runId: 'run_ghost', nodeId: 'w', attemptId: 'w#0' },
      dueAt: NOW,
      discriminator: 'wait-w#0',
    });
    expect(listPendingWakeups(db)).toHaveLength(1);

    clock.tick();
    await settle();

    expect(listPendingWakeups(db)).toHaveLength(0);
    expect(loadEngineEvents(db, 'run_ghost')).toEqual([]);
  });

  it('SUPPRESSES an alarm whose node is no longer parked at that attempt', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [waitNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, {}, () => t);
    await startRun(deps, run);
    t = NOW + 30_000;

    // The wait already completed (its alarm delivered once); the clock now
    // re-delivers the SAME alarm — at-least-once is the contract.
    appendEngineEvent(db, {
      type: 'timer.due',
      runId: run.id,
      nodeId: 'w',
      previousAttemptId: 'w#0',
    });

    clock.tick();
    await settle();

    // Only the one timer.due we appended — the stale alarm added none.
    expect(loadEngineEvents(db, run.id).filter((e) => e.type === 'timer.due')).toHaveLength(1);
    expect(listPendingWakeups(db)).toHaveLength(0);
  });

  it('SUPPRESSES rather than re-delivering forever when the pipeline version is gone', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [waitNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    let t = NOW;
    let deleted = false;
    const resolveDoc: DocResolver = (id) => {
      if (deleted) throw new DocUnresolvableError('version deleted');
      const pv = getPipelineVersion(db, id);
      if (pv === null) throw new DocUnresolvableError(`no pv ${id}`);
      return pv;
    };
    const deps: DriveDeps = {
      db,
      resolveDoc,
      executor: makeStubExecutor(),
      alarms: {
        arm: (i) => clock.arm(i),
        find: (i) => getWakeupByKey(db, i.kind, buildDedupeKey(i)),
      },
      drives: createRunDrives(),
      now: () => t,
    };
    const clock: AlarmClock = createAlarmClock({
      db,
      handlers: [createWaitAlarmHandler(deps)],
      now: () => t,
      log: silentLog(),
    });

    await startRun(deps, run);
    expect(listPendingWakeups(db)).toHaveLength(1);

    deleted = true;
    t = NOW + 30_000;
    clock.tick();
    await settle();

    expect(listPendingWakeups(db)).toHaveLength(0);
  });

  it('does NOT suppress a TRANSIENT resolve fault — the alarm stays pending for the next tick', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [waitNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    let t = NOW;
    let blip = false;
    const resolveDoc: DocResolver = (id) => {
      if (blip) throw new Error('db read timed out');
      const pv = getPipelineVersion(db, id);
      if (pv === null) throw new DocUnresolvableError(`no pv ${id}`);
      return pv;
    };
    const deps: DriveDeps = {
      db,
      resolveDoc,
      executor: makeStubExecutor(),
      alarms: {
        arm: (i) => clock.arm(i),
        find: (i) => getWakeupByKey(db, i.kind, buildDedupeKey(i)),
      },
      drives: createRunDrives(),
      now: () => t,
    };
    const clock: AlarmClock = createAlarmClock({
      db,
      handlers: [createWaitAlarmHandler(deps)],
      now: () => t,
      log: silentLog(),
    });

    await startRun(deps, run);
    const armed = listPendingWakeups(db);
    expect(armed).toHaveLength(1);

    blip = true;
    t = NOW + 30_000;
    clock.tick();
    await settle();

    // Rolled back, NOT suppressed: the same alarm row is still pending.
    const still = listPendingWakeups(db);
    expect(still).toHaveLength(1);
    expect(still[0]!.id).toBe(armed[0]!.id);
    expect(still[0]!.status).toBe('pending');
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
