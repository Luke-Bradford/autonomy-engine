import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_VERSION,
  SubstituteError,
  type NewPipelineVersion,
  type Node,
  type RunWindow,
  type Trigger,
  type TriggerMode,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createTrigger, updateTrigger } from '../../repo/triggers.js';
import { triggers } from '../../db/schema.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { armWakeup, getWakeup, listPendingWakeups } from '../../repo/scheduled-wakeups.js';
import { listRuns } from '../../repo/runs.js';
import type { Db } from '../../repo/types.js';
import {
  createRunLauncher,
  UnboundTriggerError,
  type FireContext,
  type FireResult,
} from '../../run/launcher.js';
import { type DocResolver, type DriveDeps } from '../../run/driver.js';
import { createRunDrives } from '../../run/drives.js';
import { makeStubExecutor } from '../../run/__tests__/stub-executor.js';
import { stubAlarms } from '../../run/__tests__/stub-alarms.js';
import { createAlarmClock } from '../alarms.js';
import {
  createScheduleTickHandler,
  SCHEDULE_TICK_KIND,
  type ScheduleTickLauncher,
} from '../schedule-tick.js';
import { silentLog } from './testLog.js';

/**
 * #5 S5 — the `schedule_tick` alarm handler, against a real DB, the real alarm
 * clock, real transactions and real `scheduled_wakeups` rows. Nothing mocked but
 * the clock (`now`) and the launcher (a run-spawning seam the handler must reach
 * only via `afterCommit`).
 *
 * `nextOccurrence` (the pure calculator) is pinned in `recurrence.test.ts`. What
 * is under test HERE is everything durable: the in-tx re-arm that continues the
 * schedule chain, the freshness suppressions (disabled / unbound / edited /
 * out-of-window / invalid), and ≤1-late/no-backfill catch-up on boot.
 */

const NOON = Date.parse('2026-07-15T12:00:00.000Z');
const NEXT_MINUTE = Date.parse('2026-07-15T12:01:00.000Z');

function seedVersion(db: Db): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  // Uncatalogued on purpose (as launcher/retry tests do): keeps the output
  // contract `absent` so the stub executor's `{}` payload is not failed against a
  // catalog contract F13b/#456 would lower into a known type.
  const node: Node = { id: 'a', type: 'test_activity', config: {}, position: { x: 0, y: 0 } };
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [node],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input).id;
}

function seedTrigger(
  db: Db,
  opts: {
    pipelineVersionId: string | null;
    mode?: TriggerMode;
    schedule?: string | null;
    enabled?: boolean;
    runWindows?: RunWindow[] | null;
  },
): Trigger {
  return createTrigger(db, {
    ownerId: 'local',
    name: 'T',
    pipelineVersionId: opts.pipelineVersionId,
    params: {},
    mode: opts.mode ?? 'schedule',
    schedule: opts.schedule === undefined ? '* * * * *' : opts.schedule,
    webhook: null,
    concurrency: { policy: 'skip_if_running' },
    runWindows: opts.runWindows ?? null,
    enabled: opts.enabled ?? true,
  });
}

/** A launcher test double that records every fire (trigger + fire-time context). */
function fakeLauncher(): ScheduleTickLauncher & {
  fires: Trigger[];
  contexts: (FireContext | undefined)[];
} {
  const fires: Trigger[] = [];
  const contexts: (FireContext | undefined)[] = [];
  return {
    fires,
    contexts,
    fire: vi.fn((t: Trigger, fc?: FireContext): FireResult => {
      fires.push(t);
      contexts.push(fc);
      return { outcome: 'started', runId: `run-${t.id}` };
    }),
  };
}

/** Build a clock with only the schedule-tick handler; return the clock + launcher double. */
function harness(db: Db, now: () => number, launcher: ScheduleTickLauncher = fakeLauncher()) {
  const handler = createScheduleTickHandler({ launcher, log: silentLog() });
  const clock = createAlarmClock({ db, handlers: [handler], log: silentLog(), now });
  return { clock, launcher, handler };
}

/** Arm a schedule_tick for `trigger` due at `dueAt`, as sync()/a prior tick would. */
function armTick(db: Db, trigger: Trigger, dueAt: number) {
  return armWakeup(db, {
    kind: SCHEDULE_TICK_KIND,
    ref: { triggerId: trigger.id, schedule: trigger.schedule as string },
    dueAt,
    discriminator: `tick-${dueAt}`,
  });
}

function pendingTicks(db: Db) {
  return listPendingWakeups(db).filter((w) => w.kind === SCHEDULE_TICK_KIND);
}

