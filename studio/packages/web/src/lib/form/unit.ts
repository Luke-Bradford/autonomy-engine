/**
 * #1680 — a value shown as `D.HH:MM:SS` (`formatTimeoutDuration`). It draws no
 * suffix, because the value carries its own units, and only names the field:
 * "Timeout (duration)".
 */
export const DURATION_UNIT = 'duration';

/**
 * #1694 OR42 item 5 — what a field's unit reads as in the SUFFIX drawn inside
 * its box (`30` `s`), so the unit leaves the label and the label never wraps.
 * The full word stays in the field's accessible name ("Timeout (seconds)"):
 * the suffix is drawn for the eye, never read.
 *
 * `null` draws none, for `DURATION_UNIT`.
 */
export function unitSuffix(unit: string): string | null {
  if (unit === DURATION_UNIT) return null;
  return unit === 'seconds' ? 's' : unit;
}

/**
 * A field's title with its unit, "Timeout (seconds)": its name, its `?`'s and
 * its validation messages' — the one spelling of that idea, `DURATION_UNIT`'s
 * included.
 */
export function titleWithUnit(title: string, unit: string | undefined): string {
  return unit === undefined ? title : `${title} (${unit})`;
}
