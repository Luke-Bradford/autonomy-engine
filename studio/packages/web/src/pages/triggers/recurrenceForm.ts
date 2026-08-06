import {
  formatZodIssues,
  HONOURED_FIELDS,
  RecurrenceWriteSchema,
  recurrenceToCron,
  type Recurrence,
  type RecurrenceFrequency,
  type RecurrenceSchedule,
} from '@autonomy-studio/shared';
import {
  pad,
  parseWholeNumber,
  resolveBoundsInto,
  utcIsoToLocalInput,
  WHOLE_NUMBER,
} from './formFields';

/**
 * #439 U14b — the PURE half of the recurrence builder: converting between the
 * strings an `<input>` holds and the structured `Recurrence` the trigger write
 * boundary accepts. Kept out of the component so the conversion — which is
 * where every lossy edge lives — is unit-testable without a DOM.
 *
 * ## The two rules this module exists to honour
 *
 * 1. **A blank field is an ABSENT field, never `[]`.** Every
 *    `RecurrenceScheduleSchema` array is `.nonempty()`, so an empty array is
 *    REFUSED by the write boundary — it is not a benign "nothing selected".
 *    Same shape as #473's fail-open `.default([])`: an absent fact must not be
 *    manufactured into a present one.
 * 2. **Only fields the frequency HONOURS are emitted.** `HONOURED_FIELDS` is
 *    imported from the schema module rather than restated here, so a frequency
 *    change prunes exactly what the server would refuse. A parallel list would
 *    drift, and the drift would only surface as a 400 at save time.
 *
 * Validation is delegated WHOLE to `RecurrenceWriteSchema` — not re-implemented
 * as a subset. That is what buys the cross-field rules for free: the `interval
 * > 1` startTime anchor (#550), the `MAX_RECURRENCE_INTERVAL` cap, the
 * `interval > 1` + `hour` + non-UTC DST refusal (#623), the resolvable-IANA
 * check (#552) and the non-empty `[startTime, endTime)` window (#549).
 */

/** Which of the two mutually-exclusive ways of authoring a schedule is active.
 * The server refuses a write that authors BOTH a `recurrence` and a raw cron
 * `schedule` (`assertRecurrenceConsistent`), so the form models the choice as a
 * toggle and always sends the other side as an explicit `null`. */
export type ScheduleKind = 'recurrence' | 'cron';

/** Day-of-week labels indexed so `0` is Sunday — matching
 * `RecurrenceScheduleSchema.weekDays`, `RunWindowSchema.days` and cron's
 * day-of-week field. The index IS the stored value; do not reorder. */
export const WEEK_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * The editor's state. Every numeric field is held as the TEXT the operator
 * typed (not a parsed number) so a half-typed value survives a re-render and an
 * invalid one can be reported with the text that caused it. `weekDays` is the
 * exception: it comes from a checkbox group, so it is already numeric and has
 * no unparseable intermediate state.
 */
export interface RecurrenceFormState {
  frequency: RecurrenceFrequency;
  interval: string;
  minutes: string;
  hours: string;
  weekDays: number[];
  monthDays: string;
  /** IANA zone; `''` = absent, which the schema reads as UTC. */
  timeZone: string;
  /** `datetime-local` values (naive, browser-local wall clock); `''` = absent. */
  startTime: string;
  endTime: string;
  /**
   * The bounds EXACTLY as they were loaded, so an untouched one is written back
   * byte-identical instead of being re-derived from the control.
   *
   * A `datetime-local` value has no sub-second component, so a stored
   * `09:15:45.500Z` would otherwise come back as `09:15:45.000Z` merely because
   * the operator opened the form to rename the trigger. That is not cosmetic:
   * `startTime` is the INCLUSIVE bound and `endTime` the EXCLUSIVE one, so a
   * silent shift widens the firing window at one end and drops the last
   * occurrence at the other — and a sub-minute window would collapse to
   * `endTime <= startTime`, which the write boundary refuses, leaving the
   * trigger permanently unsaveable. Same principle as the rest of this module:
   * do not manufacture a fact the operator did not author.
   */
  startTimeIso: string;
  endTimeIso: string;
}

