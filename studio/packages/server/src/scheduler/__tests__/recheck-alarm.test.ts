import { describe, expect, it } from 'vitest';
import {
  buildDedupeKey,
  CATALOG_VERSION,
  type EngineEvent,
  type NewPipelineVersion,
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
  type Executor,
} from '../../run/driver.js';
import { createRunDrives } from '../../run/drives.js';
import { loadEngineEvents } from '../../run/events.js';
import { createAlarmClock, type AlarmClock } from '../alarms.js';
import { createRecheckAlarmHandler } from '../recheck-alarm.js';
import { silentLog } from './testLog.js';
import { STUB_SAVE_CATALOG } from '../../__tests__/stub-catalog.js';

/**
 * #1600 OR41 C8d — the Wait until re-check, end to end through the driver and
 * the alarm clock: a not-ready check parks the run on a `node_recheck` alarm,
 * the alarm re-dispatches it, and the deadline fails it.
 */

const NOW = 1_700_000_000_000;

function seed(db: Db) {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [{ id: 'g', type: 'test_activity', config: {}, position: { x: 0, y: 0 } }],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  const pvId = createPipelineVersion(db, input, { catalog: STUB_SAVE_CATALOG }).id;
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId: pvId,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
}

/** An executor whose check holds only once `ready()` says so. */
function checker(ready: () => boolean): Executor & { checks: string[] } {
  const checks: string[] = [];
  return {
    checks,
    async *perform(command, runId): AsyncGenerator<EngineEvent> {
      if (command.type !== 'dispatchNode') return;
      const { nodeId, attemptId } = command;
      checks.push(attemptId);
      yield { type: 'node.dispatched', runId, nodeId, attemptId, idempotent: true };
      yield ready()
        ? { type: 'node.succeeded', runId, nodeId, attemptId, outputs: {} }
        : {
            type: 'node.notReady',
            runId,
            nodeId,
            attemptId,
            reason: "'in/a.csv' does not exist yet",
            recheckAfterSeconds: 10,
            giveUpAfterSeconds: 25,
          };
    },
  };
}

function harness(db: Db, executor: Executor, now: () => number) {
  const resolveDoc: DocResolver = (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
  const deps: DriveDeps = {
    db,
    resolveDoc,
    executor,
    alarms: {
      arm: (input) => clock.arm(input),
      find: (input) => getWakeupByKey(db, input.kind, buildDedupeKey(input)),
    },
    drives: createRunDrives(),
    now,
  };
  const clock: AlarmClock = createAlarmClock({
    db,
    handlers: [createRecheckAlarmHandler(deps)],
    now,
    log: silentLog(),
  });
  return { deps, clock };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
function stateOf(db: Db, deps: DriveDeps, runId: string) {
  const run = getRun(db, runId)!;
  return buildEngine(deps.resolveDoc(run.pipelineVersionId)).projectRunState(
    loadEngineEvents(db, runId),
  );
}

describe('#1600 C8d — the re-check alarm', () => {
  it('parks the run on an alarm, re-checks when it is due, and succeeds once it holds', async () => {
    const { db } = freshDb();
    const run = seed(db);
    let t = NOW;
    let present = false;
    const exec = checker(() => present);
    const { deps, clock } = harness(db, exec, () => t);

    const state = await startRun(deps, run);
    expect(state.nodes.g!.status).toBe('wait_pending');
    expect(getRun(db, run.id)!.status).toBe('waiting');
    expect(listPendingWakeups(db)).toEqual([
      expect.objectContaining({
        kind: 'node_recheck',
        ref: { runId: run.id, nodeId: 'g', attemptId: 'g#0' },
        dueAt: NOW + 10_000,
      }),
    ]);
    expect(
      loadEngineEvents(db, run.id).find((e) => e.type === 'node.recheckScheduled'),
    ).toMatchObject({
      nextCheckAt: NOW + 10_000,
      giveUpAt: NOW + 25_000,
    });

    // Not due: nothing runs.
    clock.tick();
    await settle();
    expect(exec.checks).toEqual(['g#0']);

    // Due, still missing: a second check, parked again with the SAME deadline.
    t = NOW + 10_000;
    clock.tick();
    await settle();
    expect(exec.checks).toEqual(['g#0', 'g#1']);
    expect(getRun(db, run.id)!.status).toBe('waiting');
    expect(stateOf(db, deps, run.id).nodes.g!.recheck?.giveUpAt).toBe(NOW + 25_000);

    present = true;
    t = NOW + 20_000;
    clock.tick();
    await settle();
    expect(exec.checks).toEqual(['g#0', 'g#1', 'g#2']);
    expect(getRun(db, run.id)!.status).toBe('success');
    expect(stateOf(db, deps, run.id).nodes.g).toMatchObject({ status: 'success', retries: 0 });
  });

  it('runs the last check at the deadline, then fails wait_until_timeout', async () => {
    const { db } = freshDb();
    const run = seed(db);
    let t = NOW;
    const exec = checker(() => false);
    const { deps, clock } = harness(db, exec, () => t);
    await startRun(deps, run);

    for (const at of [10_000, 20_000]) {
      t = NOW + at;
      clock.tick();
      await settle();
    }
    // The third alarm is clamped to the deadline (NOW + 25s), not NOW + 30s.
    expect(listPendingWakeups(db)).toEqual([expect.objectContaining({ dueAt: NOW + 25_000 })]);
    t = NOW + 25_000;
    clock.tick();
    await settle();

    expect(exec.checks).toEqual(['g#0', 'g#1', 'g#2', 'g#3']);
    expect(getRun(db, run.id)!.status).toBe('failure');
    expect(loadEngineEvents(db, run.id).at(-2)).toMatchObject({
      type: 'node.failed',
      attemptId: 'g#3',
      kind: 'permanent',
      code: 'wait_until_timeout',
      error: "Wait until gave up after 25s: 'in/a.csv' does not exist yet",
    });
    expect(listPendingWakeups(db)).toEqual([]);
  });
});
