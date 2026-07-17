import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type NewPipelineVersion,
  type Node,
  type RunWindow,
  type ScheduledWakeup,
  type Trigger,
  type TriggerMode,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createTrigger, deleteTrigger, updateTrigger } from '../../repo/triggers.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { armWakeup, listPendingWakeups } from '../../repo/scheduled-wakeups.js';
import type { Db } from '../../repo/types.js';
import { createAlarmClock } from '../alarms.js';
import { createScheduler, type SchedulerDeps } from '../scheduler.js';
import { createScheduleTickHandler, SCHEDULE_TICK_KIND } from '../schedule-tick.js';
import { silentLog } from './testLog.js';

/**
 * #5 S5 — the SCHEDULE RECONCILER, against a real DB, the real alarm clock's
 * `arm`, and real `scheduled_wakeups` rows. `sync()` no longer builds in-memory
 * crons; it reconciles the durable `schedule_tick` set. The FIRING is the
 * handler's job (`schedule-tick.test.ts`); what is under test here is seed /
 * cancel / re-seed / keep-overdue / idempotency.
 */

const NOON = Date.parse('2026-07-15T12:00:00.000Z');
const NEXT_MINUTE = Date.parse('2026-07-15T12:01:00.000Z');

function seedVersion(db: Db): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const node: Node = { id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } };
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

/** A scheduler whose `arm` is a real alarm clock's (so refs are validated). */
function makeScheduler(db: Db, now: () => number = () => NOON) {
  const clock = createAlarmClock({
    db,
    handlers: [
      // The reconciler never fires (sync only seeds/drops rows), so this launcher
      // double is never called; it still must satisfy the `FireResult` seam.
      createScheduleTickHandler({
        launcher: { fire: () => ({ outcome: 'queued' }) },
        log: silentLog(),
      }),
    ],
    log: silentLog(),
    now,
  });
  return createScheduler({ db, arm: clock.arm, log: silentLog(), now });
}

function pendingTicks(db: Db): ScheduledWakeup[] {
  return listPendingWakeups(db).filter((w) => w.kind === SCHEDULE_TICK_KIND);
}

/** The `{triggerId, dueAt}` of each pending schedule_tick, for compact asserts. */
function tickSummary(db: Db) {
  return pendingTicks(db)
    .map((w) => ({ triggerId: (w.ref as { triggerId: string }).triggerId, dueAt: w.dueAt }))
    .sort((a, b) => a.triggerId.localeCompare(b.triggerId));
}

