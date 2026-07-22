import { describe, expect, it } from 'vitest';
import {
  isValidTimeZone,
  RecurrenceSchema,
  RecurrenceWriteSchema,
  recurrenceToCron,
  type Recurrence,
} from './recurrence.js';

/**
 * #5 S5b-1/S5b-2 — the ADF recurrence MODEL, compiled to a cron string ("croner
 * under the hood"). This suite pins the compiler (the crux), the write-boundary
 * rules, and the S5b-2 (#549) `startTime`/`endTime` bounds. `interval > 1` (#550)
 * is now accepted (startTime-anchored, capped) — the compiler still emits only the
 * within-period pattern; the server stepping calculator gates the periods. `timeZone`
 * (#552) is now accepted (a resolvable IANA zone; UTC-only when `interval > 1` — the
 * zone-aware period model is deferred to #623), threaded to croner by `nextOccurrence`.
 */

const base = (over: Partial<Recurrence> = {}): Recurrence => ({
  frequency: 'day',
  interval: 1,
  ...over,
});

describe('recurrenceToCron — the ADF recurrence → cron compiler (interval=1)', () => {
  it('minute frequency fires every minute (schedule sub-fields are not part of it)', () => {
    expect(recurrenceToCron(base({ frequency: 'minute' }))).toBe('* * * * *');
  });

  it('hour frequency defaults to the top of every hour', () => {
    expect(recurrenceToCron(base({ frequency: 'hour' }))).toBe('0 * * * *');
  });

  it('hour frequency honours enumerated minutes (this is how "every 15 min" is authored)', () => {
    expect(
      recurrenceToCron(base({ frequency: 'hour', schedule: { minutes: [0, 15, 30, 45] } })),
    ).toBe('0,15,30,45 * * * *');
  });

  it('day frequency defaults to midnight UTC', () => {
    expect(recurrenceToCron(base({ frequency: 'day' }))).toBe('0 0 * * *');
  });

  it('day frequency honours hours + minutes (daily at 09:00 and 17:30)', () => {
    expect(
      recurrenceToCron(base({ frequency: 'day', schedule: { hours: [9, 17], minutes: [0, 30] } })),
    ).toBe('0,30 9,17 * * *');
  });

  it('week frequency honours weekDays (Mon & Fri at 08:00)', () => {
    expect(
      recurrenceToCron(
        base({ frequency: 'week', schedule: { weekDays: [1, 5], hours: [8], minutes: [0] } }),
      ),
    ).toBe('0 8 * * 1,5');
  });

  it('month frequency honours monthDays (the 1st and 15th at 06:00)', () => {
    expect(
      recurrenceToCron(base({ frequency: 'month', schedule: { monthDays: [1, 15], hours: [6] } })),
    ).toBe('0 6 1,15 * *');
  });

  it('sorts and de-duplicates field values for a stable, canonical cron string', () => {
    // Two authored recurrences that mean the same thing compile identically, so a
    // no-op edit does not churn the derived `schedule` (and thus the freshness
    // compare in the scheduler).
    expect(
      recurrenceToCron(
        base({ frequency: 'day', schedule: { hours: [17, 9, 9], minutes: [30, 0] } }),
      ),
    ).toBe('0,30 9,17 * * *');
  });
});

