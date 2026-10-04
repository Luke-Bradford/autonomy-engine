import { isValidTimeZone } from '@autonomy-studio/shared';

/**
 * #1484 OR35 principle 4 — every timestamp the app shows, in ONE display time
 * zone the viewer chooses, in ONE format.
 *
 * The zone is a per-viewer preference (`uiStore.displayTimeZone`), not a
 * workspace setting: two engineers reading the same run from different offices
 * each want their own wall clock, and the instant itself never changes. Under
 * CONFIG OVER DECISIONS the default is `local` (the browser's zone, which is
 * what every timestamp showed before this), with UTC and every IANA zone the
 * browser knows as pickable overrides.
 *
 * The format is ISO-ordered (`2026-10-04 13:05:07.123 GMT+1`) rather than the
 * browser locale's, so a column of timestamps sorts by eye and reads the same on
 * every machine. The zone is printed as the formatter's short name in `en-US`,
 * which is an OFFSET (`GMT+1`) for most zones and a name only where it is
 * unambiguous (`UTC`, `EDT`) — measured on Node 25, not assumed.
 *
 * Pure: every function takes the zone, and `now` where it needs one, as an
 * argument. The preference lives in `uiStore`, the hook in
 * `useDisplayTimeZone.ts`, and the component in `When.tsx`.
 */

/** `local`, or an IANA zone name such as `UTC` or `Europe/London`. */
export type DisplayTimeZone = string;

export const LOCAL_TIME_ZONE = 'local';
export const DEFAULT_DISPLAY_TIME_ZONE: DisplayTimeZone = LOCAL_TIME_ZONE;

/** The `timeZone` option `Intl` takes: `undefined` means the runtime's own. */
function intlZone(zone: DisplayTimeZone): string | undefined {
  return zone === LOCAL_TIME_ZONE ? undefined : zone;
}

/**
 * A stored or chosen zone, or `undefined` when the runtime cannot format in it.
 * The runtime is the authority: `Intl.DateTimeFormat` throws a `RangeError` for
 * a zone it does not know (`isValidTimeZone`, the check a recurrence's zone
 * already goes through), so a value stored by a newer browser, or typed into
 * storage by hand, falls back to the default instead of crashing every page
 * that shows a time.
 */
export function parseDisplayTimeZone(raw: string): DisplayTimeZone | undefined {
  if (raw === LOCAL_TIME_ZONE) return raw;
  return raw.length > 0 && isValidTimeZone(raw) ? raw : undefined;
}

/**
 * The zones the Settings picker offers: local, UTC, then every zone the runtime
 * lists. `Intl.supportedValuesOf` omits `UTC` itself (it lists `Etc/UTC`
 * spellings at most), which is why it is named explicitly; a runtime without
 * the API still offers the two that need no list.
 */
export function displayTimeZoneOptions(): DisplayTimeZone[] {
  const listed =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return [LOCAL_TIME_ZONE, 'UTC', ...listed.filter((zone) => zone !== 'UTC')];
}

interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  fraction: string;
  zoneName: string;
}

/* Formatters are costly to build (~25µs, against ~5µs to use one) and a grid
   renders hundreds of cells, so one per zone is kept, bounded by the zones a
   viewer ever picks. A cached `local` formatter keeps the machine zone it was
   built in; a machine that changes zone under an open tab shows the old one
   until a reload, which is the trade for a grid that renders fast. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: DisplayTimeZone): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: intlZone(zone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** The `Date` range: a finite number outside it is still not an instant, and
 * `formatToParts` throws on it. */
const MAX_INSTANT_MS = 8.64e15;

/** Whether `ms` is an instant a `Date` can hold. */
export function isInstant(ms: number): boolean {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_INSTANT_MS;
}

/** What a timestamp that is not an instant renders as — the old
 * `toLocaleString` said "Invalid Date" and did not throw, and a formatter must
 * not be the thing that crashes a page over one bad field. */
export const INVALID_TIME = 'invalid time';

function zonedParts(ms: number, zone: DisplayTimeZone): ZonedParts {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(zone).formatToParts(ms)) parts[part.type] = part.value;
  return {
    // `year: 'numeric'` does not pad: year 999 must still read `0999`.
    year: (parts.year ?? '').padStart(4, '0'),
    month: parts.month ?? '',
    day: parts.day ?? '',
    hour: parts.hour ?? '',
    minute: parts.minute ?? '',
    second: parts.second ?? '',
    fraction: parts.fractionalSecond ?? '000',
    zoneName: parts.timeZoneName ?? '',
  };
}

/** How much of the clock a timestamp shows: detail views show milliseconds. */
export type TimestampPrecision = 'second' | 'ms';

/** The zone's short name at an instant — `UTC`, `GMT+1`, `EDT` — for a
 * surface that shows only clock times and names the zone once. */
export function zoneLabel(ms: number, zone: DisplayTimeZone): string {
  return isInstant(ms) ? zonedParts(ms, zone).zoneName : '';
}

