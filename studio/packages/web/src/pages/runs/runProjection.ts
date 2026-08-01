import {
  EngineEventSchema,
  createEngine,
  type EngineDoc,
  type EngineEvent,
  type RunEvent,
  type RunState,
} from '@autonomy-studio/shared';

/**
 * U11 — the run monitor's DOC-AWARE projection.
 *
 * `runSummary.ts`'s `deriveNodeActivity` folds its own doc-free approximation
 * because the page could not reach the pipeline version. R1 changed that, so
 * this module folds the ENGINE's own reducer instead — the same
 * `createEngine(doc).projectRunState(events)` the driver runs — and the monitor
 * stops having a second, lossier opinion about what a node's status is.
 *
 * What the doc buys, concretely: `seedState()` seeds the doc's nodes as
 * `pending`, so a node that never dispatched is visible. The event-driven fold
 * structurally cannot show one — no event was ever appended for it. U25 is what
 * makes the table read this instead of guessing.
 *
 * ONE exception, and it matters to every reader: a PARALLEL foreach's body
 * nodes are deliberately NOT seeded (`reduce.ts`'s `seedState` skips
 * `parallelChildIds`). Their state exists only under transient per-item
 * instance keys (`w@1`), which are DELETED as each item completes, so
 * `state.nodes['w']` is absent for such a node whether it has never run, is
 * running, or has finished. Absent therefore does not mean `pending` here, and
 * a reader that treats the projection as total over the doc will blank exactly
 * the rows a parallel foreach lights up. `reconcileNodeActivity` states how it
 * handles that.
 *
 * The tone and label maps that used to live here are in `nodeStatus.ts`, which
 * is type-only against the engine — this module imports `createEngine` as a
 * VALUE, and the node table needs the words without the reducer.
 */

/**
 * A projection either succeeded, or it did not happen. There is deliberately no
 * partial third state.
 *
 * `runSummary.ts` SKIPS an event whose payload fails `EngineEventSchema`
 * (`safeParse` → `continue`), which is safe there because each row independently
 * writes one cell of a table. It is NOT safe here. The reducer is a state
 * machine: drop `run.started` and `state.nodes` stays empty, and every later
 * `withNode` spreads an `undefined` — `createEngine`'s own docblock names that
 * failure ("the reads walk off the end — a TypeError out of the PURE reducer").
 * A hole folded into a state machine is not a slightly-wrong picture, it is an
 * arbitrary one.
 *
 * The whole projection is abandoned, not just the tail — the valid PREFIX is
 * discarded too, which the argument above does not by itself require. That is a
 * deliberate second choice: a partial overlay would need its own "projected
 * through seq N" vocabulary on every node to be honest, and this path is close
 * to unreachable in the first place (the server validates through the SAME
 * `EngineEventSchema` on write, so the only realistic cause is a stale browser
 * bundle against an upgraded server). The page says why, and the doc-free table
 * below — which does skip — still renders the whole run.
 */
export type RunProjection = { ok: true; state: RunState } | { ok: false; reason: string };

/**
 * Fold `events` into a run state.
 *
 * PURE and complete — the whole log, every call. There is deliberately no
 * incremental carry, and that was tried: `reduce` re-spreads `nodes`/`outputs`/
 * `containers` and derives commands + diagnostics per event, all of which this
 * caller discards, so folding only the new suffix is a real saving on a long
 * live run. Holding the accumulator is what fails. A ref cannot be read or
 * written during render, and a React render may be DISCARDED without
 * committing — a carry advanced by one would fold those events twice, silently,
 * into a state machine. Moving it to an effect trades that for a `setState`
 * cascade, which is the same impurity with extra renders.
 *
 * So the page refolds, exactly as its two existing folds already do
 * (`deriveNodeActivity`, `deriveRunLifecycle` — both `useMemo` over the full
 * log). The cost is a constant factor on a shape the page already has, and
 * fixing it belongs with those two rather than here: see #849.
 */
export function projectRun(doc: EngineDoc, events: RunEvent[]): RunProjection {
  // Parse the WHOLE log first, then hand it to the engine's own replay seam, so
  // this is literally `createEngine(doc).projectRunState(events)` rather than a
  // second hand-rolled fold that could drift from it. Validating up front is
  // also what makes the abandon above a single early return.
  const parsed: EngineEvent[] = [];
  for (const envelope of events) {
    const result = EngineEventSchema.safeParse(envelope.payload);
    if (!result.success) {
      return {
        ok: false,
        reason: `event ${envelope.seq} (${envelope.type}) is not a valid engine event, so the graph cannot be projected`,
      };
    }
    parsed.push(result.data);
  }
  return { ok: true, state: createEngine(doc).projectRunState(parsed) };
}
