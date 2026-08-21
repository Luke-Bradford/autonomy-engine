import { useCallback, useEffect, useRef } from 'react';
import type { TriggerMode } from '@autonomy-studio/shared';
import { useRowKeys } from '../../hooks/useRowKeys';
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
 * component is presentation and wiring only — no window DATA is held here, and
 * the `WindowEditor`/`RecurrenceEditor` shape is otherwise followed exactly.
 *
 * #1092 qualified the "no state of its own" half, and the qualification is
 * deliberate rather than drift. Two pieces of state live here now, both about
 * this MOUNTED editor rather than about the windows: the per-row keys React
 * needs to match rows by identity instead of by position (`useRowKeys`, which
 * exists so `runWindowsForm.ts` can stay pure), and where focus should go after
 * a removal unmounts the button that was holding it. Neither is ever read back
 * into `value`, and a save cannot see either.
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
  const { keys, removeAt, insertAt } = useRowKeys(value.rows.length);

  /**
   * #1092 — where focus goes when a removal unmounts the button holding it.
   *
   * This is the cost of the fix, paid deliberately. With `key={index}` the
   * remove button was REUSED, so focus never moved — it just came to rest on a
   * control that now removed a different window. With stable keys the row's
   * whole subtree unmounts, which is correct and which drops a keyboard user to
   * `<body>` unless focus is placed somewhere on purpose.
   *
   * Named by KEY, not by index: an index resolved after the removal would be
   * matching by position again, inside the fix for matching by position. `null`
   * targets the "Add window" button, the pane's one control that always exists
   * — the same fallback `FactoryResources` uses for a row that has gone.
   *
   * It lands in an EFFECT for the reason `PendingCallbacks` documents: the
   * button being aimed at has not rendered yet when the click handler runs, so
   * a `.focus()` there is a guaranteed no-op.
   */
  const removeButtons = useRef<Record<string, HTMLButtonElement | null>>({});
  const addButton = useRef<HTMLButtonElement | null>(null);
  /**
   * A REF, not state, and `FactoryResources`'s `draftReturnFocus` is the
   * precedent. A state-held target would have to be cleared from inside the
   * effect that consumes it, which is a synchronous `setState` in an effect —
   * a cascading render, and one the lint rules refuse outright. Nothing here
   * renders differently because of it, so state buys nothing: this is a
   * one-shot instruction to the next commit, which is what a ref is for.
   * `undefined` = no request pending, `null` = aim at "Add window".
   */
  const pendingFocus = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const requested = pendingFocus.current;
    if (requested === undefined) return;
    pendingFocus.current = undefined;
    const target = requested === null ? addButton.current : removeButtons.current[requested];
    // Falling back rather than stranding: the neighbour we aimed at can be gone
    // if `value` was also replaced from outside between the click and this
    // effect. Landing somewhere beats landing on `<body>`.
    (target ?? addButton.current)?.focus();
    // No dependency array: the request is raised by an event handler, and the
    // very next commit is the one where the neighbour has rendered and its ref
    // callback has run. The guard above makes every other render a no-op.
  });

  const removeRow = useCallback(
    (index: number) => {
      // The NEIGHBOUR that inherits this position, else the one before it, else
      // nothing left to aim at. Resolved from the pre-removal key list, which is
      // the only moment both the departing row and its neighbours are known.
      const next = keys[index + 1] ?? keys[index - 1] ?? null;
      pendingFocus.current = next;
      delete removeButtons.current[keys[index] ?? ''];
      removeAt(index);
      onChange({ ...value, rows: value.rows.filter((_, i) => i !== index) });
    },
    [keys, removeAt, onChange, value],
  );

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
    insertAt(value.rows.length);
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
        //
        // `contract-advisory` and not `page-hint`, deliberately: this is the one
        // advisory here describing something the save ACCEPTS, which is exactly
        // what that class is documented to mean. The two below describe states
        // the write schema REFUSES, so they take the siblings' "not valid yet"
        // `page-hint` instead — a blocked save is reported by the form's own
        // `role="alert"`.
        <p className="contract-advisory">
          Restricted with no windows: this trigger can never fire automatically. Add a window, or
          clear the restriction above.
        </p>
      )}

      {value.restricted && !isGated && ungatedReason !== undefined && (
        <p className="page-hint">
          {`Run windows do not gate a ${mode} trigger — ${ungatedReason}. This restriction will be stored, and consulted if the mode changes.`}
        </p>
      )}

      {value.rows.map((row, index) => (
        <div
          // #1092 — the row's IDENTITY, not its position. `key={index}` made
          // React reuse a removed row's DOM nodes for whichever row shifted into
          // its place; a stable key makes a surviving row keep the element the
          // operator was working in.
          key={keys[index]}
          className="run-window-row"
          role="group"
          aria-label={`Window ${index + 1}`}
        >
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
            <p className="page-hint">
              {`Not a valid window yet — the scheduler cannot read ${[
                isUnreadableBound(row.start) ? `start "${row.start}"` : null,
                isUnreadableBound(row.end) ? `end "${row.end}"` : null,
              ]
                .filter((part) => part !== null)
                .join(
                  ' and ',
                )}, so it would never open. Times are 24-hour UTC, like 09:00 or 22:30.`}
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
            <p className="page-hint">
              {`Not a valid window yet — window ${index + 1} is restricted to specific days but none are selected, so it could never open.`}
            </p>
          )}

          <button
            type="button"
            ref={(el) => {
              const key = keys[index];
              if (key !== undefined) removeButtons.current[key] = el;
            }}
            onClick={() => removeRow(index)}
          >
            {`Remove window ${index + 1}`}
          </button>
        </div>
      ))}

      <button type="button" ref={addButton} onClick={addRow}>
        Add window
      </button>
    </fieldset>
  );
}
