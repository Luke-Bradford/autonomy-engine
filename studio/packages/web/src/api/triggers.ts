import { z } from 'zod';
import {
  FireResultSchema,
  TriggerCreateBodySchema,
  TriggerPublicSchema,
  TriggerWriteBodySchema,
  type FireResult,
  type TriggerPublic,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';

/**
 * The client-facing write body. This is now the SAME OBJECT the route parses
 * (`@autonomy-studio/shared`), not a client-side re-derivation that claims to
 * match it: the form's validation cannot drift from the server's, including the
 * cross-field concurrency rule (`ConcurrencyWriteSchema`: `parallel` requires
 * `max`, single-slot policies forbid it).
 */
export const TriggerWriteSchema = TriggerWriteBodySchema;
export type TriggerWrite = z.input<typeof TriggerWriteSchema>;

/**
 * #981 — the CREATE body, which additionally admits `bindToActive` (#3 G6c-2)
 * and is XOR-refined against `pipelineVersionId`. Shared for the same reason:
 * a cross-field refinement copied client-side drifts silently, and the drift
 * only surfaces as a 400 the client thought it had already excluded.
 *
 * Note the XOR keys on PRESENCE — a bind-to-active create must OMIT
 * `pipelineVersionId` entirely. `JSON.stringify` drops `undefined` but KEEPS
 * `null`, so building the body with an explicit `null` would violate the XOR
 * on the wire even though it looks like the unbound request it isn't.
 */
export const TriggerCreateSchema = TriggerCreateBodySchema;
export type TriggerCreateWrite = z.input<typeof TriggerCreateSchema>;

const TriggerListSchema = z.array(TriggerPublicSchema);

/**
 * Response of `POST /api/triggers/:id/webhook-secret`: the plaintext secret is
 * returned EXACTLY ONCE (never persisted in plaintext, never readable again),
 * plus the URL signed deliveries are POSTed to.
 */
export const WebhookSecretResultSchema = z.object({
  secret: z.string().min(1),
  deliveryUrl: z.string().min(1),
});
export type WebhookSecretResult = z.infer<typeof WebhookSecretResultSchema>;

/** Owner-scoped list of triggers (webhook `secretRef` never present — `TriggerPublic`). */
export function listTriggers(signal?: AbortSignal): Promise<TriggerPublic[]> {
  return apiFetch('/api/triggers', { schema: TriggerListSchema, signal });
}

export function createTrigger(body: TriggerCreateWrite): Promise<TriggerPublic> {
  return apiFetch('/api/triggers', {
    method: 'POST',
    body,
    schema: TriggerPublicSchema,
  });
}

/** PATCH is partial: only the supplied fields change. */
export function updateTrigger(id: string, body: Partial<TriggerWrite>): Promise<TriggerPublic> {
  return apiFetch(`/api/triggers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: TriggerPublicSchema,
  });
}

export function deleteTrigger(id: string): Promise<void> {
  return apiFetch<void>(`/api/triggers/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Manual "Fire now" (`POST /api/triggers/:id/fire`) — an explicit operator
 * action, independent of the trigger's `enabled` flag and `mode`. The `202`
 * body reports whether the fire `started` (with a `runId`), was `queued`, or
 * `skipped` (with a `reason`) per the trigger's concurrency policy.
 */
export function fireTrigger(id: string): Promise<FireResult> {
  return apiFetch(`/api/triggers/${encodeURIComponent(id)}/fire`, {
    method: 'POST',
    schema: FireResultSchema,
  });
}

/**
 * Provision (or rotate) a webhook trigger's per-trigger secret
 * (`POST /api/triggers/:id/webhook-secret`). Only valid for a `webhook`-mode
 * trigger; the returned plaintext `secret` is shown once and never again.
 */
export function provisionWebhookSecret(id: string): Promise<WebhookSecretResult> {
  return apiFetch(`/api/triggers/${encodeURIComponent(id)}/webhook-secret`, {
    method: 'POST',
    schema: WebhookSecretResultSchema,
  });
}
