import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import {
  WebhookDeliverySchema,
  type WebhookDelivery,
  type WebhookDeliveryOutcome,
} from '@autonomy-studio/shared';
import { webhookDeliveries } from '../db/schema.js';
import { newId } from './ids.js';
import { drainByBatches } from './retention.js';
import type { Db } from './types.js';

/**
 * Durable webhook-delivery ledger — the source of truth for replay protection
 * and caller idempotency (see `routes/webhooks.ts`). A delivery is CLAIMED with
 * `claimWebhookDelivery` (INSERT under the `(triggerId, idempotencyKey)` UNIQUE
 * index) BEFORE the fire, then FINALIZED with the fire's outcome; the UNIQUE
 * index is the atomic guard that makes "fire at most once per key" hold under
 * concurrent identical deliveries.
 */

/** Thrown by `claimWebhookDelivery` when the `(triggerId, idempotencyKey)`
 * pair is already recorded — i.e. this delivery is a replay/duplicate. */
export class DuplicateWebhookDeliveryError extends Error {
  constructor(
    public readonly triggerId: string,
    public readonly idempotencyKey: string,
  ) {
    super(`webhook delivery already recorded for trigger '${triggerId}'`);
    this.name = 'DuplicateWebhookDeliveryError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  // better-sqlite3 surfaces a UNIQUE-index conflict with this stable code.
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

/**
 * Atomically CLAIM a delivery: INSERT a fresh `pending` row keyed by
 * `(triggerId, idempotencyKey)`. Returns the claimed row, or throws
 * `DuplicateWebhookDeliveryError` if the key is already present (the UNIQUE
 * index rejected the insert) — the caller then serves the existing row as a
 * duplicate WITHOUT firing.
 */
export function claimWebhookDelivery(
  db: Db,
  input: { triggerId: string; idempotencyKey: string },
): WebhookDelivery {
  const row: WebhookDelivery = {
    id: newId('whd'),
    triggerId: input.triggerId,
    idempotencyKey: input.idempotencyKey,
    outcome: 'pending',
    runId: null,
    receivedAt: Date.now(),
  };
  try {
    db.insert(webhookDeliveries).values(row).run();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DuplicateWebhookDeliveryError(input.triggerId, input.idempotencyKey);
    }
    throw err;
  }
  return WebhookDeliverySchema.parse(row);
}

export function getWebhookDelivery(
  db: Db,
  triggerId: string,
  idempotencyKey: string,
): WebhookDelivery | null {
  const row = db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.triggerId, triggerId),
        eq(webhookDeliveries.idempotencyKey, idempotencyKey),
      ),
    )
    .get();
  return row ? WebhookDeliverySchema.parse(row) : null;
}

/** Write the fire's outcome (and `runId`, if `started`) back onto a claimed
 * `pending` row. */
export function finalizeWebhookDelivery(
  db: Db,
  id: string,
  result: { outcome: WebhookDeliveryOutcome; runId: string | null },
): void {
  db.update(webhookDeliveries)
    .set({ outcome: result.outcome, runId: result.runId })
    .where(eq(webhookDeliveries.id, id))
    .run();
}

/** Release a claim whose fire FAILED before it could be finalized, so a
 * corrected retry of the same key is not permanently deduped. */
export function deleteWebhookDelivery(db: Db, id: string): void {
  db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, id)).run();
}

/**
 * #421 — RETENTION. DELETE ledger rows whose `receivedAt` is strictly before
 * `before`, oldest-first, at most `limit` per call. Returns the number deleted.
 * `limit` omitted = unbounded (delete every eligible row in one statement).
 *
 * By AGE, ALL outcomes — NOT filtered by `outcome` like the wakeup sweep's
 * `status`. A `webhook_deliveries` row has no "settled = final" resurrection
 * invariant: it exists only to make "fire at most once per `(triggerId,
 * idempotencyKey)`" hold. So the sole safety question is whether deleting a row
 * could let a delivery fire TWICE — and it cannot, because:
 *
 *   - REPLAY protection (a resend of the SAME signed request) is enforced at
 *     auth by the ±300s signature-timestamp tolerance, BEFORE any ledger read;
 *     a replay old enough to have been pruned is already rejected at 401.
 *   - CALLER idempotency (a caller RE-driving the same `x-webhook-idempotency-key`
 *     after a network hiccup) is the only thing the row's age protects. The
 *     retention floor is generous ON PURPOSE (default 30 days, configurable via
 *     `WEBHOOK_RETENTION_DAYS`) — orders of magnitude beyond any real caller's
 *     retry window — so a key is freed only long after any legitimate retry of
 *     it could arrive. Pinning retention to the ±300s replay window would be
 *     WRONG here: it would free a caller's key inside their retry horizon.
 *   - A crash-orphaned `pending` row (a claim whose fire died before
 *     finalize/delete) is pruned by the SAME age rule; freeing its key long after
 *     the fact is correct, not a hazard (`deleteWebhookDelivery` already frees a
 *     fresh one deliberately).
 *
 * The boundary is EXCLUSIVE (`receivedAt < before`, not `<=`): `before` is
 * `now - retentionMs`, so a row exactly at the floor is still inside the safe
 * window and survives — matching `pruneSettledWakeups`. Uses the existing
 * `webhook_deliveries_received_at_idx` for an index range scan; the id-subquery
 * form (not `DELETE … LIMIT`, which needs a non-default better-sqlite3 build)
 * mirrors the wakeup sweep.
 */
export function pruneWebhookDeliveries(db: Db, opts: { before: number; limit?: number }): number {
  // Oldest-first, `id` breaking `receivedAt` ties so batch boundaries are stable
  // across sweeps — the same total order the wakeup sweep uses.
  const doomed = db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(lt(webhookDeliveries.receivedAt, opts.before))
    .orderBy(asc(webhookDeliveries.receivedAt), asc(webhookDeliveries.id));
  const bounded = opts.limit === undefined ? doomed : doomed.limit(opts.limit);
  const deleted = db
    .delete(webhookDeliveries)
    .where(inArray(webhookDeliveries.id, bounded))
    .returning({ id: webhookDeliveries.id })
    .all();
  return deleted.length;
}

/**
 * #421 — drain ledger rows older than `before` in bounded batches to a fixpoint
 * OR `maxBatches`. Returns the total deleted. Pure over the clock — the caller
 * passes `before = now - retentionMs`. Batching loop is the shared
 * `drainByBatches` (see `./retention.ts`), identical to `drainSettledWakeups`.
 */
export function drainWebhookDeliveries(
  db: Db,
  opts: { before: number; batch?: number; maxBatches?: number },
): number {
  return drainByBatches((limit) => pruneWebhookDeliveries(db, { before: opts.before, limit }), {
    batch: opts.batch,
    maxBatches: opts.maxBatches,
  });
}
