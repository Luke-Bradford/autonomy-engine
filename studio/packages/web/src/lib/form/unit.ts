/**
 * #1694 OR42 item 5 — what a field's unit reads as in the SUFFIX drawn inside
 * its box (`30` `s`), so the unit leaves the label and the label never wraps.
 * The full word stays in the field's accessible name ("Timeout (seconds)"):
 * the suffix is drawn for the eye, never read.
 */
export function unitSuffix(unit: string): string {
  return unit === 'seconds' ? 's' : unit;
}
