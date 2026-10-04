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
 * argument. The store and the React side live in `When.tsx`.
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

/* Formatters are costly to build and a grid renders hundreds of cells, so one
   per NAMED zone is kept, bounded by the zones a viewer ever picks. `local` is
   not cached: a formatter fixes the runtime's zone when it is built, and the
   machine's zone can change under a long-lived tab. */
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
    if (zone !== LOCAL_TIME_ZONE) formatters.set(zone, formatter);
  }
  return formatter;
}

/** What a timestamp that is not an instant renders as — the old
 * `toLocaleString` said "Invalid Date" and did not throw, and a formatter must
 * not be the thing that crashes a page over one bad field. */
export const INVALID_TIME = 'invalid time';

function zonedParts(ms: number, zone: DisplayTimeZone): ZonedParts {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatterFor(zone).formatToParts(ms)) parts[part.type] = part.value;
  return {
    year: parts.year ?? '',
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

/** `2026-10-04 13:05:07 GMT+1`, or with `.123` at `ms` precision. */
export function formatTimestamp(
  ms: number,
  zone: DisplayTimeZone,
  precision: TimestampPrecision = 'second',
): string {
  if (!Number.isFinite(ms)) return INVALID_TIME;
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
  if (!Number.isFinite(ms)) return INVALID_TIME;
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
  if (!Number.isFinite(ms)) return INVALID_TIME;
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
 * what "on that day" means.
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
  let guess = utcMidnight - offsetAt(utcMidnight, zone);
  guess = utcMidnight - offsetAt(guess, zone);
  // A midnight skipped by a spring-forward lands on the previous day's 23:00;
  // step to the first instant that is on the asked-for day.
  if (dayOf(guess, zone) !== day) guess += 3_600_000;
  return guess;
}

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
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
    Number(p.fraction),
  );
  return asUtc - ms;
}
