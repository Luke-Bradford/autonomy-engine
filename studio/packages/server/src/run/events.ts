import { EngineEventSchema, type EngineEvent } from '@autonomy-studio/shared';
import { appendRunEvent, listRunEvents } from '../repo/run-events.js';
import type { Db } from '../repo/types.js';

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
 */
export function appendEngineEvent(db: Db, event: EngineEvent): EngineEvent {
  // Re-validate on the way in too: a driver/reconciler bug that hands us a
  // malformed event fails HERE (before it is durably appended) rather than
  // silently corrupting a run's log to be discovered only on replay.
  const parsed = EngineEventSchema.parse(event);
  appendRunEvent(db, { runId: parsed.runId, type: parsed.type, payload: parsed });
  return parsed;
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