describe('RecurrenceWriteSchema — the write-boundary rules', () => {
  const ok = (r: unknown) => RecurrenceWriteSchema.safeParse(r).success;
  const err = (r: unknown) => {
    const res = RecurrenceWriteSchema.safeParse(r);
    return res.success ? '' : res.error.issues.map((i) => i.message).join(' | ');
  };

  it('accepts a minimal valid recurrence and defaults interval to 1', () => {
    const parsed = RecurrenceWriteSchema.parse({ frequency: 'day' });
    expect(parsed.interval).toBe(1);
  });

  it('accepts interval > 1 WHEN anchored by startTime (#550 — every-N-period stepping)', () => {
    // interval>1 is "every N periods", faithfully computed by the server stepping
    // calculator (not cron-expressible). It is startTime-ANCHORED (which period is
    // period 0), so an anchor is mandatory.
    expect(ok(base({ interval: 2, startTime: '2026-08-01T00:00:00Z' }))).toBe(true);
    expect(
      ok(
        base({
          frequency: 'week',
          interval: 3,
          schedule: { weekDays: [1] },
          startTime: '2026-08-01T00:00:00Z',
        }),
      ),
    ).toBe(true);
  });

  it('rejects interval > 1 WITHOUT startTime (#550 — no anchor means no defined period 0)', () => {
    expect(ok(base({ interval: 2 }))).toBe(false);
    expect(err(base({ interval: 2 }))).toMatch(/startTime/);
    // interval === 1 needs no anchor (every period fires; nothing to anchor).
    expect(ok(base({ interval: 1 }))).toBe(true);
  });

  it('rejects interval above the MAX cap (#550 — bounds the stepping calculator)', () => {
    expect(ok(base({ interval: 1001, startTime: '2026-08-01T00:00:00Z' }))).toBe(false);
    expect(err(base({ interval: 1001, startTime: '2026-08-01T00:00:00Z' }))).toMatch(/1000/);
    // The cap boundary itself is accepted.
    expect(ok(base({ interval: 1000, startTime: '2026-08-01T00:00:00Z' }))).toBe(true);
  });

  it('requires weekDays for a weekly recurrence (a week with no day is not cron-expressible)', () => {
    expect(ok(base({ frequency: 'week' }))).toBe(false);
    expect(ok(base({ frequency: 'week', schedule: { weekDays: [1] } }))).toBe(true);
  });

  it('requires monthDays for a monthly recurrence', () => {
    expect(ok(base({ frequency: 'month' }))).toBe(false);
    expect(ok(base({ frequency: 'month', schedule: { monthDays: [1] } }))).toBe(true);
  });

  it('rejects a schedule sub-field the frequency does not honour', () => {
    // weekDays on a daily recurrence is meaningless — reject, do not silently drop.
    expect(ok(base({ frequency: 'day', schedule: { weekDays: [1] } }))).toBe(false);
    // hours on an hourly recurrence (hourly already fires every hour) — reject.
    expect(ok(base({ frequency: 'hour', schedule: { hours: [9] } }))).toBe(false);
    // any sub-field on a per-minute recurrence — reject.
    expect(ok(base({ frequency: 'minute', schedule: { minutes: [0] } }))).toBe(false);
    // monthDays on a weekly recurrence — reject.
    expect(ok(base({ frequency: 'week', schedule: { weekDays: [1], monthDays: [1] } }))).toBe(
      false,
    );
  });

  it('rejects out-of-range field values', () => {
    expect(ok(base({ frequency: 'day', schedule: { hours: [24] } }))).toBe(false);
    expect(ok(base({ frequency: 'day', schedule: { minutes: [60] } }))).toBe(false);
    expect(ok(base({ frequency: 'week', schedule: { weekDays: [7] } }))).toBe(false);
    expect(ok(base({ frequency: 'month', schedule: { monthDays: [0] } }))).toBe(false);
    expect(ok(base({ frequency: 'month', schedule: { monthDays: [32] } }))).toBe(false);
  });

  it('accepts start/end bounds and rejects a non-UTC or naive datetime (#549 S5b-2)', () => {
    // UTC-with-Z only (the run-window UTC contract); offsets + naive strings refused.
    expect(ok(base({ startTime: '2026-08-01T00:00:00Z' }))).toBe(true);
    expect(
      ok(base({ startTime: '2026-08-01T00:00:00.000Z', endTime: '2026-08-31T00:00:00Z' })),
    ).toBe(true);
    expect(ok(base({ startTime: '2026-08-01T00:00:00+02:00' }))).toBe(false);
    expect(ok(base({ endTime: '2026-08-01T00:00:00' }))).toBe(false);
    expect(ok(base({ endTime: '2026-08-01' }))).toBe(false);
  });

  it('rejects endTime <= startTime (an empty/inverted window never fires) (#549)', () => {
    expect(ok(base({ startTime: '2026-08-31T00:00:00Z', endTime: '2026-08-01T00:00:00Z' }))).toBe(
      false,
    );
    expect(
      err(base({ startTime: '2026-08-31T00:00:00Z', endTime: '2026-08-01T00:00:00Z' })),
    ).toMatch(/endTime/);
    // Equal instants are also empty (half-open [start, end) with start==end is empty).
    expect(ok(base({ startTime: '2026-08-01T00:00:00Z', endTime: '2026-08-01T00:00:00Z' }))).toBe(
      false,
    );
    // A lone bound (only start, or only end) is fine — the other side is open.
    expect(ok(base({ startTime: '2026-08-01T00:00:00Z' }))).toBe(true);
    expect(ok(base({ endTime: '2026-08-01T00:00:00Z' }))).toBe(true);
  });

  it('accepts a resolvable IANA timeZone and rejects an unresolvable one (#552)', () => {
    expect(ok(base({ timeZone: 'America/New_York' }))).toBe(true);
    expect(ok(base({ timeZone: 'UTC' }))).toBe(true);
    expect(ok(base({ timeZone: 'Europe/London' }))).toBe(true);
    // Unresolvable / empty zone → refused (croner would throw at nextRun otherwise).
    expect(ok(base({ timeZone: 'Not/AZone' }))).toBe(false);
    expect(err(base({ timeZone: 'Not/AZone' }))).toMatch(/timeZone/);
    expect(ok(base({ timeZone: '' }))).toBe(false);
    // Absent is fine — unzoned ⇒ UTC, byte-identical to a pre-#552 recurrence.
    expect(ok(base({}))).toBe(true);
  });

  it('interval > 1 is UTC-only: refuses a non-UTC timeZone, allows UTC/absent (#552, defer #623)', () => {
    const anchored = { interval: 2, startTime: '2026-08-01T00:00:00Z' };
    // Stepping in a non-UTC zone is deferred (#623) — refuse it, do not mis-fire.
    expect(ok(base({ ...anchored, timeZone: 'America/New_York' }))).toBe(false);
    expect(err(base({ ...anchored, timeZone: 'America/New_York' }))).toMatch(/623|UTC-only/);
    // Explicit UTC (behaviourally identical to unzoned) and absent are permitted.
    expect(ok(base({ ...anchored, timeZone: 'UTC' }))).toBe(true);
    expect(ok(base(anchored))).toBe(true);
    // interval === 1 with a non-UTC zone is the common case — fully supported.
    expect(ok(base({ timeZone: 'America/New_York' }))).toBe(true);
  });

  it('every write-valid recurrence compiles without throwing (compiler totality)', () => {
    const valids: Recurrence[] = [
      base({ frequency: 'minute' }),
      base({ frequency: 'hour', schedule: { minutes: [0, 30] } }),
      base({ frequency: 'day', schedule: { hours: [9] } }),
      base({ frequency: 'week', schedule: { weekDays: [0, 6] } }),
      base({ frequency: 'month', schedule: { monthDays: [1, 28] } }),
    ];
    for (const r of valids) {
      const parsed = RecurrenceWriteSchema.parse(r);
      expect(() => recurrenceToCron(parsed)).not.toThrow();
    }
  });
});

