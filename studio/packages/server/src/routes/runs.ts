import type { FastifyPluginAsync } from 'fastify';
import { getRun, listRunEvents, listRuns } from '../repo/index.js';
import { requireOwned } from './util.js';

/**
 * READ-ONLY: runs are created by the engine/scheduler in later phases (P2-P4)
 * — there is deliberately no `POST /api/runs` here.
 */
export const runsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.get<{
    Querystring: { pipelineVersionId?: string; triggerId?: string; parentRunId?: string };
  }>('/api/runs', async (request) => {
    const { pipelineVersionId, triggerId, parentRunId } = request.query;
    // `listRuns`'s filter doesn't support `ownerId` at the repo layer —
    // owner scoping is applied here, same as `triggers.ts`.
    return listRuns(db, { pipelineVersionId, triggerId, parentRunId }).filter(
      (run) => run.ownerId === request.principal.ownerId,
    );
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
