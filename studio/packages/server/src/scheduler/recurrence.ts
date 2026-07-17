import { Cron } from 'croner';

/**
 * #5 S5 — croner as a RECURRENCE CALCULATOR, not a firing source.
 *
 * The spec's load-bearing inversion (codex-hardened CORE): the old scheduler
 * kept a live `Cron` per trigger whose CALLBACK fired — an in-memory timer that
 * a restart silently lost. Here croner only ever COMPUTES "the next occurrence
 * strictly after `from`", which the caller persists as a durable `scheduled_wakeups`
 * row (S1). One clock, one persistence, one boot re-arm.
 *
 * This is the SINGLE seam both the reconciler (`scheduler.ts`) and the alarm
 * handler (`schedule-tick.ts`) compute through, so they cannot disagree about
 * when a trigger is next due (CLAUDE.md: single source of truth).
 *
 * TIMEZONE — always UTC, matching the run-window UTC contract, so a self-hosted
 * instance behaves identically regardless of host timezone.
 */

/**
 * A cron string the trigger schema accepted but croner cannot parse. The trigger
 * schema does NOT validate cron syntax (see `TriggerSchema.schedule`), so a bad
 * string can reach the calculator. A TYPED error lets callers SUPPRESS the alarm
 * (settle it, no re-arm) or SKIP the trigger in a reconcile — never let a raw
 * croner throw escape and, inside the alarm clock's transaction, roll back and
 * re-deliver the same row every tick FOREVER (the forever-spin the retry
 * handler's `DocUnresolvableError` guard exists to prevent for its own kind).
 */
export class InvalidScheduleError extends Error {
  constructor(
    readonly schedule: string,
    readonly cause: unknown,
  ) {
    super(`invalid cron schedule: ${JSON.stringify(schedule)}`);
    this.name = 'InvalidScheduleError';
  }
}

/**
 * The next fire time STRICTLY AFTER `fromEpochMs`, as epoch ms, or `null` if the
 * schedule has no further occurrence (a finite one-shot already in the past).
 *
 * Computes next-from-`from`, so every slot missed during downtime is SKIPPED —
 * which is what makes schedule catch-up "no-backfill / ≤1 late fire" structural
 * rather than a policy the outbox has to enforce.
 *
 * @throws {InvalidScheduleError} if `schedule` is not a cron string croner can parse.
 */
export function nextOccurrence(schedule: string, fromEpochMs: number): number | null {
  let cron: Cron;
  try {
    cron = new Cron(schedule, { timezone: 'UTC' });
  } catch (err) {
    throw new InvalidScheduleError(schedule, err);
  }
  const next = cron.nextRun(new Date(fromEpochMs));
  return next === null ? null : next.getTime();
}