describe('RecurrenceSchema — the lenient stored/read shape', () => {
  it('parses a stored recurrence with interval > 1 (a row written before #550 tightened)', () => {
    // Read must NOT reject what write does — the same lenient-read discipline as
    // TriggerParamsSchema / ConcurrencySchema, so an older row never throws on read.
    expect(RecurrenceSchema.safeParse({ frequency: 'day', interval: 3 }).success).toBe(true);
  });

  it('parses stored start/end bounds and a bounds-free recurrence alike (#549)', () => {
    expect(
      RecurrenceSchema.safeParse({
        frequency: 'day',
        interval: 1,
        startTime: '2026-08-01T00:00:00Z',
        endTime: '2026-08-31T00:00:00Z',
      }).success,
    ).toBe(true);
    // Absent bounds = unbounded/open-ended, exactly today's behaviour.
    expect(RecurrenceSchema.safeParse({ frequency: 'day', interval: 1 }).success).toBe(true);
  });

  it('parses a stored timeZone (read is lenient — no IANA check on read) (#552)', () => {
    // The read shape must never reject what write accepted; it also does not
    // re-validate the zone (an imported/legacy row is taken as-is). The firing
    // chain's `isValidTimeZone` belt + `InvalidScheduleError` guard cover a bad
    // stored zone at fire time.
    expect(
      RecurrenceSchema.safeParse({ frequency: 'day', interval: 1, timeZone: 'America/New_York' })
        .success,
    ).toBe(true);
    // Absent timeZone = UTC, exactly today's behaviour.
    expect(RecurrenceSchema.safeParse({ frequency: 'day', interval: 1 }).success).toBe(true);
  });
});

describe('isValidTimeZone — the IANA-zone write-boundary guard (#552)', () => {
  it('accepts resolvable IANA zones (including UTC and aliases)', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Etc/GMT+5')).toBe(true);
  });

  it('rejects unresolvable and empty strings (croner would throw on these)', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('utc/nonsense')).toBe(false);
  });
});
