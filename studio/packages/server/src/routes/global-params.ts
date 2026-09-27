import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  GlobalParamCreateBodySchema,
  GlobalParamPatchBodySchema,
  GlobalParamValueSchema,
  type GlobalParam,
} from '@autonomy-studio/shared';
import {
  createGlobalParam,
  deleteGlobalParam,
  getGlobalParam,
  listGlobalParamsPage,
  updateGlobalParam,
} from '../repo/index.js';
import { globalParamUsage } from '../repo/global-param-usage.js';
import { NotFoundError } from '../errors.js';
import { pageArgsFromQuery, requireOwned } from './util.js';

/**
 * #844 GL1 — the global-params store's REST surface (spec
 * `studio/docs/2026-09-27-foundation-global-params.md` GL-D1/GL-D7). Pipelines
 * read a global as `${global.<name>}` (GL3); the `usage` route answers from the
 * reads each version recorded when it was saved.
 *
 * Security model: every by-id route passes `requireOwned`, so another owner's
 * global and a missing one are the same 404. The list is owner-scoped in SQL.
 * Values are cleartext configuration (GL-D5), so they are returned as stored.
 */
export const globalParamsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  function requireOwnedGlobalParam(
    request: FastifyRequest<{ Params: { id: string } }>,
  ): GlobalParam {
    return requireOwned(
      getGlobalParam(db, request.params.id),
      request.principal,
      'global parameter',
      request.params.id,
    );
  }

  fastify.get('/api/global-params', async (request) => {
    const page = listGlobalParamsPage(
      db,
      request.principal.ownerId,
      pageArgsFromQuery(request.query),
    );
    return { items: page.items, nextCursor: page.nextCursor };
  });

  fastify.post('/api/global-params', async (request, reply) => {
    const body = GlobalParamCreateBodySchema.parse(request.body);
    // A case-variant duplicate is refused by the DB's NOCASE unique index and
    // surfaces as a 409 via the shared `SQLITE_CONSTRAINT` handler — no
    // read-then-write pre-check, which would race.
    const created = createGlobalParam(db, { ...body, ownerId: request.principal.ownerId });
    reply.status(201).send(created);
  });

  /**
   * `value` and `description` only; `.strict()` refuses `name` and `type`
   * (immutable, GL-D1). Ownership first, then the body, as `PATCH
   * /api/secrets/:id` does. The value is checked against the STORED type.
   */
  fastify.patch<{ Params: { id: string } }>('/api/global-params/:id', async (request) => {
    const existing = requireOwnedGlobalParam(request);
    const patch = GlobalParamPatchBodySchema.parse(request.body);
    if (patch.value !== undefined) {
      GlobalParamValueSchema.parse({ type: existing.type, value: patch.value });
    }
    const updated = updateGlobalParam(db, existing.id, patch);
    if (!updated) throw new NotFoundError('global parameter', existing.id);
    return updated;
  });

  /**
   * #844 GL3 (GL-D4) — what reads this global: the pipelines whose latest
   * version reads it, and the triggers whose pinned version does. Advisory, for
   * the delete confirmation; it never gates the delete.
   */
  fastify.get<{ Params: { id: string } }>('/api/global-params/:id/usage', async (request) => {
    const existing = requireOwnedGlobalParam(request);
    return globalParamUsage(db, existing.ownerId, existing.name);
  });

  /**
   * Allowed even when a pipeline reads the global (GL-D4): versions are
   * immutable, so blocking on every version that ever read it would make it
   * undeletable. A new run of such a version is refused at start (GL3).
   */
  fastify.delete<{ Params: { id: string } }>('/api/global-params/:id', async (request, reply) => {
    const existing = requireOwnedGlobalParam(request);
    deleteGlobalParam(db, existing.id);
    reply.status(204).send();
  });
};
