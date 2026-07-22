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
import {
  getExternalWaitByTokenHash,
  listPendingExternalWaitsByRun,
} from '../../repo/external-waits.js';
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
import { makeStubExecutor, type StubExecutorOptions } from '../../run/__tests__/stub-executor.js';
import {
  deriveExternalWaitToken,
  hashExternalWaitToken,
} from '../../webhooks/external-wait-token.js';
import { createAlarmClock, type AlarmClock } from '../alarms.js';
import { createExternalWaitAlarmHandler } from '../external-wait-alarm.js';
import { silentLog } from './testLog.js';

/**
 * #4 A13 — the DRIVER + CLOCK half of the durable `webhook` external wait, against a
 * real DB, real transactions, real alarm + correlation rows and the real reducer.
 * The near-verbatim twin of `wait-alarm.test.ts`: the pure park→resume/expire state
 * machine is pinned in the engine's `webhook-routing.test.ts`; what is under test
 * HERE is arming the expiry alarm + recording the correlation row, the
 * arm-before-append ordering, the freshness re-check, and the EXPIRY path closing
 * (a parked webhook ending in a failed node + red run). The COMPLETION path (an
 * inbound callback) is covered by `routes/__tests__/external-wait.test.ts`.
 */

const KIND = 'node_external_wait';
const MASTER_KEY = new Uint8Array(32).fill(7);
const sign = (args: { runId: string; nodeId: string; attemptId: string }) =>
  deriveExternalWaitToken(MASTER_KEY, args);

