import type { FastifyPluginAsync } from 'fastify';
import {
  SecretPublicSchema,
  SecretRotateBodySchema,
  SecretWriteBodySchema,
  type Secret,
} from '@autonomy-studio/shared';
import {
  createSecret,
  deleteSecret,
  getSecret,
  listNamedSecretsPage,
  updateSecretCiphertext,
} from '../repo/index.js';
import { newId } from '../repo/ids.js';
import { encrypt } from '../secrets/secrets.js';
import { NotFoundError } from '../errors.js';
import { pageArgsFromQuery, requireOwned } from './util.js';

/**
 * item 7 / S1 — the SOURCE. A STANDALONE, name-addressable secret, decoupled
 * from any connection binding, so F15's `{ "$secret": "<name>" }` sink (S2) has
 * something to reference. Spec: `studio/docs/2026-07-16-foundation-unified-secret-model.md`.
 *
 * The write body this route parses is `SecretWriteBodySchema`, which lives in
 * `@autonomy-studio/shared` (#1060) so the Secrets form parses the SAME object
 * rather than a copy of it — the boundary rules (strict, bounded, non-blank and
 * already-trimmed name) and the reasons for them travel with the schema there.
 */
function toPublic(secret: Secret) {
  return SecretPublicSchema.parse(secret);
}

export const secretsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db, masterKey } = fastify;

  fastify.post('/api/secrets', async (request, reply) => {
    const { name, secret } = SecretWriteBodySchema.parse(request.body);

    // Encrypt BEFORE any DB touch; the plaintext is never stored, returned, or
    // logged (mirrors the connection-secret discipline). A duplicate
    // `(owner_id, name)` is refused by the DB UNIQUE index and surfaces as a
    // 409 via the shared `SQLITE_CONSTRAINT` handler — no read-then-write
    // pre-check (which would race).
    const ciphertext = await encrypt(secret, masterKey);
    const created = createSecret(db, {
      ref: newId('secref'),
      ciphertext,
      ownerId: request.principal.ownerId,
      name,
    });
    reply.status(201).send(toPublic(created));
  });

  fastify.get('/api/secrets', async (request) => {
    // #534 — keyset-paginated envelope `{ items, nextCursor }`; each item is the
    // public projection (no ciphertext/ref), `nextCursor` opaque.
    const page = listNamedSecretsPage(
      db,
      request.principal.ownerId,
      pageArgsFromQuery(request.query),
    );
    return { items: page.items.map(toPublic), nextCursor: page.nextCursor };
  });

  /**
   * #1061 — ROTATION, in place. Replacing a standalone secret's value used to
   * mean DELETE + POST, and between those two calls the name resolved to
   * nothing: every node dispatching in that window failed with `secret
   * '<name>' not found` (`run/executor.ts`), which a scheduled trigger firing
   * mid-rotation would hit. This route closes the window by re-encrypting
   * under the row's existing `id`/`ref`/`name` — exactly what `PATCH
   * /api/connections/:id` has always done for a connection-owned secret, via
   * the same `updateSecretCiphertext` repo function.
   *
   * The body carries `secret` and NOTHING else. Renaming is not merely
   * unimplemented, it is refused: the name is the key every stored
   * `{ "$secret": "<name>" }` marker resolves through, and a pipeline version
   * is immutable, so a rename would strand those markers with no way to repair
   * the version holding them. Because the name cannot move, a rotation needs
   * no revalidation of any stored pipeline version — the property to preserve
   * if this body is ever widened.
   */
  fastify.patch<{ Params: { id: string } }>('/api/secrets/:id', async (request) => {
    // Ownership first, mirroring `PATCH /api/connections/:id`. Same two gates
    // as DELETE below, for the same reasons: `requireOwned` is the real
    // authorization check, and the `name === null` guard keeps this route to
    // STANDALONE secrets — a connection's secret is managed only through its
    // connection, never sideways by id.
    const existing = requireOwned(
      getSecret(db, request.params.id),
      request.principal,
      'secret',
      request.params.id,
    );
    if (existing.name === null) throw new NotFoundError('secret', request.params.id);

    const { secret } = SecretRotateBodySchema.parse(request.body);

    // Encrypt BEFORE the DB touch, as POST does — the plaintext is never
    // stored, returned, or logged.
    const ciphertext = await encrypt(secret, masterKey);
    const updated = updateSecretCiphertext(db, existing.id, ciphertext);
    // `null` means the row vanished between the read above and this write (a
    // concurrent DELETE). Report it as the 404 it is; never report a write
    // that did not land as a success.
    if (!updated) throw new NotFoundError('secret', request.params.id);

    return toPublic(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/api/secrets/:id', async (request, reply) => {
    // `requireOwned` (owner-scope) is the real authorization gate: a
    // connection-owned secret carries `ownerId = null`, so it can never match
    // `principal.ownerId` and is already invisible here. The `name === null`
    // guard is belt-and-braces — it keeps this route to STANDALONE secrets even
    // if a future connection-owned secret were ever stamped with an owner.
    const secret = requireOwned(
      getSecret(db, request.params.id),
      request.principal,
      'secret',
      request.params.id,
    );
    if (secret.name === null) throw new NotFoundError('secret', request.params.id);

    deleteSecret(db, secret.id);
    reply.status(204).send();
  });
};
