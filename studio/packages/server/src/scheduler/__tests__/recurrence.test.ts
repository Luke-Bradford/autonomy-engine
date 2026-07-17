import { describe, expect, it } from 'vitest';
import { InvalidScheduleError, nextOccurrence } from '../recurrence.js';

/**
 * #5 S5 — croner-as-CALCULATOR (not a firing source). `nextOccurrence` is the
 * single seam both the schedule reconciler (`scheduler.ts`) and the alarm
 * handler (`schedule-tick.ts`) compute fire times through, so the two can never
 * disagree about when a trigger is next due.
 */
describe('nextOccurrence — croner as a pure next-fire calculator', () => {
  it('returns the next fire time STRICTLY AFTER `from`, in UTC', () => {
    // Every minute; from 12:00:00.000 → the next tick is 12:01:00.000.
    const from = Date.parse('2026-07-15T12:00:00.000Z');
    const next = nextOccurrence('* * * * *', from);
    expect(next).toBe(Date.parse('2026-07-15T12:01:00.000Z'));
  });

  it('is host-timezone-independent (UTC): "0 9 * * *" resolves to 09:00Z', () => {
    const from = Date.parse('2026-07-15T08:30:00.000Z');
    const next = nextOccurrence('0 9 * * *', from);
    expect(next).toBe(Date.parse('2026-07-15T09:00:00.000Z'));
  });

  it('SKIPS every missed slot — computes next-from-now, never backfills', () => {
    // Down for hours on an every-minute schedule: the answer is the single next
    // minute AFTER `from`, not the first of the missed backlog. This is exactly
    // what makes schedule catch-up "no-backfill / ≤1 late fire" structural.
    const from = Date.parse('2026-07-15T12:34:30.000Z');
    const next = nextOccurrence('* * * * *', from);
    expect(next).toBe(Date.parse('2026-07-15T12:35:00.000Z'));
  });

  it('is stable across advancing `from` until the occurrence passes', () => {
    // The reconciler relies on this: re-computing at any point before 09:00Z
    // yields the SAME 09:00Z, so a pending row is not needlessly churned.
    const nine = Date.parse('2026-07-15T09:00:00.000Z');
    expect(nextOccurrence('0 9 * * *', Date.parse('2026-07-15T08:00:00.000Z'))).toBe(nine);
    expect(nextOccurrence('0 9 * * *', Date.parse('2026-07-15T08:59:59.000Z'))).toBe(nine);
  });

  it('returns null when the schedule has no future occurrence', () => {
    // croner accepts a one-shot ISO-8601 instant; once it is in the past there is
    // no next occurrence and `nextRun` is null. Callers treat null as "nothing
    // more to arm" and settle without re-arming (a finite, exhausted schedule).
    const oneShotPast = '2020-01-01T00:00:00';
    const next = nextOccurrence(oneShotPast, Date.parse('2026-07-15T12:00:00.000Z'));
    expect(next).toBeNull();
  });

  it('returns a future time for a recurring schedule (sanity: not everything is null)', () => {
    const next = nextOccurrence('0 0 1 1 *', Date.parse('2026-07-15T12:00:00.000Z'));
    expect(next).toBe(Date.parse('2027-01-01T00:00:00.000Z'));
  });

  it('throws InvalidScheduleError on an unparseable cron string', () => {
    // The trigger schema does NOT validate cron syntax, so a bad string can reach
    // here. It must throw a TYPED error so callers can suppress/skip it rather
    // than letting a raw croner throw spin an alarm forever.
    expect(() => nextOccurrence('not a cron', Date.parse('2026-07-15T12:00:00.000Z'))).toThrow(
      InvalidScheduleError,
    );
  });
});