let seq = 0;
function webhookNode(id: string, timeoutSeconds: string): Node {
  seq += 1;
  return { id, type: 'webhook', config: { timeoutSeconds }, position: { x: seq, y: 0 } };
}
function activity(id: string): Node {
  seq += 1;
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

function harness(db: Db, executorOpts: StubExecutorOptions = {}, now: () => number = () => NOW) {
  const resolveDoc: DocResolver = (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
  const deps: DriveDeps = {
    db,
    resolveDoc,
    executor: makeStubExecutor(executorOpts),
    alarms: {
      arm: (input) => clock.arm(input),
      find: (input) => getWakeupByKey(db, input.kind, buildDedupeKey(input)),
    },
    drives: createRunDrives(),
    now,
    signExternalWaitToken: sign,
  };
  const clock: AlarmClock = createAlarmClock({
    db,
    handlers: [createExternalWaitAlarmHandler(deps)],
    now,
    log: silentLog(),
  });
  return { deps, clock, resolveDoc };
}

describe('A13 — arming a webhook (the driver half)', () => {
  it('arms an expiry alarm, records a correlation row, and PARKS the node', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [webhookNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    const { deps } = harness(db);

    const state = await startRun(deps, run);

    expect(state.nodes.w!.status).toBe('external_wait_pending');
    // #5 S3 (#619) — the producer parked the whole run `waiting` (was `running`
    // before the producer), reason `waiting_external`.
    expect(state.status).toBe('waiting');
    expect(state.waitingReason).toBe('waiting_external');
    expect(getRun(db, run.id)!.status).toBe('waiting');
    expect(loadEngineEvents(db, run.id).find((e) => e.type === 'run.waiting')).toMatchObject({
      reason: 'waiting_external',
    });

    // The expiry alarm.
    const pending = listPendingWakeups(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: KIND,
      ref: { runId: run.id, nodeId: 'w', attemptId: 'w#0' },
      dueAt: NOW + 30_000,
    });

    // The correlation row: pending, expires at the alarm's dueAt, addressable by the
    // DERIVED token's hash (the raw token is never stored).
    const rows = listPendingExternalWaitsByRun(db, run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      nodeId: 'w',
      attemptId: 'w#0',
      status: 'pending',
      expiresAt: NOW + 30_000,
    });
    const token = sign({ runId: run.id, nodeId: 'w', attemptId: 'w#0' });
    expect(rows[0]!.tokenHash).toBe(hashExternalWaitToken(token));
    expect(rows[0]!.tokenHash).not.toBe(token); // stored the HASH, not the raw token

    // The durable created event carries dueAt but NOT the token.
    const created = loadEngineEvents(db, run.id).find((e) => e.type === 'externalWait.created');
    expect(created).toMatchObject({ nodeId: 'w', attemptId: 'w#0', dueAt: NOW + 30_000 });
    expect(JSON.stringify(created)).not.toContain(token);
  });

  it('ARMS + RECORDS before it appends — a crash between leaves a live alarm, not a hung run', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [webhookNode('w', '${30}')]);
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
      signExternalWaitToken: sign,
    };

    await expect(startRun(deps, run)).rejects.toThrow('arm exploded');
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('externalWait.created');
  });

  it('THROWS loudly (never hangs) when the token signer is not wired', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [webhookNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    const resolveDoc: DocResolver = (id) => getPipelineVersion(db, id)!;
    const deps: DriverDeps = {
      db,
      resolveDoc,
      executor: makeStubExecutor(),
      alarms: { arm: () => ({}) as never, find: () => null },
      now: () => NOW,
      // signExternalWaitToken deliberately absent.
    };
    await expect(startRun(deps, run)).rejects.toThrow(/signExternalWaitToken/);
  });

  it('a REPLAYED arm reuses the SAME row + token and keeps the ORIGINAL expiry', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [webhookNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps } = harness(db, {}, () => t);

    await startRun(deps, run);
    const first = listPendingExternalWaitsByRun(db, run.id);
    expect(first).toHaveLength(1);

    // Re-derive + re-record an hour later (a replayed command / crash-recovery
    // re-arm): the DETERMINISTIC token reproduces, so it upserts the SAME row.
    t = NOW + 3_600_000;
    const { recordExternalWait } = await import('../../repo/external-waits.js');
    const token = sign({ runId: run.id, nodeId: 'w', attemptId: 'w#0' });
    const rearmed = recordExternalWait(db, {
      runId: run.id,
      nodeId: 'w',
      attemptId: 'w#0',
      tokenHash: hashExternalWaitToken(token),
      expiresAt: t + 30_000,
      now: t,
    });
    expect(listPendingExternalWaitsByRun(db, run.id)).toHaveLength(1);
    expect(rearmed.id).toBe(first[0]!.id);
    expect(rearmed.expiresAt).toBe(first[0]!.expiresAt); // ORIGINAL expiry kept
  });
});

describe('A13 — the expiry alarm fires: the webhook FAILS', () => {
  it('fails the parked node and finishes the run RED when no callback arrives', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [webhookNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, {}, () => t);

    await startRun(deps, run);
    expect(getRunState(db, deps, run.id).nodes.w!.status).toBe('external_wait_pending');

    // Not due yet: the clock must not fire it early.
    clock.tick();
    await settle();
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('externalWait.expired');

    // Time passes; the expiry comes due.
    t = NOW + 30_000;
    clock.tick();
    await settle();

    const state = getRunState(db, deps, run.id);
    expect(state.nodes.w!.status).toBe('failure');
    expect(state.status).toBe('failure');
    expect(getRun(db, run.id)!.status).toBe('failure');
    // The correlation row settled to expired; the alarm is spent.
    expect(listPendingExternalWaitsByRun(db, run.id)).toHaveLength(0);
    expect(listPendingWakeups(db)).toHaveLength(0);
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).toContain('externalWait.expired');
  });

  it('routes the FAILURE edge on expiry (the timeout/default path)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [webhookNode('w', '${30}'), activity('onTimeout')],
      [{ id: 'w->onTimeout', from: 'w', to: 'onTimeout', on: 'failure' }],
    );
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, {}, () => t);

    await startRun(deps, run);
    t = NOW + 30_000;
    clock.tick();
    await settle();

    const state = getRunState(db, deps, run.id);
    expect(state.nodes.w!.status).toBe('failure');
    // The failure edge fired onTimeout, which succeeds → the run SUCCEEDS (handled).
    expect(state.nodes.onTimeout!.status).toBe('success');
    expect(state.status).toBe('success');
  });

  it("an EXPIRED run's log replays to the identical final state (event-sourcing invariant)", async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [webhookNode('w', '${30}')]);
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
    expect(replayed.status).toBe('failure');
  });
});

