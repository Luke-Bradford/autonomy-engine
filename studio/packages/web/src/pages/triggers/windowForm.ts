import {
  WindowConfigWriteSchema,
  formatZodIssues,
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
 * 3. **A sub-object is all or nothing.** `retry` needs both of its fields and
 *    `selfDependency` needs its offset (#861). Both halves blank is an ABSENT
 *    sub-object (rule 1); half of one is refused here, naming the control, where
 *    the schema would only say `Required` against a path the operator never saw.
 *    That is the one shape rule restated client-side, for its message (the
 *    `startTime` precedent below) — every RANGE stays the schema's.
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
  /** #861 — `retry.count` / `retry.intervalInSeconds`, as typed. */
  retryCount: string;
  retryIntervalSeconds: string;
  /** #861 — `selfDependency`, as typed. The offset is SIGNED (strictly
   * negative when valid), exactly the stored field, so the schema's own
   * refusals name what the operator typed rather than a negated copy of it. */
  dependencyOffsetSeconds: string;
  /** Blank = ABSENT = one window size — the schema's default, not `0`. */
  dependencySizeSeconds: string;
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
    retryCount: '',
    retryIntervalSeconds: '',
    dependencyOffsetSeconds: '',
    dependencySizeSeconds: '',
  };
}

/**
 * Is this form still exactly as it was opened on an unconfigured trigger?
 *
 * `frequency` is excluded deliberately: it has a default and no "unset" state,
 * so choosing one authors nothing on its own. Every other control counts.
 */
function isUntouched(form: WindowFormState): boolean {
  return TEXT_FIELDS.every((key) => form[key].trim() === '');
}

export type WindowConversion =
  { ok: true; window: WindowConfig | null } | { ok: false; reason: string };

/** The optional whole-number caps. Both are read the same way, so they are a
 * plain list rather than a table of one-field rows. */
const CAP_FIELDS = ['maxBackfillWindows', 'maxConcurrentWindows'] as const;

/** The #861 sub-object fields, read like the caps: whole numbers, blank = absent. */
const SUB_OBJECT_FIELDS = [
  'retryCount',
  'retryIntervalSeconds',
  'dependencyOffsetSeconds',
  'dependencySizeSeconds',
] as const;

/** Every free-text control — what "untouched" is judged over. */
const TEXT_FIELDS = [
  'interval',
  'startTime',
  'endTime',
  ...CAP_FIELDS,
  ...SUB_OBJECT_FIELDS,
] as const;

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

  const sub: Partial<Record<(typeof SUB_OBJECT_FIELDS)[number], number>> = {};
  for (const key of SUB_OBJECT_FIELDS) {
    const parsed = parseWholeNumber(form[key]);
    if (!parsed.ok) return { ok: false, reason: `${key}: ${parsed.reason}` };
    if (parsed.value !== undefined) sub[key] = parsed.value;
  }

  // Rule 3: all or nothing per sub-object.
  const { retryCount, retryIntervalSeconds, dependencyOffsetSeconds, dependencySizeSeconds } = sub;
  if (retryCount !== undefined && retryIntervalSeconds !== undefined) {
    candidate.retry = { count: retryCount, intervalInSeconds: retryIntervalSeconds };
  } else if (retryCount !== undefined) {
    return { ok: false, reason: 'retry: a retry policy needs an interval as well as a count' };
  } else if (retryIntervalSeconds !== undefined) {
    return { ok: false, reason: 'retry: a retry policy needs a count as well as an interval' };
  }
  if (dependencyOffsetSeconds !== undefined) {
    candidate.selfDependency = {
      offsetInSeconds: dependencyOffsetSeconds,
      ...(dependencySizeSeconds !== undefined ? { sizeInSeconds: dependencySizeSeconds } : {}),
    };
  } else if (dependencySizeSeconds !== undefined) {
    return {
      ok: false,
      reason: 'selfDependency: a dependency size needs an offset to measure it from',
    };
  }

  const parsed = WindowConfigWriteSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: formatZodIssues(parsed.error.issues),
    };
  }
  return { ok: true, window: parsed.data };
}

/** Load a stored window back into the editor — the inverse of `formToWindow`. */
export function windowToForm(window: WindowConfig): WindowFormState {
  return {
    frequency: window.frequency,
    interval: String(window.interval),
    maxBackfillWindows: optionalText(window.maxBackfillWindows),
    maxConcurrentWindows: optionalText(window.maxConcurrentWindows),
    startTime: utcIsoToLocalInput(window.startTime),
    endTime: window.endTime === undefined ? '' : utcIsoToLocalInput(window.endTime),
    startTimeIso: window.startTime,
    endTimeIso: window.endTime ?? '',
    retryCount: optionalText(window.retry?.count),
    retryIntervalSeconds: optionalText(window.retry?.intervalInSeconds),
    dependencyOffsetSeconds: optionalText(window.selfDependency?.offsetInSeconds),
    dependencySizeSeconds: optionalText(window.selfDependency?.sizeInSeconds),
  };
}

/** An absent number is a blank control, never `'0'` or `'undefined'`. */
function optionalText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}
