import { z } from 'zod';
import {
  ConnectionPublicSchema,
  NewConnectionSchema,
  type ConnectionPublic,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';

/**
 * The client-facing write body, reconstructed to match the server's local
 * `ConnectionWriteBodySchema` (`packages/server/src/routes/connections.ts`)
 * EXACTLY: everything `NewConnectionSchema` needs except `ownerId` (stamped
 * server-side from the principal) and `secretRef` (an internal FK), plus an
 * OPTIONAL plaintext `secret` that the server encrypts into a `secrets` row.
 * Deriving it from the same shared `NewConnectionSchema` keeps the form's
 * client-side validation identical to the server's — one source of truth.
 */
export const ConnectionWriteSchema = NewConnectionSchema.omit({
  ownerId: true,
  secretRef: true,
}).extend({
  secret: z.string().min(1).optional(),
});
export type ConnectionWrite = z.input<typeof ConnectionWriteSchema>;

const ConnectionListSchema = z.array(ConnectionPublicSchema);

/** Owner-scoped list of connections (secrets never present — `ConnectionPublic`). */
export function listConnections(signal?: AbortSignal): Promise<ConnectionPublic[]> {
  return apiFetch('/api/connections', { schema: ConnectionListSchema, signal });
}

export function createConnection(body: ConnectionWrite): Promise<ConnectionPublic> {
  return apiFetch('/api/connections', {
    method: 'POST',
    body,
    schema: ConnectionPublicSchema,
  });
}

/**
 * PATCH is partial: only the supplied fields change. Passing `secret` rotates
 * the ciphertext in place under the connection's stable `secretRef`; omitting
 * it leaves the existing secret untouched (never cleared by accident).
 */
export function updateConnection(
  id: string,
  body: Partial<ConnectionWrite>,
): Promise<ConnectionPublic> {
  return apiFetch(`/api/connections/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: ConnectionPublicSchema,
  });
}

export function deleteConnection(id: string): Promise<void> {
  return apiFetch<void>(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