/** `2026-10-04 13:05:07 GMT+1`, or with `.123` at `ms` precision. */
export function formatTimestamp(
  ms: number,
  zone: DisplayTimeZone,
  precision: TimestampPrecision = 'second',
): string {
  if (!isInstant(ms)) return INVALID_TIME;
  const p = zonedParts(ms, zone);
  const fraction = precision === 'ms' ? `.${p.fraction}` : '';
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}${fraction} ${p.zoneName}`;
}

/** A time of day only — `13:05:07.123` — for a feed or axis whose day is known. */
export function formatTimeOfDay(
  ms: number,
  zone: DisplayTimeZone,
  precision: TimestampPrecision = 'second',
): string {
  if (!isInstant(ms)) return INVALID_TIME;
  const p = zonedParts(ms, zone);
  return `${p.hour}:${p.minute}:${p.second}${precision === 'ms' ? `.${p.fraction}` : ''}`;
}

/**
 * The runs grid's Started cell, which is 124px: `10-04 13:05:07` for a time in
 * the same year as `now` (in the display zone), else `2025-10-04 13:05`. The
 * zone and the full form are the cell's hover title (`When`), so the compact
 * text drops nothing that is not one hover away.
 */
export function formatCompactTimestamp(ms: number, zone: DisplayTimeZone, now: number): string {
  if (!isInstant(ms)) return INVALID_TIME;
  const p = zonedParts(ms, zone);
  if (p.year === zonedParts(now, zone).year) {
    return `${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3_600_000],
  ['month', 30 * 24 * 3_600_000],
  ['day', 24 * 3_600_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1_000],
];

const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** `3 minutes ago`, `in 2 hours`, `now` — the largest whole unit that fits. */
export function formatRelative(ms: number, now: number): string {
  const delta = ms - now;
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= size) return relativeFormat.format(Math.trunc(delta / size), unit);
  }
  return relativeFormat.format(0, 'second');
}

/** The `YYYY-MM-DD` calendar day an instant falls on, in the display zone. */
export function dayOf(ms: number, zone: DisplayTimeZone): string {
  const p = zonedParts(ms, zone);
  return `${p.year}-${p.month}-${p.day}`;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The first instant of a `YYYY-MM-DD` day in the display zone, as epoch ms, or
 * `null` for a string that is not a real day (`2026-02-30`).
 *
 * A zone's offset is itself a function of the instant, so this starts from the
 * day's UTC midnight, measures the zone's offset THERE, corrects, and measures
 * again at the corrected instant — the second pass is what lands a day whose
 * offset changes overnight. Where midnight does not exist (a zone that springs
 * forward AT midnight), the day begins at the first instant it has, which is
 * what "on that day" means; where it happens twice, at the first.
 *
 * The scheduler answers the same question server-side with a bisection
 * (`scheduler/recurrence.ts`, `localDayStartInstant`); web cannot import the
 * server, and that one is a closure inside the period model.
 */
export function zonedDayStart(day: string, zone: DisplayTimeZone): number | null {
  const match = DAY.exec(day);
  if (match === null) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utcMidnight = calendarDay(year, month, date);
  if (utcMidnight === null) return null;
  if (zone === LOCAL_TIME_ZONE) {
    // `setFullYear`, as `calendarDay` — the constructor reads a year below 100
    // as 19xx, and a year typed into a date input passes through `0002-…`.
    const local = new Date(2000, 0, 1);
    local.setFullYear(year, month - 1, date);
    return local.getTime();
  }
  let start = utcMidnight - offsetAt(utcMidnight, zone);
  start = utcMidnight - offsetAt(start, zone);
  /* The guess is the day's midnight wherever midnight happens once. Where it
     does not, walk on the 15-minute grid every zone offset sits on:
     - a midnight skipped by a spring-forward lands on the day before, so step
       FORWARD to the day's first instant (and past a day the zone skipped
       entirely, as Samoa skipped 2011-12-30, to the next day's — an empty
       range, which is the truth);
     - a fall-back from 01:00 to 00:00 lands on the SECOND midnight, so step
       BACK while the instant before is still on the day.
     Day strings are zero-padded `YYYY-MM-DD`, so they compare in calendar
     order. Each walk is bounded by a day's worth of steps. */
  for (let i = 0; i < STEPS_PER_DAY && dayOf(start, zone) < day; i++) start += STEP_MS;
  for (let i = 0; i < STEPS_PER_DAY && dayOf(start - STEP_MS, zone) === day; i++) start -= STEP_MS;
  return start;
}

const STEP_MS = 15 * 60_000;
const STEPS_PER_DAY = 26 * 4;

/** A calendar day's UTC midnight, or `null` when it is not on the calendar —
 * `2026-02-30` is refused rather than rolled into March. `setUTCFullYear`
 * rather than `Date.UTC`, which reads a year below 100 as 19xx. */
function calendarDay(year: number, month: number, date: number): number | null {
  const day = new Date(0);
  day.setUTCFullYear(year, month - 1, date);
  return day.getUTCFullYear() === year &&
    day.getUTCMonth() === month - 1 &&
    day.getUTCDate() === date
    ? day.getTime()
    : null;
}

/** Whether a string is a `YYYY-MM-DD` day on the calendar (in any zone). */
export function isCalendarDay(day: string): boolean {
  const match = DAY.exec(day);
  return (
    match !== null && calendarDay(Number(match[1]), Number(match[2]), Number(match[3])) !== null
  );
}

/** A `YYYY-MM-DD` day moved by whole calendar days — calendar arithmetic, so no
 * zone and no 23- or 25-hour day can shift it. An unparseable day comes back as is. */
export function shiftDay(day: string, days: number): string {
  const match = DAY.exec(day);
  if (match === null) return day;
  const moved = new Date(0);
  moved.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  return moved.toISOString().slice(0, 10);
}

/** The zone's offset from UTC at an instant, in ms (`+3_600_000` for GMT+1). */
function offsetAt(ms: number, zone: DisplayTimeZone): number {
  const p = zonedParts(ms, zone);
  // `setUTCFullYear`, not `Date.UTC`, which reads a year below 100 as 19xx.
  const asUtc = new Date(0);
  asUtc.setUTCFullYear(Number(p.year), Number(p.month) - 1, Number(p.day));
  asUtc.setUTCHours(Number(p.hour), Number(p.minute), Number(p.second), Number(p.fraction));
  return asUtc.getTime() - ms;
}