describe('schedule_tick handler — fire + continue the chain', () => {
  it('fires the launcher and arms the NEXT occurrence, in one durable step', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pv, schedule: '* * * * *' });
    const noonRow = armTick(db, trigger, NOON);

    const { clock, launcher } = harness(db, () => NOON);
    clock.tick();

    // The launcher fired exactly once, with this trigger (afterCommit, not in-tx).
    expect((launcher as ReturnType<typeof fakeLauncher>).fires.map((t) => t.id)).toEqual([
      trigger.id,
    ]);
    // #5 S12 — the fire carries the INTENDED occurrence (the row's dueAt = NOON)
    // as `scheduledTime`, so `${trigger.scheduledTime}` reads the slot it fired
    // for (immune to any lateness in actual delivery).
    expect((launcher as ReturnType<typeof fakeLauncher>).contexts).toEqual([
      { scheduledTime: new Date(NOON).toISOString() },
    ]);

    // The chain advanced: the NOON row is settled `fired`; a single pending row
    // remains, for the next minute (12:01), armed inside the same fire.
    expect(getWakeup(db, noonRow.id)?.status).toBe('fired');
    const pending = pendingTicks(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dueAt).toBe(NEXT_MINUTE);
    expect(pending[0]?.ref).toEqual({ triggerId: trigger.id, schedule: '* * * * *' });
  });

  it('does NOT double-fire on at-least-once redelivery of the same row', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pv, schedule: '* * * * *' });
    armTick(db, trigger, NOON);

    const { clock, launcher } = harness(db, () => NOON);
    clock.tick();
    clock.tick(); // the settled row is no longer pending → nothing to re-deliver.

    expect((launcher as ReturnType<typeof fakeLauncher>).fires).toHaveLength(1);
  });

  it('≤1 LATE FIRE + NO BACKFILL: a row overdue by hours fires once, next is future', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pv, schedule: '* * * * *' });
    // Armed for NOON; the server was down and only ticks at 15:34:30 — hundreds
    // of every-minute slots elapsed. Exactly ONE overdue row exists (the chain
    // only ever holds one), so it fires once and the next is 15:35 — not 12:01.
    armTick(db, trigger, NOON);
    const bootAt = Date.parse('2026-07-15T15:34:30.000Z');

    const { clock, launcher } = harness(db, () => bootAt);
    clock.tick();

    expect((launcher as ReturnType<typeof fakeLauncher>).fires).toHaveLength(1);
    const pending = pendingTicks(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dueAt).toBe(Date.parse('2026-07-15T15:35:00.000Z'));
  });
});

describe('schedule_tick handler — freshness suppressions', () => {
  /**
   * Drive one row through the handler directly (not the clock) so the suppression
   * REASON — which the clock only debug-logs — is assertable. `next` reports the
   * rows the handler ARMED, excluding the row under test.
   */
  function fireDirect(db: Db, trigger: Trigger, opts: { now?: number; refSchedule?: string } = {}) {
    const launcher = fakeLauncher();
    const handler = createScheduleTickHandler({ launcher, log: silentLog() });
    const now = opts.now ?? NOON;
    const row = armWakeup(db, {
      kind: SCHEDULE_TICK_KIND,
      ref: { triggerId: trigger.id, schedule: opts.refSchedule ?? (trigger.schedule as string) },
      dueAt: now,
      discriminator: `tick-${now}`,
    });
    const result = handler.fire(row, { scheduledFor: now, firedAt: now, latenessMs: 0 }, db);
    const next = pendingTicks(db).filter((w) => w.id !== row.id);
    return { result, launcher, next };
  }

  it('disabled trigger → suppressed, NO re-arm (schedule is gone)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pv, enabled: true });
    updateTrigger(db, trigger.id, { enabled: false });
    const { result, launcher, next } = fireDirect(db, trigger);
    expect(result).toMatchObject({ status: 'suppressed', reason: 'trigger_not_schedulable' });
    expect(launcher.fires).toHaveLength(0);
    expect(next).toHaveLength(0);
  });

  it('unbound trigger → suppressed trigger_unbound, NO re-arm (belt to the launcher)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pv });
    // The write API blocks enabling an unbound trigger, so force the raw
    // enabled+schedule+unbound state directly — the exact belt-and-braces case
    // the guard exists for. isSchedulable is true (it does not check binding), so
    // the handler must reach and honour its own `pipelineVersionId === null` guard.
    db.update(triggers).set({ pipelineVersionId: null }).where(eq(triggers.id, trigger.id)).run();
    const { result, launcher, next } = fireDirect(db, { ...trigger, pipelineVersionId: null });
    expect(result).toMatchObject({ status: 'suppressed', reason: 'trigger_unbound' });
    expect(launcher.fires).toHaveLength(0);
    expect(next).toHaveLength(0);
  });

  // #5 S12b — a save-valid `${trigger.body.x}` binding throws at fire time on a
  // schedule fire (null body until S8). The afterCommit skip-and-logs it so a
  // misconfigured binding drops the one occurrence, never wedges the clock.
  it('a fire-time binding SubstituteError is skipped in afterCommit — clock never wedged', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pv });
    const throwingLauncher: ScheduleTickLauncher = {
      fire: () => {
        throw new SubstituteError('${trigger.body.k}: has no field — the value before it is null');
      },
    };
    const handler = createScheduleTickHandler({ launcher: throwingLauncher, log: silentLog() });
    const row = armWakeup(db, {
      kind: SCHEDULE_TICK_KIND,
      ref: { triggerId: trigger.id, schedule: trigger.schedule as string },
      dueAt: NOON,
      discriminator: `tick-${NOON}`,
    });
    const result = handler.fire(row, { scheduledFor: NOON, firedAt: NOON, latenessMs: 0 }, db);

    // The tick FIRED (the chain is armed in-tx); the launcher throw is swallowed
    // in afterCommit as a skip, so the clock's afterCommit guard never sees it.
    expect(result.status).toBe('fired');
    if (result.status === 'fired') {
      expect(() => result.afterCommit?.()).not.toThrow();
    }
  });

  it('schedule edited since arm → suppressed schedule_changed, NO re-arm (sync reseeds)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pv, schedule: '* * * * *' });
    // Row armed for the OLD schedule; the trigger now runs a different one.
    updateTrigger(db, trigger.id, { schedule: '0 9 * * *' });
    const edited = { ...trigger, schedule: '0 9 * * *' };
    const { result, launcher, next } = fireDirect(db, edited, { refSchedule: '* * * * *' });
    expect(result).toMatchObject({ status: 'suppressed', reason: 'schedule_changed' });
    expect(launcher.fires).toHaveLength(0);
    expect(next).toHaveLength(0);
  });

  it('outside a run window → suppressed, but DOES re-arm the next occurrence', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    // A window that never contains NOON (12:00Z): 13:00–14:00 only.
    const trigger = seedTrigger(db, {
      pipelineVersionId: pv,
      schedule: '* * * * *',
      runWindows: [{ start: '13:00', end: '14:00' }],
    });
    const { result, launcher, next } = fireDirect(db, trigger);
    expect(result).toMatchObject({ status: 'suppressed', reason: 'outside_run_window' });
    expect(launcher.fires).toHaveLength(0);
    // The schedule stays alive across a closed window — next minute is armed.
    expect(next).toHaveLength(1);
    expect(next[0]?.dueAt).toBe(NEXT_MINUTE);
  });

  it('invalid cron string → suppressed invalid_schedule, NO re-arm, NO throw', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pv, schedule: '* * * * *' });
    // Force a syntactically-invalid schedule past the schema (it does not validate
    // cron syntax). The handler must SETTLE, never throw (a throw rolls back inside
    // the clock tx and re-delivers forever).
    updateTrigger(db, trigger.id, { schedule: 'not a cron' });
    const invalid = { ...trigger, schedule: 'not a cron' };
    const { result, launcher, next } = fireDirect(db, invalid, { refSchedule: 'not a cron' });
    expect(result).toMatchObject({ status: 'suppressed', reason: 'invalid_schedule' });
    expect(launcher.fires).toHaveLength(0);
    expect(next).toHaveLength(0);
  });
});

