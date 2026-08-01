import { useId } from 'react';
import {
  MAX_BACKFILL_WINDOWS_CAP,
  MAX_CONCURRENT_WINDOWS_CAP,
  WindowFrequencySchema,
  windowSizeSeconds,
  type WindowFrequency,
} from '@autonomy-studio/shared';
import { formToWindow, type WindowFormState } from './windowForm';
import { resolveBound } from './formFields';

const FREQUENCIES = WindowFrequencySchema.options;

/** How the interval control reads for each frequency: "Each window covers N …". */
const PERIOD_NOUN: Record<WindowFrequency, string> = {
  minute: 'minutes',
  hour: 'hours',
  day: 'days',
};

/**
 * #439 U14b remainder (#854) — the tumbling-window builder.
 *
 * A tumbling trigger fires once per contiguous window of time, and until now the
 * mode was selectable in the trigger form with no way to configure it at all:
 * `assertWindowConsistent` refuses an enabled `tumbling` trigger that carries no
 * `window`, so choosing the mode and saving simply 400d.
 *
 * All conversion and validation lives in `windowForm.ts` (pure, unit-tested);
 * this component is presentation and wiring only, and holds no state of its own.
 * The advisory hints mirror `RecurrenceEditor`: an always-on `page-hint` says
 * what the window WOULD be (or why it is not one yet), while a save-blocking
 * failure is the form's `role="alert"`.
 */
export function WindowEditor({
  value,
  onChange,
}: {
  value: WindowFormState;
  onChange: (next: WindowFormState) => void;
}) {
  const frequencyId = useId();
  const set = (patch: Partial<WindowFormState>) => onChange({ ...value, ...patch });

  const conversion = formToWindow(value);
  const problem = conversion.ok ? null : conversion.reason;
  const built = conversion.ok ? conversion.window : null;

  /** The instant the epoch control will actually SUBMIT — resolved through the
   * same `resolveBound` the write path uses, so an untouched sub-second bound is
   * echoed as what will be written rather than as a truncated re-derivation. */
  const startUtc =
    value.startTime.trim() === '' ? null : resolveBound(value.startTime, value.startTimeIso);
  const endUtc = value.endTime.trim() === '' ? null : resolveBound(value.endTime, value.endTimeIso);

  return (
    <fieldset className="window-editor">
      <legend>Tumbling window</legend>

      {/* The select is labelled by `htmlFor`/`id` rather than wrapped: wrapping
       * folds every option's text into the control's accessible name (#857). */}
      <label htmlFor={frequencyId}>Window frequency</label>
      <select
        id={frequencyId}
        value={value.frequency}
        onChange={(e) => set({ frequency: e.target.value as WindowFrequency })}
      >
        {FREQUENCIES.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>

      <label>
        {`Each window covers N ${PERIOD_NOUN[value.frequency]}`}
        <input
          type="number"
          min={1}
          value={value.interval}
          onChange={(e) => set({ interval: e.target.value })}
          placeholder="1"
        />
      </label>

      {/* `step={1}` admits seconds, so a stored bound that has them can be both
          shown and re-entered rather than silently rounded to the minute. */}
      <label>
        Start time (required — the window epoch)
        <input
          type="datetime-local"
          step={1}
          value={value.startTime}
          onChange={(e) => set({ startTime: e.target.value })}
        />
      </label>

      <label>
        End time (optional)
        <input
          type="datetime-local"
          step={1}
          value={value.endTime}
          onChange={(e) => set({ endTime: e.target.value })}
        />
      </label>

      <label>
        Max backfill windows (optional)
        <input
          type="number"
          min={1}
          max={MAX_BACKFILL_WINDOWS_CAP}
          value={value.maxBackfillWindows}
          onChange={(e) => set({ maxBackfillWindows: e.target.value })}
          placeholder="unlimited"
        />
      </label>

      <label>
        Max concurrent windows (optional)
        <input
          type="number"
          min={1}
          max={MAX_CONCURRENT_WINDOWS_CAP}
          value={value.maxConcurrentWindows}
          onChange={(e) => set({ maxConcurrentWindows: e.target.value })}
          placeholder="unlimited"
        />
      </label>

      {/* The epoch is an absolute instant; the control is anchored in the
          browser's zone, so echo what will actually be stored. Every window
          boundary the trigger ever computes is keyed off this instant. */}
      {startUtc && (
        <p className="page-hint" data-testid="window-bounds-utc">
          {`Windows are keyed from ${startUtc}, entered in your browser's local time`}
          {endUtc ? `, until ${endUtc}` : ', with no end'}
        </p>
      )}

      {built && (
        <p className="page-hint" data-testid="window-preview">
          {`Each window covers ${built.interval} ${PERIOD_NOUN[built.frequency]} (${windowSizeSeconds(built)}s)`}
        </p>
      )}

      {/* #854 ships editors for the geometry and bounds only; #861 adds the rest.
          A window authored through the API can carry a retry policy or a
          self-dependency — say so rather than let it look absent, since a save
          DOES write it back. */}
      {(value.retry !== undefined || value.selfDependency !== undefined) && (
        <p className="page-hint" data-testid="window-preserved">
          {'This window also carries '}
          {[
            value.retry !== undefined ? 'a retry policy' : null,
            value.selfDependency !== undefined ? 'a self-dependency' : null,
          ]
            .filter((s) => s !== null)
            .join(' and ')}
          {
            ', authored outside this form. There is no control for it here yet (#861); it is preserved unchanged when you save.'
          }
        </p>
      )}

      {problem && (
        <p className="page-hint" data-testid="window-problem">
          {`Not a valid window yet — ${problem}`}
        </p>
      )}
    </fieldset>
  );
}
