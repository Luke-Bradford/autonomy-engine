import type { RunWindow } from '../schemas/index.js';

/**
 * P4b — the pure run-window evaluator. A run window is an ALLOW-list on when a
 * trigger may start a NEW run; the scheduler consults it before every automatic
 * fire (a manual "run now" is an explicit operator override and is NOT gated by
 * windows). Kept pure (a function of `(windows, at)`, no clock of its own) so it
 * is unit-testable in isolation and reusable FE-side for a "next open window"
 * preview.
 *
 * Semantics (see `docs/2026-07-12-target-architecture.md` §Run windows):
 *   - UTC. `at` is evaluated in UTC (`getUTCHours`/`getUTCMinutes`/`getUTCDay`),
 *     matching the schema's documented UTC contract, so behaviour never depends
 *     on the host's timezone.
 *   - `null` windows → OPEN (no restriction configured). A caller who wants no
 *     restriction sets `null`, which is why a non-null but EMPTY array is the
 *     fail-closed case below rather than "unrestricted".
 *   - Non-null array → open iff at least one window matches. An EMPTY array is
 *     therefore CLOSED (fail-closed: "windows configured, none of them").
 *   - Each window: `[start, end)` — start inclusive, end EXCLUSIVE, "HH:MM" 24h
 *     UTC. `start > end` WRAPS past midnight (e.g. 22:00→02:00). A malformed
 *     time string makes that window never match (fail-closed), so a window we
 *     cannot parse never admits a run.
 *   - `days` (optional, ISO-ish 0=Sunday..6=Saturday): when present the current
 *     UTC weekday must be listed. For a wrap-past-midnight window the day filter
 *     is applied to the CURRENT day of both segments (the post-midnight tail is
 *     attributed to the same listed day) — a conscious simplification, adequate
 *     for windowing; exact start-day attribution across a wrap is not needed.
 */
export function isWithinRunWindows(windows: RunWindow[] | null, at: Date): boolean {
  if (windows === null) return true;
  if (windows.length === 0) return false;
  return windows.some((w) => matchesWindow(w, at));
}

/** Parse "HH:MM" (1-2 digit hour, 2 digit minute) 24h into minutes-of-day, or
 * `null` if malformed / out of range — an unparseable bound fails closed. */
function parseHM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function matchesWindow(w: RunWindow, at: Date): boolean {
  const start = parseHM(w.start);
  const end = parseHM(w.end);
  if (start === null || end === null) return false;
  if (w.days !== undefined && !w.days.includes(at.getUTCDay())) return false;
  const cur = at.getUTCHours() * 60 + at.getUTCMinutes();
  // Same-day window: [start, end). start === end is an empty window → closed.
  if (start <= end) return cur >= start && cur < end;
  // Wraps past midnight: [start, 24:00) ∪ [00:00, end).
  return cur >= start || cur < end;
}
