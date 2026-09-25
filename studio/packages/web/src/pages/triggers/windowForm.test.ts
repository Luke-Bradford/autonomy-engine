import { describe, expect, it } from 'vitest';
import type { WindowConfig } from '@autonomy-studio/shared';
import { localInputToUtcIso } from './formFields';
import { blankWindowForm, formToWindow, windowToForm, type WindowFormState } from './windowForm';

function form(over: Partial<WindowFormState> = {}): WindowFormState {
  return { ...blankWindowForm(), ...over };
}

/** The window a valid conversion produced, or a thrown reason. */
function windowOf(state: WindowFormState): WindowConfig | null {
  const converted = formToWindow(state);
  if (!converted.ok) throw new Error(`expected a conversion, got: ${converted.reason}`);
  return converted.window;
}

function reasonOf(state: WindowFormState): string {
  const converted = formToWindow(state);
  if (converted.ok) throw new Error('expected a refusal, got a window');
  return converted.reason;
}

/**
 * The instant a local wall-clock fixture denotes, resolved the way the browser
 * would — never written as a literal beside it.
 *
 * A hardcoded pair (`'2026-08-01T09:00'` ↔ `'2026-08-01T08:00:00.000Z'`) is only
 * self-consistent in a UTC+1 zone, and `resolveBound` reads an INCONSISTENT pair
 * as a control the operator edited, so it re-derives the bound instead of
 * honouring the shadow. That makes the fixture, not the code, decide which
 * branch is under test: it asserted the untouched branch in BST and the edited
 * branch in CI's UTC, where it failed.
 */
function isoOf(local: string): string {
  const iso = localInputToUtcIso(local);
  if (iso === null) throw new Error(`fixture is not a local date-time: ${local}`);
  return iso;
}

/** A start bound, with its shadow — the shape `windowToForm` produces. */
const START_LOCAL = '2026-08-01T09:00';
const START_ISO = isoOf(START_LOCAL);
const START = { startTime: START_LOCAL, startTimeIso: START_ISO };

describe('formToWindow — the absent/present boundary', () => {
  it('reads an untouched form as NO window, not a half-built one', () => {
    // A tumbling trigger may legally be stored with `window: null` while it is
    // disabled (`assertWindowConsistent` only requires one when ENABLED), so an
    // untouched builder must round-trip to null rather than invent a window.
    expect(windowOf(blankWindowForm())).toBeNull();
  });

  it('refuses a form that was filled in but has no start time', () => {
    // The opposite fail-open: silently returning null here would DISCARD what
    // the operator typed, and (on a disabled trigger) save clean while doing it.
    //
    // Asserting the MESSAGE, not just the path: the schema emits its own
    // `startTime: Required`, so a path-only assertion passes with this explicit
    // refusal deleted — and the whole point of it is to name the CONTROL the
    // operator is looking at rather than the shape.
    expect(reasonOf(form({ interval: '4' }))).toBe(
      'startTime: a tumbling window needs a start time',
    );
  });

  it('builds a window from the three fields that give it its geometry', () => {
    expect(windowOf(form({ frequency: 'hour', interval: '2', ...START }))).toEqual({
      frequency: 'hour',
      interval: 2,
      startTime: START_ISO,
    });
  });

  it('treats a blank interval as the schema default of 1', () => {
    expect(windowOf(form(START))?.interval).toBe(1);
  });

  it('OMITS a blank optional bound rather than sending 0', () => {
    const built = windowOf(form(START));
    expect(built).not.toBeNull();
    expect('maxBackfillWindows' in built!).toBe(false);
    expect('maxConcurrentWindows' in built!).toBe(false);
    expect('endTime' in built!).toBe(false);
  });
});

describe('formToWindow — the text a control can hold that a number cannot', () => {
  it("refuses an exponent interval rather than reading '2e1' as 20", () => {
    // `<input type="number">` accepts any valid floating-point number, so `2e1`
    // reaches the conversion from the real control (#623's lesson, one form over).
    expect(reasonOf(form({ ...START, interval: '2e1' }))).toMatch(/not a whole number/);
  });

  it('refuses a fractional backfill cap', () => {
    expect(reasonOf(form({ ...START, maxBackfillWindows: '2.5' }))).toMatch(/not a whole number/);
  });

  it('refuses a start time that is not a well-formed date', () => {
    expect(reasonOf(form({ startTime: 'whenever', startTimeIso: '' }))).toMatch(/startTime/);
  });
});

describe('formToWindow — every rule beyond "is this a number" comes from the schema', () => {
  it('refuses an endTime at or before the startTime', () => {
    // The "at" case: an end bound on the same instant as the start, i.e. a
    // zero-length window.
    expect(reasonOf(form({ ...START, endTime: START_LOCAL, endTimeIso: START_ISO }))).toMatch(
      /endTime/,
    );
  });

  it('refuses a backfill cap above MAX_BACKFILL_WINDOWS_CAP', () => {
    expect(reasonOf(form({ ...START, maxBackfillWindows: '1001' }))).toMatch(/maxBackfillWindows/);
  });

  it('refuses a concurrent-window cap above MAX_CONCURRENT_WINDOWS_CAP', () => {
    expect(reasonOf(form({ ...START, maxConcurrentWindows: '51' }))).toMatch(
      /maxConcurrentWindows/,
    );
  });

  it('refuses a non-positive interval', () => {
    expect(reasonOf(form({ ...START, interval: '0' }))).toMatch(/interval/);
  });
});

