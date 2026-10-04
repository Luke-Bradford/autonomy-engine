import { describe, expect, it } from 'vitest';
import {
  dayOf,
  displayTimeZoneOptions,
  formatCompactTimestamp,
  formatRelative,
  formatTimeOfDay,
  formatTimestamp,
  parseDisplayTimeZone,
  shiftDay,
  zonedDayStart,
} from './displayTime';

const AT = Date.UTC(2026, 9, 4, 12, 5, 7, 123); // 2026-10-04T12:05:07.123Z

describe('displayTime — #1484 principle 4', () => {
  it('formats one instant in the chosen zone, ISO-ordered, with the zone named', () => {
    expect(formatTimestamp(AT, 'UTC')).toBe('2026-10-04 12:05:07 UTC');
    expect(formatTimestamp(AT, 'UTC', 'ms')).toBe('2026-10-04 12:05:07.123 UTC');
    expect(formatTimestamp(AT, 'Europe/London', 'ms')).toBe('2026-10-04 13:05:07.123 GMT+1');
    expect(formatTimestamp(AT, 'America/New_York')).toBe('2026-10-04 08:05:07 EDT');
    // Midnight is 00, not 24 — the h23 cycle.
    expect(formatTimestamp(Date.UTC(2026, 0, 1), 'UTC')).toBe('2026-01-01 00:00:00 UTC');
  });

  it('says a timestamp that is not an instant is invalid, rather than throwing', () => {
    expect(formatTimestamp(Number.NaN, 'UTC')).toBe('invalid time');
    expect(formatTimeOfDay(Number.NaN, 'UTC')).toBe('invalid time');
    expect(formatCompactTimestamp(Number.NaN, 'UTC', AT)).toBe('invalid time');
  });

  it('formats a time of day alone, for a feed whose day is known', () => {
    expect(formatTimeOfDay(AT, 'UTC')).toBe('12:05:07');
    expect(formatTimeOfDay(AT, 'Europe/London', 'ms')).toBe('13:05:07.123');
  });

  it('is compact for the grid: month-day in the current year, the year otherwise', () => {
    expect(formatCompactTimestamp(AT, 'UTC', AT + 86_400_000)).toBe('10-04 12:05:07');
    expect(formatCompactTimestamp(AT, 'UTC', Date.UTC(2027, 1, 1))).toBe('2026-10-04 12:05');
    // "Same year" is the DISPLAY zone's year: 23:30 UTC on Dec 31 is already
    // next year in Tokyo.
    const newYearsEve = Date.UTC(2026, 11, 31, 23, 30);
    expect(formatCompactTimestamp(newYearsEve, 'Asia/Tokyo', newYearsEve)).toBe('01-01 08:30:00');
  });

  it('accepts local and any zone the runtime knows, and rejects the rest', () => {
    expect(parseDisplayTimeZone('local')).toBe('local');
    expect(parseDisplayTimeZone('UTC')).toBe('UTC');
    expect(parseDisplayTimeZone('Europe/London')).toBe('Europe/London');
    expect(parseDisplayTimeZone('Mars/Olympus_Mons')).toBeUndefined();
    expect(parseDisplayTimeZone('')).toBeUndefined();
  });

  it('offers local and UTC first, then the runtime list, with UTC once', () => {
    const options = displayTimeZoneOptions();
    expect(options.slice(0, 2)).toEqual(['local', 'UTC']);
    expect(options).toContain('Europe/London');
    expect(options.filter((zone) => zone === 'UTC')).toHaveLength(1);
  });

  it('says how long ago, in the largest whole unit', () => {
    expect(formatRelative(AT - 3 * 60_000 - 5_000, AT)).toBe('3 minutes ago');
    expect(formatRelative(AT + 2 * 3_600_000, AT)).toBe('in 2 hours');
    expect(formatRelative(AT - 86_400_000, AT)).toBe('yesterday');
    expect(formatRelative(AT, AT)).toBe('now');
  });

  it('starts a day at its first instant in the zone, on 23- and 25-hour days too', () => {
    expect(zonedDayStart('2026-10-04', 'UTC')).toBe(Date.UTC(2026, 9, 4));
    expect(zonedDayStart('2026-10-04', 'Europe/London')).toBe(Date.UTC(2026, 9, 3, 23));
    // London springs forward on 2026-03-29 (a 23-hour day) and falls back on
    // 2026-10-25 (25 hours); each day's start is its own midnight, so the span
    // to the next start is the day's real length.
    const springLength =
      zonedDayStart('2026-03-30', 'Europe/London')! - zonedDayStart('2026-03-29', 'Europe/London')!;
    expect(springLength).toBe(23 * 3_600_000);
    const fallLength =
      zonedDayStart('2026-10-26', 'Europe/London')! - zonedDayStart('2026-10-25', 'Europe/London')!;
    expect(fallLength).toBe(25 * 3_600_000);
    expect(zonedDayStart('2026-10-04', 'America/New_York')).toBe(Date.UTC(2026, 9, 4, 4));
  });

  it('lands a day whose offset at UTC midnight is not the offset at its own midnight', () => {
    // Sydney leaves daylight time at 03:00 on 2026-04-05 (16:00Z on the 4th).
    // UTC midnight of the 5th is already standard time (+10), but the 5th's own
    // midnight was still daylight time (+11): 13:00Z on the 4th. One offset
    // reading lands an hour late; the second, taken at that guess, corrects it.
    expect(zonedDayStart('2026-04-05', 'Australia/Sydney')).toBe(Date.UTC(2026, 3, 4, 13));
  });

  it('starts a day whose midnight does not exist at its first real instant', () => {
    // Santiago springs forward AT midnight on 2026-09-06: 00:00 becomes 01:00.
    const start = zonedDayStart('2026-09-06', 'America/Santiago')!;
    expect(dayOf(start, 'America/Santiago')).toBe('2026-09-06');
    expect(dayOf(start - 1, 'America/Santiago')).toBe('2026-09-05');
  });

  it('refuses a day that is not on the calendar', () => {
    expect(zonedDayStart('2026-02-30', 'UTC')).toBeNull();
    expect(zonedDayStart('not a day', 'UTC')).toBeNull();
  });

  it('names the calendar day an instant falls on in the zone', () => {
    const lateUtc = Date.UTC(2026, 9, 4, 23, 30);
    expect(dayOf(lateUtc, 'UTC')).toBe('2026-10-04');
    expect(dayOf(lateUtc, 'Europe/London')).toBe('2026-10-05');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDay('2026-03-02', -6)).toBe('2026-02-24');
  });
});