describe('Scheduler — sync() reconciles the durable schedule_tick set', () => {
  it('requires a `log` dependency — it is a required key of SchedulerDeps, not optional (#470)', () => {
    // If `log` reverts to optional, `SchedulerDeps['log']` widens to include
    // `undefined`, `LogRequired` collapses to `never`, and `const _: never = true`
    // fails to compile — a precise tripwire, not a bare `@ts-expect-error`.
    type LogRequired = undefined extends SchedulerDeps['log'] ? never : true;
    const logIsRequired: LogRequired = true;
    expect(logIsRequired).toBe(true);
  });

  it('seeds only enabled, schedule-mode, scheduled triggers — at the next occurrence', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const wanted = seedTrigger(db, { pipelineVersionId: pv });
    seedTrigger(db, { pipelineVersionId: pv, enabled: false }); // disabled
    seedTrigger(db, { pipelineVersionId: pv, mode: 'manual', schedule: null }); // manual
    seedTrigger(db, { pipelineVersionId: pv, mode: 'webhook', schedule: null }); // webhook

    makeScheduler(db).sync();

    expect(tickSummary(db)).toEqual([{ triggerId: wanted.id, dueAt: NEXT_MINUTE }]);
  });

  it('is idempotent — a second sync does not double-seed', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const t = seedTrigger(db, { pipelineVersionId: pv });
    const s = makeScheduler(db);
    s.sync();
    s.sync();
    expect(tickSummary(db)).toEqual([{ triggerId: t.id, dueAt: NEXT_MINUTE }]);
  });

  it('cancels the pending row when its trigger is disabled', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const t = seedTrigger(db, { pipelineVersionId: pv });
    const s = makeScheduler(db);
    s.sync();
    expect(pendingTicks(db)).toHaveLength(1);

    updateTrigger(db, t.id, { enabled: false });
    s.sync();
    expect(pendingTicks(db)).toHaveLength(0);
  });

  it('cancels the pending row when its trigger is deleted', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const t = seedTrigger(db, { pipelineVersionId: pv });
    const s = makeScheduler(db);
    s.sync();
    deleteTrigger(db, t.id);
    s.sync();
    expect(pendingTicks(db)).toHaveLength(0);
  });

  it('re-seeds when the schedule STRING changes (cancel old, arm the new occurrence)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const t = seedTrigger(db, { pipelineVersionId: pv, schedule: '* * * * *' });
    const s = makeScheduler(db);
    s.sync();
    expect(tickSummary(db)).toEqual([{ triggerId: t.id, dueAt: NEXT_MINUTE }]);

    updateTrigger(db, t.id, { schedule: '0 13 * * *' }); // 13:00Z daily
    s.sync();
    expect(tickSummary(db)).toEqual([
      { triggerId: t.id, dueAt: Date.parse('2026-07-15T13:00:00.000Z') },
    ]);
  });

  it('KEEPS an overdue-but-current row — never cancels the ≤1-late fire', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const t = seedTrigger(db, { pipelineVersionId: pv, schedule: '* * * * *' });
    makeScheduler(db, () => NOON).sync(); // seeds 12:01
    expect(tickSummary(db)).toEqual([{ triggerId: t.id, dueAt: NEXT_MINUTE }]);

    // Reconcile again well past 12:01 (the clock has not fired it yet). The row is
    // overdue but its schedule still matches, so it is KEPT — not cancelled and
    // re-seeded to 12:06 (which would drop the late fire).
    makeScheduler(db, () => Date.parse('2026-07-15T12:05:30.000Z')).sync();
    expect(tickSummary(db)).toEqual([{ triggerId: t.id, dueAt: NEXT_MINUTE }]);
  });

  it('re-seeds after disable→re-enable within the same occurrence interval (no dedupeKey collision)', () => {
    // REGRESSION: a cancelled row keeps its `(kind, dedupeKey)`. When the re-seed
    // lands on the SAME occurrence epoch (still future), `armWakeup`'s
    // upsert-if-absent used to return the dead cancelled row and insert nothing —
    // the schedule silently died with no pending row. DROP (delete) fixes it.
    const { db } = freshDb();
    const pv = seedVersion(db);
    // Every 6h; at 12:00 the next occurrence is 18:00 — the same epoch persists
    // across the disable→re-enable below (all syncs at a fixed 12:00 `now`).
    const t = seedTrigger(db, { pipelineVersionId: pv, schedule: '0 */6 * * *' });
    const SIX_PM = Date.parse('2026-07-15T18:00:00.000Z');
    const s = makeScheduler(db, () => NOON);
    s.sync();
    expect(tickSummary(db)).toEqual([{ triggerId: t.id, dueAt: SIX_PM }]);

    updateTrigger(db, t.id, { enabled: false });
    s.sync();
    expect(pendingTicks(db)).toHaveLength(0);

    updateTrigger(db, t.id, { enabled: true });
    s.sync(); // re-seeds the SAME 18:00 occurrence — must arm a real pending row
    expect(tickSummary(db)).toEqual([{ triggerId: t.id, dueAt: SIX_PM }]);
  });

  it('re-seeds after schedule edit→revert within the interval (no dedupeKey collision)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const t = seedTrigger(db, { pipelineVersionId: pv, schedule: '0 */6 * * *' });
    const SIX_PM = Date.parse('2026-07-15T18:00:00.000Z');
    const s = makeScheduler(db, () => NOON);
    s.sync();
    expect(tickSummary(db)).toEqual([{ triggerId: t.id, dueAt: SIX_PM }]);

    updateTrigger(db, t.id, { schedule: '0 */3 * * *' }); // next 15:00
    s.sync();
    expect(tickSummary(db)).toEqual([
      { triggerId: t.id, dueAt: Date.parse('2026-07-15T15:00:00.000Z') },
    ]);

    updateTrigger(db, t.id, { schedule: '0 */6 * * *' }); // revert → next 18:00 again
    s.sync();
    expect(tickSummary(db)).toEqual([{ triggerId: t.id, dueAt: SIX_PM }]);
  });

  it('reconciles several triggers together', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const a = seedTrigger(db, { pipelineVersionId: pv, schedule: '* * * * *' });
    const b = seedTrigger(db, { pipelineVersionId: pv, schedule: '0 13 * * *' });
    makeScheduler(db).sync();
    expect(tickSummary(db)).toEqual(
      [
        { triggerId: a.id, dueAt: NEXT_MINUTE },
        { triggerId: b.id, dueAt: Date.parse('2026-07-15T13:00:00.000Z') },
      ].sort((x, y) => x.triggerId.localeCompare(y.triggerId)),
    );
  });

  it('skips an invalid cron string without arming it — and still seeds the others', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const good = seedTrigger(db, { pipelineVersionId: pv, schedule: '* * * * *' });
    const bad = seedTrigger(db, { pipelineVersionId: pv, schedule: '* * * * *' });
    // Force an invalid schedule past the schema (it does not validate cron syntax).
    updateTrigger(db, bad.id, { schedule: 'not a cron' });

    makeScheduler(db).sync();
    // The bad one is skipped (no row); the good one is still seeded — one poison
    // schedule must not dark-out all scheduling.
    expect(tickSummary(db)).toEqual([{ triggerId: good.id, dueAt: NEXT_MINUTE }]);
  });

  it('is a no-op after stop()', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    seedTrigger(db, { pipelineVersionId: pv });
    const s = makeScheduler(db);
    s.stop();
    s.sync();
    expect(pendingTicks(db)).toHaveLength(0);
  });

  it('cancels a schedule_tick row whose ref cannot be parsed', () => {
    const { db } = freshDb();
    // A row with a ref shape the current schema rejects (missing `schedule`) must
    // be cancelled, not left as an un-droppable pending row.
    armWakeup(db, {
      kind: SCHEDULE_TICK_KIND,
      ref: { triggerId: 'ghost' },
      dueAt: NOON,
      discriminator: 'tick-legacy',
    });
    expect(pendingTicks(db)).toHaveLength(1);
    makeScheduler(db).sync();
    expect(pendingTicks(db)).toHaveLength(0);
  });
});
