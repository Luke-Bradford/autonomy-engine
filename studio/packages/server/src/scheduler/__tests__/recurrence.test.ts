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

/**
 * #5 S5b-2 (#549) — bounds. `nextOccurrence` honours a half-open `[startAt, stopAt)`
 * window: `startAt` INCLUSIVE (an occurrence exactly at `startAt` fires), `stopAt`
 * EXCLUSIVE (an occurrence exactly at `stopAt` does NOT — the window ends). This
 * suite pins that contract, including the croner-boundary compensation that makes
 * `startAt` inclusive despite croner's native exclusivity.
 */
describe('nextOccurrence — start/end bounds (a half-open firing window)', () => {
  const daily9 = '0 9 * * *';
  const at = (iso: string) => Date.parse(iso);

  it('startAt in the future: the first occurrence is at/after startAt, not before', () => {
    // Seeded at Aug 1 while startAt is Aug 10 → the first fire is Aug 10 09:00,
    // every daily slot before startAt is skipped.
    const next = nextOccurrence(daily9, at('2026-08-01T00:00:00Z'), {
      startAt: at('2026-08-10T00:00:00Z'),
    });
    expect(next).toBe(at('2026-08-10T09:00:00Z'));
  });

  it('startAt is INCLUSIVE — an occurrence exactly at startAt fires (croner-boundary compensated)', () => {
    // Native croner `startAt` is exclusive at the exact second; the calculator
    // compensates so `[startAt, …)` includes startAt itself. from strictly before.
    const next = nextOccurrence(daily9, at('2026-08-01T00:00:00Z'), {
      startAt: at('2026-08-01T09:00:00Z'),
    });
    expect(next).toBe(at('2026-08-01T09:00:00Z'));
  });

  it('a sub-second startAt does NOT re-admit the earlier whole-second slot (half-open, strict)', () => {
    // startAt 09:00:00.500 → the 09:00:00.000 slot is BEFORE the window and must
    // NOT fire (a full -1s nudge would wrongly re-admit it); the first in-window
    // occurrence is the next day's 09:00.
    const next = nextOccurrence(daily9, at('2026-08-01T00:00:00Z'), {
      startAt: at('2026-08-01T09:00:00.500Z'),
    });
    expect(next).toBe(at('2026-08-02T09:00:00Z'));
  });

  it('stopAt is EXCLUSIVE — an occurrence exactly at stopAt does not fire, the window ends', () => {
    const next = nextOccurrence(daily9, at('2026-08-01T00:00:00Z'), {
      stopAt: at('2026-08-01T09:00:00Z'),
    });
    expect(next).toBeNull();
  });

  it('a sub-second stopAt does NOT exclude an occurrence strictly before the raw instant', () => {
    // stopAt 09:00:00.500 → the 09:00:00.000 slot is strictly BEFORE the end and
    // must still fire (a raw floored stopAt would wrongly drop it); symmetric to
    // the inclusive-start sub-second case.
    const next = nextOccurrence(daily9, at('2026-08-01T00:00:00Z'), {
      stopAt: at('2026-08-01T09:00:00.500Z'),
    });
    expect(next).toBe(at('2026-08-01T09:00:00Z'));
  });

  it('an occurrence strictly before stopAt fires; the last one ends the chain', () => {
    // stopAt Aug 3 09:00: Aug 1 & Aug 2 fire; Aug 3 (== stopAt) does not.
    expect(
      nextOccurrence(daily9, at('2026-08-01T00:00:00Z'), { stopAt: at('2026-08-03T09:00:00Z') }),
    ).toBe(at('2026-08-01T09:00:00Z'));
    expect(
      nextOccurrence(daily9, at('2026-08-02T09:00:00Z'), { stopAt: at('2026-08-03T09:00:00Z') }),
    ).toBeNull();
  });

  it('from already past stopAt → null (an exhausted window arms nothing)', () => {
    expect(
      nextOccurrence(daily9, at('2026-08-05T00:00:00Z'), { stopAt: at('2026-08-03T09:00:00Z') }),
    ).toBeNull();
  });

  it('start+end together bound both sides', () => {
    expect(
      nextOccurrence(daily9, at('2026-08-01T00:00:00Z'), {
        startAt: at('2026-08-10T00:00:00Z'),
        stopAt: at('2026-08-20T00:00:00Z'),
      }),
    ).toBe(at('2026-08-10T09:00:00Z'));
  });

  it('no bounds passed → identical to the unbounded call (back-compat)', () => {
    const from = at('2026-08-01T00:00:00Z');
    expect(nextOccurrence(daily9, from, {})).toBe(nextOccurrence(daily9, from));
  });
});

