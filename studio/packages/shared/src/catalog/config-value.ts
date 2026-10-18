/**
 * A setting the author filled: not absent, and not an emptied box, list or
 * table. One reading for every save rule that asks "is this set?", because the
 * dock writes an emptied control as `''`, `[]` or `{}` (#1600: Web's request
 * settings, Copy's Key columns).
 */
export function isSet(value: unknown): boolean {
  if (value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object' && value !== null) return Object.keys(value).length > 0;
  return true;
}
