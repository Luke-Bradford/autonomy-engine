import { afterEach, describe, expect, it, vi } from 'vitest';
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

/**
 * #5 S5b-timeZone (#552) — `timeZone` interprets the cron pattern in a non-UTC zone.
 * These pin croner 10.0.1's native wall-clock/DST behaviour (croner is EXACT-pinned,
 * so this suite fails LOUDLY if an upgrade changes it) and the invalid-zone
 * fail-closed guard against the alarm-spin the class exists to prevent.
 */
describe('nextOccurrence — timeZone (non-UTC firing, #552)', () => {
  const at = (iso: string) => Date.parse(iso);
  const daily9 = '0 9 * * *';

  it('default (absent/UTC) is unchanged — a daily 09:00 resolves to 09:00Z', () => {
    const from = at('2026-07-15T08:30:00.000Z');
    // Both the omitted-param default and an explicit 'UTC' resolve identically.
    expect(nextOccurrence(daily9, from)).toBe(at('2026-07-15T09:00:00.000Z'));
    expect(nextOccurrence(daily9, from, {}, undefined, 'UTC')).toBe(at('2026-07-15T09:00:00.000Z'));
  });

  it('interprets the pattern in the given zone — 09:00 America/New_York is a UTC-offset instant', () => {
    // Mid-summer NY is EDT (UTC-4), so 09:00 NY = 13:00Z.
    expect(
      nextOccurrence(daily9, at('2026-07-15T00:00:00Z'), {}, undefined, 'America/New_York'),
    ).toBe(at('2026-07-15T13:00:00Z'));
    // Mid-winter NY is EST (UTC-5), so 09:00 NY = 14:00Z.
    expect(
      nextOccurrence(daily9, at('2026-01-15T00:00:00Z'), {}, undefined, 'America/New_York'),
    ).toBe(at('2026-01-15T14:00:00Z'));
  });

  it('tracks the DST spring-forward: 09:00 NY moves 14:00Z→13:00Z across 2026-03-08', () => {
    // The daily 09:00 NY occurrence stays 09:00 wall-clock; its UTC instant shifts an
    // hour earlier the day the clocks spring forward (02:00 EST → 03:00 EDT). This is
    // the whole point of a wall-clock zone vs a fixed offset.
    // From the evening of 03-07 (past that day's 14:00Z EST occurrence): the next is
    // 03-08 09:00 EDT = 13:00Z (an hour earlier in UTC than an EST day).
    const afterSwitch = nextOccurrence(
      daily9,
      at('2026-03-07T18:00:00Z'),
      {},
      undefined,
      'America/New_York',
    );
    expect(afterSwitch).toBe(at('2026-03-08T13:00:00Z')); // 09:00 EDT (clocks sprung forward)
    // From midnight-eve 03-06 (before that day's 14:00Z occurrence): the next is
    // 03-06 09:00 EST = 14:00Z — an EST day sits an hour later in UTC than an EDT one.
    const beforeSwitch = nextOccurrence(
      daily9,
      at('2026-03-06T02:00:00Z'),
      {},
      undefined,
      'America/New_York',
    );
    expect(beforeSwitch).toBe(at('2026-03-06T14:00:00Z')); // 09:00 EST, before the switch
  });

  it('fires a DST fall-back wall-time ONCE (croner picks the first occurrence)', () => {
    // 01:30 NY occurs twice on 2026-11-01 (01:30 EDT then 01:30 EST). croner returns
    // the FIRST (05:30Z), not a double-fire — characterize it so an upgrade can't
    // silently change it.
    expect(
      nextOccurrence('30 1 * * *', at('2026-10-31T12:00:00Z'), {}, undefined, 'America/New_York'),
    ).toBe(at('2026-11-01T05:30:00Z'));
  });

  it('bounds are absolute instants — a UTC startAt still clips a non-UTC recurrence', () => {
    // The [startAt, stopAt) window is instants, independent of the cron's zone. A NY
    // daily 09:00 with a UTC startAt at 2026-07-16T00:00:00Z skips the 07-15 occurrence
    // (13:00Z, before the bound) and fires the 07-16 one.
    const next = nextOccurrence(
      daily9,
      at('2026-07-15T00:00:00Z'),
      { startAt: at('2026-07-16T00:00:00Z') },
      undefined,
      'America/New_York',
    );
    expect(next).toBe(at('2026-07-16T13:00:00Z'));
  });

  it('throws InvalidScheduleError (never a raw croner throw) for an unresolvable zone', () => {
    // The belt: croner does NOT reject a bad zone at construct — it throws a raw
    // TypeError at nextRun. A raw throw here would roll back inside the alarm clock's
    // tx and re-deliver forever; it MUST surface as the typed error the handler
    // suppresses. Assert BOTH that it's the typed error AND that no raw TypeError
    // escapes the nextRun path.
    expect(() =>
      nextOccurrence(daily9, at('2026-07-15T00:00:00Z'), {}, undefined, 'Not/AZone'),
    ).toThrow(InvalidScheduleError);
    expect(() =>
      nextOccurrence(daily9, at('2026-07-15T00:00:00Z'), {}, undefined, 'Not/AZone'),
    ).not.toThrow(TypeError);
    // Empty string would be silently interpreted as host-local by croner — reject it.
    expect(() => nextOccurrence(daily9, at('2026-07-15T00:00:00Z'), {}, undefined, '')).toThrow(
      InvalidScheduleError,
    );
  });

  it('fails CLOSED on interval>1 + an HOUR frequency in a non-UTC zone (write-refused, lenient-read could pair)', () => {
    // #623: hour-frequency stepping in a non-UTC zone stays refused — croner
    // enumerates an `hour` pattern by WALL-CLOCK hour, which skips/repeats an absolute
    // hour across DST (verified empirically), so the absolute-hour period grid
    // mis-qualifies. The write schema refuses it, but the READ shape is lenient (an
    // imported row could carry both), so the firing chain fail-closes (settle, no
    // mis-fire) rather than silently step on wrong hours.
    const hourStep = {
      frequency: 'hour' as const,
      interval: 2,
      anchorEpochMs: at('2026-08-01T00:00:00Z'),
    };
    expect(() =>
      nextOccurrence('30 * * * *', at('2026-08-01T00:00:00Z'), {}, hourStep, 'America/New_York'),
    ).toThrow(InvalidScheduleError);
    // The SAME hour step with UTC (or unzoned) still steps normally — the base case.
    // Anchor 00:00Z is period 0 (qualifying), so the first :30 occurrence, 00:30Z, fires.
    expect(nextOccurrence('30 * * * *', at('2026-08-01T00:00:00Z'), {}, hourStep, 'UTC')).toBe(
      at('2026-08-01T00:30:00Z'),
    );
    // A DAY step in a non-UTC zone NO LONGER throws — it steps on the local calendar
    // grid now (#623; see the zone-aware suite below). Just assert it does not throw.
    const dayStep = {
      frequency: 'day' as const,
      interval: 2,
      anchorEpochMs: at('2026-08-01T00:00:00Z'),
    };
    expect(() =>
      nextOccurrence(daily9, at('2026-08-01T12:00:00Z'), {}, dayStep, 'America/New_York'),
    ).not.toThrow();
  });
});

