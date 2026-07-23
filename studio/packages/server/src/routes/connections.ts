import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  ConnectionPublicSchema,
  NewConnectionSchema,
  canonicalStringify,
  type Connection,
} from '@autonomy-studio/shared';
import {
  createConnection,
  createSecret,
  deleteConnection,
  deleteSecret,
  getConnection,
  getSecretByRef,
  listConnectionsPage,
  updateConnection,
  updateSecretCiphertext,
} from '../repo/index.js';
import { newId } from '../repo/ids.js';
import { encrypt } from '../secrets/secrets.js';
import { NotFoundError } from '../errors.js';
import { pageArgsFromQuery, requireOwned } from './util.js';
import { exportConnection } from '../portability/index.js';

/**
 * The client-facing write body: everything `NewConnectionSchema` needs
 * EXCEPT `ownerId` (stamped from `request.principal`, never client-supplied
 * — see the auth seam) and `secretRef` (an internal FK to the `secrets`
 * table; a client can never set it directly). In its place, an OPTIONAL
 * plaintext `secret` — encrypted server-side into a `secrets` row before
 * anything touches the DB.
 */
const ConnectionWriteBodySchema = NewConnectionSchema.omit({
  ownerId: true,
  secretRef: true,
  parameters: true,
}).extend({
  secret: z.string().min(1).optional(),
  /**
   * #2 L13b — re-declared WITHOUT `ConnectionSchema`'s `.default([])`, and the
   * difference is load-bearing: Zod applies a `.default()` even through the
   * PATCH handler's `.partial()` (a recorded repo gotcha), so inheriting it
   * would turn EVERY patch that omits `parameters` — e.g. the web form's
   * rename, which sends only `{name, kind, config}` — into a silent reset of
   * the stored allowlist to `[]`, permanently failing every pipeline bound to
   * those parameters. `.optional()` leaves the key ABSENT when the body omits
   * it, so `updateConnection`'s spread preserves the stored value; the CREATE
   * path gets `[]` from `NewConnectionSchema`'s own default inside
   * `createConnection`.
   */
  parameters: z.array(z.string().min(1)).optional(),
});

function toPublic(connection: Connection) {
  return ConnectionPublicSchema.parse(connection);
}

export const connectionsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db, masterKey } = fastify;

  fastify.post('/api/connections', async (request, reply) => {
    const { secret, ...rest } = ConnectionWriteBodySchema.parse(request.body);

    let secretRef: string | null = null;
    if (secret !== undefined) {
      const ciphertext = await encrypt(secret, masterKey);
      const secretRow = createSecret(db, { ref: newId('secref'), ciphertext });
      secretRef = secretRow.ref;
    }

    const created = createConnection(db, {
      ...rest,
      ownerId: request.principal.ownerId,
      secretRef,
    });
    reply.status(201).send(toPublic(created));
  });

  fastify.get('/api/connections', async (request) => {
    // #534 — keyset-paginated envelope `{ items, nextCursor }`; the public
    // projection is applied per item, `nextCursor` passes through opaque.
    const page = listConnectionsPage(
      db,
      request.principal.ownerId,
      pageArgsFromQuery(request.query),
    );
    return { items: page.items.map(toPublic), nextCursor: page.nextCursor };
  });

  fastify.get<{ Params: { id: string } }>('/api/connections/:id', async (request) => {
    const row = requireOwned(
      getConnection(db, request.params.id),
      request.principal,
      'connection',
      request.params.id,
    );
    return toPublic(row);
  });

  fastify.patch<{ Params: { id: string } }>('/api/connections/:id', async (request) => {
    const existing = requireOwned(
      getConnection(db, request.params.id),
      request.principal,
      'connection',
      request.params.id,
    );
    const { secret, ...rest } = ConnectionWriteBodySchema.partial().parse(request.body);

    let secretRef = existing.secretRef;
    if (secret !== undefined) {
      const ciphertext = await encrypt(secret, masterKey);
      const existingSecret = existing.secretRef ? getSecretByRef(db, existing.secretRef) : null;
      if (existingSecret) {
        // Rotate the ciphertext IN PLACE, under the same stable `ref` — the
        // connection's `secretRef` never changes on a rotation.
        updateSecretCiphertext(db, existingSecret.id, ciphertext);
      } else {
        // No secret existed yet (or the ref was somehow dangling, which the
        // FK should prevent) — mint a brand-new one.
        const created = createSecret(db, { ref: newId('secref'), ciphertext });
        secretRef = created.ref;
      }
    }

    const updated = updateConnection(db, existing.id, { ...rest, secretRef });
    if (!updated) throw new NotFoundError('connection', existing.id);
    return toPublic(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/api/connections/:id', async (request, reply) => {
    const existing = requireOwned(
      getConnection(db, request.params.id),
      request.principal,
      'connection',
      request.params.id,
    );

    // Order matters: `connections.secret_ref -> secrets.ref` is
    // `ON DELETE RESTRICT`, so the secret row cannot be deleted while this
    // connection still references it. Delete the connection FIRST (which
    // drops the only reference), THEN delete its secret — this is the
    // "delete the secret too" choice (vs. leaving it orphaned): a
    // connection's secret is exclusively its own in this MVP (nothing else
    // ever points at the same `ref`), so nothing else can be left dangling.
    deleteConnection(db, existing.id);
    if (existing.secretRef) {
      const secretRow = getSecretByRef(db, existing.secretRef);
      if (secretRow) deleteSecret(db, secretRow.id);
    }
    reply.status(204).send();
  });

  // Version-stamped JSON export (P1c). `exportConnection` does its own
  // owner-check (404 if not owned) and NEVER includes `secretRef`.
  // #3 G1: canonical-JSON body (see the pipelines export route).
  fastify.get<{ Params: { id: string } }>('/api/connections/:id/export', async (request, reply) => {
    const envelope = exportConnection(db, request.params.id, request.principal.ownerId);
    return reply.type('application/json').send(canonicalStringify(envelope));
  });
};
