import {
  EngineEventSchema,
  terminalStatusOf,
  type Engine,
  type EngineEvent,
  type ReduceResult,
  type RunEvent,
  type RunLifecycleStatus,
  type RunState,
} from '@autonomy-studio/shared';
import { appendRunEvent, listRunEvents } from '../repo/run-events.js';
import { recordRunDiagnostics } from '../repo/run-diagnostics.js';
import type { Db } from '../repo/types.js';
import type { RunEventBus } from './event-bus.js';

/**
 * The bridge between the engine's typed `EngineEvent` union and the generic
 * `run_events` envelope (P1a: `{ runId, type, payload }`, `seq`/`ts`/`id`
 * server-assigned). The engine (in `@autonomy-studio/shared`) is I/O-free and
 * knows nothing about the DB; this module is the one place that (de)serialises
 * its events, so the driver and reconciler never touch the envelope shape.
 *
 * The WHOLE `EngineEvent` (including its own `type`/`runId`) is stored as the
 * `payload`, and `EngineEventSchema.parse` re-validates it on read. Round-trip:
 * every `EngineEvent` variant carries a `runId`, so the envelope's `runId`
 * column is always `event.runId` — the append-order (`seq` per run) is the
 * durable source of truth the projection folds over.
 *
 * Returns BOTH the durable `RunEvent` ENVELOPE (server-assigned `id`/`seq`/`ts`,
 * for callers that need the monotonic `seq` — the P6 live tail) and the PARSED
 * `EngineEvent`. When a `bus` is supplied, the envelope is published to it AFTER
 * the durable append — so a live subscriber never observes an event that is not
 * yet in the log, and the WS layer can dedupe replay-vs-live purely by `seq`.
 * This is the ONE append choke point, so every event the driver/reconciler
 * appends (whichever module) uniformly streams to any watching client.
 *
 * **Why `event` is returned, and why every caller must FOLD IT rather than its
 * own input** (the joint F1b/F2b spec's build order names this as F2b's first
 * task): this function APPENDS the parsed value but callers used to REDUCE the
 * raw one. Those differ wherever the schema has a `.default()` — and
 * `node.failed.kind` is exactly that: an event constructed without `kind` is
 * STORED as `permanent` (the parse default) while the live reducer sees
 * `undefined`. Inert while nothing read `kind`; F2b's retry-eligibility reads
 * exactly it, so the live run and its replay would disagree about whether a node
 * retries — the one class of bug event-sourcing is supposed to make impossible.
 * Returning the parsed value is what lets the fold and the log be the same fact.
 */
export function appendEngineEvent(
  db: Db,
  event: EngineEvent,
  bus?: RunEventBus,
): { record: RunEvent; event: EngineEvent } {
  // Re-validate on the way in too: a driver/reconciler bug that hands us a
  // malformed event fails HERE (before it is durably appended) rather than
  // silently corrupting a run's log to be discovered only on replay.
  const parsed = EngineEventSchema.parse(event);
  const record = appendRunEvent(db, { runId: parsed.runId, type: parsed.type, payload: parsed });
  // Publish AFTER the durable append: a subscriber must never see an event that
  // is not yet in the log. `publish` is synchronous and never throws (it
  // isolates a broken subscriber), so it cannot disrupt the driver's pump.
  bus?.publish(record);
  return { record, event: parsed };
}

/**
 * #497 — APPEND an event, FOLD it, and RECORD the fold's diagnostics: the three
 * halves of one turn, bound to ONE `db` handle.
 *
 * This exists to make a class of bug unrepresentable rather than merely avoided.
 * The rule is "whoever appends, records", and the hazard is that the recorder
 * reaches a DIFFERENT handle than the append did. `retry-alarm.ts` is the live
 * case: it appends inside the alarm clock's transaction (on `tx`) while also
 * holding `deps.db`, and its rollback is the documented at-least-once contract.
 * A diagnostic recorded on `deps.db` would survive a rollback that erased its
 * event — and then, when the redelivery re-appended at that same `seq`, the
 * insert's `OR IGNORE` would silently swallow the REAL diagnostics in favour of
 * the orphans. Taking one `db` for all three steps means the two can never
 * disagree, so no call site has to remember.
 *
 * Folds the PARSED event, never the raw input — see `appendEngineEvent`.
 *
 * NOT usable where the fold must precede the append (`reconcile.ts` derives its
 * commands before deciding whether it can honour them, and appends only if it
 * can). That site pairs each event's diagnostics to its `seq` by index at the
 * append instead, which is the same rule reached the long way round.
 */
