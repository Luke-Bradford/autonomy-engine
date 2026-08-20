/**
 * #996 M7 slice 2 (#1165) — the one place a store reader hands the event loop
 * back between batches (data-movement spec §9's batch-yield).
 *
 * MOVED here from `sqlite.ts`, where it was module-private, so the `delimited`
 * reader honours the SAME contract with the SAME primitive instead of a second
 * copy that could drift. That mattered enough to extract for a two-line
 * function because the primitive is not the obvious one: `queueMicrotask` is a
 * NO-OP for this purpose — a microtask drains before the loop turns, so a
 * "yield" built on it hands nothing back. It must be a macrotask.
 *
 * That is MEASURED, not reasoned: 200 `queueMicrotask` yields served ZERO
 * pending HTTP requests, while 5 `setImmediate` yields served one.
 * `run/launcher.ts`, `run/child.ts` and `scheduler/tumbling.ts` all use
 * `queueMicrotask` correctly — for ORDERING. This is not that.
 *
 * STATED HONESTLY for the `delimited` reader, because the two callers differ:
 * §9's measured hazard is the SYNCHRONOUS store (`better-sqlite3` steps its
 * cursor in-process and blocks the loop until it is done), which is what the
 * yield was extracted to fix. A file read is genuinely async — every
 * `FileHandle.read()` already turns the loop — so this is contract compliance
 * for the CSV reader rather than a fix for a measured stall. It is kept there
 * anyway: it costs one macrotask per 1000 rows, and a reader that yields only
 * when its own store forces it to would leave §9's guarantee a property of the
 * store rather than of the seam.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
