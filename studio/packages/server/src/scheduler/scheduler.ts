import type { ArmWakeupInput, ScheduledWakeup } from '@autonomy-studio/shared';
import { listParsedTriggers } from '../repo/triggers.js';
import { deleteWakeup, listPendingWakeups } from '../repo/scheduled-wakeups.js';
import type { Db } from '../repo/types.js';
import { InvalidScheduleError, nextOccurrence } from './recurrence.js';
import { isSchedulable, SCHEDULE_TICK_KIND, ScheduleTickRefSchema } from './schedule-tick.js';

/**
 * #5 S5 — the SCHEDULE RECONCILER. It reconciles the set of durable
 * `schedule_tick` wakeup rows against the DB's schedulable triggers, so every
 * automatic schedule fire flows through the ONE durable outbox (S1) and the ONE
 * alarm clock — NOT a per-trigger in-memory `Cron` a restart silently lost
 * (the pre-S5 design). Croner is now a CALCULATOR (`recurrence.ts`), never a
 * firing source; the `schedule_tick` HANDLER (`schedule-tick.ts`) owns the fire
 * and continues the chain.
 *
 * The reconciler owns only SEEDING and CANCELLING:
 *
 *   - SEED — a schedulable trigger with no valid pending row gets its next
 *     occurrence armed (the handler arms every occurrence after that).
 *   - DROP — a pending row whose trigger is no longer schedulable (disabled,
 *     mode changed, schedule cleared, unbound-out-of-schedule, or deleted), or
 *     whose armed schedule string no longer matches the trigger's current one
 *     (an edit), is DELETED (not settled `cancelled` — a cancelled row keeps its
 *     `(kind, dedupeKey)`, which would make re-seeding the SAME occurrence after
 *     a disable→re-enable within one interval collide and silently never arm);
 *     the loop below re-seeds the new schedule.
 *
 * An OVERDUE-but-current pending row (a late fire the clock has not delivered
 * yet) is KEPT, never dropped — dropping it would lose the ≤1-late fire.
 *
 * Idempotent — safe at boot and after every trigger write. A no-op once
 * `stop()`ped. Resilient: one corrupt trigger row or one unparseable wakeup ref
 * is skipped (and warned), never allowed to dark-out the whole reconcile.
 */

/** Minimal logger seam (Fastify's `log` satisfies it). REQUIRED on the deps
 * (#470); tests supply `silentLog()`. Shared with `alarms.ts` (imported there). */
export interface SchedulerLog {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface Scheduler {
  /**
   * Reconcile the durable `schedule_tick` rows against the DB: seed newly-eligible
   * triggers, re-seed ones whose schedule string changed, and DROP (delete) rows
   * for triggers no longer eligible. Overdue-but-current rows are kept (the clock
   * fires them). Idempotent — safe at boot and after every trigger write. A no-op
   * once `stop()`ped.
   */
  sync(): void;
  /** Stop accepting new reconciles. Idempotent. The actual firing is stopped by
   * the alarm clock (`alarmClock.stop()` + `clearInterval`), not here — this only
   * makes `sync()` a no-op during shutdown so a late trigger write cannot seed a
   * fresh row as the process goes away. */
  stop(): void;
}

export interface SchedulerDeps {
  db: Db;
  /**
   * The alarm clock's `arm` — seeding goes through it so the `schedule_tick` kind
   * + ref are validated at the call site (a malformed ref fails loudly here, not
   * hours later in a background tick).
   */
  arm: (input: ArmWakeupInput) => ScheduledWakeup;
  /**
   * REQUIRED (#470): every reconcile fault path (invalid cron, corrupt trigger
   * row, unparseable wakeup ref, list-on-sync fault) reports through `log`.
   * Optional would let a caller omit it and swallow those faults silently — an
   * absent logger must not be manufactured as a benign no-op.
   */
  log: SchedulerLog;
  /** Clock seam (epoch ms); defaults to the wall clock, matching the alarm clock. */
  now?: () => number;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { db, arm } = deps;
  const now = deps.now ?? (() => Date.now());
  let stopped = false;

  function seed(triggerId: string, schedule: string): void {
    let next: number | null;
    try {
      next = nextOccurrence(schedule, now());
    } catch (err) {
      if (err instanceof InvalidScheduleError) {
        // A cron the schema let through but croner rejects. Skip THIS trigger,
        // never abort the reconcile — one poison schedule must not dark-out all
        // scheduling (the blast-radius the per-row guards here exist to prevent).
        deps.log.warn(
          { err, triggerId, schedule },
          'scheduler: invalid cron expression — skipping',
        );
        return;
      }
      throw err;
    }
    // A finite schedule with no future occurrence: nothing to arm.
    if (next === null) return;
    arm({
      kind: SCHEDULE_TICK_KIND,
      ref: { triggerId, schedule },
      dueAt: next,
      discriminator: `tick-${next}`,
    });
  }

  function sync(): void {
    if (stopped) return;

    let all;
    try {
      // Resilient: a single corrupt/legacy row is SKIPPED (and warned), not
      // allowed to throw out the whole list — one poison row would otherwise
      // dark-out ALL scheduling.
      all = listParsedTriggers(db, (triggerId, err) =>
        deps.log.warn({ err, triggerId }, 'scheduler: skipping unparseable trigger row'),
      );
    } catch (err) {
      deps.log.error({ err }, 'scheduler: failed to list triggers on sync');
      return;
    }

    const schedulable = new Map<string, string>(); // triggerId → current schedule
    for (const t of all) {
      if (isSchedulable(t)) schedulable.set(t.id, t.schedule as string);
    }

    // Pass 1 — CANCEL dead / stale-schedule rows; remember which triggers still
    // hold a valid pending row (so pass 2 does not double-seed them).
    const keep = new Set<string>();
    for (const row of listPendingWakeups(db)) {
      if (row.kind !== SCHEDULE_TICK_KIND) continue;
      const parsed = ScheduleTickRefSchema.safeParse(row.ref);
      if (!parsed.success) {
        // A ref we cannot read can never be reconciled or fired — drop it rather
        // than leave an un-droppable pending row spinning.
        deps.log.warn(
          { wakeupId: row.id, err: parsed.error },
          'scheduler: deleting unparseable schedule_tick ref',
        );
        deleteWakeup(db, row.id);
        continue;
      }
      const { triggerId, schedule } = parsed.data;
      const current = schedulable.get(triggerId);
      if (current === undefined || current !== schedule) {
        // DELETE, not cancel: a cancelled row keeps its `(kind, dedupeKey)`, so a
        // re-seed of the SAME occurrence after a disable→re-enable (or edit→revert)
        // within one interval would collide with the dead row and silently never
        // arm. Deleting the dropped PENDING row frees the key. `deleteWakeup` is
        // guarded to `status='pending'`, so a fired/suppressed sibling is untouched.
        deleteWakeup(db, row.id);
      } else {
        keep.add(triggerId);
      }
    }

    // Pass 2 — SEED any schedulable trigger left without a valid pending row.
    for (const [triggerId, schedule] of schedulable) {
      if (!keep.has(triggerId)) seed(triggerId, schedule);
    }
  }

  function stop(): void {
    stopped = true;
  }

  return { sync, stop };
}
