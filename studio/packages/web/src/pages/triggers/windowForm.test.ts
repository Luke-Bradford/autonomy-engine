import { describe, expect, it } from 'vitest';
import type { WindowConfig } from '@autonomy-studio/shared';
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

/** A start bound, with its shadow — the shape `windowToForm` produces. */
const START = { startTime: '2026-08-01T09:00', startTimeIso: '2026-08-01T08:00:00.000Z' };

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
      startTime: '2026-08-01T08:00:00.000Z',
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
    expect(
      reasonOf(
        form({ ...START, endTime: '2026-08-01T09:00', endTimeIso: '2026-08-01T08:00:00.000Z' }),
      ),
    ).toMatch(/endTime/);
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

describe('windowToForm — a window this builder has no controls for still survives', () => {
  // #854 deliberately ships editors for the geometry + bounds only. `retry` and
  // `selfDependency` are held VERBATIM so editing a window authored through the
  // API (or a later, richer editor) cannot silently drop them — the same reason
  // `eventForm` keeps its catchall extras.
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

  it('round-trips a fully-populated window byte for byte', () => {
    expect(windowOf(windowToForm(stored))).toEqual(stored);
  });

  it('keeps retry and selfDependency when an editable field is changed', () => {
    const edited = { ...windowToForm(stored), maxBackfillWindows: '9' };
    expect(windowOf(edited)).toEqual({ ...stored, maxBackfillWindows: 9 });
  });

  it('reports a preserved sub-object so the editor can say it is there', () => {
    const loaded = windowToForm(stored);
    expect(loaded.retry).toEqual({ count: 2, intervalInSeconds: 60 });
    expect(loaded.selfDependency).toEqual({ offsetInSeconds: -7200 });
    expect(blankWindowForm().retry).toBeUndefined();
  });

  it('is not read as an untouched form merely because the text fields are blank', () => {
    // A preserved sub-object is authored state: clearing the visible fields must
    // not collapse the whole window to null and take the retry policy with it.
    const preservedOnly = form({ retry: { count: 2, intervalInSeconds: 60 } });
    expect(reasonOf(preservedOnly)).toMatch(/startTime/);
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
