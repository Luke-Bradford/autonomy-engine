import { z } from 'zod';

/**
 * The recorded outcome of a webhook delivery that PASSED authentication and
 * was admitted to the launcher. `pending` is the transient state between the
 * idempotency row being claimed (INSERT) and the fire's outcome being written
 * back — a crash in that sub-tick window leaves a `pending` row, which the
 * idempotency check treats as "already handled" (fail-safe: never double-fire).
 * `started`/`queued`/`skipped` mirror the launcher's `FireOutcome`.
 *
 * NOT stored: `duplicate` (a response-only outcome for a replayed key) and any
 * pre-auth/gated skip (a disabled or out-of-window trigger records NO delivery,
 * so a later retry of the same key still fires — see `routes/webhooks.ts`).
 */
export const WebhookDeliveryOutcomeSchema = z.enum(['pending', 'started', 'queued', 'skipped']);
export type WebhookDeliveryOutcome = z.infer<typeof WebhookDeliveryOutcomeSchema>;

/**
 * A durable record that a webhook delivery was processed, keyed by
 * `(triggerId, idempotencyKey)` UNIQUE. This is the source of truth for BOTH
 * replay protection and caller idempotency: the launcher fires a delivery at
 * most once, even across a process restart, because the row survives the
 * restart (an in-memory nonce cache would not). The `idempotencyKey` is the
 * caller-supplied `x-webhook-idempotency-key` when present, else the request
 * signature itself (which is deterministic in secret+timestamp+body, so a
 * verbatim replay collides while a freshly-signed new event does not).
 *
 * Never reachable from an HTTP client projection: a delivery row carries no
 * secret material, but it is internal bookkeeping, not part of any resource
 * response.
 */
export const WebhookDeliverySchema = z.object({
  id: z.string().min(1),
  triggerId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  outcome: WebhookDeliveryOutcomeSchema,
  /** The created run's id — present iff `outcome === 'started'`. */
  runId: z.string().min(1).nullable(),
  receivedAt: z.number().int(),
});
export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

// No `NewWebhookDelivery` insert-shape schema: a delivery's caller-facing input
// is only `{ triggerId, idempotencyKey }` — the server always claims it
// `pending` with a null `runId` and a server-set `id`/`receivedAt` (see
// `claimWebhookDelivery`), so an insert schema over `outcome`/`runId` would
// mis-model the one write path this row has.
