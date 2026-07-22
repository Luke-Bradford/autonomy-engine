import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_VERSION,
  SubstituteError,
  type NewPipelineVersion,
  type Node,
  type Recurrence,
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
  buildScheduleTickRef,
  createScheduleTickHandler,
  isRefFresh,
  SCHEDULE_TICK_KIND,
  type ScheduleTickLauncher,
  type ScheduleTickRef,
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
    recurrence?: Recurrence | null;
  },
): Trigger {
  return createTrigger(db, {
    ownerId: 'local',
    name: 'T',
    pipelineVersionId: opts.pipelineVersionId,
    params: {},
    mode: opts.mode ?? 'schedule',
    // When a recurrence is given, `createTrigger` DERIVES `schedule` from it (the
    // raw `schedule` here is ignored) — so bounds tests author via `recurrence`.
    schedule: opts.schedule === undefined ? '* * * * *' : opts.schedule,
    recurrence: opts.recurrence ?? null,
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

/** Arm a schedule_tick for `trigger` due at `dueAt`, as sync()/a prior tick would.
 * Uses the SINGLE ref constructor so a bounded trigger's row carries its bounds. */
function armTick(db: Db, trigger: Trigger, dueAt: number) {
  return armWakeup(db, {
    kind: SCHEDULE_TICK_KIND,
    ref: buildScheduleTickRef(trigger),
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
  function fireDirect(
    db: Db,
    trigger: Trigger,
    opts: { now?: number; refSchedule?: string; ref?: ScheduleTickRef } = {},
  ) {
    const launcher = fakeLauncher();
    const handler = createScheduleTickHandler({ launcher, log: silentLog() });
    const now = opts.now ?? NOON;
    // Default ref = the one the trigger would arm NOW; `ref`/`refSchedule` let a
    // test pin a STALE armed ref (schedule or bounds) to exercise freshness.
    const ref: ScheduleTickRef = opts.ref ?? {
      ...buildScheduleTickRef(trigger),
      ...(opts.refSchedule !== undefined ? { schedule: opts.refSchedule } : {}),
    };
    const row = armWakeup(db, {
      kind: SCHEDULE_TICK_KIND,
      ref,
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

  it('schedule edited since arm → suppressed ref_stale, NO re-arm (sync reseeds)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pv, schedule: '* * * * *' });
    // Row armed for the OLD schedule; the trigger now runs a different one.
    updateTrigger(db, trigger.id, { schedule: '0 9 * * *' });
    const edited = { ...trigger, schedule: '0 9 * * *' };
    const { result, launcher, next } = fireDirect(db, edited, { refSchedule: '* * * * *' });
    expect(result).toMatchObject({ status: 'suppressed', reason: 'ref_stale' });
    expect(launcher.fires).toHaveLength(0);
    expect(next).toHaveLength(0);
  });

  // #5 S5b-2 (#549) — a bounds-only edit leaves the compiled cron IDENTICAL, so
  // the old schedule-string compare would have missed it and fired the row under
  // the STALE window. The full-ref freshness check catches it.
  it('bounds edited since arm (cron unchanged) → suppressed ref_stale, NO re-arm', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    // Daily-9 recurrence, no bounds → schedule '0 9 * * *'.
    const trigger = seedTrigger(db, {
      pipelineVersionId: pv,
      recurrence: { frequency: 'day', interval: 1, schedule: { hours: [9] } },
    });
    // Add an endTime; the derived cron is still '0 9 * * *' (bounds are not cron).
    const edited = updateTrigger(db, trigger.id, {
      recurrence: {
        frequency: 'day',
        interval: 1,
        schedule: { hours: [9] },
        endTime: '2027-01-01T00:00:00Z',
      },
    });
    if (!edited) throw new Error('update failed');
    expect(edited.schedule).toBe(trigger.schedule); // cron genuinely unchanged
    // Row still carries the pre-edit (bounds-free) ref.
    const { result, launcher, next } = fireDirect(db, edited, {
      ref: buildScheduleTickRef(trigger),
    });
    expect(result).toMatchObject({ status: 'suppressed', reason: 'ref_stale' });
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

  // #637 — a poison (unparseable) trigger row must SETTLE the chain, never
  // throw: a handler throw rolls back the fire tx, so the pending row would
  // re-fire + error-log on every tick, forever. `sync()` re-seeds the chain if
  // the row is later repaired — the `invalid_schedule` discipline.
  //
  // The write API cannot produce a corrupt row (`updateTrigger` re-parses), so
  // corrupt it directly — the hand-edit/legacy-drift vector the ticket names.
  // Out-of-enum concurrency policy: valid JSON, no CHECK, `TriggerSchema` rejects.
  function corruptTriggerRow(db: Db, id: string): void {
    db.update(triggers)
      .set({ concurrency: { policy: 'nope' } as unknown as Trigger['concurrency'] })
      .where(eq(triggers.id, id))
      .run();
  }

  it('unparseable trigger row → suppressed trigger_unparseable, NO re-arm, NO throw (#637)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pv });
    corruptTriggerRow(db, trigger.id);
    const { result, launcher, next } = fireDirect(db, trigger);
    expect(result).toMatchObject({ status: 'suppressed', reason: 'trigger_unparseable' });
    expect(launcher.fires).toHaveLength(0);
    expect(next).toHaveLength(0);
  });

  it('poison row through the REAL clock: settles suppressed, second tick inert (#637)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pv });
    const row = armTick(db, trigger, NOON);
    corruptTriggerRow(db, trigger.id);

    const { clock, launcher } = harness(db, () => NOON);
    expect(() => clock.tick()).not.toThrow();

    // Settled durably — NOT left pending (the forever-re-fire the ticket names).
    expect(getWakeup(db, row.id)?.status).toBe('suppressed');
    expect(pendingTicks(db)).toHaveLength(0);
    clock.tick(); // nothing left to deliver
    expect((launcher as ReturnType<typeof fakeLauncher>).fires).toHaveLength(0);
  });
});

describe('schedule_tick — ref construction + bounded re-arm (#5 S5b-2, #549)', () => {
  it('buildScheduleTickRef OMITS absent bounds — byte-identical to a pre-S5b-2 ref', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    // A raw-cron trigger (no recurrence) and a bounds-free recurrence both produce
    // a two-key ref, so a row armed before S5b-2 still reads as fresh on deploy.
    const raw = seedTrigger(db, { pipelineVersionId: pv, schedule: '0 9 * * *' });
    expect(buildScheduleTickRef(raw)).toEqual({ triggerId: raw.id, schedule: '0 9 * * *' });
    expect(Object.keys(buildScheduleTickRef(raw)).sort()).toEqual(['schedule', 'triggerId']);

    const bounded = seedTrigger(db, {
      pipelineVersionId: pv,
      recurrence: {
        frequency: 'day',
        interval: 1,
        schedule: { hours: [9] },
        startTime: '2026-08-01T00:00:00Z',
        endTime: '2026-08-31T00:00:00Z',
      },
    });
    expect(buildScheduleTickRef(bounded)).toEqual({
      triggerId: bounded.id,
      schedule: '0 9 * * *',
      startTime: '2026-08-01T00:00:00Z',
      endTime: '2026-08-31T00:00:00Z',
    });
    // isRefFresh: same trigger fresh; a bounds change makes the old ref stale.
    expect(isRefFresh(bounded, buildScheduleTickRef(bounded))).toBe(true);
    expect(isRefFresh(bounded, buildScheduleTickRef(raw))).toBe(false);
  });

  // #5 S5b (#550) — an interval edit leaves the derived cron IDENTICAL
  // (`recurrenceToCron` ignores interval), so without `interval` in the ref the
  // schedule-string + bounds compare would miss it and keep firing on the OLD
  // cadence. The ref carries `interval` (only when >1) so the edit reads as stale.
  it('interval carried in the ref ONLY when >1; an interval edit reads as stale', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const every2 = seedTrigger(db, {
      pipelineVersionId: pv,
      recurrence: {
        frequency: 'day',
        interval: 2,
        schedule: { hours: [9] },
        startTime: '2026-08-01T00:00:00Z',
      },
    });
    expect(buildScheduleTickRef(every2)).toEqual({
      triggerId: every2.id,
      schedule: '0 9 * * *',
      startTime: '2026-08-01T00:00:00Z',
      interval: '2',
    });
    // Edit interval 2 → 3: cron is byte-identical, but the ref's interval changes.
    const every3 = updateTrigger(db, every2.id, {
      recurrence: {
        frequency: 'day',
        interval: 3,
        schedule: { hours: [9] },
        startTime: '2026-08-01T00:00:00Z',
      },
    });
    if (!every3) throw new Error('update failed');
    expect(every3.schedule).toBe(every2.schedule); // cron genuinely unchanged
    expect(isRefFresh(every3, buildScheduleTickRef(every2))).toBe(false);

    // interval === 1 OMITS the key — byte-identical to a pre-#550 ref, so a row
    // armed before this shipped stays fresh on deploy.
    const every1 = seedTrigger(db, {
      pipelineVersionId: pv,
      recurrence: { frequency: 'day', interval: 1, schedule: { hours: [9] } },
    });
    expect('interval' in buildScheduleTickRef(every1)).toBe(false);
  });

  // #5 S5b-timeZone (#552) — a timeZone edit leaves the derived cron IDENTICAL (the
  // zone is a croner interpretation option, not part of the pattern), so the ref
  // carries `timeZone` (only when non-UTC) to make a zone edit read as stale.
  it('timeZone carried in the ref ONLY when non-UTC; a timeZone edit reads as stale', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const ny = seedTrigger(db, {
      pipelineVersionId: pv,
      recurrence: {
        frequency: 'day',
        interval: 1,
        schedule: { hours: [9] },
        timeZone: 'America/New_York',
      },
    });
    expect(buildScheduleTickRef(ny)).toEqual({
      triggerId: ny.id,
      schedule: '0 9 * * *',
      timeZone: 'America/New_York',
    });
    // Edit the zone NY → London: cron is byte-identical, but the ref's timeZone changes.
    const london = updateTrigger(db, ny.id, {
      recurrence: {
        frequency: 'day',
        interval: 1,
        schedule: { hours: [9] },
        timeZone: 'Europe/London',
      },
    });
    if (!london) throw new Error('update failed');
    expect(london.schedule).toBe(ny.schedule); // cron genuinely unchanged
    expect(isRefFresh(london, buildScheduleTickRef(ny))).toBe(false);

    // Absent timeZone OMITS the key — byte-identical to a pre-#552 ref (unzoned ⇒
    // UTC), so a row armed before this shipped stays fresh on deploy.
    const unzoned = seedTrigger(db, {
      pipelineVersionId: pv,
      recurrence: { frequency: 'day', interval: 1, schedule: { hours: [9] } },
    });
    expect('timeZone' in buildScheduleTickRef(unzoned)).toBe(false);
    // Explicit UTC is behaviourally identical to unzoned → also OMITS the key, so a
    // UTC recurrence's ref stays byte-identical to an unzoned one (and to pre-#552).
    const utc = seedTrigger(db, {
      pipelineVersionId: pv,
      recurrence: { frequency: 'day', interval: 1, schedule: { hours: [9] }, timeZone: 'UTC' },
    });
    expect('timeZone' in buildScheduleTickRef(utc)).toBe(false);
    expect(isRefFresh(unzoned, buildScheduleTickRef(utc))).toBe(true);
  });

  it('a stepped (interval>1) trigger re-arms the NEXT qualifying occurrence, not the next daily slot', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    // Every 2 days at 09:00, anchored Aug 1. Deliver the Aug 1 09:00 fire → the next
    // armed slot must be Aug 3 09:00 (Aug 2 is a skipped, non-qualifying day).
    const trigger = seedTrigger(db, {
      pipelineVersionId: pv,
      recurrence: {
        frequency: 'day',
        interval: 2,
        schedule: { hours: [9] },
        startTime: '2026-08-01T00:00:00Z',
      },
    });
    const aug1 = Date.parse('2026-08-01T09:00:00Z');
    const row = armTick(db, trigger, aug1);
    const launcher = fakeLauncher();
    const handler = createScheduleTickHandler({ launcher, log: silentLog() });
    const result = handler.fire(row, { scheduledFor: aug1, firedAt: aug1, latenessMs: 0 }, db);
    expect(result.status).toBe('fired');
    const armed = pendingTicks(db).filter((w) => w.id !== row.id);
    expect(armed).toHaveLength(1);
    expect(armed[0]?.dueAt).toBe(Date.parse('2026-08-03T09:00:00Z'));
  });

  it('a fresh bounded trigger fires and re-arms the NEXT in-window occurrence', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    // Daily-9, window [Aug 1, Aug 4). Deliver the Aug 1 09:00 occurrence.
    const trigger = seedTrigger(db, {
      pipelineVersionId: pv,
      recurrence: {
        frequency: 'day',
        interval: 1,
        schedule: { hours: [9] },
        startTime: '2026-08-01T00:00:00Z',
        endTime: '2026-08-04T00:00:00Z',
      },
    });
    const aug1 = Date.parse('2026-08-01T09:00:00Z');
    const row = armTick(db, trigger, aug1);
    const launcher = fakeLauncher();
    const handler = createScheduleTickHandler({ launcher, log: silentLog() });
    const result = handler.fire(row, { scheduledFor: aug1, firedAt: aug1, latenessMs: 0 }, db);
    expect(result.status).toBe('fired');
    // Next armed = Aug 2 09:00 (still < endTime).
    const armed = pendingTicks(db).filter((w) => w.id !== row.id);
    expect(armed).toHaveLength(1);
    expect(armed[0]?.dueAt).toBe(Date.parse('2026-08-02T09:00:00Z'));
  });

  it('the last occurrence before endTime ends the chain (no re-arm past the window)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTrigger(db, {
      pipelineVersionId: pv,
      recurrence: {
        frequency: 'day',
        interval: 1,
        schedule: { hours: [9] },
        endTime: '2026-08-04T00:00:00Z',
      },
    });
    // Deliver Aug 3 09:00 (the last slot before the Aug 4 endTime).
    const aug3 = Date.parse('2026-08-03T09:00:00Z');
    const row = armTick(db, trigger, aug3);
    const launcher = fakeLauncher();
    const handler = createScheduleTickHandler({ launcher, log: silentLog() });
    const result = handler.fire(row, { scheduledFor: aug3, firedAt: aug3, latenessMs: 0 }, db);
    expect(result.status).toBe('fired');
    // nextOccurrence(Aug 3 09:00, stopAt=Aug 4) → Aug 4 is past the window's last
    // slot → null → chain ends, nothing re-armed.
    expect(pendingTicks(db).filter((w) => w.id !== row.id)).toHaveLength(0);
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
