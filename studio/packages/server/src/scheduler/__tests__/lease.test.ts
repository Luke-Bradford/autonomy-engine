import { describe, expect, it } from 'vitest';
import {
  buildDedupeKey,
  CATALOG_VERSION,
  type Edge,
  type NewPipelineVersion,
  type Node,
  type NodePolicy,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun, updateRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { getWakeupByKey, listPendingWakeups } from '../../repo/scheduled-wakeups.js';
import type { Db } from '../../repo/types.js';
import { LEASE_TTL_MS, startRun, type DocResolver, type DriveDeps } from '../../run/driver.js';
import { createRunDrives } from '../../run/drives.js';
import { loadEngineEvents } from '../../run/events.js';
import { makeStubExecutor, type StubExecutorOptions } from '../../run/__tests__/stub-executor.js';
import { createAlarmClock, type AlarmClock } from '../alarms.js';
import { createRetryAlarmHandler } from '../retry-alarm.js';
import { createWaitAlarmHandler } from '../wait-alarm.js';
import { createLeaseService, LEASE_WAKEUP_KIND, type LeaseService } from '../lease.js';
import { silentLog } from './testLog.js';

/**
 * #5 S7 — the run-lease service end to end, against the real DB, real alarm
 * rows, the real reducer and the real reconcile policy. Only the clock (`now`)
 * and the activity executor are stubbed — both production seams.
 *
 * The stub executor's `hang` plan is load-bearing here: it produces EXACTLY the
 * stranded state S7 exists to reclaim (a `node.dispatched` with no terminal
 * event, the run at rest `running` with NO live drive — the same state a lost
 * drive leaves behind).
 */

let seq = 0;
function node(id: string, policy?: NodePolicy): Node {
  seq += 1;
  return {
    id,
    // Uncatalogued on purpose (the `driver.test.ts` factory note): keeps the
    // output contract `absent` so the stub's payload is not failed by F13b.
    type: 'test_activity',
    config: {},
    position: { x: seq, y: 0 },
    ...(policy && { policy }),
  };
}

function waitNode(id: string, seconds: string): Node {
  seq += 1;
  return { id, type: 'wait', config: { seconds }, position: { x: seq, y: 0 } };
}

function edge(from: string, to: string): Edge {
  return { id: `${from}->${to}:success`, from, to, on: 'success' };
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

/** The production wiring in miniature (the `retry-alarm.test.ts` harness plus
 * the lease service): one drive registry shared by every entry point, a clock
 * whose handlers include `run_lease`, and a MUTABLE `now` so tests can walk
 * time past a lease. */
function harness(db: Db, executorOpts: StubExecutorOptions = {}) {
  const time = { t: NOW };
  const now = () => time.t;
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
  const lease: LeaseService = createLeaseService(deps);
  const clock: AlarmClock = createAlarmClock({
    db,
    handlers: [createRetryAlarmHandler(deps), createWaitAlarmHandler(deps), lease.handler],
    now,
    log: silentLog(),
  });
  return { deps, clock, drives, lease, time };
}

/** The single pending `run_lease` row, asserted to be alone in its kind. */
function pendingLeaseAlarms(db: Db) {
  return listPendingWakeups(db).filter((w) => w.kind === LEASE_WAKEUP_KIND);
}

describe('#5 S7 — the heartbeat sweep', () => {
  it('BRANCH 1: renews a live-drive run — heartbeat stamped, lease pushed out, alarm armed', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    updateRun(db, run.id, { status: 'running', leaseUntil: NOW + LEASE_TTL_MS });
    const { drives, lease, time } = harness(db);

    // A live drive, held open across the sweep.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const drive = drives.serialize(run.id, () => gate);

    time.t = NOW + 60_000;
    lease.sweep();

    const after = getRun(db, run.id)!;
    expect(after.heartbeatAt).toBe(NOW + 60_000);
    expect(after.leaseUntil).toBe(NOW + 60_000 + LEASE_TTL_MS);
    const alarms = pendingLeaseAlarms(db);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.dueAt).toBe(NOW + 60_000 + LEASE_TTL_MS);

    release();
    await drive;
    await drives.whenIdle();
  });

  it('BRANCH 1: a second renewal SUPERSEDES the previous generation (cancelled + supersededBy)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    updateRun(db, run.id, { status: 'running', leaseUntil: NOW + LEASE_TTL_MS });
    const { drives, lease, time } = harness(db);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const drive = drives.serialize(run.id, () => gate);

    time.t = NOW + 60_000;
    lease.sweep();
    const first = pendingLeaseAlarms(db)[0]!;

    time.t = NOW + 120_000;
    lease.sweep();

    // "Heartbeats supersede old alarms": exactly one pending generation, the
    // old one cancelled with provenance to its replacement.
    const pending = pendingLeaseAlarms(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.dueAt).toBe(NOW + 120_000 + LEASE_TTL_MS);
    const firstAfter = getWakeupByKey(db, LEASE_WAKEUP_KIND, first.dedupeKey)!;
    expect(firstAfter.status).toBe('cancelled');
    expect(firstAfter.supersededBy).toBe(pending[0]!.id);

    release();
    await drive;
    await drives.whenIdle();
  });

  it('BRANCH 2: arms the missing alarm for a no-drive run whose lease is still live', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    // The drive-dropped-before-first-sweep window: lease granted on entry to
    // `running` (S4's stamp), no alarm armed yet, and no drive left to renew.
    updateRun(db, run.id, { status: 'running', leaseUntil: NOW + LEASE_TTL_MS });
    const { lease, time } = harness(db);

    time.t = NOW + 60_000;
    lease.sweep();

    const alarms = pendingLeaseAlarms(db);
    expect(alarms).toHaveLength(1);
    // Armed AT the existing lease — the sweep watches the grant, never extends
    // it for a run nothing is executing.
    expect(alarms[0]!.dueAt).toBe(NOW + LEASE_TTL_MS);
    // No heartbeat: heartbeatAt is live-drive evidence and there is no drive.
    expect(getRun(db, run.id)!.heartbeatAt).toBeNull();

    // Idempotent: a second sweep finds the pending alarm and does nothing.
    time.t = NOW + 120_000;
    lease.sweep();
    expect(pendingLeaseAlarms(db)).toHaveLength(1);
  });

  it('BRANCH 3: bumps the generation for a no-drive EXPIRED lease and arms it immediately due', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    updateRun(db, run.id, { status: 'running', leaseUntil: NOW - 1_000 });
    const { lease, time } = harness(db);

    time.t = NOW;
    lease.sweep();

    // The lost-reclaim self-heal: a fresh, strictly-later generation, due now.
    expect(getRun(db, run.id)!.leaseUntil).toBe(NOW);
    const alarms = pendingLeaseAlarms(db);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.dueAt).toBe(NOW);
    expect(alarms[0]!.ref).toEqual({ runId: run.id, leaseUntil: String(NOW) });
  });

  it('BRANCH 3: a running row that never got a lease (null) is granted one and watched', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    updateRun(db, run.id, { status: 'running' });
    expect(getRun(db, run.id)!.leaseUntil).toBeNull();
    const { lease } = harness(db);

    lease.sweep();

    expect(getRun(db, run.id)!.leaseUntil).toBe(NOW);
    expect(pendingLeaseAlarms(db)).toHaveLength(1);
  });

  it('ignores non-running rows entirely', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    // `pending` (pre-start) and terminal rows are out of lease scope.
    const { lease } = harness(db);
    lease.sweep();
    expect(pendingLeaseAlarms(db)).toHaveLength(0);
    expect(getRun(db, run.id)!.leaseUntil).toBeNull();
  });

  it('ONE bad row cannot stall the heartbeat for the others (per-run isolation)', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const runA = seedRun(db, pvId);
    const runB = seedRun(db, pvId);
    updateRun(db, runA.id, { status: 'running', leaseUntil: NOW - 1_000 });
    updateRun(db, runB.id, { status: 'running', leaseUntil: NOW - 1_000 });
    const { deps, lease } = harness(db);

    // Poison the FIRST sweepOne's registry read; the second must still run.
    const real = deps.drives.activeRunIds.bind(deps.drives);
    let calls = 0;
    deps.drives.activeRunIds = () => {
      calls += 1;
      if (calls === 1) throw new Error('injected registry fault');
      return real();
    };

    lease.sweep();

    // Exactly one of the two rows got its bump — the fault degraded THAT run
    // only, and the next sweep will heal it.
    expect(pendingLeaseAlarms(db)).toHaveLength(1);
  });
});

