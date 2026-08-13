import type { FastifyPluginAsync } from 'fastify';
import { SecretPublicSchema, SecretWriteBodySchema, type Secret } from '@autonomy-studio/shared';
import { createSecret, deleteSecret, getSecret, listNamedSecretsPage } from '../repo/index.js';
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
