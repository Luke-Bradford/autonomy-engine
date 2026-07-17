import { describe, expect, it } from 'vitest';
import {
  buildDedupeKey,
  CATALOG_VERSION,
  MAX_WAIT_SECONDS,
  type Container,
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
  CONTAINER_TIMEOUT_WAKEUP_KIND,
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
import { createContainerTimeoutAlarmHandler } from '../container-timeout-alarm.js';
import { silentLog } from './testLog.js';

/**
 * #4 A17 — the DRIVER + CLOCK half of a `loop`'s wall-clock timeout, against a real
 * DB, real transactions, real alarm rows and the real reducer. Nothing is mocked
 * but the clock (`now`) and the activity executor. The pure fold state machine is
 * pinned in the engine's `reduce-p2c.test.ts`; what is under test HERE is the
 * container-scoped arm (arm-before-append, the MAX_WAIT_SECONDS clamp), the
 * freshness re-check on fire, and a loop actually failing `timeout` when it outruns
 * its bound.
 */

const KIND = CONTAINER_TIMEOUT_WAKEUP_KIND;

let seq = 0;
/** An agent_task with a declared boolean output so a loop's `exitWhen` can ref it. */
function gate(id: string): Node {
  seq += 1;
  return {
    id,
    type: 'agent_task',
    config: { outputs: [{ name: 'done', type: 'boolean' }] },
    position: { x: seq, y: 0 },
  };
}
function activity(id: string): Node {
  seq += 1;
  return { id, type: 'test_activity', config: {}, position: { x: seq, y: 0 } };
}
function timedLoop(id: string, children: string[], timeout: number): Container {
  return { id, kind: 'loop', children, exitWhen: `\${nodes.${children[0]}.output.done}`, timeout };
}

function seedVersion(
  db: Db,
  nodes: Node[],
  edges: Edge[] = [],
  containers: Container[] = [],
): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes,
    edges,
    containers,
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
 * clock whose container-timeout handler drives through that same driver. */
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
    handlers: [createContainerTimeoutAlarmHandler(deps)],
    now,
    log: silentLog(),
  });
  return { deps, clock, drives, resolveDoc };
}

describe('A17 — arming a loop timeout (the driver half)', () => {
  it('arms a durable alarm, records container.timeoutScheduled, and stamps timeoutDueAt', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [gate('work')], [], [timedLoop('lp', ['work'], 30)]);
    const run = seedRun(db, pvId);
    // `work` HANGS (dispatched, no terminal) so the loop stays active across the tick.
    const { deps } = harness(db, { nodes: { work: { hang: true } } });

    const state = await startRun(deps, run);
    expect(state.containers.lp!.status).toBe('active');
    expect(state.containers.lp!.timeoutDueAt).toBe(NOW + 30_000);
    expect(state.status).toBe('running');

    const pending = listPendingWakeups(db).filter((w) => w.kind === KIND);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: KIND,
      ref: { runId: run.id, containerId: 'lp' },
      dueAt: NOW + 30_000,
    });

    const scheduled = loadEngineEvents(db, run.id).find(
      (e) => e.type === 'container.timeoutScheduled',
    );
    expect(scheduled).toMatchObject({ containerId: 'lp', dueAt: NOW + 30_000 });
  });

  it('ARMS BEFORE it appends — a crash between them leaves no phantom scheduled event', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [gate('work')], [], [timedLoop('lp', ['work'], 30)]);
    const run = seedRun(db, pvId);
    const resolveDoc: DocResolver = (id) => getPipelineVersion(db, id)!;
    const deps: DriverDeps = {
      db,
      resolveDoc,
      executor: makeStubExecutor({ nodes: { work: { hang: true } } }),
      alarms: {
        arm: () => {
          throw new Error('arm exploded');
        },
        find: () => null,
      },
      now: () => NOW,
    };

    await expect(startRun(deps, run)).rejects.toThrow('arm exploded');
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain(
      'container.timeoutScheduled',
    );
  });

  it('CLAMPS an absurd timeout to MAX_WAIT_SECONDS so the dueAt never overflows', async () => {
    const { db } = freshDb();
    // A timeout past the safe-integer ceiling would poison `now + seconds*1000`.
    const huge = MAX_WAIT_SECONDS + 1_000_000;
    const pvId = seedVersion(db, [gate('work')], [], [timedLoop('lp', ['work'], huge)]);
    const run = seedRun(db, pvId);
    const { deps } = harness(db, { nodes: { work: { hang: true } } });

    await startRun(deps, run);
    const pending = listPendingWakeups(db).filter((w) => w.kind === KIND);
    expect(pending).toHaveLength(1);
    expect(Number.isSafeInteger(pending[0]!.dueAt)).toBe(true);
    expect(pending[0]!.dueAt).toBe(Math.round(NOW + MAX_WAIT_SECONDS * 1000));
  });
});