describe('#861 retry + self-dependency — edited as text, validated by the write schema', () => {
  const stored: WindowConfig = {
    frequency: 'hour',
    interval: 2,
    startTime: '2026-08-01T08:00:00.000Z',
    endTime: '2026-09-01T08:00:00.000Z',
    maxBackfillWindows: 5,
    maxConcurrentWindows: 3,
    retry: { count: 2, intervalInSeconds: 60 },
    selfDependency: { offsetInSeconds: -7200 },
  };
  /** A valid window with nothing but the geometry — the base the sub-objects are typed into. */
  const base = (): WindowFormState => windowToForm({
    frequency: 'hour',
    interval: 2,
    startTime: '2026-08-01T08:00:00.000Z',
  });

  it('round-trips a fully-populated window byte for byte', () => {
    expect(windowOf(windowToForm(stored))).toEqual(stored);
    expect(windowOf(windowToForm({ ...stored, selfDependency: { offsetInSeconds: -14400, sizeInSeconds: 3600 } })))
      .toEqual({ ...stored, selfDependency: { offsetInSeconds: -14400, sizeInSeconds: 3600 } });
  });

  it('loads each sub-object field into its own text control', () => {
    const loaded = windowToForm(stored);
    expect(loaded.retryCount).toBe('2');
    expect(loaded.retryIntervalSeconds).toBe('60');
    expect(loaded.dependencyOffsetSeconds).toBe('-7200');
    // ABSENT size stays blank — it means "one window", not 0.
    expect(loaded.dependencySizeSeconds).toBe('');
  });

  it('keeps retry and selfDependency when an unrelated field is changed', () => {
    const edited = { ...windowToForm(stored), maxBackfillWindows: '9' };
    expect(windowOf(edited)).toEqual({ ...stored, maxBackfillWindows: 9 });
  });

  it('authors both sub-objects from typed text', () => {
    const typed = {
      ...base(),
      retryCount: '3',
      retryIntervalSeconds: '120',
      dependencyOffsetSeconds: '-7200',
      dependencySizeSeconds: '3600',
    };
    expect(windowOf(typed)).toMatchObject({
      retry: { count: 3, intervalInSeconds: 120 },
      selfDependency: { offsetInSeconds: -7200, sizeInSeconds: 3600 },
    });
  });

  it('reads blank fields as ABSENT sub-objects, never zeros', () => {
    const w = windowOf(base());
    expect(w).not.toHaveProperty('retry');
    expect(w).not.toHaveProperty('selfDependency');
    // Clearing a loaded policy removes it — that is how an operator turns retry off.
    const cleared = { ...windowToForm(stored), retryCount: '', retryIntervalSeconds: '' };
    expect(windowOf(cleared)).not.toHaveProperty('retry');
  });

  it('refuses half a retry policy, naming the missing half', () => {
    expect(reasonOf({ ...base(), retryCount: '3' })).toMatch(/^retry: .*interval/);
    expect(reasonOf({ ...base(), retryIntervalSeconds: '60' })).toMatch(/^retry: .*count/);
  });

  it('refuses a dependency size with no offset', () => {
    expect(reasonOf({ ...base(), dependencySizeSeconds: '3600' })).toMatch(
      /^selfDependency: .*offset/,
    );
  });

  it('refuses text that is not a whole number, naming the control', () => {
    expect(reasonOf({ ...base(), retryCount: '1.5', retryIntervalSeconds: '60' })).toMatch(
      /^retryCount: /,
    );
    expect(reasonOf({ ...base(), dependencyOffsetSeconds: 'soon' })).toMatch(
      /^dependencyOffsetSeconds: /,
    );
  });

  it('leaves the ranges to the write schema — the client restates no cap', () => {
    // Each of these is a WindowConfigWriteSchema rule, so the refusal carries its path.
    expect(reasonOf({ ...base(), retryCount: '101', retryIntervalSeconds: '60' })).toMatch(
      /retry\.count/,
    );
    expect(reasonOf({ ...base(), retryCount: '1', retryIntervalSeconds: '29' })).toMatch(
      /retry\.intervalInSeconds/,
    );
    // A dependency on the present or future is a deadlock: the offset must be negative …
    expect(reasonOf({ ...base(), dependencyOffsetSeconds: '7200' })).toMatch(/selfDependency/);
    // … and the interval must end at or before the window's own start.
    expect(
      reasonOf({ ...base(), dependencyOffsetSeconds: '-3600', dependencySizeSeconds: '7200' }),
    ).toMatch(/selfDependency/);
  });

  it('is not read as an untouched form merely because the geometry is blank', () => {
    // A typed sub-object field is authored state: it must not collapse the whole
    // window to null and silently drop what was typed.
    expect(reasonOf(form({ retryCount: '2' }))).toMatch(/startTime/);
    expect(reasonOf(form({ dependencyOffsetSeconds: '-60' }))).toMatch(/startTime/);
  });

  it('does not re-derive an untouched bound from the control', () => {
    // A `datetime-local` holds no sub-seconds, so re-deriving would shift the
    // stored instant just because the form was opened.
    const subSecond: WindowConfig = {
      frequency: 'minute',
      interval: 15,
      startTime: '2026-08-01T08:00:30.500Z',
    };
    expect(windowOf(windowToForm(subSecond))?.startTime).toBe('2026-08-01T08:00:30.500Z');
  });
});
