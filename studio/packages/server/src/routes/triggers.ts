import type { FastifyPluginAsync } from 'fastify';
import { NewTriggerSchema } from '@autonomy-studio/shared';
import {
  createTrigger,
  deleteTrigger,
  getTrigger,
  listTriggers,
  updateTrigger,
} from '../repo/index.js';
import { NotFoundError } from '../errors.js';
import { requireOwned } from './util.js';

/** `ownerId` is stamped from `request.principal`, never client-supplied. */
const TriggerWriteBodySchema = NewTriggerSchema.omit({ ownerId: true });

export const triggersRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.post('/api/triggers', async (request, reply) => {
    const body = TriggerWriteBodySchema.parse(request.body);
    const created = createTrigger(db, { ...body, ownerId: request.principal.ownerId });
    reply.status(201).send(created);
  });

  fastify.get('/api/triggers', async (request) => {
    // `listTriggers` only supports filtering by `pipelineVersionId` at the
    // repo layer (no `ownerId` column filter there) — owner scoping is
    // applied here, same as `runs.ts`.
    return listTriggers(db).filter((trigger) => trigger.ownerId === request.principal.ownerId);
  });

  fastify.get<{ Params: { id: string } }>('/api/triggers/:id', async (request) => {
    return requireOwned(
      getTrigger(db, request.params.id),
      request.principal,
      'trigger',
      request.params.id,
    );
  });

  fastify.patch<{ Params: { id: string } }>('/api/triggers/:id', async (request) => {
    const existing = requireOwned(
      getTrigger(db, request.params.id),
      request.principal,
      'trigger',
      request.params.id,
    );
    const body = TriggerWriteBodySchema.partial().parse(request.body);
    const updated = updateTrigger(db, existing.id, body);
    if (!updated) throw new NotFoundError('trigger', existing.id);
    return updated;
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
};
