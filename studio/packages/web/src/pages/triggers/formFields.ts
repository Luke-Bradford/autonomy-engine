/**
 * #439 U14b / #854 — the primitives every trigger-config builder shares:
 * reading what an `<input>` holds back as the structured value a write schema
 * accepts.
 *
 * Extracted from `recurrenceForm.ts` when the tumbling-window builder became a
 * second caller. They live here rather than in either builder because a second
 * COPY of the whole-number rule is exactly how `interval` drifted from the list
 * fields once already — one rule, one home, imported by both.
 */

/**
 * The only accepted shape for a whole number typed into a trigger form.
 *
 * Pinned as a pattern rather than left to `Number`, which also accepts hex and
 * exponent literals — `0x1f` would silently become 31 and `2e1` become 20, while
 * the "not a whole number" message claimed the opposite. Exponent notation is
 * not hypothetical for the interval controls either: `<input type="number">`
 * accepts any "valid floating-point number", which INCLUDES `2e1`, so the value
 * reaches the conversion from the real control and not only from a test.
 */
export const WHOLE_NUMBER = /^[+-]?\d+$/;

export type WholeNumberParse =
  | { ok: true; value: number | undefined }
  | { ok: false; reason: string };

/**
 * Parse a single whole number typed into a text/number input. A blank input is
 * an ABSENT value (`undefined`), never `0` — callers omit the field entirely so
 * the schema's own optionality decides what absent means. Range and cap checks
 * are deliberately NOT done here; they live on the write schema, so there is one
 * place that knows a backfill cap is 1000.
 */
export function parseWholeNumber(raw: string): WholeNumberParse {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  if (!WHOLE_NUMBER.test(trimmed)) {
    return { ok: false, reason: `'${raw}' is not a whole number` };
  }
  return { ok: true, value: Number(trimmed) };
}

/**
 * Read a `datetime-local` value (naive, no zone) as an absolute UTC instant.
 *
 * The anchoring zone is the BROWSER's, because both `RecurrenceSchema` and
 * `WindowConfigSchema` pin their bounds as absolute instants. The editor labels
 * the control and echoes the resolved instant rather than silently
 * reinterpreting it.
 *
 * Returns `null` for anything that is not a well-formed local date-time, so a
 * caller never propagates an `Invalid Date`.
 */
export function localInputToUtcIso(local: string): string | null {
  const trimmed = local.trim();
  // Pin the accepted shape rather than trusting `Date`'s lenient fallback
  // parsing, which would accept (and mis-anchor) an offset-bearing string.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(trimmed)) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** Zero-pad a clock component to two digits. */
export const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Render an absolute UTC instant back into a `datetime-local` value, in the
 * browser's LOCAL wall clock — the inverse of `localInputToUtcIso`. Building
 * the string from the local getters (rather than slicing `toISOString`, which
 * is UTC) is what keeps the round trip stable in a non-UTC browser.
 */
export function utcIsoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const base =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // Only surface seconds when the instant actually has them, so the common
  // minute-aligned bound stays a clean `HH:MM` rather than a noisy `HH:MM:00`.
  return d.getSeconds() === 0 ? base : `${base}:${pad(d.getSeconds())}`;
}

/**
 * The absolute instant a bound control will actually SUBMIT — the single place
 * that decision is made, so what the editor echoes and what the write boundary
 * receives cannot drift apart.
 *
 * An UNTOUCHED bound resolves to the instant exactly as it was loaded. The
 * control cannot hold sub-second precision, so re-deriving it from the local
 * string would silently shift a stored instant just because the form was opened
 * (see `startTimeIso`). Returns `null` when `local` is not a well-formed local
 * date-time — including when it is empty.
 */
export function resolveBound(local: string, originalIso: string): string | null {
  if (originalIso !== '' && utcIsoToLocalInput(originalIso) === local) return originalIso;
  return localInputToUtcIso(local);
}
