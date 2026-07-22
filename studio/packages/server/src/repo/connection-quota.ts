import { eq, sql } from 'drizzle-orm';

import { connectionQuotaState } from '../db/schema.js';
import type { Db } from './types.js';

/**
 * #2 L14c — the per-connection quota RESET-WINDOW primitive (proactive half).
 *
 * A subscription CLI (`agent_cli` connection) exhausts a rolling usage quota.
 * The FIRST dispatch to discover exhaustion records the reset epoch here
 * (`recordConnectionQuotaExhaustion`, driver-only); every subsequent dispatch of
 * that shared connection reads it (`getConnectionQuotaResetEpoch`, executor
 * pre-flight) and short-circuits to a `rate_limit` retry without spawning a
 * doomed subprocess — the admission gate.
 *
 * The driver is the SOLE WRITER (the studio analog of the engine's
 * reset-epoch-split invariant: adapters only EXTRACT the window, one orchestrator
 * persists it), and the reset epoch is anchored to the failure event's durable
 * `ts`, so a replay reproduces the identical row and the upsert is idempotent.
 */

/** The stored reset epoch (ms) for a connection, or null if none is recorded.
 * Null means "not known exhausted" — the fail-safe permissive default. */
export function getConnectionQuotaResetEpoch(db: Db, connectionId: string): number | null {
  const row = db
    .select({ resetEpochMs: connectionQuotaState.resetEpochMs })
    .from(connectionQuotaState)
    .where(eq(connectionQuotaState.connectionId, connectionId))
    .get();
  return row?.resetEpochMs ?? null;
}

/**
 * Record (upsert) an exhausted quota window for `connectionId`, resetting at
 * `resetEpochMs`. `updatedAtMs` is the writing failure event's `ts` — a
 * last-write AUDIT stamp only (read nowhere today; it advances on every write, so
 * on a MAX-upsert that keeps an earlier window it stamps the newest write, not the
 * kept window's setting event).
 *
 * ATOMIC MAX-upsert: `ON CONFLICT DO UPDATE SET reset_epoch_ms =
 * MAX(new, existing)`. A longer window must NEVER be shortened — if two exhausted
 * dispatches report different reset epochs (or the admission gate re-derives a
 * slightly rounded one), the connection stays gated until the LATEST known reset.
 * The `MAX` also makes the write idempotent on a replayed/re-dispatched failure
 * (same event `ts` ⇒ same epoch ⇒ a no-op update). Doing it in one statement
 * (rather than a JS read-then-write) is race-proof even though F2c's per-run
 * locks already serialise most contention: two DIFFERENT runs can write the same
 * connection's row concurrently.
 */
export function recordConnectionQuotaExhaustion(
  db: Db,
  connectionId: string,
  resetEpochMs: number,
  updatedAtMs: number,
): void {
  db.insert(connectionQuotaState)
    .values({ connectionId, resetEpochMs, updatedAtMs })
    .onConflictDoUpdate({
      target: connectionQuotaState.connectionId,
      set: {
        resetEpochMs: sql`max(excluded.reset_epoch_ms, ${connectionQuotaState.resetEpochMs})`,
        updatedAtMs: sql`excluded.updated_at_ms`,
      },
    })
    .run();
}
