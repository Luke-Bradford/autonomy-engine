import {
  MAX_BACKFILL_WINDOWS_CAP,
  MAX_CONCURRENT_WINDOWS_CAP,
  MAX_WINDOW_RETRY_COUNT_CAP,
  MAX_WINDOW_RETRY_INTERVAL_SECONDS,
  MIN_WINDOW_RETRY_INTERVAL_SECONDS,
  WindowFrequencySchema,
  windowSizeSeconds,
  type WindowFrequency,
} from '@autonomy-studio/shared';
import { formToWindow, type WindowFormState } from './windowForm';
import { boundEcho } from './formFields';
import { BoundShiftNotices } from './BoundShiftNotices';
import { LabelledControl } from '../../lib/LabelledControl';

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
  const set = (patch: Partial<WindowFormState>) => onChange({ ...value, ...patch });

  const conversion = formToWindow(value);
  const problem = conversion.ok ? null : conversion.reason;
  const built = conversion.ok ? conversion.window : null;

  /** The instants the bound controls will actually SUBMIT — resolved through the
   * same path the write uses, so an untouched sub-second bound is echoed as what
   * will be written rather than as a truncated re-derivation. */
  const startUtc = boundEcho(value.startTime, value.startTimeIso);
  const endUtc = boundEcho(value.endTime, value.endTimeIso);

  return (
    <fieldset className="window-editor">
      <legend>Tumbling window</legend>

      {/* Labelled by `htmlFor`/`id` rather than wrapped: wrapping folds every
       * option's text into the control's accessible name (#857, #1227). */}
      <LabelledControl label="Window frequency">
        {(id) => (
          <select
            id={id}
            value={value.frequency}
            onChange={(e) => set({ frequency: e.target.value as WindowFrequency })}
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
        Max backfill windows (optional — blank means none)
        <input
          type="number"
          min={1}
          max={MAX_BACKFILL_WINDOWS_CAP}
          value={value.maxBackfillWindows}
          onChange={(e) => set({ maxBackfillWindows: e.target.value })}
          placeholder="no backfill"
        />
      </label>

      <label>
        Max concurrent windows (optional — blank means one)
        <input
          type="number"
          min={1}
          max={MAX_CONCURRENT_WINDOWS_CAP}
          value={value.maxConcurrentWindows}
          onChange={(e) => set({ maxConcurrentWindows: e.target.value })}
          placeholder="one at a time"
        />
      </label>

      {/* #861 — the two opt-in sub-objects. Blank means absent (no retry, no
          dependency); every range is the write schema's, reported below. */}
      <label>
        Retry a failed window N times (optional — blank means no retry)
        <input
          type="number"
          min={1}
          max={MAX_WINDOW_RETRY_COUNT_CAP}
          value={value.retryCount}
          onChange={(e) => set({ retryCount: e.target.value })}
          placeholder="no retry"
        />
      </label>

      <label>
        Seconds between retries
        <input
          type="number"
          min={MIN_WINDOW_RETRY_INTERVAL_SECONDS}
          max={MAX_WINDOW_RETRY_INTERVAL_SECONDS}
          value={value.retryIntervalSeconds}
          onChange={(e) => set({ retryIntervalSeconds: e.target.value })}
        />
      </label>

      {/* Deliberately NO `min`: a valid offset is negative, and the form runs
          native constraint validation before its own `role="alert"` path. */}
      <label>
        Depend on earlier windows: offset in seconds (optional — negative, before each window&apos;s
        start)
        <input
          type="number"
          max={-1}
          value={value.dependencyOffsetSeconds}
          onChange={(e) => set({ dependencyOffsetSeconds: e.target.value })}
          placeholder="no dependency"
        />
      </label>

      <label>
        Dependency span in seconds (optional — blank means one window)
        <input
          type="number"
          min={1}
          value={value.dependencySizeSeconds}
          onChange={(e) => set({ dependencySizeSeconds: e.target.value })}
          placeholder="one window"
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

      <BoundShiftNotices bounds={value} />

      {built && (
        <p className="page-hint" data-testid="window-preview">
          {`Each window covers ${built.interval} ${PERIOD_NOUN[built.frequency]} (${windowSizeSeconds(built)}s)`}
        </p>
      )}

      {built?.retry && (
        <p className="page-hint" data-testid="window-retry-preview">
          {`A failed window is re-run up to ${built.retry.count} more time${built.retry.count === 1 ? '' : 's'}, ${built.retry.intervalInSeconds}s apart`}
        </p>
      )}

      {built?.selfDependency && (
        <p className="page-hint" data-testid="window-dependency-preview">
          {dependencySentence(built.selfDependency, windowSizeSeconds(built))}
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

/**
 * What a self-dependency makes each window wait for, stated from the numbers.
 * A window the trigger itself dispositioned (skipped, superseded) satisfies the
 * dependency too (`WindowSelfDependencySchema`), so "succeeded" alone would
 * overclaim.
 */
function dependencySentence(
  dependency: { offsetInSeconds: number; sizeInSeconds?: number },
  windowSeconds: number,
): string {
  const from = -dependency.offsetInSeconds;
  const to = from - (dependency.sizeInSeconds ?? windowSeconds);
  const end = to === 0 ? 'its own start' : `${to}s before its start`;
  return `Each window waits until every window overlapping ${from}s before its start to ${end} has succeeded (or was skipped or superseded by the trigger itself)`;
}
