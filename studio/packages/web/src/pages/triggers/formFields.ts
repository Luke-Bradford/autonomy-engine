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

import { formatZodIssues } from '@autonomy-studio/shared';
import type { z } from 'zod';
import { splitIssues } from '../../lib/form/fieldValidation';
import {
  LOCAL_TIME_ZONE,
  WALL_CLOCK,
  wallClockInput,
  zonedWallClockInstant,
  type DisplayTimeZone,
} from '../../lib/displayTime';

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
 * The anchoring zone is the viewer's DISPLAY zone (#1524), the one every
 * timestamp around the form is shown in — the browser's own for the default
 * `local` — because both `RecurrenceSchema` and `WindowConfigSchema` pin their
 * bounds as absolute instants. `local` keeps reading through `Date`, which
 * follows the runtime's zone live; a named zone resolves through
 * `zonedWallClockInstant`, which settles a daylight-saving gap or overlap the
 * way `Date` does. Two paths rather than one: the cached `local` formatter
 * keeps the zone it was built in, and `Date` does not. The editor labels the
 * control with its zone and echoes the resolved instant rather than silently
 * reinterpreting it — and where that zone has no such wall clock (a
 * daylight-saving gap), `boundShift` names the one it will read back as.
 *
 * Returns `null` for anything that is not a well-formed local date-time, so a
 * caller never propagates an `Invalid Date`.
 */
export function localInputToUtcIso(local: string, zone: DisplayTimeZone): string | null {
  const trimmed = local.trim();
  // Pin the accepted shape rather than trusting `Date`'s lenient fallback
  // parsing, which would accept (and mis-anchor) an offset-bearing string.
  if (!WALL_CLOCK.test(trimmed)) return null;
  if (zone !== LOCAL_TIME_ZONE) {
    const ms = zonedWallClockInstant(trimmed, zone);
    return ms === null ? null : new Date(ms).toISOString();
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** Zero-pad a clock component to two digits. */
export const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Render an absolute UTC instant back into a `datetime-local` value, in the
 * display zone's wall clock — the inverse of `localInputToUtcIso`. For `local`, building
 * the string from the local getters (rather than slicing `toISOString`, which
 * is UTC) is what keeps the round trip stable in a non-UTC browser.
 */
export function utcIsoToLocalInput(iso: string, zone: DisplayTimeZone): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (zone !== LOCAL_TIME_ZONE) return wallClockInput(d.getTime(), zone);
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
export function resolveBound(
  local: string,
  originalIso: string,
  zone: DisplayTimeZone,
): string | null {
  if (originalIso !== '' && utcIsoToLocalInput(originalIso, zone) === local) return originalIso;
  return localInputToUtcIso(local, zone);
}

/** The two `datetime-local` bound controls every builder shares. */
export interface BoundFields {
  startTime: string;
  endTime: string;
  startTimeIso: string;
  endTimeIso: string;
  /** #1524 — the zone the two wall clocks are WRITTEN in: the display zone
   * when the form was opened. Held with them, because a wall clock means
   * nothing without its zone, and a zone changed mid-edit must not re-read
   * what was already typed. */
  boundsZone: DisplayTimeZone;
}

/**
 * The wall clock (in `zone`) a bound will actually READ BACK as, when that differs
 * from what the operator typed — `null` otherwise, and for a blank or
 * unreadable control (#855).
 *
 * The case it exists for is a daylight-saving GAP: under `Europe/London`,
 * `2026-03-29T01:30` does not exist (01:00 jumps to 02:00), so `Date` (or
 * `zonedWallClockInstant`, for a named zone) resolves it with the pre-transition offset and the stored instant reloads as `02:30`.
 * That instant is well-defined and stable, so the editors WARN rather than
 * refuse — what they must not do is let the typed value change with nothing
 * said. It reports ANY read-back mismatch, not only a gap — `Date` also rolls a
 * day past the end of its month forward (`02-30` becomes `03-02`), which is the
 * same silent rewrite — so the message names both causes. An ambiguous
 * fall-back wall clock round-trips stably and is not
 * reported. An untouched bound cannot shift: `resolveBound` hands back the
 * loaded instant, whose read-back is by definition the control's value.
 */
export function boundShift(
  local: string,
  originalIso: string,
  zone: DisplayTimeZone,
): string | null {
  const iso = resolveBound(local, originalIso, zone);
  if (iso === null) return null;
  const readBack = utcIsoToLocalInput(iso, zone);
  // `utcIsoToLocalInput` omits zero seconds, so compare against the typed value
  // in that same shape rather than report `09:00:00` as having moved to `09:00`.
  const typed = local.trim().replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):00$/, '$1');
  return readBack === typed ? null : readBack;
}

