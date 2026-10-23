/**
 * #1694 OR42 item 5 — what a field's unit reads as in the SUFFIX drawn inside
 * its box (`30` `s`), so the unit leaves the label and the label never wraps.
 * The full word stays in the field's accessible name ("Timeout (seconds)"):
 * the suffix is drawn for the eye, never read.
 *
 * `null` draws none: a `duration` shows its units in its value (`12:00:00`,
 * #1680), so only its name says what it is ("Timeout (duration)").
 */
export function unitSuffix(unit: string): string | null {
  if (unit === 'duration') return null;
  return unit === 'seconds' ? 's' : unit;
}

/**
 * A field's title with its unit, "Timeout (seconds)": its name, its `?`'s and
 * its validation messages' — the one spelling of that idea.
 */
export function titleWithUnit(title: string, unit: string | undefined): string {
  return unit === undefined ? title : `${title} (${unit})`;
}
