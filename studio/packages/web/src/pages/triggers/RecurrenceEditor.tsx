import { useId } from 'react';
import { FieldError } from '../../lib/form/FieldError';
import { editorFields, type FieldSlots } from './editorFields';
import {
  HONOURED_FIELDS,
  MAX_RECURRENCE_INTERVAL,
  REQUIRED_FIELDS,
  RecurrenceFrequencySchema,
  type RecurrenceFrequency,
} from '@autonomy-studio/shared';
import {
  cronPreview,
  formToRecurrence,
  pruneForFrequency,
  WEEK_DAY_NAMES,
  type RecurrenceFormState,
} from './recurrenceForm';
import { boundEcho } from './formFields';
import { BoundShiftNotices } from './BoundShiftNotices';
import { LabelledControl } from '../../lib/LabelledControl';
import { RequiredMark } from '../../lib/form/RequiredMark';

const FREQUENCIES = RecurrenceFrequencySchema.options;

/** How the interval control reads for each frequency: "Repeat every N …". */
const PERIOD_NOUN: Record<RecurrenceFrequency, string> = {
  minute: 'minute(s)',
  hour: 'hour(s)',
  day: 'day(s)',
  week: 'week(s)',
  month: 'month(s)',
};

/**
 * #439 U14b — the structured recurrence builder.
 *
 * Which sub-fields appear is driven by `HONOURED_FIELDS` from the schema module,
 * not by a list held here: the editor offers exactly the fields the write
 * boundary accepts for the chosen frequency, and `pruneForFrequency` clears the
 * rest when the frequency changes. A field this editor showed but the server
 * refused would be a control that cannot be saved.
 *
 * All conversion and validation lives in `recurrenceForm.ts` (pure, unit-tested);
 * this component is presentation and wiring only.
 */