describe('#5 S7 — the run_lease handler (freshness verdicts)', () => {
  function armLease(clock: AlarmClock, runId: string, leaseUntil: number) {
    return clock.arm({
      kind: LEASE_WAKEUP_KIND,
      ref: { runId, leaseUntil: String(leaseUntil) },
      dueAt: leaseUntil,
      discriminator: `lease-${leaseUntil}`,
    });
  }

  it('suppresses run_not_found / not_running / lease_renewed instead of reclaiming', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const gone = 'run_gone'; // no such row
    const terminal = seedRun(db, pvId);
    updateRun(db, terminal.id, { status: 'success' });
    const renewed = seedRun(db, pvId);
    // The GENERATION TOKEN check: the row's lease moved (a heartbeat or a
    // park→resume re-stamp) — the old generation's alarm must stand down.
    updateRun(db, renewed.id, { status: 'running', leaseUntil: NOW + 999_000 });
    const { clock, time } = harness(db);

    const a = armLease(clock, gone, NOW - 3_000);
    const b = armLease(clock, terminal.id, NOW - 2_000);
    const c = armLease(clock, renewed.id, NOW - 1_000);

    time.t = NOW;
    clock.tick();

    expect(getWakeupByKey(db, LEASE_WAKEUP_KIND, a.dedupeKey)!.status).toBe('suppressed');
    expect(getWakeupByKey(db, LEASE_WAKEUP_KIND, b.dedupeKey)!.status).toBe('suppressed');
    expect(getWakeupByKey(db, LEASE_WAKEUP_KIND, c.dedupeKey)!.status).toBe('suppressed');
    // Nothing was reclaimed: the renewed run is untouched and still running.
    expect(getRun(db, renewed.id)!.status).toBe('running');
  });

  it('suppresses drive_live — NEVER reclaims under a live drive, even with an expired matching lease', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    updateRun(db, run.id, { status: 'running', leaseUntil: NOW - 1_000 });
    const { clock, drives, time } = harness(db);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const drive = drives.serialize(run.id, () => gate);

    const alarm = armLease(clock, run.id, NOW - 1_000);
    time.t = NOW;
    clock.tick();

    expect(getWakeupByKey(db, LEASE_WAKEUP_KIND, alarm.dedupeKey)!.status).toBe('suppressed');
    expect(getRun(db, run.id)!.status).toBe('running');

    release();
    await drive;
    await drives.whenIdle();
  });
});

