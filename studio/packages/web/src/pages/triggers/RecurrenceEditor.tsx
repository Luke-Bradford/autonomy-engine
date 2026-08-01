import {
  HONOURED_FIELDS,
  REQUIRED_FIELDS,
  RecurrenceFrequencySchema,
  type RecurrenceFrequency,
} from '@autonomy-studio/shared';
import {
  cronPreview,
  formToRecurrence,
  localInputToUtcIso,
  pruneForFrequency,
  WEEK_DAY_NAMES,
  type RecurrenceFormState,
} from './recurrenceForm';

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
}: {
  value: RecurrenceFormState;
  onChange: (next: RecurrenceFormState) => void;
}) {
  const honoured = HONOURED_FIELDS[value.frequency];
  const required = REQUIRED_FIELDS[value.frequency];
  const set = (patch: Partial<RecurrenceFormState>) => onChange({ ...value, ...patch });

  const conversion = formToRecurrence(value);
  const preview = conversion.ok ? cronPreview(conversion.recurrence) : null;

  const toggleWeekDay = (day: number, checked: boolean) => {
    const next = checked
      ? [...value.weekDays, day].sort((a, b) => a - b)
      : value.weekDays.filter((d) => d !== day);
    set({ weekDays: next });
  };

  /** The absolute instant a bound resolves to, echoed so the browser-local
   * anchoring of the control is visible rather than implied. */
  const boundEcho = (local: string): string | null =>
    local.trim() === '' ? null : localInputToUtcIso(local);

  return (
    <fieldset className="recurrence-editor">
      <legend>Recurrence</legend>

      <label>
        Frequency
        <select
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
      </label>

      <label>
        {`Repeat every N ${PERIOD_NOUN[value.frequency]}`}
        <input
          type="number"
          min={1}
          value={value.interval}
          onChange={(e) => set({ interval: e.target.value })}
        />
      </label>

      {honoured.includes('weekDays') && (
        <fieldset className="recurrence-days">
          <legend>{`Days of week${required === 'weekDays' ? ' (required)' : ''}`}</legend>
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

      {honoured.includes('monthDays') && (
        <label>
          {`Days of month (1-31, comma-separated)${required === 'monthDays' ? ' (required)' : ''}`}
          <input
            type="text"
            value={value.monthDays}
            onChange={(e) => set({ monthDays: e.target.value })}
            placeholder="1, 15"
            spellCheck={false}
          />
        </label>
      )}

      {honoured.includes('hours') && (
        <label>
          Hours (0-23, comma-separated)
          <input
            type="text"
            value={value.hours}
            onChange={(e) => set({ hours: e.target.value })}
            placeholder="9"
            spellCheck={false}
          />
        </label>
      )}

      {honoured.includes('minutes') && (
        <label>
          Minutes (0-59, comma-separated)
          <input
            type="text"
            value={value.minutes}
            onChange={(e) => set({ minutes: e.target.value })}
            placeholder="0"
            spellCheck={false}
          />
        </label>
      )}

      <label>
        Time zone (IANA, blank = UTC)
        <input
          type="text"
          value={value.timeZone}
          onChange={(e) => set({ timeZone: e.target.value })}
          placeholder="Europe/London"
          spellCheck={false}
        />
      </label>

      <label>
        Start time (optional)
        <input
          type="datetime-local"
          value={value.startTime}
          onChange={(e) => set({ startTime: e.target.value })}
        />
      </label>

      <label>
        End time (optional)
        <input
          type="datetime-local"
          value={value.endTime}
          onChange={(e) => set({ endTime: e.target.value })}
        />
      </label>

      {/* The bounds are absolute instants that the time zone above does NOT
          shift, so the control is anchored in the browser's zone. Echo the
          resolved instant rather than leaving that anchoring to be guessed. */}
      {(boundEcho(value.startTime) || boundEcho(value.endTime)) && (
        <p className="page-hint" data-testid="recurrence-bounds-utc">
          {`Bounds are absolute instants, entered in your browser's local time — `}
          {boundEcho(value.startTime) ? `from ${boundEcho(value.startTime)}` : 'open start'}
          {boundEcho(value.endTime) ? ` until ${boundEcho(value.endTime)}` : ', open end'}
        </p>
      )}

      {preview && (
        <p className="page-hint" data-testid="recurrence-preview">
          {preview.kind === 'cron' ? `Fires on cron: ${preview.cron}` : `Fires ${preview.text}`}
        </p>
      )}
    </fieldset>
  );
}