describe('A17 — the alarm fires: the loop times out', () => {
  it('fails the loop `timeout`, neutralizes the live child, and finishes the run', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [gate('work'), activity('after')],
      [{ id: 'lp->after', from: 'lp', to: 'after', on: 'success' }],
      [timedLoop('lp', ['work'], 30)],
    );
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, { nodes: { work: { hang: true } } }, () => t);

    await startRun(deps, run);
    expect(getRunState(db, deps, run.id).containers.lp!.status).toBe('active');

    // Not due yet: the clock must not fire it early.
    clock.tick();
    await settle();
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('container.timedOut');

    // Time passes; the wall-clock bound elapses.
    t = NOW + 30_000;
    clock.tick();
    await settle();

    const state = getRunState(db, deps, run.id);
    expect(state.containers.lp!.status).toBe('failure');
    expect(state.containers.lp!.reason).toBe('timeout');
    expect(state.nodes.work!.status).toBe('skipped'); // the hung child was abandoned
    expect(state.nodes.after!.status).toBe('skipped'); // the SUCCESS edge is unsatisfied by a failed loop
    expect(state.status).toBe('failure');
    expect(getRun(db, run.id)!.status).toBe('failure');
    // The alarm is spent, not left to re-fire.
    expect(listPendingWakeups(db).filter((w) => w.kind === KIND)).toHaveLength(0);
  });

  it("a TIMED-OUT run's log replays to the identical final state (event-sourcing invariant)", async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [gate('work')], [], [timedLoop('lp', ['work'], 30)]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock, resolveDoc } = harness(db, { nodes: { work: { hang: true } } }, () => t);

    await startRun(deps, run);
    t = NOW + 30_000;
    clock.tick();
    await settle();

    const live = getRunState(db, deps, run.id);
    const replayed = buildEngine(resolveDoc(pvId)).projectRunState(loadEngineEvents(db, run.id));
    expect(replayed).toEqual(live);
    expect(replayed.status).toBe('failure');
    expect(replayed.containers.lp).toMatchObject({ status: 'failure', reason: 'timeout' });
  });
});

describe('A17 — freshness: at-least-once + a stale-delivery check', () => {
  it('SUPPRESSES a timeout for a loop that already EXITED (the alarm outlived a clean run)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [gate('work')], [], [timedLoop('lp', ['work'], 30)]);
    const run = seedRun(db, pvId);
    let t = NOW;
    // `work` SUCCEEDS with done=true, so the loop exits round 0 while its timeout
    // alarm is already armed — the alarm outlives the loop.
    const { deps, clock } = harness(
      db,
      { nodes: { work: { outcome: 'success', outputs: { done: true } } } },
      () => t,
    );

    await startRun(deps, run);
    expect(getRun(db, run.id)!.status).toBe('success');
    expect(listPendingWakeups(db).filter((w) => w.kind === KIND)).toHaveLength(1);

    t = NOW + 30_000;
    clock.tick();
    await settle();

    // The timeout fired but suppressed: no container.timedOut, run stays green.
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('container.timedOut');
    expect(getRun(db, run.id)!.status).toBe('success');
    expect(listPendingWakeups(db).filter((w) => w.kind === KIND)).toHaveLength(0);
  });

  it('SUPPRESSES a timeout whose run does not exist (run_not_found)', async () => {
    const { db } = freshDb();
    const { clock } = harness(db);
    clock.arm({
      kind: KIND,
      ref: { runId: 'run_ghost', containerId: 'lp' },
      dueAt: NOW,
      discriminator: 'container-timeout-lp',
    });
    expect(listPendingWakeups(db)).toHaveLength(1);

    clock.tick();
    await settle();

    expect(listPendingWakeups(db)).toHaveLength(0);
    expect(loadEngineEvents(db, 'run_ghost')).toEqual([]);
  });

  it('SUPPRESSES rather than re-delivering forever when the pipeline version is gone', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [gate('work')], [], [timedLoop('lp', ['work'], 30)]);
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
      executor: makeStubExecutor({ nodes: { work: { hang: true } } }),
      alarms: {
        arm: (i) => clock.arm(i),
        find: (i) => getWakeupByKey(db, i.kind, buildDedupeKey(i)),
      },
      drives: createRunDrives(),
      now: () => t,
    };
    const clock: AlarmClock = createAlarmClock({
      db,
      handlers: [createContainerTimeoutAlarmHandler(deps)],
      now: () => t,
      log: silentLog(),
    });

    await startRun(deps, run);
    expect(listPendingWakeups(db).filter((w) => w.kind === KIND)).toHaveLength(1);

    deleted = true;
    t = NOW + 30_000;
    clock.tick();
    await settle();

    expect(listPendingWakeups(db).filter((w) => w.kind === KIND)).toHaveLength(0);
  });

  it('SUPPRESSES a timeout whose run was interrupted behind the alarm (#443 — the log is authoritative)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [gate('work')], [], [timedLoop('lp', ['work'], 30)]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, { nodes: { work: { hang: true } } }, () => t);
    await startRun(deps, run);
    t = NOW + 30_000;

    appendEngineEvent(db, { type: 'run.interrupted', runId: run.id, reason: 'drive_failed' });

    clock.tick();
    await settle();

    expect(listPendingWakeups(db).filter((w) => w.kind === KIND)).toHaveLength(0);
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('container.timedOut');
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
