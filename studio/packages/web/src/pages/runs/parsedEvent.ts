import { EngineEventSchema, type EngineEvent, type RunEvent } from '@autonomy-studio/shared';

/**
 * #849 — parse one log envelope's payload ONCE, for as long as that envelope lives.
 *
 * The run detail page walks the whole event log several times per appended event
 * (`projectRun`, `deriveNodeActivity`, `deriveRunLifecycle`), and every one of
 * those walks re-ran `EngineEventSchema.safeParse` over EVERY row. That is a Zod
 * validation per event per event — quadratic in the length of a live run's log,
 * and Zod validation dominates the `switch` folds those walks actually perform.
 * A long-running pipeline therefore got slower to WATCH the longer it ran.
 *
 * The fix is a memo keyed on envelope identity, which works because the stream
 * hook appends by allocating a fresh ARRAY while keeping the element objects
 * (`useRunStream`: `{ ...s, events: [...s.events, event] }`). Each walk's
 * `useMemo` is still invalidated by the new array, but the rows it re-walks now
 * hit the cache.
 *
 * WHY THIS IS SOUND WHERE AN INCREMENTAL FOLD IS NOT. `projectRun`'s docblock
 * rejects carrying an accumulator across renders, and rightly: React may DISCARD
 * a render, so a carry advanced by one would silently fold events twice. This is
 * not a carry. It is a pure function memoized on its argument's identity — the
 * same envelope always yields the same result, in any order, however many
 * renders are thrown away. Nothing here depends on being called once.
 *
 * THE INVARIANT IT RESTS ON: no consumer mutates a parsed event, or any
 * sub-object reachable from one. Before this memo each walk got its own
 * materialisation, so a mutation would have been contained; now the walks share
 * one. Audited at the time of writing — the reducer never assigns to its event
 * argument, and `deriveNodeActivity` only ever REASSIGNS `n.outputValues = e.outputs`
 * (readers are `Object.keys`/`JSON.stringify`), so the sharing is observationally
 * invisible. A future consumer that wants to mutate must copy first.
 *
 * (This does NOT make the server's own guarantee weaker: `appendEngineEvent`
 * re-validates and re-materialises on the way into the log, which is what
 * `reduce.ts` relies on. This memo is client-side, downstream of all of that.)
 *
 * A `WeakMap` and not a `Map`: the entries are collected with the envelopes
 * themselves, so nothing is retained past the run view that holds the log.
 */
const parsed = new WeakMap<RunEvent, EngineEvent | null>();

/**
 * The envelope's payload as an `EngineEvent`, or `null` if it does not validate.
 *
 * Callers differ on what an invalid row means — `projectRun` refuses the whole
 * projection, the doc-free folds skip the row — so this reports the failure
 * rather than deciding for them.
 */
export function parseEngineEvent(row: RunEvent): EngineEvent | null {
  const hit = parsed.get(row);
  if (hit !== undefined) return hit;
  const result = EngineEventSchema.safeParse(row.payload);
  const value = result.success ? result.data : null;
  parsed.set(row, value);
  return value;
}
