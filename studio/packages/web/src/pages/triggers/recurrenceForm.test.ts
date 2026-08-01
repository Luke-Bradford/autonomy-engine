import { describe, expect, it, afterEach } from 'vitest';
import { recurrenceToCron, type Recurrence } from '@autonomy-studio/shared';
import {
  blankRecurrenceForm,
  cronPreview,
  formToRecurrence,
  formatNumberList,
  localInputToUtcIso,
  parseNumberList,
  pruneForFrequency,
  recurrenceToForm,
  utcIsoToLocalInput,
  WEEK_DAY_NAMES,
  type RecurrenceFormState,
} from './recurrenceForm';

/** A form in the state the editor would be in after the operator filled it. */
function form(over: Partial<RecurrenceFormState> = {}): RecurrenceFormState {
  return { ...blankRecurrenceForm(), ...over };
}

/** Unwrap a successful conversion, failing loudly with the reason otherwise. */
function recurrenceOf(f: RecurrenceFormState): Recurrence {
  const result = formToRecurrence(f);
  if (!result.ok) throw new Error(`expected a valid recurrence, got: ${result.reason}`);
  return result.recurrence;
}

describe('parseNumberList / formatNumberList', () => {
  it('parses a comma-separated list, tolerating spaces', () => {
    expect(parseNumberList('1, 2,3')).toEqual({ ok: true, values: [1, 2, 3] });
  });

  it('yields an EMPTY list for a blank input, so the caller can OMIT the field', () => {
    // Load-bearing: `RecurrenceScheduleSchema`'s fields are `.nonempty()`, so a
    // blank input must become an ABSENT field, never `[]` (which the write
    // schema refuses). The distinction is asserted end-to-end below.
    expect(parseNumberList('')).toEqual({ ok: true, values: [] });
    expect(parseNumberList('   ')).toEqual({ ok: true, values: [] });
  });

  it('refuses a non-numeric entry rather than coercing it', () => {
    const result = parseNumberList('1,x,3');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('x');
  });

  it('refuses a fractional entry (the schema wants integers)', () => {
    expect(parseNumberList('1.5').ok).toBe(false);
  });

  it('refuses hex and exponent literals rather than silently converting them', () => {
    // `Number('0x1f')` is 31 and `Number('1e1')` is 10, both integers — so a
    // bare `Number.isInteger` check would accept them and store a value the
    // operator never typed.
    expect(parseNumberList('0x1f').ok).toBe(false);
    expect(parseNumberList('1e1').ok).toBe(false);
  });

  it('formats a list back to the input text, and an absent field to blank', () => {
    expect(formatNumberList([1, 2, 3])).toBe('1, 2, 3');
    expect(formatNumberList(undefined)).toBe('');
  });
});