describe('#5 S7 — the reclaim (reconcile policy under the drive lock)', () => {
  it('RESUMES a stranded run whose in-flight node was provably idempotent', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    // `hang` = dispatched, no terminal event: the stranded state a lost drive
    // leaves. Idempotent → safe to re-run under a new attempt.
    const plan = { outcome: 'success' as const, idempotent: true, hang: true };
    const { deps, clock, drives, lease, time } = harness(db, { nodes: { a: plan } });

    await startRun(deps, run);
    await drives.whenIdle();
    expect(getRun(db, run.id)!.status).toBe('running');
    // S4's entry stamp exists but reads the WALL clock (like `finishedAt` in
    // `syncRunLifecycle`), while this harness's clock is frozen at NOW — so
    // re-pin the grant to the harness timeline before walking time past it.
    expect(getRun(db, run.id)!.leaseUntil).not.toBeNull();
    updateRun(db, run.id, { leaseUntil: NOW + LEASE_TTL_MS });

    // The sweep (no drive, lease live) arms the watch...
    time.t = NOW + 60_000;
    lease.sweep();
    expect(pendingLeaseAlarms(db)).toHaveLength(1);

    // ...the lease expires with no renewal, the alarm fires, the reclaim runs
    // the boot policy under the lock — and this time the node completes.
    plan.hang = false;
    time.t = NOW + LEASE_TTL_MS;
    clock.tick();
    await drives.whenIdle();

    const after = getRun(db, run.id)!;
    expect(after.status).toBe('success');
    const events = loadEngineEvents(db, run.id);
    expect(events.some((e) => e.type === 'run.resumed' && e.reason === 'lease_reclaim')).toBe(true);
    expect(
      events.some((e) => e.type === 'node.retryRequested' && e.reason === 'lease_reclaim'),
    ).toBe(true);
    // Terminal → the lease is released (S4's projection).
    expect(after.leaseUntil).toBeNull();
  });

  it('INTERRUPTS a stranded run whose in-flight node was NOT provably idempotent', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    const { deps, clock, drives, lease, time } = harness(db, {
      nodes: { a: { idempotent: false, hang: true } },
    });

    await startRun(deps, run);
    await drives.whenIdle();
    // Re-pin the wall-clock S4 grant to the harness timeline (see above).
    updateRun(db, run.id, { leaseUntil: NOW + LEASE_TTL_MS });

    time.t = NOW + 60_000;
    lease.sweep();
    time.t = NOW + LEASE_TTL_MS;
    clock.tick();
    await drives.whenIdle();

    const after = getRun(db, run.id)!;
    expect(after.status).toBe('interrupted');
    expect(after.leaseUntil).toBeNull();
    const events = loadEngineEvents(db, run.id);
    const interrupted = events.find((e) => e.type === 'run.interrupted');
    expect(interrupted).toMatchObject({ reason: 'non_idempotent_in_flight:a' });
  });

  it('RENEWS a held run (alive on its own retry alarm) instead of reclaiming — no churn, no interrupt', async () => {
    const { db } = freshDb();
    // A transient failure with a LONG retry interval: the node holds
    // `retry_pending` on a durable retry alarm that is nowhere near due when
    // the lease expires.
    const pvId = seedVersion(db, [node('a', { retry: 1, retryIntervalSeconds: 3600 })]);
    const run = seedRun(db, pvId);
    const { deps, clock, drives, lease, time } = harness(db, {
      nodes: { a: { outcome: 'failure', kind: 'transient' } },
    });

    await startRun(deps, run);
    await drives.whenIdle();
    expect(getRun(db, run.id)!.status).toBe('running');
    // Re-pin the wall-clock S4 grant to the harness timeline (see above).
    updateRun(db, run.id, { leaseUntil: NOW + LEASE_TTL_MS });

    time.t = NOW + 60_000;
    lease.sweep();
    const logBefore = loadEngineEvents(db, run.id).length;

    time.t = NOW + LEASE_TTL_MS;
    clock.tick();
    await drives.whenIdle();

    const after = getRun(db, run.id)!;
    // Untouched and alive: still running, still held, retry alarm still pending.
    expect(after.status).toBe('running');
    expect(loadEngineEvents(db, run.id)).toHaveLength(logBefore);
    // The liveness-check chain: lease renewed + the NEXT generation armed.
    expect(after.leaseUntil).toBe(NOW + LEASE_TTL_MS + LEASE_TTL_MS);
    const alarms = pendingLeaseAlarms(db);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.dueAt).toBe(NOW + LEASE_TTL_MS + LEASE_TTL_MS);
    // heartbeatAt untouched: it is live-drive evidence, and a held run has none.
    expect(after.heartbeatAt).toBeNull();
    // The retry alarm survives untouched, still pending for its own due time.
    expect(listPendingWakeups(db).filter((w) => w.kind === 'node_retry')).toHaveLength(1);
  });

  it('the sweep does not heartbeat a run whose RECLAIM is in flight (registration ≠ drive)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    const plan = {
      outcome: 'success' as const,
      idempotent: true,
      hang: true,
      delayMs: 50,
    };
    const { deps, clock, drives, lease, time } = harness(db, { nodes: { a: plan } });

    await startRun(deps, run);
    await drives.whenIdle();
    // Re-pin the wall-clock S4 grant to the harness timeline (see above).
    updateRun(db, run.id, { leaseUntil: NOW + LEASE_TTL_MS });

    time.t = NOW + 60_000;
    lease.sweep();
    plan.hang = false;
    time.t = NOW + LEASE_TTL_MS;
    // Fire the reclaim; its re-dispatched node stays in flight for `delayMs`,
    // so the reclaim's registration is live when the next sweep runs.
    clock.tick();
    lease.sweep();

    // The sweep SKIPPED the run: no heartbeat stamped off the reclaim's own
    // `serialize` registration (heartbeatAt stays live-drive-only evidence).
    expect(getRun(db, run.id)!.heartbeatAt).toBeNull();

    await drives.whenIdle();
    expect(getRun(db, run.id)!.status).toBe('success');
  });
});

