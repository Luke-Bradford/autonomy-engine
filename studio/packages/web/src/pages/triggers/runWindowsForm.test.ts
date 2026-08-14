import { describe, expect, it } from 'vitest';
import {
  blankRunWindowRow,
  blankRunWindowsForm,
  formToRunWindows,
  isUnreadableBound,
  runWindowsToForm,
  type RunWindowsFormState,
} from './runWindowsForm';

const row = (over: Partial<ReturnType<typeof blankRunWindowRow>> = {}) => ({
  ...blankRunWindowRow(),
  ...over,
});

const restricted = (...rows: ReturnType<typeof row>[]): RunWindowsFormState => ({
  restricted: true,
  rows,
});

describe('formToRunWindows', () => {
  it('an unrestricted form is `null`, not an empty array', () => {
    expect(formToRunWindows(blankRunWindowsForm())).toEqual({ ok: true, runWindows: null });
  });

  it('builds a window from the typed bounds', () => {
    expect(formToRunWindows(restricted(row({ start: '09:00', end: '17:00' })))).toEqual({
      ok: true,
      runWindows: [{ start: '09:00', end: '17:00' }],
    });
  });

  it('OMITS `days` when the row is not day-restricted — never `[]`', () => {
    const result = formToRunWindows(restricted(row({ start: '09:00', end: '17:00', days: [1] })));
    expect(result).toEqual({ ok: true, runWindows: [{ start: '09:00', end: '17:00' }] });
    // An empty `days` matches no weekday at all, so manufacturing one from "no
    // boxes ticked" would make the default authoring a window that never opens.
    if (!result.ok) return;
    expect('days' in result.runWindows![0]!).toBe(false);
  });

  it('writes `days` sorted when the row IS day-restricted', () => {
    expect(
      formToRunWindows(
        restricted(row({ start: '09:00', end: '17:00', daysRestricted: true, days: [5, 1, 3] })),
      ),
    ).toEqual({ ok: true, runWindows: [{ start: '09:00', end: '17:00', days: [1, 3, 5] }] });
  });

  it('keeps the deliberate never-open `[]` when restricted with no rows', () => {
    // `restricted` exists precisely so this stays distinguishable from `null`.
    expect(formToRunWindows({ restricted: true, rows: [] })).toEqual({ ok: true, runWindows: [] });
  });

  it('does NOT write rows the operator has switched off — they are not an error', () => {
    expect(
      formToRunWindows({ restricted: false, rows: [row({ start: 'nonsense', end: '' })] }),
    ).toEqual({ ok: true, runWindows: null });
  });

  it.each([
    ['a bound the scheduler cannot read', row({ start: '9am', end: '17:00' })],
    ['a blank bound', row({ start: '', end: '17:00' })],
    ['a zero-width window', row({ start: '09:00', end: '09:00' })],
    ['day-restricted with no day selected', row({ start: '09:00', end: '17:00', daysRestricted: true })],
  ])('refuses %s', (_label, bad) => {
    expect(formToRunWindows(restricted(bad)).ok).toBe(false);
  });

  it('trims a padded bound rather than refusing it', () => {
    // The schema is anchored and would refuse ' 09:00'; whitespace is a typing
    // artefact, not an authoring decision, so the form settles it.
    expect(formToRunWindows(restricted(row({ start: ' 09:00 ', end: '17:00' })))).toEqual({
      ok: true,
      runWindows: [{ start: '09:00', end: '17:00' }],
    });
  });

  it('names the offending WINDOW by its on-screen number, not its array index', () => {
    const result = formToRunWindows(
      restricted(row({ start: '09:00', end: '17:00' }), row({ start: '9am', end: '17:00' })),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Zod says `1.start`; the operator is looking at a row headed "Window 2".
    expect(result.reason).toContain('window 2.start');
    expect(result.reason).not.toContain('1.start');
  });
});

describe('runWindowsToForm', () => {
  it('distinguishes `null` (unrestricted) from `[]` (configured, never open)', () => {
    expect(runWindowsToForm(null)).toEqual({ restricted: false, rows: [] });
    expect(runWindowsToForm([])).toEqual({ restricted: true, rows: [] });
  });

  it('distinguishes an ABSENT `days` from an empty one', () => {
    const absent = runWindowsToForm([{ start: '09:00', end: '17:00' }]).rows[0]!;
    const empty = runWindowsToForm([{ start: '09:00', end: '17:00', days: [] }]).rows[0]!;
    expect(absent.daysRestricted).toBe(false);
    expect(empty.daysRestricted).toBe(true);
  });

  it.each([
    ['unrestricted', null],
    ['a plain window', [{ start: '09:00', end: '17:00' }]],
    ['a wrap-past-midnight window', [{ start: '22:00', end: '02:00' }]],
    ['a day-restricted window', [{ start: '09:00', end: '17:00', days: [1, 5] }]],
    ['two windows', [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '17:00' }]],
    ['the never-open empty array', []],
  ])('round-trips %s unchanged', (_label, stored) => {
    const result = formToRunWindows(runWindowsToForm(stored));
    expect(result).toEqual({ ok: true, runWindows: stored });
  });

  it('carries a bound the control could not have produced, rather than dropping it', () => {
    // Rule 3. The JSON textarea this editor replaces could store "9am"; the
    // operator must SEE the value that broke their trigger to repair it.
    const form = runWindowsToForm([{ start: '9am', end: '5pm' }]);
    expect(form.rows[0]!.start).toBe('9am');
    // ...and the save still refuses it, so the repair is enforced, not suggested.
    expect(formToRunWindows(form).ok).toBe(false);
  });

  it('a stored empty `days` survives a reload as day-restricted, so a rename cannot widen it', () => {
    // The regression this guards: reading "no boxes ticked" as "every day" would
    // turn a window that never opened into one that opens every day, silently,
    // on a save that touched something else entirely.
    const form = runWindowsToForm([{ start: '09:00', end: '17:00', days: [] }]);
    expect(formToRunWindows(form).ok).toBe(false);
  });
});

describe('isUnreadableBound', () => {
  it.each(['9am', '25:00', '09:60', '24:00', 'nonsense'])('flags %s', (bound) => {
    expect(isUnreadableBound(bound)).toBe(true);
  });

  it.each(['09:00', '9:00', '00:00', '23:59', ' 09:00 '])('accepts %s', (bound) => {
    expect(isUnreadableBound(bound)).toBe(false);
  });

  it('a BLANK bound is un-authored, not malformed', () => {
    // It still fails the save; it just must not be reported as a value the
    // scheduler cannot read, because there is no value.
    expect(isUnreadableBound('')).toBe(false);
    expect(isUnreadableBound('   ')).toBe(false);
  });
});