describe('formToRecurrence — per-frequency field honouring', () => {
  it('builds a weekly recurrence from the honoured fields', () => {
    const r = recurrenceOf(
      form({ frequency: 'week', weekDays: [1, 3], hours: '9', minutes: '30' }),
    );
    expect(r).toEqual({
      frequency: 'week',
      interval: 1,
      schedule: { minutes: [30], hours: [9], weekDays: [1, 3] },
    });
  });

  it('OMITS a blank optional field instead of sending an empty array', () => {
    const r = recurrenceOf(form({ frequency: 'day', hours: '9', minutes: '' }));
    expect(r.schedule).toEqual({ hours: [9] });
    expect(r.schedule && 'minutes' in r.schedule).toBe(false);
  });

  it('omits `schedule` entirely when no honoured field is filled', () => {
    const r = recurrenceOf(form({ frequency: 'minute' }));
    expect(r).toEqual({ frequency: 'minute', interval: 1 });
  });

  it('never emits a field the frequency does not honour', () => {
    // `weekDays` is meaningless for a daily recurrence and the write schema
    // REFUSES it (`HONOURED_FIELDS`), so the form must not carry a stale
    // selection across a frequency change.
    const r = recurrenceOf(form({ frequency: 'day', weekDays: [1, 3], hours: '9' }));
    expect(r.schedule).toEqual({ hours: [9] });
  });

  it('refuses a weekly recurrence with no weekDays (the schema requires them)', () => {
    const result = formToRecurrence(form({ frequency: 'week', hours: '9' }));
    expect(result.ok).toBe(false);
  });

  it('refuses a monthly recurrence with no monthDays', () => {
    expect(formToRecurrence(form({ frequency: 'month', hours: '9' })).ok).toBe(false);
  });

  it('surfaces a bad number list as a reason rather than throwing', () => {
    const result = formToRecurrence(form({ frequency: 'day', hours: 'noon' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.toLowerCase()).toContain('hours');
  });
});

describe('formToRecurrence — interval, timeZone and bounds', () => {
  it('carries an interval > 1 with its startTime anchor', () => {
    const r = recurrenceOf(
      form({
        frequency: 'week',
        weekDays: [1],
        interval: '2',
        startTime: '2026-08-01T09:00',
      }),
    );
    expect(r.interval).toBe(2);
    expect(r.startTime).toBe(localInputToUtcIso('2026-08-01T09:00'));
  });

  it('refuses interval > 1 with no startTime anchor (#550 write rule)', () => {
    const result = formToRecurrence(form({ frequency: 'week', weekDays: [1], interval: '2' }));
    expect(result.ok).toBe(false);
  });

  it('refuses a non-integer or non-positive interval', () => {
    expect(formToRecurrence(form({ frequency: 'day', interval: '0' })).ok).toBe(false);
    expect(formToRecurrence(form({ frequency: 'day', interval: '-1' })).ok).toBe(false);
    expect(formToRecurrence(form({ frequency: 'day', interval: 'many' })).ok).toBe(false);
  });

  it('refuses an unresolvable IANA time zone', () => {
    expect(formToRecurrence(form({ frequency: 'day', timeZone: 'Mars/Olympus' })).ok).toBe(false);
  });

  it('omits an absent time zone (absent ⇒ UTC), rather than defaulting it to a string', () => {
    const r = recurrenceOf(form({ frequency: 'day', timeZone: '' }));
    expect('timeZone' in r).toBe(false);
  });

  it('refuses an empty window (endTime <= startTime)', () => {
    const result = formToRecurrence(
      form({
        frequency: 'day',
        startTime: '2026-08-01T09:00',
        endTime: '2026-08-01T09:00',
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('refuses interval > 1 on an hourly recurrence in a non-UTC zone (#623 DST rule)', () => {
    // The rule lives in `RecurrenceWriteSchema`, not in this module — this
    // asserts the form validates THROUGH the shared schema rather than a
    // hand-rolled subset that would miss it.
    const result = formToRecurrence(
      form({
        frequency: 'hour',
        interval: '2',
        startTime: '2026-08-01T09:00',
        timeZone: 'America/New_York',
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('compiles to the cron the server will derive, for every frequency', () => {
    // Asserting the DERIVED cron, not `RecurrenceWriteSchema.safeParse(...)` —
    // `formToRecurrence` returns that schema's own parse output, so re-parsing
    // it could never fail and would prove nothing.
    const cases: Array<[RecurrenceFormState, string]> = [
      [form({ frequency: 'minute' }), '* * * * *'],
      [form({ frequency: 'hour', minutes: '0,30' }), '0,30 * * * *'],
      [form({ frequency: 'day', hours: '9', minutes: '0' }), '0 9 * * *'],
      [form({ frequency: 'week', weekDays: [3, 1], hours: '9' }), '0 9 * * 1,3'],
      [form({ frequency: 'month', monthDays: '15,1', hours: '9' }), '0 9 1,15 * *'],
    ];
    for (const [input, cron] of cases) {
      expect(recurrenceToCron(recurrenceOf(input))).toBe(cron);
    }
  });
});

describe('formToRecurrence — an untouched bound is written back unchanged', () => {
  /** A form as loaded from a stored recurrence, with nothing edited. */
  function loaded(recurrence: Recurrence): RecurrenceFormState {
    return recurrenceToForm(recurrence);
  }

  it('preserves sub-second precision the control cannot hold', () => {
    // The control has no milliseconds, so re-deriving the bound from it would
    // shift an INCLUSIVE start and an EXCLUSIVE end merely because the form was
    // opened — silently widening the firing window at one end and dropping the
    // last occurrence at the other.
    const original: Recurrence = {
      frequency: 'day',
      interval: 1,
      startTime: '2026-01-01T09:15:45.500Z',
      endTime: '2026-06-01T09:15:45.500Z',
    };
    expect(recurrenceOf(loaded(original))).toEqual(original);
  });

  it('keeps a sub-minute window saveable', () => {
    // Both bounds would round to the same minute, making the window empty and
    // the trigger permanently unsaveable against the write schema's
    // `endTime > startTime` rule.
    const original: Recurrence = {
      frequency: 'day',
      interval: 1,
      startTime: '2026-01-01T09:15:10.000Z',
      endTime: '2026-01-01T09:15:50.000Z',
    };
    expect(recurrenceOf(loaded(original))).toEqual(original);
  });

  it('re-derives a bound the operator DID edit', () => {
    const asLoaded = loaded({
      frequency: 'day',
      interval: 1,
      startTime: '2026-01-01T09:15:45.500Z',
    });
    const edited = { ...asLoaded, startTime: '2026-02-02T10:00' };
    expect(recurrenceOf(edited).startTime).toBe(localInputToUtcIso('2026-02-02T10:00'));
  });
});

describe('recurrenceToForm — round trip', () => {
  const cases: Recurrence[] = [
    { frequency: 'minute', interval: 1 },
    { frequency: 'hour', interval: 1, schedule: { minutes: [0, 30] } },
    { frequency: 'day', interval: 1, schedule: { hours: [9], minutes: [0] } },
    { frequency: 'week', interval: 1, schedule: { weekDays: [1, 3], hours: [9] } },
    { frequency: 'month', interval: 1, schedule: { monthDays: [1, 15], hours: [9] } },
    {
      frequency: 'week',
      interval: 2,
      schedule: { weekDays: [1] },
      startTime: '2026-08-01T09:00:00.000Z',
      timeZone: 'Europe/London',
    },
  ];

  it('re-derives the same recurrence after a trip through the form', () => {
    for (const original of cases) {
      expect(recurrenceOf(recurrenceToForm(original))).toEqual(original);
    }
  });
});

describe('localInputToUtcIso / utcIsoToLocalInput', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it('reads a datetime-local value as BROWSER-LOCAL wall clock', () => {
    // The schema pins `startTime`/`endTime` as ABSOLUTE instants, unaffected by
    // the recurrence's own `timeZone`. So the control's naive value is anchored
    // in the browser's zone — asserted here against a PINNED zone, or this test
    // would pass vacuously in a UTC CI box.
    process.env.TZ = 'America/New_York';
    expect(localInputToUtcIso('2026-08-01T09:00')).toBe('2026-08-01T13:00:00.000Z');
    process.env.TZ = 'UTC';
    expect(localInputToUtcIso('2026-08-01T09:00')).toBe('2026-08-01T09:00:00.000Z');
  });

  it('renders a stored UTC instant back in local wall clock, not UTC', () => {
    process.env.TZ = 'America/New_York';
    expect(utcIsoToLocalInput('2026-08-01T13:00:00.000Z')).toBe('2026-08-01T09:00');
  });

  it('round-trips through the control in a non-UTC zone', () => {
    process.env.TZ = 'Australia/Sydney';
    const local = '2026-12-25T18:30';
    const iso = localInputToUtcIso(local);
    expect(iso).not.toBeNull();
    expect(utcIsoToLocalInput(iso as string)).toBe(local);
  });

  it('returns null for an unparseable value rather than an Invalid Date', () => {
    expect(localInputToUtcIso('not-a-date')).toBeNull();
    expect(localInputToUtcIso('')).toBeNull();
  });
});

describe('pruneForFrequency', () => {
  it('drops a selection the new frequency does not honour', () => {
    const weekly = form({ frequency: 'week', weekDays: [1, 3], hours: '9', minutes: '30' });
    const daily = pruneForFrequency(weekly, 'day');
    expect(daily.frequency).toBe('day');
    expect(daily.weekDays).toEqual([]);
    // `hours`/`minutes` ARE honoured by `day`, so they survive the switch.
    expect(daily.hours).toBe('9');
    expect(daily.minutes).toBe('30');
  });

  it('drops everything for a per-minute recurrence, which honours no sub-field', () => {
    const pruned = pruneForFrequency(
      form({ frequency: 'day', hours: '9', minutes: '30' }),
      'minute',
    );
    expect(pruned.hours).toBe('');
    expect(pruned.minutes).toBe('');
  });
});

describe('cronPreview', () => {
  it('shows the compiled cron when it is the WHOLE truth', () => {
    const preview = cronPreview({ frequency: 'day', interval: 1, schedule: { hours: [2] } });
    expect(preview).toEqual({ kind: 'cron', cron: '0 2 * * *' });
  });

  it('refuses to show a cron for interval > 1, which the compiler IGNORES', () => {
    // `recurrenceToCron` compiles only the within-period pattern; interval is
    // computed server-side. Showing its output here would misrepresent the
    // schedule as "every week" when the operator authored "every 2 weeks".
    const preview = cronPreview({
      frequency: 'week',
      interval: 2,
      schedule: { weekDays: [1] },
      startTime: '2026-08-01T09:00:00.000Z',
    });
    expect(preview.kind).toBe('summary');
    if (preview.kind === 'summary') expect(preview.text).toContain('every 2 weeks');
  });

  it('refuses to show a cron for a non-UTC zone, which the cron string cannot carry', () => {
    const preview = cronPreview({
      frequency: 'day',
      interval: 1,
      schedule: { hours: [9] },
      timeZone: 'Europe/London',
    });
    expect(preview.kind).toBe('summary');
    if (preview.kind === 'summary') expect(preview.text).toContain('Europe/London');
  });

  it('still shows the cron for an explicit UTC zone, which the cron DOES mean', () => {
    const preview = cronPreview({
      frequency: 'day',
      interval: 1,
      schedule: { hours: [9] },
      timeZone: 'UTC',
    });
    expect(preview.kind).toBe('cron');
  });
});

describe('WEEK_DAY_NAMES', () => {
  it('labels each day with the value that day actually STORES', () => {
    // Tying the label to the compiled cron day-of-week, rather than to a
    // hand-written copy of the same array: if the labels were ever reordered,
    // "Mon" would start meaning a different stored value and this would fail.
    expect(WEEK_DAY_NAMES).toHaveLength(7);
    WEEK_DAY_NAMES.forEach((name, day) => {
      const summary = cronPreview({
        frequency: 'week',
        interval: 2,
        schedule: { weekDays: [day] },
        startTime: '2026-08-01T09:00:00.000Z',
      });
      expect(summary.kind).toBe('summary');
      if (summary.kind === 'summary') expect(summary.text).toContain(name);
      expect(
        recurrenceToCron({ frequency: 'week', interval: 1, schedule: { weekDays: [day] } }),
      ).toBe(`0 0 * * ${day}`);
    });
    // The anchor the whole indexing rests on: cron day-of-week 0 is Sunday.
    expect(WEEK_DAY_NAMES[0]).toBe('Sun');
  });
});