/**
 * #5 S5b (#550) — `interval > 1` ("every N periods"). The compiled cron carries
 * only the within-period pattern; `step` gates fires to the QUALIFYING periods —
 * those an integer multiple of `interval` periods from the `startTime` anchor.
 * The anchor is also the `startAt` bound, so the series' period 0 is the anchor's
 * period and the first fire is the first qualifying occurrence at/after it.
 *
 * The week rule is studio's DOCUMENTED semantics (spec: startTime-ANCHORED, not
 * period-grid-anchored): a "week" is a rolling 7-day block counted from the
 * anchor's calendar day. These tests pin concrete UTC dates so a change to that
 * interpretation fails loudly rather than silently shifting a series.
 */
describe('nextOccurrence — interval > 1 stepping (every-N-period, startTime-anchored)', () => {
  const at = (iso: string) => Date.parse(iso);

  it('every 2 days at 09:00, anchored Aug 1 → Aug 1, 3, 5 (odd days skipped)', () => {
    const anchor = at('2026-08-01T00:00:00Z');
    const step = { frequency: 'day' as const, interval: 2, anchorEpochMs: anchor };
    const bounds = { startAt: anchor };
    expect(nextOccurrence('0 9 * * *', anchor, bounds, step)).toBe(at('2026-08-01T09:00:00Z'));
    expect(nextOccurrence('0 9 * * *', at('2026-08-01T09:00:00Z'), bounds, step)).toBe(
      at('2026-08-03T09:00:00Z'),
    );
    expect(nextOccurrence('0 9 * * *', at('2026-08-03T09:00:00Z'), bounds, step)).toBe(
      at('2026-08-05T09:00:00Z'),
    );
  });

  it('every 15 minutes, anchored 12:03 → 12:03, 12:18, 12:33 (from a per-minute cron)', () => {
    const anchor = at('2026-08-01T12:03:00Z');
    const step = { frequency: 'minute' as const, interval: 15, anchorEpochMs: anchor };
    const bounds = { startAt: anchor };
    // from BEFORE the anchor: the first fire is the anchor slot itself (inclusive).
    expect(nextOccurrence('* * * * *', at('2026-08-01T12:00:00Z'), bounds, step)).toBe(
      at('2026-08-01T12:03:00Z'),
    );
    expect(nextOccurrence('* * * * *', at('2026-08-01T12:03:00Z'), bounds, step)).toBe(
      at('2026-08-01T12:18:00Z'),
    );
    expect(nextOccurrence('* * * * *', at('2026-08-01T12:18:00Z'), bounds, step)).toBe(
      at('2026-08-01T12:33:00Z'),
    );
  });

  it('every 2 weeks on Mon & Wed at 08:00, anchored Mon Aug 3 → both days in weeks 0 and 2, none in week 1', () => {
    const anchor = at('2026-08-03T00:00:00Z'); // a Monday
    const step = { frequency: 'week' as const, interval: 2, anchorEpochMs: anchor };
    const bounds = { startAt: anchor };
    const cron = '0 8 * * 1,3';
    // Week block 0 (Aug 3–9): Mon Aug 3, Wed Aug 5 both fire.
    expect(nextOccurrence(cron, at('2026-08-03T00:00:00Z'), bounds, step)).toBe(
      at('2026-08-03T08:00:00Z'),
    );
    expect(nextOccurrence(cron, at('2026-08-03T08:00:00Z'), bounds, step)).toBe(
      at('2026-08-05T08:00:00Z'),
    );
    // Week block 1 (Aug 10–16): Mon Aug 10 & Wed Aug 12 are SKIPPED — the next fire
    // jumps to week block 2's Monday, Aug 17.
    expect(nextOccurrence(cron, at('2026-08-05T08:00:00Z'), bounds, step)).toBe(
      at('2026-08-17T08:00:00Z'),
    );
    expect(nextOccurrence(cron, at('2026-08-17T08:00:00Z'), bounds, step)).toBe(
      at('2026-08-19T08:00:00Z'),
    );
  });

  it('every 2 months on the 1st, anchored Jan → Jan, Mar, May (calendar-month stepping)', () => {
    const anchor = at('2026-01-01T00:00:00Z');
    const step = { frequency: 'month' as const, interval: 2, anchorEpochMs: anchor };
    const bounds = { startAt: anchor };
    const cron = '0 0 1 * *';
    // Seed from BEFORE the anchor: the inclusive startAt admits the Jan 1 00:00 slot
    // (croner's nextRun is strictly-after, so from == the occurrence would skip it).
    expect(nextOccurrence(cron, at('2025-12-15T00:00:00Z'), bounds, step)).toBe(
      at('2026-01-01T00:00:00Z'),
    );
    expect(nextOccurrence(cron, at('2026-01-01T00:00:00Z'), bounds, step)).toBe(
      at('2026-03-01T00:00:00Z'),
    );
    expect(nextOccurrence(cron, at('2026-03-01T00:00:00Z'), bounds, step)).toBe(
      at('2026-05-01T00:00:00Z'),
    );
  });

  it('a qualifying period that NEVER contains an occurrence → null (no spin, honest exhaustion)', () => {
    // Every 12 months on the 30th, anchored February. The only qualifying months are
    // Februaries, which never have a 30th, so croner emits the 30th of NON-qualifying
    // months forever — the step calculator jumps past each and, finding no qualifying
    // occurrence within its probe budget, returns null (settles the chain) rather than
    // looping. (Contrast: interval 1 would fire the 30th of every OTHER month.)
    const anchor = at('2026-02-01T00:00:00Z');
    const step = { frequency: 'month' as const, interval: 12, anchorEpochMs: anchor };
    expect(nextOccurrence('0 0 30 * *', anchor, { startAt: anchor }, step)).toBeNull();
  });

  it('stopAt still bounds a stepped series (Aug 1, 3 fire; Aug 5 == stopAt is excluded)', () => {
    const anchor = at('2026-08-01T00:00:00Z');
    const step = { frequency: 'day' as const, interval: 2, anchorEpochMs: anchor };
    const bounds = { startAt: anchor, stopAt: at('2026-08-05T09:00:00Z') };
    expect(nextOccurrence('0 9 * * *', at('2026-08-03T09:00:00Z'), bounds, step)).toBeNull();
  });

  it('interval 1 via step is identical to no step (the every-period base case)', () => {
    const anchor = at('2026-08-01T00:00:00Z');
    const step = { frequency: 'day' as const, interval: 1, anchorEpochMs: anchor };
    const from = at('2026-08-01T12:00:00Z');
    expect(nextOccurrence('0 9 * * *', from, {}, step)).toBe(nextOccurrence('0 9 * * *', from));
  });

  it('a step with a NaN anchor (write-impossible interval>1 without startTime) fails closed', () => {
    // The write schema requires startTime for interval>1, so this is unreachable via
    // authoring; a hand-edited/imported row could still carry it. Fail CLOSED with a
    // typed error (callers suppress + settle) rather than silently over-firing every
    // period or spinning the clock.
    const step = { frequency: 'day' as const, interval: 2, anchorEpochMs: Number.NaN };
    expect(() => nextOccurrence('0 9 * * *', at('2026-08-01T00:00:00Z'), {}, step)).toThrow(
      InvalidScheduleError,
    );
  });
});