export function blankRecurrenceForm(): RecurrenceFormState {
  return {
    frequency: 'day',
    interval: '1',
    minutes: '',
    hours: '',
    weekDays: [],
    monthDays: '',
    timeZone: '',
    startTime: '',
    endTime: '',
    startTimeIso: '',
    endTimeIso: '',
  };
}

export type NumberListParse = { ok: true; values: number[] } | { ok: false; reason: string };

/**
 * Parse a comma-separated integer list. A blank input yields an EMPTY list,
 * which callers turn into an ABSENT field — see rule 1 above. Range checks are
 * deliberately NOT done here; they live on the schema, so there is one place
 * that knows minutes are 0–59.
 */
export function parseNumberList(raw: string): NumberListParse {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, values: [] };
  const values: number[] = [];
  for (const part of trimmed.split(',')) {
    const token = part.trim();
    if (token === '') return { ok: false, reason: 'empty entry — remove the stray comma' };
    if (!WHOLE_NUMBER.test(token)) {
      return { ok: false, reason: `'${token}' is not a whole number` };
    }
    values.push(Number(token));
  }
  return { ok: true, values };
}

/** Render a stored list back into the input's text. An absent field is blank. */
export function formatNumberList(values: readonly number[] | undefined): string {
  return values === undefined ? '' : values.join(', ');
}

/** Clear every `schedule` sub-field the NEW frequency does not honour, so a
 * selection made under the old one is never submitted (the write boundary
 * refuses an unhonoured field rather than ignoring it). */
export function pruneForFrequency(
  form: RecurrenceFormState,
  frequency: RecurrenceFrequency,
): RecurrenceFormState {
  const honoured = HONOURED_FIELDS[frequency];
  return {
    ...form,
    frequency,
    minutes: honoured.includes('minutes') ? form.minutes : '',
    hours: honoured.includes('hours') ? form.hours : '',
    weekDays: honoured.includes('weekDays') ? form.weekDays : [],
    monthDays: honoured.includes('monthDays') ? form.monthDays : '',
  };
}

export type RecurrenceConversion =
  { ok: true; recurrence: Recurrence } | { ok: false; reason: string };

/** The text-list fields, paired with the label an error message should use. */
const LIST_FIELDS: ReadonlyArray<{
  key: 'minutes' | 'hours' | 'monthDays';
  label: string;
}> = [
  { key: 'minutes', label: 'minutes' },
  { key: 'hours', label: 'hours' },
  { key: 'monthDays', label: 'monthDays' },
];

/**
 * Build a `Recurrence` from the form, or report the first reason it cannot be.
 * Every rule beyond "is this text a number" is enforced by running the result
 * through `RecurrenceWriteSchema` — the same shape the server validates with.
 */
export function formToRecurrence(form: RecurrenceFormState): RecurrenceConversion {
  const honoured = HONOURED_FIELDS[form.frequency];

  const parsedInterval = parseWholeNumber(form.interval);
  if (!parsedInterval.ok) return { ok: false, reason: `interval: ${parsedInterval.reason}` };
  // A blank interval is the schema's own default of 1, not an absent field.
  const interval = parsedInterval.value ?? 1;

  const schedule: Record<string, number[]> = {};
  for (const { key, label } of LIST_FIELDS) {
    if (!honoured.includes(key)) continue;
    const parsed = parseNumberList(form[key]);
    if (!parsed.ok) return { ok: false, reason: `${label}: ${parsed.reason}` };
    // Rule 1: an empty selection is an ABSENT field, not `[]`.
    if (parsed.values.length > 0) schedule[key] = parsed.values;
  }
  if (honoured.includes('weekDays') && form.weekDays.length > 0) {
    schedule.weekDays = [...form.weekDays].sort((a, b) => a - b);
  }

  const candidate: Record<string, unknown> = { frequency: form.frequency, interval };
  if (Object.keys(schedule).length > 0) candidate.schedule = schedule as RecurrenceSchedule;
  if (form.timeZone.trim() !== '') candidate.timeZone = form.timeZone.trim();

  const boundProblem = resolveBoundsInto(form, candidate);
  if (boundProblem !== null) return { ok: false, reason: boundProblem };

  const parsed = RecurrenceWriteSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: formatZodIssues(parsed.error.issues),
    };
  }
  return { ok: true, recurrence: parsed.data };
}