export function appendAndFold(
  db: Db,
  bus: RunEventBus | undefined,
  engine: Pick<Engine, 'reduce'>,
  state: RunState,
  event: EngineEvent,
  log?: DiagnosticLog,
): ReduceResult & { record: RunEvent } {
  const appended = appendEngineEvent(db, event, bus);
  const result = engine.reduce(state, appended.event);
  recordRunDiagnostics(
    db,
    appended.record.runId,
    appended.record.seq,
    'fold',
    result.diagnostics,
    log,
  );
  return { ...result, record: appended.record };
}

/** The `log` seam `recordRunDiagnostics` reports a failed insert through. */
export interface DiagnosticLog {
  error(obj: unknown, msg?: string): void;
}

/**
 * Replay a run's durable log as the typed `EngineEvent[]` the reducer folds
 * (append order = `seq` ascending, guaranteed by `listRunEvents`). Any row
 * whose `payload` is not a valid `EngineEvent` throws here — the log is the
 * source of truth, so a corrupt entry is a hard error, never a silent skip.
 */
export function loadEngineEvents(db: Db, runId: string): EngineEvent[] {
  return listRunEvents(db, runId).map((row) => EngineEventSchema.parse(row.payload));
}

/**
 * #443 — the run's TERMINAL fact AS THE LOG RECORDS IT, or `null` if the log
 * holds none. **The LOG is authoritative over the projection for terminality.**
 *
 * Runs are event-sourced (`state = fold(run_events)`) with the CURRENT reducer,
 * so any reducer semantics change re-folds already-finished logs and can make the
 * projection contradict a `run.finished` the log already recorded. Re-deriving a
 * recorded terminal fact under newer rules is the FAIL-OPEN direction: it lets a
 * finished run look live and be re-driven, re-executing side effects. So callers
 * deciding "is this run over?" read the fact here and never re-derive it.
 *
 * `events` MUST be in append (`seq`) order — `loadEngineEvents` is the only
 * sanctioned source. An unsorted array reads the wrong terminal.
 *
 * **The LAST terminal event wins**, for three reasons:
 *   1. `pump` breaks the instant the run goes terminal (`driver.ts`), so nothing
 *      is appended after an ACCEPTED terminal — the last one is the driver's own
 *      final conclusion.
 *   2. On the one multi-terminal log the driver can produce, it is the only
 *      correct read: `pump` appends `run.finished` BEFORE folding it, so a finish
 *      the reducer REJECTS is durable, followed by the
 *      `finishRun{failure, invalid_event}` it returned instead. Reading the FIRST
 *      terminal would resync the rejected `success`.
 *   3. The shipped run-detail page already derives its lifecycle last-wins from
 *      this same log (`web/.../runSummary.ts`), so `runs.status` and what the
 *      operator is SHOWN cannot disagree about the same log.
 *
 * **The named cost (probed).** If a crash lands BETWEEN a rejected
 * `run.finished{success}` and its replacement, the log holds that success alone
 * and this reports `success` where the old projection-based path reported
 * `failure`. That is accepted, not overlooked: this function cannot distinguish
 * "an OLD reducer accepted this success" (where `success` is the right answer, and
 * is the entire point of #443) from "the CURRENT reducer rejects it" (where
 * `failure` is) — only the per-version reducer marker §E defers could, and
 * re-deriving to find out is the fail-open direction this rule exists to stop.
 * It needs a self-inconsistent reducer at write time — which is the two-call-site
 * bug F1b §B.2 fixes — AND a crash inside that window.
 *
 * The invariant this rests on is narrow and exact: **no TERMINAL event is
 * appended after an ACCEPTED terminal event** (`launcher.ts`'s
 * `terminalizeInterrupted` is the one producer that had to be taught this).
 * NON-terminal events legitimately may — a `run.resumed` from a pre-#443 log
 * already does, and it must not erase the terminal fact under it.
 *
 * This DELIBERATELY diverges from `projectRunState` on a log the current reducer
 * would re-fold differently — that divergence IS the ticket. Needs no pipeline
 * version, so a finished run whose doc no longer resolves is still readable.
 */
export function terminalFactFromLog(events: EngineEvent[]): RunLifecycleStatus | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const status = terminalStatusOf(events[i]!);
    if (status !== null) return status;
  }
  return null;
}
