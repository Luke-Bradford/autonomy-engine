/**
 * `1 trigger` / `3 triggers` — a count with its noun agreeing in number. The
 * count is the point, so it is never elided. `plural` defaults to `noun + s`;
 * pass it for anything irregular (`activity` / `activities`).
 *
 * One helper: it was written three times, privately, before #1452 folded them.
 */
export function countOf(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}
