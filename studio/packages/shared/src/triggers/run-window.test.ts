import { describe, expect, it } from 'vitest';
import type { RunWindow } from '../schemas/index.js';
import { isWithinRunWindows } from './run-window.js';

/** A fixed UTC instant helper — `at('2026-07-15T10:30')` is 10:30 UTC on a
 * Wednesday (2026-07-15 is a Wednesday, UTC day 3). */
function at(iso: string): Date {
  return new Date(`${iso}:00.000Z`);
}

describe('isWithinRunWindows', () => {
  it('null windows → always open (no restriction configured)', () => {
    expect(isWithinRunWindows(null, at('2026-07-15T03:00'))).toBe(true);
  });

  it('empty array → always CLOSED (fail-closed: configured-but-empty)', () => {
    expect(isWithinRunWindows([], at('2026-07-15T12:00'))).toBe(false);
  });

  it('same-day window: inside is open, boundaries are [start,end)', () => {
    const w: RunWindow[] = [{ start: '09:00', end: '17:00' }];
    expect(isWithinRunWindows(w, at('2026-07-15T09:00'))).toBe(true); // start inclusive
    expect(isWithinRunWindows(w, at('2026-07-15T12:30'))).toBe(true);
    expect(isWithinRunWindows(w, at('2026-07-15T16:59'))).toBe(true);
    expect(isWithinRunWindows(w, at('2026-07-15T17:00'))).toBe(false); // end exclusive
    expect(isWithinRunWindows(w, at('2026-07-15T08:59'))).toBe(false);
  });

  it('wrap-past-midnight window admits both segments, excludes the daytime gap', () => {
    const w: RunWindow[] = [{ start: '22:00', end: '02:00' }];
    expect(isWithinRunWindows(w, at('2026-07-15T23:30'))).toBe(true); // pre-midnight tail
    expect(isWithinRunWindows(w, at('2026-07-15T01:00'))).toBe(true); // post-midnight head
    expect(isWithinRunWindows(w, at('2026-07-15T02:00'))).toBe(false); // end exclusive
    expect(isWithinRunWindows(w, at('2026-07-15T12:00'))).toBe(false); // the gap
  });

  it('days filter: only the listed UTC weekdays are open', () => {
    // 2026-07-15 is Wednesday (UTC day 3); 2026-07-18 is Saturday (day 6).
    const w: RunWindow[] = [{ start: '00:00', end: '23:59', days: [3] }];
    expect(isWithinRunWindows(w, at('2026-07-15T10:00'))).toBe(true);
    expect(isWithinRunWindows(w, at('2026-07-18T10:00'))).toBe(false);
  });

  it('open if ANY window matches', () => {
    const w: RunWindow[] = [
      { start: '09:00', end: '10:00' },
      { start: '20:00', end: '21:00' },
    ];
    expect(isWithinRunWindows(w, at('2026-07-15T20:30'))).toBe(true);
    expect(isWithinRunWindows(w, at('2026-07-15T15:00'))).toBe(false);
  });

  it('malformed time string → that window never matches (fail-closed)', () => {
    expect(isWithinRunWindows([{ start: '25:00', end: '26:00' }], at('2026-07-15T00:30'))).toBe(
      false,
    );
    expect(isWithinRunWindows([{ start: 'nope', end: '17:00' }], at('2026-07-15T12:00'))).toBe(
      false,
    );
    // A malformed window alongside a valid one: the valid one still admits.
    expect(
      isWithinRunWindows(
        [
          { start: 'bad', end: 'bad' },
          { start: '09:00', end: '17:00' },
        ],
        at('2026-07-15T12:00'),
      ),
    ).toBe(true);
  });

  it('start === end is an empty (closed) window', () => {
    expect(isWithinRunWindows([{ start: '12:00', end: '12:00' }], at('2026-07-15T12:00'))).toBe(
      false,
    );
  });

  it('evaluates in UTC, not the host timezone', () => {
    // 23:30 UTC is inside a 22:00–24:00 UTC window regardless of host TZ.
    expect(isWithinRunWindows([{ start: '22:00', end: '23:59' }], at('2026-07-15T23:30'))).toBe(
      true,
    );
  });
});