describe('#5 S7 — the reclaim guard + generation token, end to end', () => {
  it("ABORTS when the run's state moved between the fire and lock acquisition (the under-lock guard)", async () => {
    // The guard's abort path is not reachable from a natural fixture — an
    // uncontended `serialize` starts the reclaim's work in the same frame as
    // the fire — so this queues the reclaim behind a HELD drive (exactly the
    // production shape: a drive registered between commit and lock grant) and
    // settles the run before releasing it. See `LeaseService.reclaim`'s doc.
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    updateRun(db, run.id, { status: 'running', leaseUntil: NOW - 1_000 });
    const { drives, lease } = harness(db);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const drive = drives.serialize(run.id, () => gate);

    const reclaiming = lease.reclaim(run.id);
    // The run terminalizes while the reclaim waits its turn.
    updateRun(db, run.id, { status: 'success', leaseUntil: null, finishedAt: NOW });
    release();
    await drive;
    await reclaiming;

    // The guard aborted: no reconcile events were appended to a settled run.
    expect(loadEngineEvents(db, run.id)).toHaveLength(0);
    expect(getRun(db, run.id)!.status).toBe('success');
  });

  it('the handler suppresses reclaim_in_flight while a reclaim already owns the run', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    updateRun(db, run.id, { status: 'running', leaseUntil: NOW - 1_000 });
    const { clock, drives, lease, time } = harness(db);

    // Hold the drive lock so the spawned reclaim stays queued (= in flight).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const drive = drives.serialize(run.id, () => gate);
    const reclaiming = lease.reclaim(run.id);

    // A sibling generation's alarm (token matches the row) comes due: it must
    // stand down rather than spawn a SECOND reclaim.
    const alarm = clock.arm({
      kind: LEASE_WAKEUP_KIND,
      ref: { runId: run.id, leaseUntil: String(NOW - 1_000) },
      dueAt: NOW - 1_000,
      discriminator: `lease-${NOW - 1_000}`,
    });
    time.t = NOW;
    clock.tick();
    expect(getWakeupByKey(db, LEASE_WAKEUP_KIND, alarm.dedupeKey)!.status).toBe('suppressed');

    release();
    await drive;
    await reclaiming;
    await drives.whenIdle();
  });

  it('lease_renewed END TO END: a pre-park alarm stands down after park → resume re-stamps the lease', async () => {
    // The REACHABLE stale-token path (planning-gate amendment 1): parking
    // releases the lease; resuming (waiting→running, a real status change)
    // stamps a FRESH one via `syncRunLifecycle` — so the pre-park generation's
    // alarm must suppress, not reclaim the healthy resumed run.
    const { db } = freshDb();
    const preParkLease = NOW + LEASE_TTL_MS;
    // wait(5s) → then a node that HANGS, so the resumed run comes to rest still
    // `running` (a terminal run would suppress as not_running, proving nothing
    // about the token).
    const pvId = seedVersion(db, [waitNode('w', '${5}'), node('b')], [edge('w', 'b')]);
    const run = seedRun(db, pvId);
    const { deps, clock, drives, time } = harness(db, {
      nodes: { b: { idempotent: true, hang: true } },
    });

    await startRun(deps, run);
    await drives.whenIdle();
    expect(getRun(db, run.id)!.status).toBe('waiting');
    // The alarm the sweep would have armed during the pre-park running stint.
    const preParkAlarm = clock.arm({
      kind: LEASE_WAKEUP_KIND,
      ref: { runId: run.id, leaseUntil: String(preParkLease) },
      dueAt: preParkLease,
      discriminator: `lease-${preParkLease}`,
    });

    // The wait comes due: the run resumes (waiting → running re-stamps the
    // lease — pinned in sync-run-lifecycle-lease.test.ts) and rests on the
    // hung node.
    time.t = NOW + 5_000;
    clock.tick();
    await drives.whenIdle();
    const resumed = getRun(db, run.id)!;
    expect(resumed.status).toBe('running');
    expect(resumed.leaseUntil).not.toBe(preParkLease);

    // The pre-park generation comes due: token mismatch → stands down; the
    // healthy resumed run is untouched.
    time.t = preParkLease;
    const logBefore = loadEngineEvents(db, run.id).length;
    clock.tick();
    await drives.whenIdle();

    expect(getWakeupByKey(db, LEASE_WAKEUP_KIND, preParkAlarm.dedupeKey)!.status).toBe(
      'suppressed',
    );
    expect(getRun(db, run.id)!.status).toBe('running');
    expect(loadEngineEvents(db, run.id)).toHaveLength(logBefore);
  });
});

