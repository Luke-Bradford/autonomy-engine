import { describe, expect, it } from 'vitest';
import { formatTimeoutDuration, parseTimeoutDuration } from './formFields';

/** #1680 — a timeout typed as `D.HH:MM:SS` (ADF's form) or whole seconds. */
describe('parseTimeoutDuration', () => {
  it.each([
    ['', undefined],
    ['  ', undefined],
    ['300', 300],
    [' 300 ', 300],
    ['43200', 43_200],
    ['00:05:00', 300],
    ['0:05:00', 300],
    ['12:00:00', 43_200],
    ['23:59:59', 86_399],
    ['1.00:00:00', 86_400],
    ['0.12:00:00', 43_200],
    ['1.02:03:04', 93_784],
    ['365.00:00:00', 31_536_000],
    [' 1.02:03:04 ', 93_784],
  ])('reads %j as %j', (raw, seconds) => {
    expect(parseTimeoutDuration(raw)).toEqual({ ok: true, value: seconds });
  });

  it.each([
    // Two parts: .NET reads `12:00` as twelve hours, a reader might as twelve minutes.
    '12:00',
    // Whole seconds only, as the stored value is.
    '00:00:01.5',
    '1.5',
    '24:00:00',
    '00:60:00',
    '00:00:60',
    '1.24:00:00',
    '00:5:00',
    '123:00:00',
    '-1',
    '+5',
    '1e3',
    '0x10',
    '1.',
    '.00:00:01',
    'twelve hours',
    // Past `Number.MAX_SAFE_INTEGER` seconds, where arithmetic stops being exact.
    '9999999999999999',
    '999999999999999.00:00:00',
  ])('refuses %j, naming both forms', (raw) => {
    const parsed = parseTimeoutDuration(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/D\.HH:MM:SS.*seconds/);
  });

  it.each(['0', '00:00:00', '0.00:00:00'])('refuses a zero timeout %j', (raw) => {
    expect(parseTimeoutDuration(raw)).toEqual({
      ok: false,
      reason: 'Enter a timeout above 0, or leave it blank',
    });
  });

  // The one-year ceiling stays on the write path (`TIMEOUT_SECONDS_SANITY_CEILING`),
  // as `parseWholeNumber` leaves every range check to the schema.
  it('leaves the write ceiling to the save', () => {
    expect(parseTimeoutDuration('400.00:00:00')).toEqual({ ok: true, value: 34_560_000 });
  });
});

describe('formatTimeoutDuration', () => {
  it.each([
    [1, '00:00:01'],
    [300, '00:05:00'],
    [43_200, '12:00:00'],
    [86_399, '23:59:59'],
    [86_400, '1.00:00:00'],
    [93_784, '1.02:03:04'],
    [40_000_000, '462.23:06:40'],
  ])('shows %j as %j', (seconds, text) => {
    expect(formatTimeoutDuration(seconds)).toBe(text);
  });

  // `DraftNumberField` does not parse a blur on untouched text, so the shown
  // text must read back as exactly the stored value.
  it('round-trips through the parser', () => {
    const samples = [
      1,
      59,
      60,
      61,
      3_599,
      3_600,
      86_399,
      86_400,
      86_401,
      31_536_000,
      40_000_000,
      Number.MAX_SAFE_INTEGER,
    ];
    for (let s = 1; s < 200_000; s += 997) samples.push(s);
    for (const seconds of samples) {
      expect(parseTimeoutDuration(formatTimeoutDuration(seconds)), String(seconds)).toEqual({
        ok: true,
        value: seconds,
      });
    }
  });

  // A value the parser would never produce (the API or an import wrote it) is
  // shown as stored rather than as a duration that reads back differently.
  it.each([0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2])('shows %j as stored', (seconds) => {
    expect(formatTimeoutDuration(seconds)).toBe(String(seconds));
  });
});
