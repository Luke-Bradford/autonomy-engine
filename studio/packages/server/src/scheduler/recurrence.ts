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
 * A recurrence's firing window (#5 S5b-2, #549), as epoch ms — a half-open
 * `[startAt, stopAt)`. Both optional/open-ended; a bounds-free call is exactly the
 * pre-S5b-2 behaviour. `startAt` is INCLUSIVE (an occurrence exactly at `startAt`
 * fires), `stopAt` is EXCLUSIVE (an occurrence exactly at `stopAt` does not — the
 * window has ended).
 */
export interface OccurrenceBounds {
  startAt?: number;
  stopAt?: number;
}

/**
 * The next fire time STRICTLY AFTER `fromEpochMs` and within the (optional) bounds
 * window, as epoch ms, or `null` if the schedule has no further occurrence (a
 * finite one-shot in the past, or the `[startAt, stopAt)` window is exhausted).
 *
 * Computes next-from-`from`, so every slot missed during downtime is SKIPPED —
 * which is what makes schedule catch-up "no-backfill / ≤1 late fire" structural
 * rather than a policy the outbox has to enforce.
 *
 * ## Boundary contract vs croner-native semantics (verified empirically, croner 10.0.1)
 *
 * croner's `startAt`/`stopAt` are BOTH exclusive at the exact second (an occurrence
 * that lands exactly on the bound is skipped), and second-truncated. We expose a
 * half-open `[startAt, stopAt)` instead:
 *   - `stopAt` EXCLUSIVE matches croner directly — pass it through.
 *   - `startAt` INCLUSIVE does NOT — so we nudge it back by 1s before handing it to
 *     croner, which admits an occurrence landing exactly on `startAt` while
 *     admitting no spurious earlier one: the compiled schedules are 5-field crons
 *     (minute granularity — `recurrenceToCron`), whose only occurrence in the
 *     `(startAt-1s, startAt]` interval is `startAt` itself. (Bounds only exist on a
 *     recurrence trigger, whose `schedule` is always a compiled cron; a raw-cron
 *     escape-hatch trigger has no `recurrence` and thus no bounds.)
 *
 * @throws {InvalidScheduleError} if `schedule` is not a cron string croner can
 *   parse (a malformed bound would also surface here — but callers pass
 *   `z.string().datetime()`-validated bounds, so that path is a belt).
 */
export function nextOccurrence(
  schedule: string,
  fromEpochMs: number,
  bounds: OccurrenceBounds = {},
): number | null {
  let cron: Cron;
  try {
    const options: { timezone: string; startAt?: Date; stopAt?: Date } = { timezone: 'UTC' };
    // Inclusive `startAt`: nudge 1s earlier so an exact-boundary occurrence clears
    // croner's exclusive comparison (see the boundary contract above).
    if (bounds.startAt !== undefined) options.startAt = new Date(bounds.startAt - 1000);
    // Exclusive `stopAt`: croner-native, pass through.
    if (bounds.stopAt !== undefined) options.stopAt = new Date(bounds.stopAt);
    cron = new Cron(schedule, options);
  } catch (err) {
    throw new InvalidScheduleError(schedule, err);
  }
  const next = cron.nextRun(new Date(fromEpochMs));
  return next === null ? null : next.getTime();
}
