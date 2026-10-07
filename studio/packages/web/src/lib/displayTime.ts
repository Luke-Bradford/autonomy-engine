import {
  civilDayNumber,
  isValidTimeZone,
  zonedCalendar,
  type ZonedCalendar,
} from '@autonomy-studio/shared';

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
 * Where midnight does not exist (a zone that springs forward AT midnight), the
 * day begins at the first instant it has, which is what "on that day" means;
 * where it happens twice, at the first; and a day the zone skipped entirely
 * begins where the next one does, an empty range. The answer comes from
 * `zonedCalendar` in `@autonomy-studio/shared` (#1525), the bisection the
 * scheduler steps its zone-aware recurrences with, so the two cannot disagree
 * about where a day begins. `local` goes through it too, as the zone the
 * runtime resolves it to.
 */
export function zonedDayStart(day: string, zone: DisplayTimeZone): number | null {
  const match = DAY.exec(day);
  if (match === null) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (calendarDay(year, month, date) === null) return null;
  return calendarFor(zone).dayStart(civilDayNumber(year, month, date));
}

/* One calendar per zone, for the reason `formatterFor` keeps one formatter:
   building it is the costly part, and the cache is bounded by the zones a
   viewer ever picks. `local` is cached under its own key, so a machine that
   changes zone under an open tab keeps the old one until a reload, as the
   formatters do. */
const calendars = new Map<string, ZonedCalendar>();

function calendarFor(zone: DisplayTimeZone): ZonedCalendar {
  let calendar = calendars.get(zone);
  if (calendar === undefined) {
    calendar = zonedCalendar(
      intlZone(zone) ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    calendars.set(zone, calendar);
  }
  return calendar;
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

/** How a display zone is named to a person — the Settings picker's wording. */
export function displayTimeZoneName(zone: DisplayTimeZone): string {
  return zone === LOCAL_TIME_ZONE ? 'Local (this browser)' : zone;
}

const WALL_DAY_MS = 86_400_000;

/** A civil date and time read as if it were UTC, as epoch ms — the wall clock
 * as a number, so two wall clocks compare and subtract. A day past the end of
 * its month rolls over, as `Date` (and `civilDayNumber`) does. */
function civilMs(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  return civilDayNumber(y, mo, d) * WALL_DAY_MS + ((h * 60 + mi) * 60 + s) * 1000;
}

/** The zone's offset at `ms`: how far its wall clock is ahead of UTC there. */
function offsetAt(ms: number, zone: DisplayTimeZone): number {
  const p = zonedParts(ms, zone);
  const wall = civilMs(+p.year, +p.month, +p.day, +p.hour, +p.minute, +p.second);
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * #1524 — an instant's wall clock in `zone` as a `datetime-local` value:
 * `YYYY-MM-DDTHH:MM`, with `:SS` only when the instant has seconds, so a
 * minute-aligned bound stays a clean `HH:MM`. `''` for a non-instant.
 */
export function wallClockInput(ms: number, zone: DisplayTimeZone): string {
  if (!isInstant(ms)) return '';
  const p = zonedParts(ms, zone);
  const base = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  return p.second === '00' ? base : `${base}:${p.second}`;
}

/** The `datetime-local` value shape: `YYYY-MM-DDTHH:MM`, optionally `:SS`. */
export const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * #1524 — the instant a `datetime-local` wall clock names in `zone`, the
 * inverse of `wallClockInput`; `null` for anything that is not one.
 *
 * It resolves the two daylight-saving cases exactly as the browser's `Date`
 * does for its own zone, so a bound means the same thing whichever zone the
 * form is in:
 * - an AMBIGUOUS wall clock (a fall-back hour happens twice) is the EARLIER
 *   instant;
 * - a wall clock in a GAP (a spring-forward hour that never happens) is read
 *   with the offset from before the jump, so it lands that far past it —
 *   London's `01:30` on a spring-forward day is `02:30` BST. `boundShift` is
 *   what tells the operator.
 *
 * The offset either side of the wall clock (a day away, past any transition
 * that could be in play), and the one at the wall clock itself (for a zone that
 * changes offset twice inside those two days), give at most three candidates;
 * a candidate is the answer when the zone's offset AT it is the one it was
 * built from. None confirming is a gap, which has no instant of its own.
 *
 * Not `zonedCalendar`'s bisection, whose header warns off an offset inverse:
 * that warning is about where a DAY begins, where the inverse lands on the
 * wrong side of a midnight gap. Here a wall clock in a gap is SUPPOSED to land
 * past it, by the pre-jump offset, because that is what `Date` does and so what
 * the `local` path and `boundShift`'s warning already mean. `24:00` is refused,
 * which `Date` would read as the next midnight; a `datetime-local` never
 * produces it.
 */
export function zonedWallClockInstant(local: string, zone: DisplayTimeZone): number | null {
  const match = WALL_CLOCK.exec(local.trim());
  if (match === null) return null;
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(match[i])) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const s = match[6] === undefined ? 0 : Number(match[6]);
  // The ranges `Date` refuses outright; a day past its month's end it rolls.
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const wall = civilMs(y, mo, d, h, mi, s);
  const before = offsetAt(wall - WALL_DAY_MS, zone);
  const after = offsetAt(wall + WALL_DAY_MS, zone);
  // The larger offset reaches the wall clock SOONER, so it is tried first.
  const offsets = [...new Set([before, offsetAt(wall, zone), after])].sort((a, b) => b - a);
  for (const offset of offsets) {
    if (offsetAt(wall - offset, zone) === offset) return wall - offset;
  }
  const shifted = wall - before;
  return isInstant(shifted) ? shifted : null;
}