/**
 * One sentence per bound that `boundShift` reports, for both editors to render.
 * Held here so the recurrence and tumbling-window editors cannot word the same
 * fact two ways.
 */
export function boundShiftWarnings(form: BoundFields): string[] {
  const warnings: string[] = [];
  for (const [bound, label] of [
    ['startTime', 'Start time'],
    ['endTime', 'End time'],
  ] as const) {
    const shifted = boundShift(form[bound], form[`${bound}Iso`], form.boundsZone);
    if (shifted === null) continue;
    warnings.push(
      `${label} ${form[bound].trim()} does not exist in ${boundZoneName(form.boundsZone)} ` +
        `(a daylight-saving jump, or a day past the end of its month) — it will be saved as ${shifted}.`,
    );
  }
  return warnings;
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
): Refusal<'startTime' | 'endTime'> | null {
  for (const bound of ['startTime', 'endTime'] as const) {
    if (form[bound].trim() === '') continue;
    const iso = resolveBound(form[bound], form[`${bound}Iso`], form.boundsZone);
    if (iso === null) return refuseAt(bound, `'${form[bound]}' is not a valid date and time`);
    candidate[bound] = iso;
  }
  return null;
}

/**
 * The absolute instant a bound control will submit, for an editor to ECHO —
 * `null` when the control is blank. Thin, but shared so what the two editors
 * display is resolved the same way the write path resolves it.
 */
export function boundEcho(
  local: string,
  originalIso: string,
  zone: DisplayTimeZone,
): string | null {
  return local.trim() === '' ? null : resolveBound(local, originalIso, zone);
}

/** #1524 — the zone a bound control is written in, as both editors say it in
 * a sentence: "does not exist in …", "entered in …". */
export function boundZoneName(zone: DisplayTimeZone): string {
  return zone === LOCAL_TIME_ZONE ? "your browser's time zone" : `the ${zone} time zone`;
}

/** #1524 — the same zone, short enough to sit in a control's label. */
export function boundZoneLabel(zone: DisplayTimeZone): string {
  return zone === LOCAL_TIME_ZONE ? 'local time' : zone;
}

/**
 * #1396 — a builder's refusal: the one-line `reason` it has always given, and
 * which of its controls each part is about, so the trigger form can show it
 * beside that control rather than only in its footer. `fields` is keyed by the
 * WRITE SCHEMA's path of the value the control authors (`schedule.hours`,
 * `retry.count`), the same path a server refusal carries, so the form keys a
 * control once for both. It is empty when no control owns the refusal.
 */
export interface Refusal<F extends string> {
  readonly ok: false;
  readonly reason: string;
  readonly fields: Readonly<Partial<Record<F, string>>>;
}

/** A refusal about one control. `reason` defaults to `<field>: <message>`, the builders' old wording. */
export function refuseAt<F extends string>(
  field: F,
  message: string,
  reason = `${field}: ${message}`,
): Refusal<F> {
  return { ok: false, reason, fields: { [field]: message } as Partial<Record<F, string>> };
}

/**
 * A write schema's refusal, each issue sorted onto the control that authors its
 * path. `fields` names the paths a control authors (`schedule.hours`,
 * `retry.count`); an issue is matched on the longest of them that prefixes its
 * path, and the rest of the path is kept in front of its message
 * (`splitIssues`), so an entry of a list still says which entry. An issue no
 * control owns is left out of `fields` and stays in `reason`.
 */
export function refuseSchema<F extends string>(
  issues: ReadonlyArray<z.core.$ZodIssue>,
  fields: ReadonlyArray<F>,
  reason = formatZodIssues(issues),
): Refusal<F> {
  const split = splitIssues(issues, (key) => (fields as ReadonlyArray<string>).includes(key));
  return {
    ok: false,
    reason,
    fields: split.fields as Partial<Record<F, string>>,
  };
}
