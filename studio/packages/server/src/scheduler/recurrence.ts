import { Cron } from 'croner';
import { isValidTimeZone, type RecurrenceFrequency } from '@autonomy-studio/shared';

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
 * TIMEZONE — UTC by DEFAULT (matching the run-window UTC contract, so a self-hosted
 * instance behaves identically regardless of host timezone), but a recurrence may
 * name an IANA `timeZone` (#5 S5b-timeZone, #552) in which the cron pattern is
 * INTERPRETED — a daily `09:00` in `America/New_York` fires at 09:00 NY wall-clock
 * (14:00Z winter / 13:00Z summer; croner tracks the DST shift). The zone governs
 * only WHICH instants the pattern picks; the `[startAt, stopAt)` bounds are absolute
 * instants and so are unaffected by it, and run windows stay UTC (a two-zoned but
 * coherent seam, documented at `schedule-tick.ts`).
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
 * The period model for a `frequency`, anchored at `anchor`, INTERPRETED in
 * `timeZone`:
 *  - `ordinal(ms)` = which period (relative to the anchor's period) an instant is
 *    in — 0 for the anchor's own period, increasing forward. Qualifying ⇔
 *    `ordinal % interval === 0`.
 *  - `startInstant(rel)` = the epoch-ms START of the period `rel` steps after the
 *    anchor's period — the instant the jump seeks the first occurrence at/after.
 *
 * ## UTC vs zone-aware (#5 S5b-timeZone stepping, #623)
 *
 * For `timeZone === 'UTC'` (the default) AND for the fixed-length `minute`/`hour`
 * units in ANY zone, the model is pure integer UTC arithmetic — no DST/leap hazard.
 * `minute`/`hour` periods are absolute durations a zone cannot stretch: an every-N
 * minute/hour cadence is the same wall-independent grid regardless of `timeZone`,
 * so the UTC arithmetic is correct even under a non-UTC recurrence (verified
 * empirically: croner's every-minute enumeration is uniform 60s across DST). This
 * keeps the whole UTC path byte-identical to pre-#623.
 *
 * For a NON-UTC `day`/`week`/`month` (calendar units whose length AND boundary move
 * with the zone's local calendar — a DST day is 23h or 25h), the grid is the zone's
 * LOCAL calendar: `ordinal` counts local calendar days/weeks/months, and
 * `startInstant` returns the exact instant a local period begins. That local-period
 * boundary is found by MONOTONIC BISECTION on the local-day number
 * (`localDayStartInstant`) rather than an offset-inverse, because a naive
 * wall-clock→instant inverse OVER-CORRECTS across a DST gap at midnight (a rare
 * zone that springs forward at 00:00, e.g. historical America/Santiago) and lands
 * on the PREVIOUS local day. Bisection is exact for every transition — gap,
 * fall-back, sub-hour-offset, even a fully-skipped civil day (Samoa 2011-12-30) —
 * because the local-day number is monotonic non-decreasing in the instant.
 *
 * `hour` in a non-UTC zone is NOT modelled here — it is refused up front by
 * `nextOccurrence` (and the write schema), because croner enumerates an `hour`
 * pattern by WALL-CLOCK hour, which skips/repeats an absolute hour across DST
 * (verified empirically), so absolute-hour ordinals mis-qualify. See `nextOccurrence`.
 */
function periodModel(
  frequency: RecurrenceFrequency,
  anchor: number,
  timeZone: string,
): { ordinal: (ms: number) => number; startInstant: (rel: number) => number } {
  const zoneAware =
    timeZone !== 'UTC' && (frequency === 'day' || frequency === 'week' || frequency === 'month');

  if (zoneAware) {
    // One formatter for the whole model (construction is the costly part; reuse it).
    // Only Y/M/D — and a `second` for the whole-minute-offset guard in
    // `localDayStartInstant` (#626) — is extracted; never the HOUR, so the ICU
    // "24:00 vs 00:00" midnight quirk cannot bite, and the model needs only the local
    // calendar date. (A `second` field with no `hour`/`minute` IS emitted by this
    // runtime's ICU — the one non-obvious dependency here, pinned by a test so a future
    // Node/ICU build that dropped it fails LOUDLY rather than silently `NaN`-ing the
    // guard.)
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      second: '2-digit',
    });
    const localYmd = (ms: number): { y: number; mo: number; d: number } => {
      const parts = dtf.formatToParts(new Date(ms));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
      return { y: get('year'), mo: get('month'), d: get('day') };
    };
    // A stable integer per LOCAL calendar day: the civil day number of the zone's
    // local date. Monotonic non-decreasing in `ms` (local time never runs backward
    // across a day boundary), which is what makes the bisection below exact.
    const localDayNumber = (ms: number): number => {
      const { y, mo, d } = localYmd(ms);
      return Date.UTC(y, mo - 1, d) / DAY_MS;
    };
    // The zone's local SECOND-of-minute at a MINUTE-ALIGNED UTC instant — which, at
    // such an instant, IS the sub-minute component of the zone's UTC offset: 0 for
    // every modern whole-minute IANA offset (including the half/three-quarter-hour
    // zones — +05:30 Kolkata, +05:45 Kathmandu, +12:45 Chatham are all whole-MINUTE),
    // and non-zero only for a pre-standardization sub-minute LMT offset (e.g.
    // America/New_York's −04:56:02 before 1883, whose local second reads 58). The
    // whole-minute-offset guard below reads it to decide whether a minute-grid boundary
    // is exact. `Number(...)`, never a `=== '00'` compare: this ICU build renders a
    // zero second as "0".
    const localSecondOfMinute = (ms: number): number =>
      Number(dtf.formatToParts(new Date(ms)).find((p) => p.type === 'second')?.value);
    // The FIRST instant whose local-day number is >= `targetDayNum` — i.e. the exact
    // instant the target local calendar day BEGINS in `timeZone`, found by MONOTONIC
    // bisection (exact for any DST transition because `localDayNumber` is monotonic).
    // On a fully-SKIPPED civil day (no local instant maps to it) this returns the next
    // day's start; the stepping loop re-validates `ordinal` after the jump, so a
    // skipped qualifying period is just omitted at the cost of a bounded extra probe or
    // two — never a mis-fire, and the calendar-day grid keeps subsequent period parity
    // aligned.
    //
    // #626 — bisect on the MINUTE grid, not the ms grid: a modern IANA offset is a
    // whole number of minutes, so a local-day boundary lands on a minute-aligned UTC
    // instant, and the minute grid brackets it in ~half the `formatToParts` calls of a
    // 1ms bisection (~13 vs ~27) — which matters because the outer probe loop is
    // bounded only by `MAX_PERIOD_PROBES` (1000), so a degenerate never-qualifying
    // config would otherwise do tens of thousands of `Intl` calls. `targetDayNum ·
    // DAY_MS ± DAY_MS` is already minute-aligned (DAY_MS = 1440 · MINUTE_MS), so the
    // bisection runs in integer MINUTES with no rounding.
    const localDayStartInstant = (targetDayNum: number): number => {
      let loMin = (targetDayNum * DAY_MS - DAY_MS) / MINUTE_MS; // localDayNumber(loMin·min) < target
      let hiMin = (targetDayNum * DAY_MS + DAY_MS) / MINUTE_MS; // localDayNumber(hiMin·min) >= target
      while (hiMin - loMin > 1) {
        const midMin = loMin + Math.floor((hiMin - loMin) / 2);
        if (localDayNumber(midMin * MINUTE_MS) >= targetDayNum) hiMin = midMin;
        else loMin = midMin;
      }
      const hi = hiMin * MINUTE_MS;
      // WHOLE-MINUTE-OFFSET GUARD. After the loop the true boundary B satisfies
      // localDayNumber(hi − MINUTE_MS) < target <= localDayNumber(hi), so B ∈
      // (hi − MINUTE_MS, hi]. When the offset is whole-minute — every reachable
      // recurrence, since post-1970 IANA offsets AND their DST transitions are all
      // minute-aligned in UTC — B is minute-aligned, and the only minute-aligned
      // instant in that half-open interval is `hi`, so B = hi exactly and a
      // minute-aligned UTC instant then reads local second 0. A NON-zero second means
      // the offset carries a sub-minute component (a pre-standardization LMT era), so
      // the boundary may fall strictly inside the last minute: fall back to an exact
      // 1ms bisection of that final minute, preserving the pre-#626 exactness. The one
      // uncovered sliver is a sub-minute DST *transition* landing inside the last minute
      // while `hi` itself still reads second 0 — bounded to pre-standardization
      // transition days no real recurrence anchors to (the same era the model already
      // dismisses), never a live gap.
      if (localSecondOfMinute(hi) === 0) return hi;
      let lo = hi - MINUTE_MS; // == loMin·MINUTE_MS: localDayNumber(lo) < target (loop invariant)
      let h = hi;
      while (h - lo > 1) {
        const mid = lo + Math.floor((h - lo) / 2);
        if (localDayNumber(mid) >= targetDayNum) h = mid;
        else lo = mid;
      }
      return h;
    };

    if (frequency === 'month') {
      const { y, mo } = localYmd(anchor);
      const anchorOrd = y * 12 + (mo - 1);
      return {
        ordinal: (ms) => {
          const p = localYmd(ms);
          return p.y * 12 + (p.mo - 1) - anchorOrd;
        },
        // Start of the 1st (local calendar) of the target month.
        startInstant: (rel) => {
          const abs = anchorOrd + rel;
          const firstOfMonthDayNum = Date.UTC(Math.floor(abs / 12), abs % 12, 1) / DAY_MS;
          return localDayStartInstant(firstOfMonthDayNum);
        },
      };
    }
    if (frequency === 'week') {
      // A "week" is a rolling 7-day block from the anchor's LOCAL calendar day.
      const anchorDay = localDayNumber(anchor);
      return {
        ordinal: (ms) => Math.floor((localDayNumber(ms) - anchorDay) / 7),
        startInstant: (rel) => localDayStartInstant(anchorDay + rel * 7),
      };
    }
    // day
    const anchorDay = localDayNumber(anchor);
    return {
      ordinal: (ms) => localDayNumber(ms) - anchorDay,
      startInstant: (rel) => localDayStartInstant(anchorDay + rel),
    };
  }

  // UTC path (default zone, and minute/hour in any zone) — unchanged pre-#623
  // arithmetic: pure integer, no DST/leap hazard.
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
 * ## `timeZone` (#5 S5b-timeZone, #552)
 *
 * `timeZone` (default `'UTC'`) is the IANA zone croner INTERPRETS `schedule` in. A
 * bad zone does NOT throw at `new Cron(...)` — croner throws a raw `TypeError` at
 * `nextRun` (verified empirically, croner 10.0.1), which OUTSIDE a guard would roll
 * back inside the alarm clock's transaction and re-deliver the row forever (the
 * exact spin `InvalidScheduleError` exists to prevent). Two defenses: an unresolvable
 * non-UTC zone is rejected up front as `InvalidScheduleError` (the belt), AND the
 * whole croner interaction — construct AND every `nextRun` — is wrapped so ANY
 * croner throw (bad cron OR a zone `TypeError`) surfaces typed, never raw.
 *
 * `timeZone` governs `interval === 1` fully, and `interval > 1` ("every N periods")
 * for the `day`/`week`/`month`/`minute` frequencies (#623): `day`/`week`/`month` step
 * on the zone's LOCAL calendar grid (`periodModel` zone-aware branch), while `minute`
 * is a fixed absolute cadence a zone cannot stretch (so its UTC grid is already
 * correct). The one exception is `hour` stepping in a non-UTC zone: croner enumerates
 * an `hour` pattern by WALL-CLOCK hour, which SKIPS or REPEATS an absolute hour across
 * a DST transition (verified empirically, croner 10.0.1 — a NY fall-back skips an
 * absolute hour; a 30-min-DST zone like Lord Howe repeats one), so the absolute-hour
 * ordinal grid mis-qualifies. That single combination stays refused at the write
 * boundary AND fail-closed here as `InvalidScheduleError` (a lenient-read imported row
 * could still pair them), until a wall-clock-hour-aware model lands (follow-up).
 *
 * @throws {InvalidScheduleError} if `schedule` is not a cron string croner can
 *   parse (a malformed bound would also surface here — but callers pass
 *   `z.string().datetime()`-validated bounds, so that path is a belt), if `timeZone`
 *   is a non-UTC zone the runtime cannot resolve, if croner throws at any `nextRun`
 *   (e.g. a zone that slips past the belt), if a `step` with `interval > 1`
 *   carries a non-finite `anchorEpochMs` (a write-impossible
 *   interval>1-without-startTime row — fail CLOSED, never over-fire), OR if a `step`
 *   with `interval > 1` pairs an `hour` frequency with a non-UTC zone (the
 *   wall-clock-hour hazard above — fail CLOSED, never mis-qualify).
 */
export function nextOccurrence(
  schedule: string,
  fromEpochMs: number,
  bounds: OccurrenceBounds = {},
  step?: OccurrenceStep,
  timeZone = 'UTC',
): number | null {
  // Fail-closed guards BEFORE any croner (kept out of the wrapping try so their own
  // typed throws are not double-wrapped):
  //  - #552 belt: an unresolvable non-UTC zone would throw a raw TypeError at
  //    nextRun (croner does NOT validate the zone at construct); reject it here.
  if (timeZone !== 'UTC' && !isValidTimeZone(timeZone)) {
    throw new InvalidScheduleError(
      schedule,
      new Error(`invalid timeZone: ${JSON.stringify(timeZone)}`),
    );
  }
  //  - #550: a non-finite anchor is write-impossible (the write schema requires
  //    startTime for interval>1) but a corrupt/imported row could reach here.
  if (step !== undefined && step.interval > 1 && !Number.isFinite(step.anchorEpochMs)) {
    throw new InvalidScheduleError(schedule, new Error('interval > 1 requires a finite anchor'));
  }
  //  - #623: `hour`-frequency stepping in a non-UTC zone is refused (write schema
  //    too), but the READ shape is lenient — a corrupt/imported row could pair them.
  //    croner enumerates an `hour` pattern by WALL-CLOCK hour, which skips/repeats an
  //    absolute hour across DST, so the absolute-hour period grid mis-qualifies. Fail
  //    CLOSED here (same discipline as the anchor guard) rather than mis-fire. (The
  //    other frequencies ARE supported: day/week/month via the zone-aware period
  //    model, minute as a zone-independent absolute cadence.)
  if (step !== undefined && step.interval > 1 && step.frequency === 'hour' && timeZone !== 'UTC') {
    throw new InvalidScheduleError(
      schedule,
      new Error('interval > 1 hour-frequency stepping with a non-UTC timeZone is not supported'),
    );
  }

  // The ENTIRE croner interaction is wrapped — construct AND every `nextRun` — so a
  // raw croner throw (a malformed cron, or a zone TypeError that slips the belt)
  // never escapes untyped to spin the alarm; it becomes InvalidScheduleError, which
  // the handler suppresses (settle, no re-arm).
  try {
    const options: { timezone: string; startAt?: Date; stopAt?: Date } = { timezone: timeZone };
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
    const cron = new Cron(schedule, options);

    // No stepping (absent, or the every-period base case): the plain calculator.
    if (step === undefined || step.interval <= 1) {
      const next = cron.nextRun(new Date(fromEpochMs));
      return next === null ? null : next.getTime();
    }

    // #550 — every-N-period stepping. `periodModel` steps on the zone's LOCAL calendar
    // for a non-UTC day/week/month (#623) and on the UTC/absolute grid otherwise; the
    // one unsafe combination (non-UTC hour) is fail-closed above.
    const { ordinal, startInstant } = periodModel(step.frequency, step.anchorEpochMs, timeZone);
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
  } catch (err) {
    // Our own guards throw before the try; anything caught here is a croner throw.
    if (err instanceof InvalidScheduleError) throw err;
    throw new InvalidScheduleError(schedule, err);
  }
}