describe('schedule_tick — end to end through the REAL launcher', () => {
  /** A real run launcher over stub executor/alarms — the same rig launcher.test.ts uses. */
  function realLauncher(db: Db) {
    const resolveDoc: DocResolver = (id) => {
      const pv = getPipelineVersion(db, id);
      if (pv === null) throw new Error(`no pv ${id}`);
      return pv;
    };
    const deps: DriveDeps = {
      db,
      resolveDoc,
      executor: makeStubExecutor({}),
      alarms: stubAlarms(),
      drives: createRunDrives(),
    };
    return createRunLauncher(deps);
  }

  it('an overdue row at boot fires ONCE, creates a run that drives to success, and re-arms', async () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pv, schedule: '* * * * *' });
    // A row armed before a crash, now overdue: the boot sweep should fire it.
    armTick(db, trigger, NOON);
    const bootAt = Date.parse('2026-07-15T12:07:30.000Z');

    const launcher = realLauncher(db);
    const handler = createScheduleTickHandler({ launcher, log: silentLog() });
    const clock = createAlarmClock({
      db,
      handlers: [handler],
      log: silentLog(),
      now: () => bootAt,
    });

    clock.tick();
    await launcher.whenIdle();

    // Exactly one run was created for this trigger, and it reached success.
    const runs = listRuns(db, { triggerId: trigger.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('success');

    // The chain advanced to the next FUTURE minute (12:08), not the missed 12:01.
    const pending = pendingTicks(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dueAt).toBe(Date.parse('2026-07-15T12:08:00.000Z'));
  });
});

describe('schedule_tick handler — the launcher fires post-commit', () => {
  it('a launcher UnboundTriggerError in afterCommit is swallowed (chain survives)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pv, schedule: '* * * * *' });
    const noonRow = armTick(db, trigger, NOON);

    const launcher: ScheduleTickLauncher = {
      fire: () => {
        throw new UnboundTriggerError('raced to unbound');
      },
    };
    const { clock } = harness(db, () => NOON, launcher);
    // Must not throw out of tick(); the NOON row settles and 12:01 is armed.
    expect(() => clock.tick()).not.toThrow();
    expect(getWakeup(db, noonRow.id)?.status).toBe('fired');
    const pending = pendingTicks(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dueAt).toBe(NEXT_MINUTE);
  });
});
