import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { getRun, listRunEvents, listRuns } from '../repo/index.js';
import { requireOwned } from './util.js';

/**
 * `pipelineVersionId`/`triggerId`/`parentRunId` are opaque ids, not
 * fielded/typed values — validated only for shape (non-empty strings) before
 * they reach the repo layer, same discipline every request-body route
 * already applies via a Zod schema.
 */
const ListRunsQuerystringSchema = z.object({
  pipelineVersionId: z.string().min(1).optional(),
  triggerId: z.string().min(1).optional(),
  parentRunId: z.string().min(1).optional(),
});

/**
 * READ-ONLY: runs are created by the engine/scheduler in later phases (P2-P4)
 * — there is deliberately no `POST /api/runs` here.
 */
export const runsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.get('/api/runs', async (request) => {
    const { pipelineVersionId, triggerId, parentRunId } = ListRunsQuerystringSchema.parse(
      request.query,
    );
    return listRuns(db, {
      pipelineVersionId,
      triggerId,
      parentRunId,
      ownerId: request.principal.ownerId,
    });
  });

  fastify.get<{ Params: { id: string } }>('/api/runs/:id', async (request) => {
    return requireOwned(getRun(db, request.params.id), request.principal, 'run', request.params.id);
  });

  fastify.get<{ Params: { id: string } }>('/api/runs/:id/events', async (request) => {
    const run = requireOwned(
      getRun(db, request.params.id),
      request.principal,
      'run',
      request.params.id,
    );
    return listRunEvents(db, run.id);
  });
};
