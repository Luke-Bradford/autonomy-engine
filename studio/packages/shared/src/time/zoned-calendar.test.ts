import { describe, expect, it } from 'vitest';
import { civilDayNumber, zonedCalendar } from './zoned-calendar.js';

const HOUR = 3_600_000;
const dayStart = (zone: string, year: number, month: number, day: number) =>
  zonedCalendar(zone).dayStart(civilDayNumber(year, month, day));

describe('civilDayNumber', () => {
  it('counts days from 1970-01-01, years below 100 included', () => {
    expect(civilDayNumber(1970, 1, 1)).toBe(0);
    expect(civilDayNumber(2026, 10, 4)).toBe(Date.UTC(2026, 9, 4) / 86_400_000);
    // `Date.UTC(2, …)` would read year 2 as 1902.
    expect(civilDayNumber(2, 6, 15)).toBe(new Date('0002-06-15T00:00:00Z').getTime() / 86_400_000);
  });
});

describe('zonedCalendar — #1525, the one day-start implementation', () => {
  it('reads the local date an instant falls on', () => {
    const london = zonedCalendar('Europe/London');
    expect(london.date(Date.UTC(2026, 9, 3, 23, 30))).toEqual({ year: 2026, month: 10, day: 4 });
    expect(london.dayNumber(Date.UTC(2026, 9, 3, 23, 30))).toBe(civilDayNumber(2026, 10, 4));
  });

  it('starts a day at local midnight, either side of a DST change', () => {
    expect(dayStart('UTC', 2026, 10, 4)).toBe(Date.UTC(2026, 9, 4));
    expect(dayStart('Europe/London', 2026, 10, 4)).toBe(Date.UTC(2026, 9, 3, 23));
    expect(dayStart('America/New_York', 2026, 10, 4)).toBe(Date.UTC(2026, 9, 4, 4));
    expect(dayStart('Australia/Sydney', 2026, 4, 5)).toBe(Date.UTC(2026, 3, 4, 13));
    // The spring-forward day is 23 hours long, the fall-back day 25.
    expect(dayStart('Europe/London', 2026, 3, 30) - dayStart('Europe/London', 2026, 3, 29)).toBe(
      23 * HOUR,
    );
    expect(
      dayStart('Europe/London', 2026, 10, 26) - dayStart('Europe/London', 2026, 10, 25),
    ).toBe(25 * HOUR);
  });

  it('a skipped midnight: the day begins at the first instant it has (Santiago springs forward AT 00:00)', () => {
    // 2026-09-06 00:00 -04 does not exist; the day begins at 01:00 -03 = 04:00Z.
    expect(dayStart('America/Santiago', 2026, 9, 6)).toBe(Date.UTC(2026, 8, 6, 4));
  });

  it('a doubled midnight: the day begins at the FIRST one (Amman fell back from 01:00 to 00:00)', () => {
    const start = dayStart('Asia/Amman', 2021, 10, 29);
    expect(start).toBe(Date.UTC(2021, 9, 28, 21));
    expect(dayStart('Asia/Amman', 2021, 10, 30) - start).toBe(25 * HOUR);
  });

  it('a skipped day begins where the next one does, so it is an empty range (Samoa 2011-12-30)', () => {
    expect(dayStart('Pacific/Apia', 2011, 12, 30)).toBe(dayStart('Pacific/Apia', 2011, 12, 31));
  });

  it('a sub-minute LMT offset is exact to the ms (America/New_York 1883, −04:56:02)', () => {
    expect(dayStart('America/New_York', 1883, 6, 1)).toBe(
      Date.UTC(1883, 5, 1) + (4 * 3600 + 56 * 60 + 2) * 1000,
    );
  });

  it('a year below 100 is that year, not 19xx', () => {
    expect(dayStart('UTC', 2, 6, 15)).toBe(new Date('0002-06-15T00:00:00Z').getTime());
  });

  it('the ICU build emits a `second` part with no hour/minute — the whole-minute guard depends on it', () => {
    // The guard reads local second-of-minute from a formatter carrying only Y/M/D +
    // `second` (never `hour`, to dodge the ICU 24:00 midnight quirk). Some ICU builds
    // drop `second` when neither `hour` nor `minute` is present; this runtime does
    // not. A build that dropped it would `NaN` the guard and always take the 1ms path
    // — slower, not wrong — so fail loudly here instead. (Moved from the scheduler's
    // tests with the calendar, #1525.)
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(Date.UTC(2026, 6, 1, 12)));
    const second = parts.find((p) => p.type === 'second');
    expect(second).toBeDefined();
    expect(Number(second!.value)).toBe(0);
  });
});
