import { z } from 'zod';
import {
  FireResultSchema,
  NewTriggerSchema,
  TriggerPublicSchema,
  type FireResult,
  type TriggerPublic,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';

/**
 * The client-facing write body, matching the server's local
 * `TriggerWriteBodySchema` (`packages/server/src/routes/triggers.ts`) EXACTLY:
 * `NewTriggerSchema` minus `ownerId` (stamped server-side from the principal).
 * Deriving it from the same shared `NewTriggerSchema` keeps the form's
 * client-side validation identical to the server's — one source of truth,
 * including the cross-field concurrency rule (`ConcurrencyWriteSchema`:
 * `parallel` requires `max`, single-slot policies forbid it).
 */
export const TriggerWriteSchema = NewTriggerSchema.omit({ ownerId: true });
export type TriggerWrite = z.input<typeof TriggerWriteSchema>;

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

export function createTrigger(body: TriggerWrite): Promise<TriggerPublic> {
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
