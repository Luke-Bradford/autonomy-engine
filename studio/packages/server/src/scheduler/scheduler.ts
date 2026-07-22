import type { ArmWakeupInput, ScheduledWakeup } from '@autonomy-studio/shared';
import { listParsedTriggers } from '../repo/triggers.js';
import { deleteWakeup, listPendingWakeups } from '../repo/scheduled-wakeups.js';
import type { Db } from '../repo/types.js';
import { InvalidScheduleError, nextOccurrence } from './recurrence.js';
import {
  buildScheduleTickRef,
  isRefFresh,
  isSchedulable,
  recurrenceStep,
  SCHEDULE_TICK_KIND,
  ScheduleTickRefSchema,
  scheduleBounds,
  type SchedulableTrigger,
} from './schedule-tick.js';

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

  function seed(trigger: SchedulableTrigger): void {
    // `SchedulableTrigger` carries a non-null `schedule` (narrowed by
    // `isSchedulable`), so no cast is needed here.
    const schedule = trigger.schedule;
    let next: number | null;
    try {
      // Bound the first occurrence to the recurrence's window (#5 S5b-2): a
      // future `startTime` seeds the first in-window slot; a past `endTime` seeds
      // nothing (`next === null`). `recurrenceStep` (#5 S5b, #550) gates it to the
      // qualifying periods for an `interval > 1` "every N periods" recurrence.
      next = nextOccurrence(schedule, now(), scheduleBounds(trigger), recurrenceStep(trigger));
    } catch (err) {
      if (err instanceof InvalidScheduleError) {
        // A cron the schema let through but croner rejects. Skip THIS trigger,
        // never abort the reconcile — one poison schedule must not dark-out all
        // scheduling (the blast-radius the per-row guards here exist to prevent).
        deps.log.warn(
          { err, triggerId: trigger.id, schedule },
          'scheduler: invalid cron expression — skipping',
        );
        return;
      }
      throw err;
    }
    // A finite schedule with no future occurrence (or a past `endTime`): nothing to arm.
    if (next === null) return;
    arm({
      kind: SCHEDULE_TICK_KIND,
      ref: buildScheduleTickRef(trigger),
      dueAt: next,
      discriminator: `tick-${next}`,
    });
  }

  function sync(): void {
    if (stopped) return;

    // TRADEOFF — the two passes are NOT wrapped in one transaction (the `arm` seam
    // goes through the alarm clock, which owns its own `db`, so a caller-supplied
    // tx cannot thread through it). A partial reconcile can therefore only happen
    // on PROCESS DEATH between a drop and a re-seed — and that is benign: while the
    // process is down nothing fires, and `buildApp` runs this `sync()` at boot
    // BEFORE the alarm clock starts ticking, so the affected trigger is re-seeded
    // before any tick could have fired it. No fire is lost beyond the crash's own
    // downtime (schedule ticks are no-backfill regardless). Idempotency makes the
    // heal safe to repeat.

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

    // triggerId → the current trigger, narrowed to `SchedulableTrigger` by the
    // `isSchedulable` type guard so seed/ref construction read `schedule` cast-free.
    const schedulable = new Map<string, SchedulableTrigger>();
    for (const t of all) {
      if (isSchedulable(t)) schedulable.set(t.id, t);
    }

    // Pass 1 — CANCEL dead / stale rows; remember which triggers still hold a
    // valid pending row (so pass 2 does not double-seed them). Staleness is the
    // full ref (`isRefFresh`), so a bounds-only edit — invisible to a bare
    // schedule-string compare — is caught too (#5 S5b-2).
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
      const trigger = schedulable.get(parsed.data.triggerId);
      if (trigger === undefined || !isRefFresh(trigger, parsed.data)) {
        // DELETE, not cancel: a cancelled row keeps its `(kind, dedupeKey)`, so a
        // re-seed of the SAME occurrence after a disable→re-enable (or edit→revert)
        // within one interval would collide with the dead row and silently never
        // arm. Deleting the dropped PENDING row frees the key. `deleteWakeup` is
        // guarded to `status='pending'`, so a fired/suppressed sibling is untouched.
        deleteWakeup(db, row.id);
      } else {
        keep.add(trigger.id);
      }
    }

    // Pass 2 — SEED any schedulable trigger left without a valid pending row.
    for (const [triggerId, trigger] of schedulable) {
      if (!keep.has(triggerId)) seed(trigger);
    }
  }

  function stop(): void {
    stopped = true;
  }

  return { sync, stop };
}
