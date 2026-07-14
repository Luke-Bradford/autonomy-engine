import { and, eq } from 'drizzle-orm';
import {
  WebhookDeliverySchema,
  type WebhookDelivery,
  type WebhookDeliveryOutcome,
} from '@autonomy-studio/shared';
import { webhookDeliveries } from '../db/schema.js';
import { newId } from './ids.js';
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
