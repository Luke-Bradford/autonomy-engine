import type { FastifyPluginAsync } from 'fastify';
import { NewTriggerSchema, TriggerPublicSchema, type Trigger } from '@autonomy-studio/shared';
import {
  createTrigger,
  deleteTrigger,
  getPipeline,
  getPipelineVersion,
  getTrigger,
  listTriggers,
  updateTrigger,
} from '../repo/index.js';
import { NotFoundError } from '../errors.js';
import { requireOwned } from './util.js';
import { exportTrigger } from '../portability/index.js';
import type { Principal } from '../auth/principal.js';
import type { Db } from '../repo/types.js';

/** `ownerId` is stamped from `request.principal`, never client-supplied. */
const TriggerWriteBodySchema = NewTriggerSchema.omit({ ownerId: true });

function toPublic(trigger: Trigger) {
  return TriggerPublicSchema.parse(trigger);
}

/**
 * Closes the cross-owner reference seam on a trigger's `pipelineVersionId`:
 * the DB's FK on `triggers.pipeline_version_id` only proves the row EXISTS,
 * not that the caller owns it — a client could otherwise bind a trigger to
 * someone else's pipeline version, and the `201` (owned/valid) vs `409`
 * (missing, FK violation) split would let them probe which version ids
 * exist. Resolving version -> pipeline and running it through the same
 * `requireOwned` used everywhere else collapses "doesn't exist" and "exists
 * but isn't yours" into the same 404, matching every other resource in this
 * API (see `util.ts`).
 *
 * `null` (an unbound trigger — see `TriggerSchema.pipelineVersionId`) is
 * always a no-op here: there is nothing to own-check, and creating/patching a
 * trigger to `null` is always allowed regardless of who's asking.
 */
function requireOwnedPipelineVersion(
  db: Db,
  pipelineVersionId: string | null,
  principal: Principal,
): void {
  if (pipelineVersionId === null) return;
  const version = getPipelineVersion(db, pipelineVersionId);
  if (!version) throw new NotFoundError('pipelineVersion', pipelineVersionId);
  requireOwned(
    getPipeline(db, version.pipelineId),
    principal,
    'pipelineVersion',
    pipelineVersionId,
  );
}

export const triggersRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.post('/api/triggers', async (request, reply) => {
    const body = TriggerWriteBodySchema.parse(request.body);
    requireOwnedPipelineVersion(db, body.pipelineVersionId, request.principal);
    const created = createTrigger(db, { ...body, ownerId: request.principal.ownerId });
    reply.status(201).send(toPublic(created));
  });

  fastify.get('/api/triggers', async (request) => {
    return listTriggers(db, { ownerId: request.principal.ownerId }).map(toPublic);
  });

  fastify.get<{ Params: { id: string } }>('/api/triggers/:id', async (request) => {
    const row = requireOwned(
      getTrigger(db, request.params.id),
      request.principal,
      'trigger',
      request.params.id,
    );
    return toPublic(row);
  });

  fastify.patch<{ Params: { id: string } }>('/api/triggers/:id', async (request) => {
    const existing = requireOwned(
      getTrigger(db, request.params.id),
      request.principal,
      'trigger',
      request.params.id,
    );
    const body = TriggerWriteBodySchema.partial().parse(request.body);
    if (body.pipelineVersionId !== undefined) {
      requireOwnedPipelineVersion(db, body.pipelineVersionId, request.principal);
    }
    const updated = updateTrigger(db, existing.id, body);
    if (!updated) throw new NotFoundError('trigger', existing.id);
    return toPublic(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/api/triggers/:id', async (request, reply) => {
    const existing = requireOwned(
      getTrigger(db, request.params.id),
      request.principal,
      'trigger',
      request.params.id,
    );
    deleteTrigger(db, existing.id);
    reply.status(204).send();
  });

  // Version-stamped JSON export (P1c). `exportTrigger` does its own
  // owner-check (404 if not owned), same outcome as `requireOwned` above.
  fastify.get<{ Params: { id: string } }>('/api/triggers/:id/export', async (request) => {
    return exportTrigger(db, request.params.id, request.principal.ownerId);
  });
};