/**
 * #5 S5b-timeZone stepping (#623) — `interval > 1` ("every N periods") in a NON-UTC
 * zone. `day`/`week`/`month` step on the zone's LOCAL calendar grid: the qualifying
 * periods align to local calendar days/weeks/months, while each occurrence's UTC
 * instant tracks the zone's DST (a wall-clock 09:00 stays 09:00 but its UTC instant
 * shifts an hour across the spring/fall transition). `minute` is a zone-independent
 * absolute cadence. `hour` stays refused (see the fail-closed test above).
 *
 * These pin concrete UTC instants a correct zone-aware stepper produces (computed
 * against croner 10.0.1, which is EXACT-pinned), so a regression in the period model
 * OR a croner upgrade that changed its zone handling fails LOUDLY.
 */
describe('nextOccurrence — zone-aware interval > 1 stepping (#623)', () => {
  const at = (iso: string) => Date.parse(iso);
  const NY = 'America/New_York';

  it('every 2 days at 09:00 America/New_York tracks the spring-forward (14:00Z→13:00Z)', () => {
    // Anchor = Mar 2 local-midnight (2026-03-02T05:00:00Z, EST). Qualifying local days
    // are Mar 2, 4, 6, 8, 10… The 09:00 occurrence is 14:00Z while EST (-5) and 13:00Z
    // after the 2026-03-08 spring-forward (EDT, -4) — same wall-clock, shifted UTC.
    const anchor = at('2026-03-02T05:00:00Z');
    const step = { frequency: 'day' as const, interval: 2, anchorEpochMs: anchor };
    const bounds = { startAt: anchor };
    const cron = '0 9 * * *';
    const expected = [
      '2026-03-02T14:00:00Z',
      '2026-03-04T14:00:00Z',
      '2026-03-06T14:00:00Z',
      '2026-03-08T13:00:00Z', // spring-forward: 09:00 EDT is an hour earlier in UTC
      '2026-03-10T13:00:00Z',
    ];
    let from = anchor - 1; // seed just before the inclusive anchor
    for (const iso of expected) {
      const next = nextOccurrence(cron, from, bounds, step, NY);
      expect(next).toBe(at(iso));
      from = next!;
    }
  });

  it('every 2 weeks on Monday at 08:00 America/New_York (local-week grid, 14-day stride)', () => {
    // Anchor = Mon Aug 3 local-midnight (2026-08-03T04:00:00Z, EDT). A "week" is a
    // rolling 7 local days from the anchor day; qualifying weeks are 0, 2, 4… so the
    // Mondays are Aug 3, 17, 31, Sep 14 (Aug 10 & 24 fall in odd weeks, skipped).
    const anchor = at('2026-08-03T04:00:00Z');
    const step = { frequency: 'week' as const, interval: 2, anchorEpochMs: anchor };
    const bounds = { startAt: anchor };
    const cron = '0 8 * * 1';
    const expected = [
      '2026-08-03T12:00:00Z',
      '2026-08-17T12:00:00Z',
      '2026-08-31T12:00:00Z',
      '2026-09-14T12:00:00Z',
    ];
    let from = anchor - 1;
    for (const iso of expected) {
      const next = nextOccurrence(cron, from, bounds, step, NY);
      expect(next).toBe(at(iso));
      from = next!;
    }
  });

  it('every 2 months on the 1st at 00:30 America/New_York tracks the spring DST (05:30Z→04:30Z)', () => {
    // Anchor = Jan 1 local-midnight (2026-01-01T05:00:00Z, EST). Qualifying months are
    // Jan, Mar, May, Jul. The 00:30 occurrence is 05:30Z under EST and 04:30Z under EDT
    // (May/Jul are after the spring-forward) — same wall-clock, DST-shifted UTC.
    const anchor = at('2026-01-01T05:00:00Z');
    const step = { frequency: 'month' as const, interval: 2, anchorEpochMs: anchor };
    const bounds = { startAt: anchor };
    const cron = '30 0 1 * *';
    const expected = [
      '2026-01-01T05:30:00Z',
      '2026-03-01T05:30:00Z',
      '2026-05-01T04:30:00Z', // EDT
      '2026-07-01T04:30:00Z',
    ];
    let from = anchor - 1;
    for (const iso of expected) {
      const next = nextOccurrence(cron, from, bounds, step, NY);
      expect(next).toBe(at(iso));
      from = next!;
    }
  });

  it('steps correctly across a DST GAP-AT-MIDNIGHT zone (America/Santiago, 2026-09-06 00:00→01:00)', () => {
    // Santiago springs forward AT midnight — local 00:00 on 2026-09-06 does not exist.
    // The local-day boundary is found by monotonic bisection (not an offset-inverse
    // that would over-correct to the previous day), so day-stepping stays exact across
    // the gap. Anchor 2026-09-04T03:00:00Z resolves to Sep 3 23:00 local (CLT -4), so
    // the anchor's local day is Sep 3. Qualifying local days are the even offsets from
    // it: Sep 3, 5, 7, 9, 11 — the first fire after the anchor instant is Sep 5. The
    // 12:00 occurrence is 16:00Z while CLT (-4) and 15:00Z after the switch (CLST -3).
    const anchor = at('2026-09-04T03:00:00Z');
    const step = { frequency: 'day' as const, interval: 2, anchorEpochMs: anchor };
    const bounds = { startAt: anchor };
    const cron = '0 12 * * *';
    const expected = [
      '2026-09-05T16:00:00Z', // CLT (-4)
      '2026-09-07T15:00:00Z', // CLST (-3), after the gap-at-midnight spring-forward
      '2026-09-09T15:00:00Z',
      '2026-09-11T15:00:00Z',
    ];
    let from = anchor - 1;
    for (const iso of expected) {
      const next = nextOccurrence(cron, from, bounds, step, 'America/Santiago');
      expect(next).toBe(at(iso));
      from = next!;
    }
  });

  it('every 2 days at 09:00 America/New_York tracks the FALL-BACK (13:00Z→14:00Z, the non-monotonicity direction)', () => {
    // Companion to the spring-forward case above, pinning the OTHER DST direction the
    // bisection's monotonicity claim rests on. A fall-back (Nov 1 2026, 02:00 EDT →
    // 01:00 EST) REPEATS the 01:00 local hour: the offset decreases and the local clock
    // re-enters an earlier wall-time — the one direction where `localDayNumber` could,
    // in theory, regress across a local midnight. It cannot: the repeated hour stays on
    // the SAME calendar day (Nov 1), so `localDayNumber` is still monotonic non-decreasing
    // and the day-start bisection in `localDayStartInstant` stays exact. This test would
    // fail loudly if a future change (or croner upgrade) let the local day briefly regress.
    // Anchor = Oct 28 local-midnight (2026-10-28T04:00:00Z, EDT). Qualifying local days
    // are Oct 28, 30, Nov 1, 3, 5. The 09:00 occurrence is 13:00Z while EDT (-4) and
    // 14:00Z after the fall-back (EST, -5) — same wall-clock, DST-shifted UTC.
    const anchor = at('2026-10-28T04:00:00Z');
    const step = { frequency: 'day' as const, interval: 2, anchorEpochMs: anchor };
    const bounds = { startAt: anchor };
    const cron = '0 9 * * *';
    const expected = [
      '2026-10-28T13:00:00Z', // EDT (-4)
      '2026-10-30T13:00:00Z', // EDT (-4)
      '2026-11-01T14:00:00Z', // EST (-5), after the fall-back — 09:00 is past the 01:00 repeat
      '2026-11-03T14:00:00Z',
      '2026-11-05T14:00:00Z',
    ];
    let from = anchor - 1;
    for (const iso of expected) {
      const next = nextOccurrence(cron, from, bounds, step, NY);
      expect(next).toBe(at(iso));
      from = next!;
    }
  });

  it('minute stepping is zone-INDEPENDENT — a non-UTC zone is identical to UTC (even across a fall-back)', () => {
    // A `minute` recurrence compiles to `* * * * *`; croner enumerates every absolute
    // minute uniformly (60s stride) regardless of zone/DST (verified empirically), so
    // the absolute-minute period grid is correct without any zone-aware handling. Every
    // step in a non-UTC zone must equal the UTC result. Span the NY fall-back to prove
    // DST does not perturb it.
    const anchor = at('2026-11-01T04:03:00Z');
    const step = { frequency: 'minute' as const, interval: 15, anchorEpochMs: anchor };
    const bounds = { startAt: anchor };
    let fromNy = anchor;
    let fromUtc = anchor;
    for (let i = 0; i < 5; i++) {
      const ny = nextOccurrence('* * * * *', fromNy, bounds, step, NY);
      const utc = nextOccurrence('* * * * *', fromUtc, bounds, step, 'UTC');
      expect(ny).toBe(utc);
      expect(ny).not.toBeNull();
      fromNy = ny!;
      fromUtc = utc!;
    }
  });

  it('a UTC recurrence is byte-identical to pre-#623 — the UTC period model is untouched', () => {
    // Regression belt: the whole zone-aware branch is gated on a non-UTC zone, so an
    // explicit 'UTC' (and the omitted-timeZone default) still walk the original UTC
    // integer arithmetic. Same expectation as the interval>1 UTC suite above.
    const anchor = at('2026-08-01T00:00:00Z');
    const step = { frequency: 'day' as const, interval: 2, anchorEpochMs: anchor };
    const bounds = { startAt: anchor };
    expect(nextOccurrence('0 9 * * *', at('2026-08-01T09:00:00Z'), bounds, step, 'UTC')).toBe(
      at('2026-08-03T09:00:00Z'),
    );
    expect(nextOccurrence('0 9 * * *', at('2026-08-01T09:00:00Z'), bounds, step)).toBe(
      at('2026-08-03T09:00:00Z'),
    );
  });
});

