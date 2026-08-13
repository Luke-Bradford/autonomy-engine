import { z } from 'zod';
import {
  SecretPublicSchema,
  SecretRotateBodySchema,
  SecretWriteBodySchema,
  paginatedResponseSchema,
  type SecretRotateBody,
  type SecretWriteBody,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';
import { fetchAllPages, pageQuery } from './pagination';

/**
 * #1060 — the client half of the standalone secret vault (item 7 / S1). The
 * write body is the SAME schema the route parses, imported from shared rather
 * than re-derived, so the form's validation cannot drift from the server's
 * (the `TriggerWriteSchema` precedent).
 *
 * SECURITY: every response here is `SecretPublic`, which omits `ciphertext`
 * AND the opaque `ref`. A secret value travels in exactly one direction — INTO
 * the server, via `createSecret` (a new value) or `rotateSecret` (a
 * replacement) — and no function in this module can return one.
 */
export const SecretWriteSchema = SecretWriteBodySchema;
export type SecretWrite = SecretWriteBody;

/** The rotate body (#1061): a value and nothing else. Derived server-side from
 *  `SecretWriteBodySchema`, so the length bound cannot fork from create's; see
 *  its docblock in `shared` for why `name` is refused rather than ignored. */
export const SecretRotateSchema = SecretRotateBodySchema;
export type SecretRotate = SecretRotateBody;

/**
 * The list row. `SecretPublicSchema.name` is `string | null` because the SAME
 * schema also describes CONNECTION-owned secrets, which have no name and are
 * addressed only by their opaque `ref`.
 *
 * `GET /api/secrets` cannot return one — `listNamedSecretsPage` filters on
 * `isNotNull(secrets.name)` (`packages/server/src/repo/secrets.ts`) — so this
 * narrows `name` to non-null at the client boundary rather than carrying a
 * null the page would have to render around. It is a real parse, not a cast:
 * were the server ever to break that filter, the list FAILS loudly instead of
 * rendering a nameless row with a Delete button the route would refuse
 * anyway (`DELETE /api/secrets/:id` 404s a `name === null` row on purpose).
 */
const NamedSecretSchema = SecretPublicSchema.extend({ name: z.string().min(1) });
export type NamedSecret = z.infer<typeof NamedSecretSchema>;

const SecretPageSchema = paginatedResponseSchema(NamedSecretSchema);

/**
 * Owner-scoped list of standalone secrets. Keyset-paginated server-side
 * (#534); this walks every page and returns the full list, the same
 * `Promise<T[]>` contract every other list wrapper here presents.
 */
export function listSecrets(signal?: AbortSignal): Promise<NamedSecret[]> {
  return fetchAllPages((cursor) =>
    apiFetch(`/api/secrets${pageQuery(cursor)}`, { schema: SecretPageSchema, signal }),
  );
}

/**
 * Creates a standalone secret. The plaintext is encrypted server-side before
 * any DB touch and is never stored, returned or logged; the response is the
 * public projection.
 *
 * A duplicate name is a 409 — uniqueness is `UNIQUE(owner_id, name COLLATE
 * NOCASE)` (#533), so a case-variant of an existing name conflicts too. To
 * replace an EXISTING name's value, use `rotateSecret` rather than creating a
 * second one.
 */
export function createSecret(body: SecretWrite): Promise<NamedSecret> {
  return apiFetch('/api/secrets', { method: 'POST', body, schema: NamedSecretSchema });
}

/**
 * Replaces a secret's value IN PLACE (#1061), keeping its id, name and the
 * opaque ref every stored `{ "$secret": "<name>" }` marker resolves through.
 *
 * This is not sugar over delete-then-create: those two calls leave a window in
 * which the name resolves to nothing, and a node dispatching inside it fails
 * with `secret '<name>' not found`. Rotation has no such window. The name is
 * deliberately not part of the body — the route refuses one with a 400, since
 * renaming would strand every marker naming the old value.
 */
export function rotateSecret(id: string, body: SecretRotate): Promise<NamedSecret> {
  return apiFetch(`/api/secrets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: NamedSecretSchema,
  });
}

export function deleteSecret(id: string): Promise<void> {
  return apiFetch<void>(`/api/secrets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
