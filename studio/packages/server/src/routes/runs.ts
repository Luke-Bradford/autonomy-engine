import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { getRun, listRunDiagnostics, listRunEvents, listRuns } from '../repo/index.js';
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

  /**
   * #497 — the reducer's EXPLANATIONS for this run: why an edge was ignored, a
   * container child neutralized, a branch inert, or which entities stalled it.
   * Its DECISIONS are `/events` (the durable log); these say why.
   *
   * Owner-scoped through the RUN, exactly as `/events` is: `run_diagnostics`
   * rows carry no `owner_id` of their own, so authorization is checked on the
   * resource that has one. Authentication is not authorization — `request.principal`
   * proves who is asking, `requireOwned` proves they may.
   */
  fastify.get<{ Params: { id: string } }>('/api/runs/:id/diagnostics', async (request) => {
    const run = requireOwned(
      getRun(db, request.params.id),
      request.principal,
      'run',
      request.params.id,
    );
    return listRunDiagnostics(db, run.id);
  });
};