/** Load a stored recurrence back into the editor. The inverse of
 * `formToRecurrence` for any recurrence that form could have produced. */
export function recurrenceToForm(recurrence: Recurrence): RecurrenceFormState {
  return {
    frequency: recurrence.frequency,
    interval: String(recurrence.interval),
    minutes: formatNumberList(recurrence.schedule?.minutes),
    hours: formatNumberList(recurrence.schedule?.hours),
    weekDays: recurrence.schedule?.weekDays ? [...recurrence.schedule.weekDays] : [],
    monthDays: formatNumberList(recurrence.schedule?.monthDays),
    timeZone: recurrence.timeZone ?? '',
    startTime: recurrence.startTime === undefined ? '' : utcIsoToLocalInput(recurrence.startTime),
    endTime: recurrence.endTime === undefined ? '' : utcIsoToLocalInput(recurrence.endTime),
    startTimeIso: recurrence.startTime ?? '',
    endTimeIso: recurrence.endTime ?? '',
  };
}

const PERIOD_PLURAL: Record<RecurrenceFrequency, string> = {
  minute: 'minutes',
  hour: 'hours',
  day: 'days',
  week: 'weeks',
  month: 'months',
};

const PERIOD_SIMPLE: Record<RecurrenceFrequency, string> = {
  minute: 'every minute',
  hour: 'hourly',
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
};

export type CronPreview = { kind: 'cron'; cron: string } | { kind: 'summary'; text: string };

/**
 * What to show the operator as "this is the schedule you authored".
 *
 * `recurrenceToCron` is the WHOLE truth only when `interval === 1` and the zone
 * is UTC. It deliberately IGNORES `interval` — "every N periods" is not
 * cron-expressible and is computed by the server's stepping calculator — and a
 * cron string carries no zone. So showing its output for `interval > 1` would
 * read as "every week" when the operator authored "every 2 weeks", and showing
 * it for a zoned recurrence would imply UTC. Rather than print a caveated
 * half-truth, the preview falls back to a plain-English summary in exactly the
 * cases where the cron would misrepresent the schedule.
 */
export function cronPreview(recurrence: Recurrence): CronPreview {
  const zoned = recurrence.timeZone !== undefined && recurrence.timeZone !== 'UTC';
  if (recurrence.interval === 1 && !zoned) {
    return { kind: 'cron', cron: recurrenceToCron(recurrence) };
  }

  const parts: string[] = [
    recurrence.interval === 1
      ? PERIOD_SIMPLE[recurrence.frequency]
      : `every ${recurrence.interval} ${PERIOD_PLURAL[recurrence.frequency]}`,
  ];
  const s = recurrence.schedule;
  if (s?.weekDays) parts.push(s.weekDays.map((d) => WEEK_DAY_NAMES[d]).join(', '));
  if (s?.monthDays) parts.push(`on day ${s.monthDays.join(', ')}`);
  if (s?.hours) parts.push(`at ${s.hours.map((h) => `${pad(h)}:00`).join(', ')}`);
  if (s?.minutes) parts.push(`minute ${s.minutes.join(', ')}`);
  if (recurrence.timeZone !== undefined) parts.push(recurrence.timeZone);
  return { kind: 'summary', text: parts.join(' · ') };
}