export function RecurrenceEditor({
  value,
  onChange,
  validation,
}: {
  value: RecurrenceFormState;
  onChange: (next: RecurrenceFormState) => void;
  /** #1396 — the trigger form's validation: each control is a `recurrence.<path>` field of it. */
  validation: FieldSlots;
}) {
  const f = editorFields(validation, 'recurrence', useId());
  const honoured = HONOURED_FIELDS[value.frequency];
  const required = REQUIRED_FIELDS[value.frequency];
  const set = (patch: Partial<RecurrenceFormState>) => onChange({ ...value, ...patch });

  const conversion = formToRecurrence(value);
  const preview = conversion.ok ? cronPreview(conversion.recurrence) : null;
  // Report WHY as soon as it is known, rather than holding it back until submit
  // — the two states a first-time author lands in (a weekly with no day ticked,
  // an interval > 1 with no anchor) are both reached before pressing anything.
  const problem = conversion.ok ? null : conversion.reason;

  const toggleWeekDay = (day: number, checked: boolean) => {
    const next = checked
      ? [...value.weekDays, day].sort((a, b) => a - b)
      : value.weekDays.filter((d) => d !== day);
    set({ weekDays: next });
  };

  /** The absolute instants the bounds resolve to, echoed so the browser-local
   * anchoring of the controls is visible rather than implied. Resolved through
   * the same path the write uses, so an untouched sub-second bound is echoed as
   * the instant that will actually be submitted rather than as the truncated
   * re-derivation. */
  const startUtc = boundEcho(value.startTime, value.startTimeIso);
  const endUtc = boundEcho(value.endTime, value.endTimeIso);

  return (
    <fieldset className="recurrence-editor">
      <legend>Recurrence</legend>

      {/* Labelled by `htmlFor`/`id` rather than wrapped: wrapping folds every
       * option's text into the control's accessible name (#857, #1227). */}
      <LabelledControl label="Frequency">
        {(id) => (
          <select
            id={id}
            value={value.frequency}
            onChange={(e) =>
              onChange(pruneForFrequency(value, e.target.value as RecurrenceFrequency))
            }
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        )}
      </LabelledControl>

      <label>
        {`Repeat every N ${PERIOD_NOUN[value.frequency]}`}
        <input
          type="number"
          min={1}
          max={MAX_RECURRENCE_INTERVAL}
          value={value.interval}
          {...f.attrs('interval')}
          onChange={(e) => set({ interval: e.target.value })}
        />
      </label>
      <FieldError {...f.errorProps('interval')} />

      {honoured.includes('weekDays') && (
        <fieldset className="recurrence-days" {...f.groupAttrs('schedule.weekDays')}>
          <legend>
            Days of week
            {required === 'weekDays' && <RequiredMark />}
          </legend>
          {WEEK_DAY_NAMES.map((name, day) => (
            <label key={name} className="checkbox">
              <input
                type="checkbox"
                checked={value.weekDays.includes(day)}
                onChange={(e) => toggleWeekDay(day, e.target.checked)}
              />
              {name}
            </label>
          ))}
        </fieldset>
      )}
      {honoured.includes('weekDays') && <FieldError {...f.errorProps('schedule.weekDays')} />}

      {honoured.includes('monthDays') && (
        <>
          <label>
            <span>
              Days of month (1-31, comma-separated)
              {required === 'monthDays' && <RequiredMark />}
            </span>
            <input
              type="text"
              value={value.monthDays}
              aria-required={required === 'monthDays'}
              {...f.attrs('schedule.monthDays')}
              onChange={(e) => set({ monthDays: e.target.value })}
              placeholder="1, 15"
              spellCheck={false}
            />
          </label>
          <FieldError {...f.errorProps('schedule.monthDays')} />
        </>
      )}

      {honoured.includes('hours') && (
        <>
          <label>
            Hours (0-23, comma-separated)
            <input
              type="text"
              value={value.hours}
              {...f.attrs('schedule.hours')}
              onChange={(e) => set({ hours: e.target.value })}
              placeholder="9"
              spellCheck={false}
            />
          </label>
          <FieldError {...f.errorProps('schedule.hours')} />
        </>
      )}

      {honoured.includes('minutes') && (
        <>
          <label>
            Minutes (0-59, comma-separated)
            <input
              type="text"
              value={value.minutes}
              {...f.attrs('schedule.minutes')}
              onChange={(e) => set({ minutes: e.target.value })}
              placeholder="0"
              spellCheck={false}
            />
          </label>
          <FieldError {...f.errorProps('schedule.minutes')} />
        </>
      )}

      <label>
        Time zone (IANA, blank = UTC)
        <input
          type="text"
          value={value.timeZone}
          {...f.attrs('timeZone')}
          onChange={(e) => set({ timeZone: e.target.value })}
          placeholder="Europe/London"
          spellCheck={false}
        />
      </label>
      <FieldError {...f.errorProps('timeZone')} />

      {/* `step={1}` admits seconds, so a stored bound that has them can be both
          shown and re-entered rather than silently rounded to the minute. */}
      <label>
        Start time
        <input
          type="datetime-local"
          step={1}
          value={value.startTime}
          {...f.attrs('startTime')}
          onChange={(e) => set({ startTime: e.target.value })}
        />
      </label>
      <FieldError {...f.errorProps('startTime')} />

      <label>
        End time
        <input
          type="datetime-local"
          step={1}
          value={value.endTime}
          {...f.attrs('endTime')}
          onChange={(e) => set({ endTime: e.target.value })}
        />
      </label>
      <FieldError {...f.errorProps('endTime')} />

      {/* The bounds are absolute instants that the time zone above does NOT
          shift, so the control is anchored in the browser's zone. Echo the
          resolved instant rather than leaving that anchoring to be guessed. */}
      {(startUtc || endUtc) && (
        <p className="page-hint" data-testid="recurrence-bounds-utc">
          {`Bounds are absolute instants, entered in your browser's local time — `}
          {startUtc ? `from ${startUtc}` : 'open start'}
          {endUtc ? ` until ${endUtc}` : ', open end'}
        </p>
      )}

      <BoundShiftNotices bounds={value} />

      {preview && (
        <p className="page-hint" data-testid="recurrence-preview">
          {preview.kind === 'cron' ? `Fires on cron: ${preview.cron}` : `Fires ${preview.text}`}
        </p>
      )}

      {problem && (
        <p className="page-hint" data-testid="recurrence-problem">
          {`Not a valid recurrence yet — ${problem}`}
        </p>
      )}
    </fieldset>
  );
}
