import {
  RunWindowWriteSchema,
  formatZodIssues,
  parseRunWindowTime,
  type RunWindow,
} from '@autonomy-studio/shared';
import { z } from 'zod';

/**
 * #1090 U14c — the PURE half of the run-window editor: converting between the
 * strings an `<input>` holds and the `RunWindow[]` the trigger write boundary
 * accepts. Kept out of the component so the conversion — where every lossy edge
 * lives — is unit-testable without a DOM, exactly as `windowForm.ts` and
 * `recurrenceForm.ts` do for the U14b builders.
 *
 * ## The rules this module exists to honour
 *
 * The stored shape has THREE meanings where a naive editor would see two, and
 * both collapses widen a trigger that can never fire into one that fires freely
 * — the exact inverse of what a run window is for:
 *
 * 1. **`null` and `[]` are different facts.** `null` is "no restriction
 *    configured"; `[]` is "windows configured, none of them", which
 *    `isWithinRunWindows` treats as permanently CLOSED (fail-closed, and
 *    documented as deliberate). An editor that renders both as "no rows" and
 *    writes back `null` turns *never fires* into *always open* on an unrelated
 *    rename. Hence `restricted`, which is the operator's own control over which
 *    of the two is meant.
 * 2. **An absent `days` and an empty `days` are different facts**, for the same
 *    reason one level down: absent is every day, `[]` is no day at all. Hence
 *    `daysRestricted` per row rather than reading "no boxes ticked" as either.
 * 3. **What this editor cannot show, it still carries.** A bound stored in a
 *    form the control cannot hold (`"9am"` from the JSON textarea this
 *    replaces) is loaded VERBATIM, so the operator sees the value that broke
 *    their trigger and can repair it in place. It is refused on save, so the
 *    repair is enforced rather than merely suggested.
 *
 * Validation is delegated WHOLE to `RunWindowWriteSchema`, never re-implemented
 * as a subset: the client's refusals are then identical to the server's by
 * construction, and the time grammar has exactly one definition
 * (`parseRunWindowTime`, shared with the evaluator itself).
 */
export interface RunWindowRow {
  /** Held as the TEXT typed, so a half-typed bound survives a re-render and an
   * invalid one is reported — and shown — with the text that caused it. */
  start: string;
  end: string;
  /** Rule 2: whether this window is restricted to specific weekdays AT ALL.
   * `false` → `days` is omitted (every day); `true` → `days` is written, and an
   * empty selection is refused rather than silently meaning "every day". */
  daysRestricted: boolean;
  /** Indices into `WEEK_DAY_NAMES` — 0 = Sunday. The index IS the stored value. */
  days: number[];
}

export interface RunWindowsFormState {
  /** Rule 1: whether the trigger has run windows configured at all. `false` →
   * `null` (unrestricted); `true` → an array, which with zero rows is the
   * deliberate never-open `[]`. */
  restricted: boolean;
  rows: RunWindowRow[];
}

export function blankRunWindowRow(): RunWindowRow {
  return { start: '', end: '', daysRestricted: false, days: [] };
}

export function blankRunWindowsForm(): RunWindowsFormState {
  return { restricted: false, rows: [] };
}

export type RunWindowsConversion =
  { ok: true; runWindows: RunWindow[] | null } | { ok: false; reason: string };

/** The whole-array write shape. Built once here so the client validates the
 * array exactly as `NewTriggerSchema.runWindows` does. */
const RunWindowsWriteSchema = z.array(RunWindowWriteSchema);

/**
 * Zod reports a row issue at `['0','start']`, which `formatZodIssues` joins to
 * `0.start` — opaque in a multi-row editor, and off-by-one against the "Window
 * 1" heading the operator is looking at. Rewritten to match what is on screen.
 */
function labelRowPaths(issues: ReadonlyArray<z.core.$ZodIssue>): string {
  return formatZodIssues(
    issues.map((issue) => {
      const [head, ...rest] = issue.path;
      if (typeof head !== 'number') return issue;
      return { ...issue, path: [`window ${head + 1}`, ...rest] };
    }),
  );
}

/**
 * Build the `runWindows` value from the form, or report the first reason it
 * cannot be. `null` (unrestricted) is a SUCCESS, not an absence of an answer.
 */
export function formToRunWindows(form: RunWindowsFormState): RunWindowsConversion {
  // Rule 1: the unrestricted case is the operator's explicit choice, so rows
  // typed and then switched off are simply not written — they are not an error,
  // and they are still on screen if the switch goes back.
  if (!form.restricted) return { ok: true, runWindows: null };

  const candidates = form.rows.map((row) => ({
    start: row.start.trim(),
    end: row.end.trim(),
    // Rule 2: omitted, never `[]`, when the row is not day-restricted.
    ...(row.daysRestricted ? { days: [...row.days].sort((a, b) => a - b) } : {}),
  }));

  const parsed = RunWindowsWriteSchema.safeParse(candidates);
  if (!parsed.success) return { ok: false, reason: labelRowPaths(parsed.error.issues) };
  return { ok: true, runWindows: parsed.data };
}

/** Load a stored `runWindows` back into the editor. The inverse of
 * `formToRunWindows` for any value that form could have produced — and a
 * faithful carrier (rule 3) for the values it could not. */
export function runWindowsToForm(runWindows: RunWindow[] | null): RunWindowsFormState {
  if (runWindows === null) return blankRunWindowsForm();
  return {
    restricted: true,
    rows: runWindows.map((w) => ({
      start: w.start,
      end: w.end,
      daysRestricted: w.days !== undefined,
      days: w.days ?? [],
    })),
  };
}

/**
 * Is this bound one the SCHEDULER cannot read? Drives the editor's advisory, so
 * a window that silently never opened says so on screen instead of looking
 * ordinary. A BLANK bound is excluded: it is un-authored, not malformed, and
 * the save refuses it with its own message.
 */
export function isUnreadableBound(bound: string): boolean {
  const value = bound.trim();
  return value !== '' && parseRunWindowTime(value) === null;
}
