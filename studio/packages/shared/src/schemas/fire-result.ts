import { z } from 'zod';
import { addParamsReplaySafetyIssues } from './replay-safety.js';

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

/**
 * The optional request body of a MANUAL fire (`POST /api/triggers/:id/fire`,
 * #5 S12b) — colocated with `FireResultSchema` (its response counterpart) on
 * purpose, so the one file owns the fire endpoint's request+result contract.
 * `params` is the RUN-NOW override layer — the TOP of the precedence stack
 * (pipeline-default < trigger-binding < run-now override). Every field is
 * optional so a bare "run now" (no body) stays valid, exactly as before S12b.
 *
 * The override values are raw (uncoerced) and validated against the pipeline's
 * declared params by `resolveRunParams` at run start — an undeclared/type-bad
 * override surfaces as an interrupted run, not a request error, consistent with
 * a bad trigger-authored param today.
 */
export const FireRequestSchema = z
  .object({
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((body, ctx) => {
    // #547 — the run-now override is frozen into `run.params` → `run.started`,
    // which `JSON.stringify`-persists (non-finite → `null`) and replays. Refuse a
    // non-finite number (incl. a `json`-typed override's nested field, which
    // `resolveRunParams` passes through untouched) at this write boundary so it
    // never becomes a silently-lossy run fact. Shared, so the web client
    // pre-validates identically.
    if (body.params === undefined) return;
    addParamsReplaySafetyIssues(body.params, ctx);
  });
export type FireRequest = z.infer<typeof FireRequestSchema>;
