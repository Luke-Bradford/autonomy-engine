import { z } from 'zod';
import {
  ConnectionDependentsResponseSchema,
  ConnectionProbeResultSchema,
  ConnectionPublicSchema,
  NewConnectionSchema,
  paginatedResponseSchema,
  type ConnectionDependentsResponse,
  type ConnectionKind,
  type ConnectionProbeResult,
  type ConnectionPublic,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';
import { fetchAllPages, pageQuery } from './pagination';

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
  parameters: true,
}).extend({
  secret: z.string().min(1).optional(),
  /**
   * #2 L13b — mirrors the server body's re-declaration WITHOUT the shared
   * schema's `.default([])`, and for the same load-bearing reason: were the
   * default inherited, `safeParse` would manufacture `parameters: []` on
   * every submit, so an EDIT of any other field would PATCH an explicit `[]`
   * and silently clear the stored allowlist (the server treats explicit `[]`
   * as a deliberate clear — correctly). Omitting the key preserves the stored
   * value, so the form sends it only when the operator changed it (#1305,
   * `allowlistChanged`).
   */
  parameters: z.array(z.string().min(1)).optional(),
});
export type ConnectionWrite = z.input<typeof ConnectionWriteSchema>;

const ConnectionPageSchema = paginatedResponseSchema(ConnectionPublicSchema);

/**
 * Owner-scoped list of connections (secrets never present — `ConnectionPublic`).
 * `GET /api/connections` is keyset-paginated (#534); this walks every page and
 * returns the full list, so callers see the same `Promise<T[]>` as before. The
 * `signal` is threaded through every page fetch, preserving cancellation.
 */
export function listConnections(signal?: AbortSignal): Promise<ConnectionPublic[]> {
  return fetchAllPages((cursor) =>
    apiFetch(`/api/connections${pageQuery(cursor)}`, { schema: ConnectionPageSchema, signal }),
  );
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

/**
 * #1191 — "Test connection". TWO endpoints, chosen by whether a row exists yet,
 * and the split is not incidental.
 *
 * A form being EDITED leaves its secret input blank to mean "keep the stored
 * secret" (see `ConnectionsPage`'s placeholder and its submit path). Probing
 * such a form through the draft endpoint would send no secret at all and report
 * a confident credential failure for every connection that has one — a button
 * that lies. So an edit probes through `:id`, where the server falls back to the
 * stored ciphertext; only a connection with no row yet uses the draft endpoint.
 *
 * The server refuses an `:id` probe whose config overlay would point the STORED
 * secret at a destination the saved row does not name. That refusal arrives as
 * an ordinary `{ok: false, error}` result, not an HTTP error, so it renders in
 * the same place as any other refusal — the form never has to special-case it.
 */
export function testDraftConnection(body: {
  kind: ConnectionKind;
  config: Record<string, unknown>;
  secret?: string;
}): Promise<ConnectionProbeResult> {
  return apiFetch('/api/connections/test', {
    method: 'POST',
    body,
    schema: ConnectionProbeResultSchema,
  });
}

export function testSavedConnection(
  id: string,
  body: { config?: Record<string, unknown>; secret?: string } = {},
): Promise<ConnectionProbeResult> {
  return apiFetch(`/api/connections/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    body,
    schema: ConnectionProbeResultSchema,
  });
}

/**
 * #1211 — which of this owner's enabled triggers a `kind` change or a DELETE
 * would SWITCH OFF, read before the write so the form can say it.
 *
 * A server route rather than a client-side filter, unlike #1174's dataset half.
 * That half could be answered from rows the page already holds because
 * `GET /api/datasets` carries `connectionId`; a trigger row carries only
 * `pipelineVersionId`, and the connection reference lives inside the bound
 * version's node JSON — the same version-crossing edge that made M9's
 * `GET /api/datasets/:id/references` a route.
 */
export function listConnectionDependents(
  id: string,
  signal?: AbortSignal,
): Promise<ConnectionDependentsResponse> {
  return apiFetch(`/api/connections/${encodeURIComponent(id)}/dependents`, {
    schema: ConnectionDependentsResponseSchema,
    signal,
  });
}
