import {
  formatZodIssues,
  WindowConfigWriteSchema,
  type WindowConfig,
  type WindowFrequency,
} from '@autonomy-studio/shared';
import { parseWholeNumber, resolveBoundsInto, utcIsoToLocalInput } from './formFields';

/**
 * #439 U14b remainder (#854) — the PURE half of the tumbling-window builder:
 * converting between the strings an `<input>` holds and the `WindowConfig` the
 * trigger write boundary accepts. Kept out of the component so the conversion —
 * where every lossy edge lives — is unit-testable without a DOM.
 *
 * ## The rules this module exists to honour
 *
 * 1. **A blank field is an ABSENT field, never `0`.** Every optional bound
 *    (`endTime`, the two caps) is omitted when blank, so the schema's own
 *    optionality decides what absent means. Manufacturing `0` would be #473's
 *    fail-open `.default([])` again — a cap of 0 is a REAL instruction.
 * 2. **An untouched form is NO window, a partly-filled one is an ERROR.** A
 *    tumbling trigger may legally be stored with `window: null` while disabled
 *    (`assertWindowConsistent` requires one only when ENABLED), so the builder
 *    must round-trip that state; but silently reading half-typed geometry as
 *    "no window" would discard what the operator typed and save clean doing it.
 * 3. **What this editor cannot show, it still carries.** `retry` and
 *    `selfDependency` have no controls in this release (#861), so they are held
 *    verbatim and written back — editing a window authored through the API must
 *    not silently drop them.
 *
 * Validation is delegated WHOLE to `WindowConfigWriteSchema`, not re-implemented
 * as a subset: that buys the caps, the non-empty `[startTime, endTime)` window
 * and the self-dependency span rules for free, and keeps the client's refusals
 * identical to the server's.
 */
export interface WindowFormState {
  frequency: WindowFrequency;
  /** Whole numbers held as the TEXT typed, so a half-typed value survives a
   * re-render and an invalid one is reported with the text that caused it. */
  interval: string;
  maxBackfillWindows: string;
  maxConcurrentWindows: string;
  /** `datetime-local` values (naive, browser-local wall clock); `''` = absent. */
  startTime: string;
  endTime: string;
  /**
   * The bounds EXACTLY as loaded, so an untouched one is written back
   * byte-identical rather than re-derived from a control that holds no
   * sub-seconds. `startTime` is the window epoch: shifting it silently re-keys
   * every window boundary the trigger has ever computed.
   */
  startTimeIso: string;
  endTimeIso: string;
  /** Preserved verbatim — see rule 3. No controls in this release (#861). */
  retry: WindowConfig['retry'];
  selfDependency: WindowConfig['selfDependency'];
}

export function blankWindowForm(): WindowFormState {
  return {
    frequency: 'hour',
    interval: '',
    maxBackfillWindows: '',
    maxConcurrentWindows: '',
    startTime: '',
    endTime: '',
    startTimeIso: '',
    endTimeIso: '',
    retry: undefined,
    selfDependency: undefined,
  };
}

/**
 * Is this form still exactly as it was opened on an unconfigured trigger?
 *
 * `frequency` is excluded deliberately: it has a default and no "unset" state,
 * so choosing one authors nothing on its own. Everything else — including a
 * preserved sub-object, which IS authored state — counts as touched.
 */
function isUntouched(form: WindowFormState): boolean {
  return (
    form.interval.trim() === '' &&
    form.maxBackfillWindows.trim() === '' &&
    form.maxConcurrentWindows.trim() === '' &&
    form.startTime.trim() === '' &&
    form.endTime.trim() === '' &&
    form.retry === undefined &&
    form.selfDependency === undefined
  );
}

export type WindowConversion =
  { ok: true; window: WindowConfig | null } | { ok: false; reason: string };

/** The optional whole-number caps. Both are read the same way, so they are a
 * plain list rather than a table of one-field rows. */
const CAP_FIELDS = ['maxBackfillWindows', 'maxConcurrentWindows'] as const;

/**
 * Build a `WindowConfig` from the form, or report the first reason it cannot be.
 */
export function formToWindow(form: WindowFormState): WindowConversion {
  if (isUntouched(form)) return { ok: true, window: null };

  const parsedInterval = parseWholeNumber(form.interval);
  if (!parsedInterval.ok) return { ok: false, reason: `interval: ${parsedInterval.reason}` };
  // `WindowConfigSchema.interval` is REQUIRED and has NO default (unlike
  // `RecurrenceSchema.interval`), so a blank control is the CLIENT supplying the
  // plainest window there is — one period — not a schema default being honoured.
  // Copying the recurrence builder must not copy a premise that does not hold.
  const candidate: Record<string, unknown> = {
    frequency: form.frequency,
    interval: parsedInterval.value ?? 1,
  };

  for (const key of CAP_FIELDS) {
    const parsed = parseWholeNumber(form[key]);
    if (!parsed.ok) return { ok: false, reason: `${key}: ${parsed.reason}` };
    // Rule 1: blank means the cap is absent, not that it is zero.
    if (parsed.value !== undefined) candidate[key] = parsed.value;
  }

  // `startTime` is REQUIRED — the window epoch. Reported as a refusal rather
  // than left to the schema so the message names the control, not the shape.
  if (form.startTime.trim() === '') {
    return { ok: false, reason: 'startTime: a tumbling window needs a start time' };
  }
  const boundProblem = resolveBoundsInto(form, candidate);
  if (boundProblem !== null) return { ok: false, reason: boundProblem };

  // Rule 3: carried through untouched, so the write is not a silent truncation
  // of what was loaded.
  if (form.retry !== undefined) candidate.retry = form.retry;
  if (form.selfDependency !== undefined) candidate.selfDependency = form.selfDependency;

  const parsed = WindowConfigWriteSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: formatZodIssues(parsed.error.issues),
    };
  }
  return { ok: true, window: parsed.data };
}

/** Load a stored window back into the editor. The inverse of `formToWindow` for
 * any window that form could have produced — and a faithful carrier for the
 * parts it could not. */
export function windowToForm(window: WindowConfig): WindowFormState {
  return {
    frequency: window.frequency,
    interval: String(window.interval),
    maxBackfillWindows:
      window.maxBackfillWindows === undefined ? '' : String(window.maxBackfillWindows),
    maxConcurrentWindows:
      window.maxConcurrentWindows === undefined ? '' : String(window.maxConcurrentWindows),
    startTime: utcIsoToLocalInput(window.startTime),
    endTime: window.endTime === undefined ? '' : utcIsoToLocalInput(window.endTime),
    startTimeIso: window.startTime,
    endTimeIso: window.endTime ?? '',
    retry: window.retry,
    selfDependency: window.selfDependency,
  };
}