/**
 * #626 — the zone-aware `localDayStartInstant` bisects a ±1-day window to find the
 * exact UTC instant a local calendar day begins. It now bisects on the MINUTE grid
 * (a modern IANA offset is whole-minute, so the boundary is minute-aligned) guarded
 * by a whole-minute check that falls back to exact 1ms bisection for a rare
 * pre-standardization sub-minute LMT offset. These pin (a) the reduced `Intl` call
 * count, (b) the ICU dependency the guard rests on, and (c) that the sub-minute
 * FALLBACK stays exact — the correctness the perf win must not cost.
 */
describe('nextOccurrence — zone-aware bisection Intl-call bound (#626)', () => {
  const at = (iso: string) => Date.parse(iso);
  const NY = 'America/New_York';
  afterEach(() => vi.restoreAllMocks());

  it('bounds formatToParts for a zone-aware step — minute-grid bisection halves the 1ms count', () => {
    // A one-jump every-2-day NY step: `startInstant` resolves ONE local-day boundary.
    // The pre-#626 1ms bisection cost 52 `formatToParts` total for this scenario; the
    // minute-grid bisection + guard costs 37. Assert a threshold strictly BETWEEN — so
    // this fails LOUDLY both on a regression to the 1ms grid (52 > 45) and if the
    // boundary bisection is ever removed/short-circuited (far fewer). Not a microbench:
    // a fixed call count for a fixed scenario, the exact "iteration-count
    // characterization" the ticket asks for.
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    const anchor = at('2026-03-02T05:00:00Z');
    const step = { frequency: 'day' as const, interval: 2, anchorEpochMs: anchor };
    const bounds = { startAt: anchor };
    spy.mockClear();
    const next = nextOccurrence('0 9 * * *', at('2026-03-02T14:00:00Z'), bounds, step, NY);
    expect(next).toBe(at('2026-03-04T14:00:00Z')); // still correct
    expect(spy.mock.calls.length).toBeLessThan(45);
    expect(spy.mock.calls.length).toBeGreaterThan(20); // not accidentally skipping the boundary
  });

  it('the ICU build emits a `second` part with no hour/minute — the whole-minute guard depends on it', () => {
    // The guard reads local second-of-minute from a formatter carrying only Y/M/D +
    // `second` (never `hour`, to dodge the ICU 24:00 midnight quirk). Some ICU builds
    // drop `second` when neither `hour` nor `minute` is present; THIS runtime does not.
    // Pin it: a future Node/ICU that dropped it would silently `NaN` the guard (making
    // it never take the fast path — a perf regression, not a correctness one, but still
    // worth catching), so fail loudly here instead.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: NY,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(at('2026-07-01T12:00:00Z')));
    const second = parts.find((p) => p.type === 'second');
    expect(second).toBeDefined();
    expect(Number(second!.value)).toBe(0); // minute-aligned UTC, whole-minute modern offset → 0
  });

  it('stays EXACT for a sub-minute LMT offset — the fallback path (America/New_York 1883, −04:56:02)', () => {
    // Before 1883-11-18 New York ran on LMT −04:56:02, a SUB-minute offset: a local-day
    // boundary (local midnight) lands at a non-minute UTC instant (…04:56:02Z), so the
    // whole-minute guard reads a non-zero second (58) and MUST fall back to 1ms bisection.
    // A `0 0 * * *` (midnight) fire makes the boundary precision load-bearing: the fire
    // IS the boundary, so a minute-grid boundary off by 58s would push croner PAST the
    // occurrence and skip it. Verified: with the fallback removed this sequence diverges
    // wildly (the 2nd fire jumps from June to November, into the post-standardization
    // whole-minute era). Pinned to exact ms.
    const anchor = Date.UTC(1883, 5, 1) + (4 * 3600 + 56 * 60 + 2) * 1000; // 1883-06-01 00:00 local NY
    const step = { frequency: 'day' as const, interval: 2, anchorEpochMs: anchor };
    const bounds = { startAt: anchor };
    const expected = [
      '1883-06-01T04:56:02Z',
      '1883-06-03T04:56:02Z',
      '1883-06-05T04:56:02Z',
      '1883-06-07T04:56:02Z',
    ];
    let from = anchor - 1;
    for (const iso of expected) {
      const next = nextOccurrence('0 0 * * *', from, bounds, step, NY);
      expect(next).toBe(at(iso));
      from = next!;
    }
  });
});