describe('A13 — freshness: at-least-once + stale-delivery checks', () => {
  it('SUPPRESSES an expiry whose run already finished (#443 — the log is authoritative)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [webhookNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, {}, () => t);
    await startRun(deps, run);
    t = NOW + 30_000;

    appendEngineEvent(db, { type: 'run.interrupted', runId: run.id, reason: 'drive_failed' });
    clock.tick();
    await settle();

    expect(listPendingWakeups(db)).toHaveLength(0);
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('externalWait.expired');
    // #580 — the orphan correlation row is SETTLED, not left `pending` forever. The
    // run went terminal while `w` was parked, so no callback can ever complete it and
    // no `externalWait.expired` is appended (the log is authoritative); the guarded
    // settle in the `run_already_terminal` branch still cleans the row up to `expired`.
    const orphan = getExternalWaitByTokenHash(
      db,
      hashExternalWaitToken(sign({ runId: run.id, nodeId: 'w', attemptId: 'w#0' })),
    );
    expect(orphan!.status).toBe('expired');
  });

  it('SUPPRESSES an expiry whose node already COMPLETED, never downgrading the row', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [webhookNode('w', '${30}')]);
    const run = seedRun(db, pvId);
    let t = NOW;
    const { deps, clock } = harness(db, {}, () => t);
    await startRun(deps, run);

    // The inbound callback completed the wait first (row → completed, node → success).
    const { markExternalWaitCompleted } = await import('../../repo/external-waits.js');
    markExternalWaitCompleted(db, { runId: run.id, nodeId: 'w', attemptId: 'w#0' }, NOW + 1);
    appendEngineEvent(db, {
      type: 'externalWait.completed',
      runId: run.id,
      nodeId: 'w',
      previousAttemptId: 'w#0',
    });

    // The still-armed expiry alarm now fires (the completed-then-timeout race).
    t = NOW + 30_000;
    clock.tick();
    await settle();

    // No externalWait.expired appended, and the row is STILL completed (not downgraded).
    expect(loadEngineEvents(db, run.id).map((e) => e.type)).not.toContain('externalWait.expired');
    const row = getExternalWaitByTokenHash(
      db,
      hashExternalWaitToken(sign({ runId: run.id, nodeId: 'w', attemptId: 'w#0' })),
    );
    expect(row!.status).toBe('completed');
    expect(listPendingWakeups(db)).toHaveLength(0);
  });

  it('SUPPRESSES an expiry whose run does not exist (run_not_found)', async () => {
    const { db } = freshDb();
    const { clock } = harness(db);
    clock.arm({
      kind: KIND,
      ref: { runId: 'run_ghost', nodeId: 'w', attemptId: 'w#0' },
      dueAt: NOW,
      discriminator: 'external-wait-w#0',
    });
    expect(listPendingWakeups(db)).toHaveLength(1);

    clock.tick();
    await settle();

    expect(listPendingWakeups(db)).toHaveLength(0);
    expect(loadEngineEvents(db, 'run_ghost')).toEqual([]);
  });
});

function getRunState(db: Db, deps: DriverDeps, runId: string) {
  const run = getRun(db, runId)!;
  const engine = buildEngine(deps.resolveDoc(run.pipelineVersionId));
  return engine.projectRunState(loadEngineEvents(db, runId));
}

const settle = () => new Promise((r) => setTimeout(r, 20));
