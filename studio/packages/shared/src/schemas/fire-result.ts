import { z } from 'zod';

/**
 * The outcome of a single trigger fire (`POST /api/triggers/:id/fire`, the P4b
 * scheduler, P4c webhooks). `started` created a run; `queued` admitted the fire
 * to the trigger's queue; `skipped` refused admission (concurrency/shutdown).
 * `started`/`queued`/`skipped` are the same three the webhook-delivery ledger
 * stores (see `WebhookDeliveryOutcomeSchema`, which adds a transient `pending`).
 */
export const FireOutcomeSchema = z.enum(['started', 'queued', 'skipped']);
export type FireOutcome = z.infer<typeof FireOutcomeSchema>;

/**
 * The wire shape the server's `RunLauncher.fire()` returns and the `202` fire
 * endpoint sends. Shared FE/BE so the web client validates the fire response
 * through the SAME schema the launcher's type is derived from (`launcher.ts`
 * derives `FireResult`/`FireOutcome` from these). `runId` is present iff
 * `started`; `reason` iff `skipped` — both optional, so the schema tolerates a
 * bare `{ outcome }` for `queued`.
 */
export const FireResultSchema = z.object({
  outcome: FireOutcomeSchema,
  /** The created run's id — present iff `outcome === 'started'`. */
  runId: z.string().min(1).optional(),
  /** Why admission was refused — present iff `outcome === 'skipped'`. */
  reason: z.string().min(1).optional(),
});
export type FireResult = z.infer<typeof FireResultSchema>;