describe('#646 — corruption cannot silence or churn the lease service', () => {
  it('the sweep survives a corrupt running row — the healthy run still gets its liveness watch', async () => {
    const { db, sqlite } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const healthy = seedRun(db, pvId);
    const bad = seedRun(db, pvId);
    const { deps, drives, lease, time } = harness(db, {
      nodes: { a: { hang: true, idempotent: true } },
    });

    await startRun(deps, healthy);
    await drives.whenIdle();
    updateRun(db, healthy.id, { leaseUntil: NOW + LEASE_TTL_MS });
    updateRun(db, bad.id, { status: 'running' });
    // Pre-#646 the strict whole-list scan threw on this one cell and the catch
    // swallowed the ENTIRE sweep — no live run was watched while it existed.
    sqlite.prepare('UPDATE runs SET params = ? WHERE id = ?').run('not json', bad.id);

    time.t = NOW + 60_000;
    lease.sweep();

    // The healthy run's liveness alarm was still armed.
    expect(pendingLeaseAlarms(db)).toHaveLength(1);
  });

  it('a corrupt-LOG run RENEWS its lease on reclaim instead of poison-churning every sweep', async () => {
    const { db, sqlite } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    const { deps, clock, drives, lease, time } = harness(db, {
      nodes: { a: { hang: true, idempotent: true } },
    });

    await startRun(deps, run);
    await drives.whenIdle();
    updateRun(db, run.id, { leaseUntil: NOW + LEASE_TTL_MS });
    // Poison appended row (the log's UPDATE is trigger-blocked — #642 precedent).
    sqlite
      .prepare(
        'INSERT INTO run_events (id, run_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('evt_poison', run.id, 999, 'x', 'not json', NOW);

    time.t = NOW + 60_000;
    lease.sweep();
    expect(pendingLeaseAlarms(db)).toHaveLength(1);

    // Lease expires → alarm fires → reclaim → reconcileOne throws the TYPED
    // corruption error → the catch renews rather than leaving the lease
    // expired for the next sweep to re-bump (one wakeup row + one error log
    // per interval, forever — the churn this branch closes).
    time.t = NOW + LEASE_TTL_MS;
    clock.tick();
    await drives.whenIdle();
    // The renew happens in reclaim's catch, after its serialized section
    // rejects — flush the microtask/timer chain before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const after = getRun(db, run.id)!;
    expect(after.status).toBe('running'); // repairable, deliberately not terminalized
    // Renewed a full TTL out from the reclaim, and the next-generation watch armed.
    expect(after.leaseUntil).toBe(NOW + LEASE_TTL_MS + LEASE_TTL_MS);
    expect(pendingLeaseAlarms(db)).toHaveLength(1);
  });
});

describe('#646 — the bespoke lease handler suppresses a corrupt run row (no 1 Hz poison loop)', () => {
  it('a due lease alarm for a corrupt row settles `suppressed` instead of re-firing every tick', async () => {
    const { db, sqlite } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    const { deps, clock, drives, lease, time } = harness(db, {
      nodes: { a: { hang: true, idempotent: true } },
    });

    await startRun(deps, run);
    await drives.whenIdle();
    updateRun(db, run.id, { leaseUntil: NOW + LEASE_TTL_MS });
    // Arm the liveness watch while the row is still healthy (the module
    // invariant: every running row holds a pending run_lease alarm)...
    time.t = NOW + 60_000;
    lease.sweep();
    expect(pendingLeaseAlarms(db)).toHaveLength(1);
    // ...then the row goes corrupt (the surface-3 row boot now lets survive).
    sqlite.prepare('UPDATE runs SET params = ? WHERE id = ?').run('not json', run.id);

    // The alarm comes due: `getRun` inside the fire throws the codec
    // SyntaxError. Pre-#646 that rolled back the settle — the alarm stayed
    // pending and re-fired on EVERY 1s tick, forever. Now: suppressed.
    time.t = NOW + LEASE_TTL_MS;
    clock.tick();
    expect(pendingLeaseAlarms(db)).toHaveLength(0);
    const settled = sqlite
      .prepare("SELECT status FROM scheduled_wakeups WHERE kind = 'run_lease'")
      .all() as Array<{ status: string }>;
    expect(settled).toEqual([{ status: 'suppressed' }]);

    // And the next tick has nothing to spin on.
    clock.tick();
    expect(pendingLeaseAlarms(db)).toHaveLength(0);
  });
});
