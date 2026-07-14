import { Cron } from 'croner';
import { isWithinRunWindows, type Trigger } from '@autonomy-studio/shared';
import { getTrigger, listParsedTriggers } from '../repo/triggers.js';
import { UnboundTriggerError, type RunLauncher } from '../run/launcher.js';
import type { Db } from '../repo/types.js';

/**
 * P4b — the SCHEDULER: the automatic firing loop for `schedule`-mode triggers.
 * It owns one `croner` `Cron` per eligible trigger and, on each tick, funnels
 * the fire through the shared run LAUNCHER — so the two load-bearing rules
 * ("unbound never fires" + concurrency admission) live in ONE place (the
 * launcher), and the scheduler adds only the two concerns that are ITS job:
 *
 *   1. **When** to fire — the cron expression (via `croner`).
 *   2. **Whether** an automatic fire is currently allowed — the trigger's
 *      run windows (`isWithinRunWindows`). A manual "run now" is an explicit
 *      operator override and is NOT gated by windows; only automatic firing is.
 *
 * DEFERRED REQ (load-bearing, per the P4 plan): the scheduler MUST refuse to
 * fire a trigger with `pipelineVersionId === null`. It does so explicitly in
 * `dispatch` (skip + debug log) AND relies on the launcher throwing
 * `UnboundTriggerError` as the backstop — "unbound never fires" is defended in
 * both places.
 *
 * DESIGN — freshness over caching. A `Cron`'s tick captures only the trigger
 * ID; `dispatch` RE-READS the trigger from the DB every tick, so a trigger that
 * was disabled, rebound, re-windowed, or deleted between ticks always fires (or
 * skips) against its CURRENT state, even before the next `sync()`. `sync()`
 * itself only decides which cron SCHEDULES exist; correctness of any single
 * fire never depends on `sync()` having run.
 *
 * TIMEZONE — every `Cron` runs in UTC, matching the run-window UTC contract, so
 * a self-hosted instance behaves identically regardless of the host timezone.
 *
 * Per-app (a `createScheduler()` factory injected into `buildApp`, mirroring
 * `createSupervisor`/`createRunLauncher`), so its cron set never leaks across
 * app instances (test isolation, multi-tenant).
 */

