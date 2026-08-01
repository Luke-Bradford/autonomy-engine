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
  { ok: true; value: number | undefined } | { ok: false; reason: string };

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

/**
 * Flatten a Zod failure into one operator-facing line.
 *
 * Every trigger-config builder delegates its validation WHOLE to a shared write
 * schema, so every one of them needs this — and each carrying its own copy is
 * how three subtly different renderings of the same failure appear on one page.
 * (`packages/web` has the same duplication at a larger scale: see #856.)
 */
export function formatZodIssues(error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/** The two `datetime-local` bound controls every builder shares. */
export interface BoundFields {
  startTime: string;
  endTime: string;
  startTimeIso: string;
  endTimeIso: string;
}

/**
 * Resolve the `startTime`/`endTime` controls onto `candidate`, omitting a blank
 * one. Returns `null` on success, or the reason the bound could not be read.
 *
 * Shared so the two builders cannot drift on what a bound means: a blank one is
 * ABSENT, and an untouched one is written back exactly as it was loaded.
 */
export function resolveBoundsInto(
  form: BoundFields,
  candidate: Record<string, unknown>,
): string | null {
  for (const bound of ['startTime', 'endTime'] as const) {
    if (form[bound].trim() === '') continue;
    const iso = resolveBound(form[bound], form[`${bound}Iso`]);
    if (iso === null) return `${bound}: '${form[bound]}' is not a valid date and time`;
    candidate[bound] = iso;
  }
  return null;
}

/**
 * The absolute instant a bound control will submit, for an editor to ECHO —
 * `null` when the control is blank. Thin, but shared so what the two editors
 * display is resolved the same way the write path resolves it.
 */
export function boundEcho(local: string, originalIso: string): string | null {
  return local.trim() === '' ? null : resolveBound(local, originalIso);
}
