import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { SecretPublicSchema, type Secret } from '@autonomy-studio/shared';
import { createSecret, deleteSecret, getSecret, listNamedSecrets } from '../repo/index.js';
import { newId } from '../repo/ids.js';
import { encrypt } from '../secrets/secrets.js';
import { NotFoundError } from '../errors.js';
import { requireOwned } from './util.js';

/**
 * item 7 / S1 — the SOURCE. A STANDALONE, name-addressable secret, decoupled
 * from any connection binding, so F15's `{ "$secret": "<name>" }` sink (S2) has
 * something to reference. Spec: `studio/docs/2026-07-16-foundation-unified-secret-model.md`.
 *
 * The client-facing write body: a user-chosen `name` + the plaintext `secret`.
 * `ownerId` is stamped from `request.principal` (never client-supplied) and
 * `ref` (the opaque machine handle) is minted server-side — a client sets
 * neither. `.strict()` so an unexpected field is a 400 at the boundary. This
 * is intentionally STRICTER than `ConnectionWriteBodySchema` (which is not
 * strict): a secret write is the highest-stakes boundary here, so a client
 * attempt to smuggle `ownerId`/`ref` is rejected loudly rather than silently
 * dropped — no reason to be lenient about unknown keys on this route.
 */
// Upper bounds so a client cannot submit an unbounded payload to be encrypted
// and stored. `name` is a short human-chosen identifier; `secret` is generous
// enough for any realistic credential (an RSA-4096 PEM is ~3.2 KB, a full cert
// chain a few KB more) while still capping the encrypt-and-store cost.
const MAX_SECRET_NAME_LEN = 255;
const MAX_SECRET_VALUE_LEN = 16384;

const SecretWriteBodySchema = z
  .object({
    // The name is a lookup KEY — F15's `{ "$secret": "<name>" }` sink resolves
    // by it (case-insensitively per #533: `UNIQUE(owner_id, name COLLATE
    // NOCASE)`, so a case-variant is a 409), and it is listed/deleted by it. So
    // it must be non-blank AND already trimmed: a whitespace-only name (`" "`
    // passes `min(1)`) or one with leading/trailing whitespace (`"key "` vs
    // `"key"`) is a silent lookup footgun that ASCII case-folding does NOT
    // cover. Reject it loudly at the boundary rather than mutating the client's
    // input by trimming.
    name: z
      .string()
      .min(1)
      .max(MAX_SECRET_NAME_LEN)
      .refine((s) => s.trim() === s && s.length > 0, {
        message: 'name must not be blank or have leading/trailing whitespace',
      }),
    secret: z.string().min(1).max(MAX_SECRET_VALUE_LEN),
  })
  .strict();

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
    return listNamedSecrets(db, request.principal.ownerId).map(toPublic);
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
