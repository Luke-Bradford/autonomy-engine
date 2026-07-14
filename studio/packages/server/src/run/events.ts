import { EngineEventSchema, type EngineEvent, type RunEvent } from '@autonomy-studio/shared';
import { appendRunEvent, listRunEvents } from '../repo/run-events.js';
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
 * Returns the durable `RunEvent` ENVELOPE (server-assigned `id`/`seq`/`ts`), not
 * the bare `EngineEvent`, so callers that need the monotonic `seq` (the P6 live
 * tail) have it. When a `bus` is supplied, the envelope is published to it AFTER
 * the durable append — so a live subscriber never observes an event that is not
 * yet in the log, and the WS layer can dedupe replay-vs-live purely by `seq`.
 * This is the ONE append choke point, so every event the driver/reconciler
 * appends (whichever module) uniformly streams to any watching client.
 */
export function appendEngineEvent(db: Db, event: EngineEvent, bus?: RunEventBus): RunEvent {
  // Re-validate on the way in too: a driver/reconciler bug that hands us a
  // malformed event fails HERE (before it is durably appended) rather than
  // silently corrupting a run's log to be discovered only on replay.
  const parsed = EngineEventSchema.parse(event);
  const record = appendRunEvent(db, { runId: parsed.runId, type: parsed.type, payload: parsed });
  // Publish AFTER the durable append: a subscriber must never see an event that
  // is not yet in the log. `publish` is synchronous and never throws (it
  // isolates a broken subscriber), so it cannot disrupt the driver's pump.
  bus?.publish(record);
  return record;
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
