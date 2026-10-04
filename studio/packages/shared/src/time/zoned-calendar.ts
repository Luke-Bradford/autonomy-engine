/**
 * #1525 — a time zone's LOCAL CALENDAR, the one implementation of "which local
 * day is this instant on" and "at which instant does a local day begin".
 *
 * Both places that ask use this one: the scheduler's zone-aware period model
 * (`scheduler/recurrence.ts`) and the web app's display-zone day filter
 * (`lib/displayTime.ts`), so the two cannot disagree about where a day begins.
 *
 * ## Why bisection, not an offset inverse
 *
 * A naive wall-clock→instant inverse OVER-CORRECTS across a DST gap at midnight
 * (a zone that springs forward at 00:00, e.g. America/Santiago) and lands on the
 * PREVIOUS local day. Bisection on the local day number is exact for every
 * transition — gap, fall-back, sub-hour offset, even a fully skipped civil day
 * (Samoa 2011-12-30) — because the local day number is monotonic non-decreasing
 * in the instant: local time never runs backward across a day boundary.
 *
 * - A day whose midnight happens twice (a fall-back from 01:00 to 00:00) begins
 *   at the FIRST one: the first instant whose day number reaches the target.
 * - A day whose midnight is skipped begins at the first instant it has.
 * - A day the zone skipped entirely begins where the next day begins, so the
 *   range "on that day" is empty — which is the truth.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A local calendar date: `month` is 1-12. */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/**
 * A stable integer per civil calendar day: days since 1970-01-01. Built with
 * `setUTCFullYear`, not `Date.UTC`, which reads a year below 100 as 19xx. A day
 * past the end of a month rolls over (`2026-02-30` is day `2026-03-02`), as
 * `Date` does; a caller that must refuse one validates first.
 */
export function civilDayNumber(year: number, month: number, day: number): number {
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  return at.getTime() / DAY_MS;
}

export interface ZonedCalendar {
  /** The local calendar date `ms` falls on. */
  date(ms: number): CalendarDate;
  /** The civil day number (`civilDayNumber`) of the local date `ms` falls on. */
  dayNumber(ms: number): number;
  /** The first instant of the local calendar day `dayNumber`, as epoch ms. */
  dayStart(dayNumber: number): number;
}

/**
 * The local calendar of `timeZone`, an IANA zone the runtime accepts
 * (`isValidTimeZone`). Construction builds ONE `Intl.DateTimeFormat`, the costly
 * part, so a caller that asks many questions of one zone builds one calendar.
 * `Intl.DateTimeFormat` throws a `RangeError` for a zone it does not know.
 */
export function zonedCalendar(timeZone: string): ZonedCalendar {
  /* Only Y/M/D, and a `second` for the whole-minute-offset guard in `dayStart`
     (#626), are extracted; never the HOUR, so the ICU "24:00 vs 00:00" midnight
     quirk cannot bite. A `second` with no `hour`/`minute` IS emitted by Node's
     ICU, pinned by a test so a build that dropped it fails loudly. An engine
     that did drop it would read `NaN` there and take the exact 1ms path every
     time: slower, never wrong. */
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    second: '2-digit',
  });
  const date = (ms: number): CalendarDate => {
    const parts = dtf.formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return { year: get('year'), month: get('month'), day: get('day') };
  };
  const dayNumber = (ms: number): number => {
    const { year, month, day } = date(ms);
    return civilDayNumber(year, month, day);
  };
  /* The zone's local SECOND-of-minute at a MINUTE-ALIGNED UTC instant — which,
     at such an instant, IS the sub-minute component of the zone's offset: 0 for
     every modern IANA offset (the half- and three-quarter-hour zones included —
     +05:30, +05:45, +12:45 are all whole MINUTES), and non-zero only for a
     pre-standardization LMT offset (America/New_York's −04:56:02 before 1883
     reads 58). `Number(...)`, never `=== '00'`: ICU renders a zero second "0". */
  const secondOfMinute = (ms: number): number =>
    Number(dtf.formatToParts(new Date(ms)).find((p) => p.type === 'second')?.value);

  /* The first instant whose local day number is >= `target`. #626 — bisect on
     the MINUTE grid, not the ms grid: a modern offset is whole minutes, so a
     local-day boundary lands on a minute-aligned UTC instant, and the minute
     grid brackets it in ~13 `formatToParts` calls instead of ~27. The scheduler
     can probe up to `MAX_PERIOD_PROBES` periods, so that halving matters.
     `target · DAY_MS ± DAY_MS` is minute-aligned, so this runs in integer
     minutes; the ±1 day window covers every offset (they are within ±14h). */
  const dayStart = (target: number): number => {
    let loMin = (target * DAY_MS - DAY_MS) / MINUTE_MS; // dayNumber(loMin·min) < target
    let hiMin = (target * DAY_MS + DAY_MS) / MINUTE_MS; // dayNumber(hiMin·min) >= target
    while (hiMin - loMin > 1) {
      const midMin = loMin + Math.floor((hiMin - loMin) / 2);
      if (dayNumber(midMin * MINUTE_MS) >= target) hiMin = midMin;
      else loMin = midMin;
    }
    const hi = hiMin * MINUTE_MS;
    /* WHOLE-MINUTE-OFFSET GUARD. The true boundary B is in (hi − 1min, hi].
       With a whole-minute offset B is minute-aligned, so B = hi, and `hi` then
       reads local second 0. A non-zero second means a sub-minute (LMT) offset,
       where B may fall inside the last minute: bisect that minute to the ms.
       The one uncovered sliver is a sub-minute TRANSITION inside the last minute
       while `hi` still reads second 0 — pre-standardization only, never a live
       zone. */
    if (secondOfMinute(hi) === 0) return hi;
    let lo = hi - MINUTE_MS; // dayNumber(lo) < target (loop invariant)
    let h = hi;
    while (h - lo > 1) {
      const mid = lo + Math.floor((h - lo) / 2);
      if (dayNumber(mid) >= target) h = mid;
      else lo = mid;
    }
    return h;
  };

  return { date, dayNumber, dayStart };
}