/** Minimal logger seam (Fastify's `log` satisfies it); optional for tests. */
export interface SchedulerLog {
  error(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface Scheduler {
  /**
   * Reconcile the live cron set against the DB: schedule newly-eligible
   * triggers, re-schedule ones whose cron expression changed, and stop crons
   * for triggers that are no longer eligible (disabled, mode changed, unbound,
   * schedule cleared, or deleted). Idempotent — safe to call at boot and after
   * every trigger write. A no-op once `stop()`ped.
   */
  sync(): void;
  /**
   * The tick body for one trigger, exposed for direct (deterministic) testing
   * and called by each `Cron`. Re-reads the trigger fresh and either fires it
   * through the launcher or skips (disabled / wrong mode / unbound / outside a
   * run window). Never throws — a scheduler tick must not crash the process.
   */
  dispatch(triggerId: string): void;
  /** The trigger IDs that currently have a live cron scheduled — for tests and
   * introspection. */
  scheduledTriggerIds(): string[];
  /** Stop every cron and stop accepting new schedules. Idempotent. */
  stop(): void;
}

export interface SchedulerDeps {
  db: Db;
  /** The run launcher — only its `fire` is used. */
  launcher: Pick<RunLauncher, 'fire'>;
  log?: SchedulerLog;
  /** Clock seam for run-window evaluation; defaults to the wall clock. */
  now?: () => Date;
}

/** A trigger is eligible for a cron iff it is enabled, in `schedule` mode, and
 * carries a (syntactically present) cron expression. Binding is intentionally
 * NOT checked here — an enabled trigger is already guaranteed bound by the
 * write API's `assertBindableIfEnabled`, and `dispatch` re-checks binding at
 * fire time regardless, so eligibility stays about scheduling, not firing. */
function isSchedulable(t: Trigger): boolean {
  return t.enabled && t.mode === 'schedule' && t.schedule !== null;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { db, launcher } = deps;
  const now = deps.now ?? (() => new Date());
  /** triggerId → its live cron + the expression it was built from (so `sync`
   * can detect an expression change and re-schedule). */
  const crons = new Map<string, { cron: Cron; schedule: string }>();
  let stopped = false;

  function dispatch(triggerId: string): void {
    // ONE structural try/catch wraps the WHOLE tick body so "a scheduler tick
    // never crashes the process" is guaranteed by construction, not by every
    // read/check/fire being individually guarded: a throw from `getTrigger`
    // (DB error), `now()`, or `launcher.fire` is caught here. croner invokes
    // this callback via an un-awaited async trigger and defaults `catch:false`,
    // so an escaped throw would become a floating unhandled rejection — this
    // catch (plus `catch:true` on the Cron below) prevents that.
    try {
      const trigger = getTrigger(db, triggerId);
      // Stale cron: the trigger was deleted, disabled, or changed mode/schedule
      // since this cron was created. Skip quietly — the next `sync()` prunes the
      // cron; correctness here is just "don't fire something ineligible".
      if (trigger === null || !isSchedulable(trigger)) return;
      // DEFERRED REQ: unbound never fires. Belt to the launcher's suspenders.
      if (trigger.pipelineVersionId === null) {
        deps.log?.debug({ triggerId }, 'scheduler: skip — trigger is unbound');
        return;
      }
      // Automatic-fire gate: run windows block NEW starts (manual fire is exempt).
      if (!isWithinRunWindows(trigger.runWindows, now())) {
        deps.log?.debug({ triggerId }, 'scheduler: skip — outside run window');
        return;
      }
      launcher.fire(trigger);
    } catch (err) {
      if (err instanceof UnboundTriggerError) {
        // Raced to unbound between the check above and the fire — safe skip.
        deps.log?.debug({ triggerId }, 'scheduler: skip — trigger became unbound');
        return;
      }
      // Any other fault (a DB read error, a launcher bug) must not crash the
      // tick — log and move on; the next tick re-reads fresh state.
      deps.log?.error({ err, triggerId }, 'scheduler: tick failed');
    }
  }

  function scheduleOne(t: Trigger): void {
    const schedule = t.schedule as string; // isSchedulable guarantees non-null
    try {
      // UTC so behaviour is host-timezone-independent; the tick captures only
      // the ID and re-reads fresh state in `dispatch`. `catch:true` makes
      // croner swallow any callback throw (defence-in-depth atop `dispatch`'s
      // own try/catch) so a tick can never surface an unhandled rejection.
      const cron = new Cron(schedule, { timezone: 'UTC', catch: true }, () => dispatch(t.id));
      crons.set(t.id, { cron, schedule });
    } catch (err) {
      // An invalid cron expression must never crash `sync()` — fail safe by
      // leaving this trigger unscheduled and logging loudly. (The trigger
      // schema does not yet validate cron syntax, so a bad string can exist.)
      deps.log?.warn({ err, triggerId: t.id, schedule }, 'scheduler: invalid cron expression');
    }
  }

  function sync(): void {
    if (stopped) return;
    let all: Trigger[];
    try {
      // Resilient: a single corrupt/legacy row is SKIPPED (and warned), not
      // allowed to throw out the whole list — otherwise one poison row would
      // dark-out ALL scheduling, the same blast-radius the per-cron try/catch
      // in `scheduleOne` exists to prevent.
      all = listParsedTriggers(db, (triggerId, err) =>
        deps.log?.warn({ err, triggerId }, 'scheduler: skipping unparseable trigger row'),
      );
    } catch (err) {
      deps.log?.error({ err }, 'scheduler: failed to list triggers on sync');
      return;
    }
    const desired = new Map<string, Trigger>();
    for (const t of all) {
      if (isSchedulable(t)) desired.set(t.id, t);
    }

    // Stop crons that are gone or whose expression changed.
    for (const [triggerId, entry] of crons) {
      const want = desired.get(triggerId);
      if (want === undefined || want.schedule !== entry.schedule) {
        entry.cron.stop();
        crons.delete(triggerId);
      }
    }
    // Schedule triggers that are newly eligible or were just re-scheduled.
    for (const [triggerId, t] of desired) {
      if (!crons.has(triggerId)) scheduleOne(t);
    }
  }

  function scheduledTriggerIds(): string[] {
    return [...crons.keys()];
  }

  function stop(): void {
    stopped = true;
    for (const { cron } of crons.values()) cron.stop();
    crons.clear();
  }

  return { sync, dispatch, scheduledTriggerIds, stop };
}
