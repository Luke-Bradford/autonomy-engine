import { Cron } from 'croner';
import type { RecurrenceFrequency } from '@autonomy-studio/shared';

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
 * #5 S5b (#550) — "every N periods" stepping. The compiled cron carries only the
 * WITHIN-period pattern (which minutes/hours/days); `step` gates fires to the
 * QUALIFYING periods — those an integer multiple of `interval` periods from the
 * `anchorEpochMs`. Absent (or `interval <= 1`) → every period fires, exactly the
 * pre-#550 behaviour.
 *
 * The anchor is the recurrence's `startTime` (also the `startAt` bound), so period
 * 0 is the anchor's period and every qualifying period is `k·interval` after it.
 * `frequency` fixes the period UNIT; a period's ordinal is computed relative to the
 * anchor so "every 2 weeks from a Wednesday" is 7-day blocks from that Wednesday —
 * studio's DOCUMENTED startTime-anchored semantics (the spec rejects the
 * period-grid anchoring that cron-step "slash-N" syntax would give).
 */
export interface OccurrenceStep {
  frequency: RecurrenceFrequency;
  interval: number;
  anchorEpochMs: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Safety backstop for the stepping probe: the maximum number of qualifying periods
 * to look ahead before declaring the series exhausted (`null`). A well-formed
 * recurrence lands its next fire in the first qualifying period; only one whose
 * qualifying periods NEVER contain a valid occurrence (e.g. the 30th every 12
 * months — the only qualifying months are Februaries, which have no 30th) probes to
 * the cap. `MAX_RECURRENCE_INTERVAL` (write cap) bounds how FAR apart qualifying
 * periods are; this bounds how MANY are probed. 1000 periods is generous
 * head-room over any real cadence.
 */
const MAX_PERIOD_PROBES = 1000;

/**
 * The period model for a `frequency`, anchored at `anchor`:
 *  - `ordinal(ms)` = which period (relative to the anchor's period) an instant is
 *    in — 0 for the anchor's own period, increasing forward. Qualifying ⇔
 *    `ordinal % interval === 0`.
 *  - `startInstant(rel)` = the epoch-ms START of the period `rel` steps after the
 *    anchor's period — the instant the jump seeks the first occurrence at/after.
 * All computed in UTC (matching the whole firing chain's UTC contract); the
 * fixed-length units (minute/hour/day/week) are pure integer arithmetic with no
 * DST/leap hazard, and month is calendar arithmetic on UTC year/month.
 */
function periodModel(
  frequency: RecurrenceFrequency,
  anchor: number,
): { ordinal: (ms: number) => number; startInstant: (rel: number) => number } {
  if (frequency === 'month') {
    const anchorOrd = new Date(anchor).getUTCFullYear() * 12 + new Date(anchor).getUTCMonth();
    return {
      ordinal: (ms) => {
        const d = new Date(ms);
        return d.getUTCFullYear() * 12 + d.getUTCMonth() - anchorOrd;
      },
      startInstant: (rel) => {
        const abs = anchorOrd + rel;
        return Date.UTC(Math.floor(abs / 12), abs % 12, 1);
      },
    };
  }
  if (frequency === 'week') {
    // A "week" is a rolling 7-day block from the anchor's calendar DAY (UTC).
    const anchorDay = Math.floor(anchor / DAY_MS);
    return {
      ordinal: (ms) => Math.floor((Math.floor(ms / DAY_MS) - anchorDay) / 7),
      startInstant: (rel) => (anchorDay + rel * 7) * DAY_MS,
    };
  }
  const unit = frequency === 'minute' ? MINUTE_MS : frequency === 'hour' ? HOUR_MS : DAY_MS;
  const anchorOrd = Math.floor(anchor / unit);
  return {
    ordinal: (ms) => Math.floor(ms / unit) - anchorOrd,
    startInstant: (rel) => (anchorOrd + rel) * unit,
  };
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
 * croner's `startAt`/`stopAt` are BOTH exclusive and second-truncated (FLOORED):
 * it fires an occurrence iff `occurrence > floor(startAt)` and `occurrence <
 * floor(stopAt)` (verified empirically). We expose a half-open `[startAt, stopAt)`
 * — inclusive start, exclusive end, to millisecond precision — by compensating for
 * both the floor and the exclusivity SYMMETRICALLY:
 *   - `startAt` INCLUSIVE: hand croner `startAt - 1ms`. Because croner FLOORS,
 *     `floor(startAt - 1ms)` is `floor(startAt) - 1s` ONLY when `startAt` is exactly
 *     on a second and `floor(startAt)` otherwise — so croner returns exactly "the
 *     first occurrence `>= startAt`": an occurrence on a whole-second `startAt` fires
 *     (inclusive), while a sub-second `startAt` (e.g. `…:00.500Z`) does NOT re-admit
 *     the earlier `…:00.000` slot (a full `-1s` nudge would).
 *   - `stopAt` EXCLUSIVE: hand croner `ceil(stopAt)` (rounded UP to the second).
 *     `floor(ceil(stopAt))` is `stopAt` for a whole-second bound (exact exclusive
 *     end — an occurrence AT `stopAt` is excluded) and `ceil(stopAt)` for a
 *     sub-second bound, so an occurrence strictly before the raw `stopAt` instant
 *     (e.g. the `…:00.000` slot under a `…:00.500Z` end) is NOT wrongly excluded.
 * Both compensations rely only on: (a) croner floors + compares exclusively, and
 * (b) the compiled schedules are 5-field crons (minute granularity —
 * `recurrenceToCron`), whose occurrences all land on whole seconds. Bounds only
 * exist on a recurrence trigger, whose `schedule` is always such a compiled cron (a
 * raw-cron escape-hatch trigger has no `recurrence`, thus no bounds).
 *
 * These boundary semantics ARE croner-internal (floor + exclusivity), so croner is
 * EXACT-pinned (`10.0.1`, no caret — see `package.json`) and the guard against a
 * silent semantics change on upgrade is the boundary CHARACTERIZATION suite in
 * `__tests__/recurrence.test.ts` (inclusive whole-second start, excluded
 * sub-second-early slot, exclusive end): a croner upgrade that changed floor or
 * exclusivity fails those tests LOUDLY at CI rather than mis-enforcing a window.
 *
 * ## `step` (#5 S5b, #550) — "every N periods"
 *
 * With a `step` whose `interval > 1`, only occurrences in QUALIFYING periods fire.
 * The cron enumerates the within-period pattern; this walks it forward, and on a
 * non-qualifying candidate JUMPS croner to the start of the next qualifying period
 * rather than enumerating every skipped occurrence — so the work per fire is
 * O(periods skipped), not O(occurrences skipped), independent of how dense the
 * within-period pattern is. A qualifying period with no occurrence (e.g. the 30th
 * of a February) advances to the next; if none is found within `MAX_PERIOD_PROBES`
 * (or croner exhausts a finite/bounded schedule), the result is `null` — the same
 * "nothing more to arm" a finite schedule yields, settling the chain rather than
 * spinning.
 *
 * @throws {InvalidScheduleError} if `schedule` is not a cron string croner can
 *   parse (a malformed bound would also surface here — but callers pass
 *   `z.string().datetime()`-validated bounds, so that path is a belt), OR if a
 *   `step` with `interval > 1` carries a non-finite `anchorEpochMs` (a
 *   write-impossible interval>1-without-startTime row — fail CLOSED, never
 *   over-fire).
 */
export function nextOccurrence(
  schedule: string,
  fromEpochMs: number,
  bounds: OccurrenceBounds = {},
  step?: OccurrenceStep,
): number | null {
  let cron: Cron;
  try {
    const options: { timezone: string; startAt?: Date; stopAt?: Date } = { timezone: 'UTC' };
    // Inclusive `startAt`: nudge 1ms earlier so a whole-second boundary occurrence
    // clears croner's floored-exclusive comparison WITHOUT re-admitting a
    // sub-second-early slot (see the boundary contract above).
    if (bounds.startAt !== undefined) options.startAt = new Date(bounds.startAt - 1);
    // Exclusive `stopAt`: round UP to the second so a sub-second end does not
    // wrongly exclude an occurrence strictly before the raw instant, while a
    // whole-second end stays an exact exclusive bound (symmetric to startAt).
    if (bounds.stopAt !== undefined) {
      options.stopAt = new Date(Math.ceil(bounds.stopAt / 1000) * 1000);
    }
    cron = new Cron(schedule, options);
  } catch (err) {
    throw new InvalidScheduleError(schedule, err);
  }

  // No stepping (absent, or the every-period base case): the plain calculator.
  if (step === undefined || step.interval <= 1) {
    const next = cron.nextRun(new Date(fromEpochMs));
    return next === null ? null : next.getTime();
  }

  // #550 — every-N-period stepping. A non-finite anchor is write-impossible (the
  // write schema requires startTime for interval>1) but a corrupt/imported row
  // could reach here; fail closed rather than mis-fire.
  if (!Number.isFinite(step.anchorEpochMs)) {
    throw new InvalidScheduleError(schedule, new Error('interval > 1 requires a finite anchor'));
  }
  const { ordinal, startInstant } = periodModel(step.frequency, step.anchorEpochMs);
  let candidate = cron.nextRun(new Date(fromEpochMs));
  for (let probes = 0; candidate !== null && probes < MAX_PERIOD_PROBES; probes++) {
    const rel = ordinal(candidate.getTime());
    // Qualifying ⇔ a NON-NEGATIVE multiple of `interval` from the anchor. The
    // `rel >= 0` half matters only defensively: production always pairs `step`
    // with `startAt === anchor` (both derive from `startTime` — see
    // `recurrenceStep`/`scheduleBounds`), so croner never returns a candidate
    // before the anchor and `rel >= 0` holds. Were a caller to pass `step` with no
    // `startAt`, JS's negative modulo (`-2 % 2 === 0`) would otherwise false-qualify
    // a pre-anchor period; the guard rejects it and the jump below advances to
    // period 0 (the anchor's period).
    if (rel >= 0 && rel % step.interval === 0) return candidate.getTime();
    // Jump croner to the start of the next qualifying period (the first multiple of
    // `interval` strictly after this candidate's period). `startInstant - 1ms`
    // reuses the inclusive-boundary compensation so an occurrence exactly at the
    // period start is not skipped.
    const nextQualifying = (Math.floor(rel / step.interval) + 1) * step.interval;
    candidate = cron.nextRun(new Date(startInstant(nextQualifying) - 1));
  }
  return null;
}
