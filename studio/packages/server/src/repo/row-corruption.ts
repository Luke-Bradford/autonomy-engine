import { ZodError } from 'zod';

/**
 * The #515 classification, named once: a stored row that will not decode is
 * PERMANENTLY corrupt (`ZodError`/`SyntaxError` — it fails identically on every
 * read), and ANY other throw is a live DB fault (a locked database, a closed
 * connection, a disk error) which the next attempt may well clear.
 *
 * The distinction is load-bearing, not cosmetic: callers file the first under a
 * permanent bucket that asks an operator to repair the row, and must let the
 * second propagate to a transient one. Conflating them either re-reports a
 * healthy row as corrupt forever, or retries a repair-needing row forever.
 *
 * The two shapes are exhaustive over "the stored bytes are wrong", and are the
 * two because of how a row is decoded: drizzle's `{mode:'json'}` codec is a bare
 * `JSON.parse`, so invalid stored TEXT throws `SyntaxError` before any schema is
 * reached, and well-formed JSON of the wrong shape throws `ZodError` from the
 * schema itself. A better-sqlite3 read fault is neither.
 *
 * ## Why this lives in its own zero-dependency module
 *
 * It is a predicate about a stored ROW, not about runs — its callers classify
 * run rows, `run_events` payloads, `scheduled_wakeups` refs and pipeline-version
 * rows alike (#1051 collapsed five hand-rolled copies into it). Homing it in
 * `repo/runs.ts`, where it was first named, made every one of those a false
 * dependency on the runs repo, and put an import edge from `run/events.ts` and
 * `repo/scheduled-wakeups.ts` back into a module that imports `run-events.js` —
 * a cycle question that a module importing nothing but `zod` cannot raise at all.
 *
 * Callers should prefer a helper that already OWNS this decision for their read
 * where one exists — `getParsedRun` for a single run row, `listParsedRuns` for a
 * scan, `loadEngineEvents`'s typed `RunLogUnparseableError` for a log — and
 * reach for this predicate only where no such reader exists. A policy applied by
 * hand at each call site is a policy that drifts, which is the defect this
 * module exists to close rather than merely relocate.
 */
export function isDeterministicRowCorruption(err: unknown): boolean {
  return err instanceof ZodError || err instanceof SyntaxError;
}
