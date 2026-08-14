import type { TriggerMode } from '@autonomy-studio/shared';
import { WEEK_DAY_NAMES } from './recurrenceForm';
import {
  blankRunWindowRow,
  isUnreadableBound,
  type RunWindowRow,
  type RunWindowsFormState,
} from './runWindowsForm';

/**
 * The modes an automatic fire is actually gated by `isWithinRunWindows`:
 * `schedule` (`scheduler/schedule-tick.ts`), `webhook` (`routes/webhooks.ts`)
 * and `event` (`routes/events.ts`). The others are deliberate non-gates, and
 * saying so is the point of the advisory below — a structured editor is a much
 * more inviting control than the JSON textarea it replaces, and configuring a
 * window that nothing consults is a silent no-op an operator would only find by
 * waiting for a fire that comes anyway.
 */
const WINDOW_GATED_MODES: readonly TriggerMode[] = ['schedule', 'webhook', 'event'];

/** Why a run window does not gate this mode. Absent = the mode is gated. */
const UNGATED_REASON: Partial<Record<TriggerMode, string>> = {
  manual: 'a manual "Fire now" is an explicit operator override and is never window-gated',
  tumbling:
    'a tumbling window fires on data completeness, so suppressing it would LOSE the window rather than delay it',
  continuous: 'this mode has no automatic dispatcher yet, so nothing consults a run window',
};

/**
 * #1090 U14c — the run-window editor.
 *
 * Run windows are an ALLOW-list on when a trigger may start an automatic run,
 * and until now the only way to author one was a raw JSON textarea. That mattered
 * more than it looks: `isWithinRunWindows` is fail-CLOSED, so every way of
 * getting the JSON slightly wrong — `"9am"`, `"25:00"`, a start equal to its
 * end, an empty `days` array — produced a trigger that persisted, sat enabled,
 * looked healthy and never fired, with no error raised anywhere.
 *
 * All conversion and validation lives in `runWindowsForm.ts` (pure, unit-tested)
 * and the refusals themselves come from the shared write schema, so this
 * component is presentation and wiring only and holds no state of its own —
 * the `WindowEditor`/`RecurrenceEditor` shape exactly.
 */
export function RunWindowsEditor({
  value,
  onChange,
  mode,
}: {
  value: RunWindowsFormState;
  onChange: (next: RunWindowsFormState) => void;
  mode: TriggerMode;
}) {
  const setRow = (index: number, patch: Partial<RunWindowRow>) => {
    onChange({
      ...value,
      rows: value.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  };

  const toggleDay = (index: number, day: number, on: boolean) => {
    const row = value.rows[index];
    if (row === undefined) return;
    setRow(index, {
      days: on ? [...row.days, day].sort((a, b) => a - b) : row.days.filter((d) => d !== day),
    });
  };

  const addRow = () => {
    // Adding a window is itself the act of restricting, so the switch follows —
    // never a row the operator can see that the save would silently discard.
    onChange({ restricted: true, rows: [...value.rows, blankRunWindowRow()] });
  };

  const ungatedReason = UNGATED_REASON[mode];
  const isGated = WINDOW_GATED_MODES.includes(mode);

  return (
    <fieldset className="run-windows">
      <legend>Run windows (UTC)</legend>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={value.restricted}
          onChange={(e) => onChange({ ...value, restricted: e.target.checked })}
        />
        Restrict when this trigger may fire automatically
      </label>

      {value.restricted && value.rows.length === 0 && (
        // The `[]` state, which the engine reads as permanently closed. It is a
        // legitimate thing to mean and a terrible thing to mean by accident, so
        // it is stated rather than left to be inferred from an empty list.
        <p className="contract-advisory">
          Restricted with no windows: this trigger can never fire automatically. Add a window, or
          clear the restriction above.
        </p>
      )}

      {value.restricted && !isGated && ungatedReason !== undefined && (
        <p className="contract-advisory">
          {`Run windows do not gate a ${mode} trigger — ${ungatedReason}. This restriction will be stored, and consulted if the mode changes.`}
        </p>
      )}

      {value.rows.map((row, index) => (
        <div key={index} className="run-window-row" role="group" aria-label={`Window ${index + 1}`}>
          <label>
            {`Window ${index + 1} start`}
            <input
              type="text"
              // A TEXT control, not `type="time"`: the native picker cannot hold
              // `9:00` (which the scheduler reads fine) and — decisively — cannot
              // hold a malformed legacy bound at all, so it would render the
              // value that broke the trigger as an empty box. Rule 3 of
              // `runWindowsForm.ts`: what this editor cannot show, it still
              // carries.
              value={row.start}
              onChange={(e) => setRow(index, { start: e.target.value })}
              placeholder="HH:MM"
              spellCheck={false}
            />
          </label>
          <label>
            {`Window ${index + 1} end`}
            <input
              type="text"
              value={row.end}
              onChange={(e) => setRow(index, { end: e.target.value })}
              placeholder="HH:MM"
              spellCheck={false}
            />
          </label>

          {(isUnreadableBound(row.start) || isUnreadableBound(row.end)) && (
            <p className="contract-advisory">
              {`The scheduler cannot read ${[
                isUnreadableBound(row.start) ? `start "${row.start}"` : null,
                isUnreadableBound(row.end) ? `end "${row.end}"` : null,
              ]
                .filter((part) => part !== null)
                .join(
                  ' and ',
                )}, so this window has never opened. Times are 24-hour UTC, like 09:00 or 22:30.`}
            </p>
          )}

          <label className="checkbox">
            <input
              type="checkbox"
              checked={row.daysRestricted}
              onChange={(e) => setRow(index, { daysRestricted: e.target.checked })}
            />
            Only on selected days
          </label>

          {row.daysRestricted && (
            <fieldset className="recurrence-days">
              <legend>{`Window ${index + 1} days (UTC)`}</legend>
              {WEEK_DAY_NAMES.map((name, day) => (
                <label key={name} className="checkbox">
                  <input
                    type="checkbox"
                    checked={row.days.includes(day)}
                    onChange={(e) => toggleDay(index, day, e.target.checked)}
                  />
                  {name}
                </label>
              ))}
            </fieldset>
          )}

          {row.daysRestricted && row.days.length === 0 && (
            // The per-row twin of the `[]` advisory: an empty `days` matches no
            // weekday, so the window is dead. Refused on save; said here so the
            // operator is not waiting on a save to find out.
            <p className="contract-advisory">
              {`Window ${index + 1} is restricted to specific days but none are selected, so it can never open.`}
            </p>
          )}

          <button
            type="button"
            onClick={() => onChange({ ...value, rows: value.rows.filter((_, i) => i !== index) })}
          >
            {`Remove window ${index + 1}`}
          </button>
        </div>
      ))}

      <button type="button" onClick={addRow}>
        Add window
      </button>
    </fieldset>
  );
}
