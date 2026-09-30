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
 * derives `FireResult`/`FireOutcome` from these). `runId` is present iff a
 * run row was created (`started` AND — since #5 S9 — `queued`, whose durable
 * row always existed but went unreported; the tumbling-window completion
 * chain needs to link a queued run to its window); `reason` iff `skipped`.
 * Both optional, so the schema tolerates a bare `{ outcome }` (a pre-S9
 * `queued` response).
 */
export const FireResultSchema = z.object({
  outcome: FireOutcomeSchema,
  /** The created run's id — present iff a run row exists (`started`/`queued`). */
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

/**
 * #1395 OR4 — the body of a RUN FROM THE EDITOR (`POST /api/pipelines/:id/runs`):
 * run one saved version of the pipeline now, with no trigger. Its reply is the
 * `FireResultSchema` above (`started` with a `runId`, or `skipped` with a
 * `reason`), so it lives beside the fire contract rather than in a file of its
 * own.
 *
 * `pipelineVersionId` is the version the operator was SHOWN on the Run button,
 * sent explicitly so a save landing between the click and the request cannot
 * change what runs. The server refuses a version of a different pipeline.
 *
 * `params` is the run-now layer over the version's defaults. Unlike a trigger
 * fire, the route checks it against the version's declared params BEFORE a run
 * row exists, so a bad value is a 400 the operator can correct, not an
 * interrupted run.
 */
export const ManualRunRequestSchema = z
  .object({
    pipelineVersionId: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((body, ctx) => {
    // The same write-boundary refusal as `FireRequestSchema`, for the same reason.
    if (body.params === undefined) return;
    addParamsReplaySafetyIssues(body.params, ctx);
  });
export type ManualRunRequest = z.infer<typeof ManualRunRequestSchema>;
