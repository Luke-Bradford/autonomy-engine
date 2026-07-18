import type { FastifyPluginAsync } from 'fastify';
import {
  NewPipelineSchema,
  NewPipelineVersionSchema,
  computeRunCost,
  rollupPipelineCost,
} from '@autonomy-studio/shared';
import {
  createPipeline,
  createPipelineVersion,
  deletePipeline,
  getPipeline,
  listMeteredEventsForPipeline,
  listPipelineVersions,
  listPipelinesPage,
  listRunsForPipeline,
  updatePipeline,
} from '../repo/index.js';
import { NotFoundError } from '../errors.js';
import { pageArgsFromQuery, requireOwned } from './util.js';
import { exportPipeline } from '../portability/index.js';

/** `ownerId` is stamped from `request.principal`, never client-supplied. */
const PipelineWriteBodySchema = NewPipelineSchema.omit({ ownerId: true });

/** `pipelineId` comes from the `:id` route param, never the body. */
const PipelineVersionWriteBodySchema = NewPipelineVersionSchema.omit({ pipelineId: true });

export const pipelinesRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.post('/api/pipelines', async (request, reply) => {
    const body = PipelineWriteBodySchema.parse(request.body);
    const created = createPipeline(db, { ...body, ownerId: request.principal.ownerId });
    reply.status(201).send(created);
  });

  fastify.get('/api/pipelines', async (request) => {
    // #534 — keyset-paginated envelope `{ items, nextCursor }`.
    return listPipelinesPage(db, request.principal.ownerId, pageArgsFromQuery(request.query));
  });

  fastify.get<{ Params: { id: string } }>('/api/pipelines/:id', async (request) => {
    return requireOwned(
      getPipeline(db, request.params.id),
      request.principal,
      'pipeline',
      request.params.id,
    );
  });

  fastify.patch<{ Params: { id: string } }>('/api/pipelines/:id', async (request) => {
    const existing = requireOwned(
      getPipeline(db, request.params.id),
      request.principal,
      'pipeline',
      request.params.id,
    );
    const body = PipelineWriteBodySchema.partial().parse(request.body);
    const updated = updatePipeline(db, existing.id, body);
    if (!updated) throw new NotFoundError('pipeline', existing.id);
    return updated;
  });

  fastify.delete<{ Params: { id: string } }>('/api/pipelines/:id', async (request, reply) => {
    const existing = requireOwned(
      getPipeline(db, request.params.id),
      request.principal,
      'pipeline',
      request.params.id,
    );
    // Throws `PipelineHasRunsError` (mapped to 409 by the global error
    // handler) when the pipeline has run history — see `repo/pipelines.ts`.
    deletePipeline(db, existing.id);
    reply.status(204).send();
  });

  fastify.post<{ Params: { id: string } }>(
    '/api/pipelines/:id/versions',
    async (request, reply) => {
      const pipeline = requireOwned(
        getPipeline(db, request.params.id),
        request.principal,
        'pipeline',
        request.params.id,
      );
      const body = PipelineVersionWriteBodySchema.parse(request.body);
      const created = createPipelineVersion(db, { ...body, pipelineId: pipeline.id });
      reply.status(201).send(created);
    },
  );

  fastify.get<{ Params: { id: string } }>('/api/pipelines/:id/versions', async (request) => {
    const pipeline = requireOwned(
      getPipeline(db, request.params.id),
      request.principal,
      'pipeline',
      request.params.id,
    );
    return listPipelineVersions(db, pipeline.id);
  });

  fastify.get<{ Params: { id: string; v: string } }>(
    '/api/pipelines/:id/versions/:v',
    async (request) => {
      const pipeline = requireOwned(
        getPipeline(db, request.params.id),
        request.principal,
        'pipeline',
        request.params.id,
      );
      const versionNumber = Number(request.params.v);
      const version = Number.isInteger(versionNumber)
        ? listPipelineVersions(db, pipeline.id).find((v) => v.version === versionNumber)
        : undefined;
      if (!version) throw new NotFoundError('pipeline version', request.params.v);
      return version;
    },
  );

  /**
   * #2 L6 — the per-PIPELINE cost rollup: SUMS `costEstimate` across EVERY run of
   * the pipeline (all versions). Two indexed queries — the run set (for
   * `runCount`, incl. zero-cost runs) + all their `activity.metered` events —
   * folded per-run through `computeRunCost` then `rollupPipelineCost`, the shared
   * SSOT. Fail-closed: an unpriced/unknown response leaves the rollup
   * `complete:false` (and its run counted in `incompleteRunCount`); the total is
   * an honest lower bound, never manufactured-0-padded.
   *
   * Owner-scoped in TWO places (authentication ≠ authorization): `requireOwned`
   * on the pipeline, AND the run/event queries filter on the RUNS' own
   * `owner_id` — defense in depth, never trusting that every run under the
   * pipeline shares its owner.
   *
   * NOTE (scope): this is the API/projection half of "→ Monitor". Rendering the
   * cost in the run/pipeline monitor UI is deferred to the U-series UI epic
   * (#439), which carries the mandatory browser-verify gate.
   */
  fastify.get<{ Params: { id: string } }>('/api/pipelines/:id/cost', async (request) => {
    const pipeline = requireOwned(
      getPipeline(db, request.params.id),
      request.principal,
      'pipeline',
      request.params.id,
    );
    const ownerId = request.principal.ownerId;
    const pipelineRuns = listRunsForPipeline(db, pipeline.id, ownerId);
    const meteredEvents = listMeteredEventsForPipeline(db, pipeline.id, ownerId);

    // Group the (already metered-only) events by run so each run's completeness
    // is computed independently — a run with no metered events folds to a
    // complete $0 (it is still in `pipelineRuns`, so it counts toward `runCount`).
    const eventsByRun = new Map<string, typeof meteredEvents>();
    for (const event of meteredEvents) {
      const bucket = eventsByRun.get(event.runId);
      if (bucket) bucket.push(event);
      else eventsByRun.set(event.runId, [event]);
    }

    return rollupPipelineCost(
      pipelineRuns.map((run) => computeRunCost(eventsByRun.get(run.id) ?? [])),
    );
  });

  // Deliberately NO update/delete route for a specific version: PipelineVersion
  // is immutable once written (see `repo/pipeline-versions.ts` — the module
  // exports no `updatePipelineVersion`/delete at all). A new version is
  // always a new POST to `.../versions`.

  // Version-stamped JSON export (P1c), the pipeline + ALL of its versions.
  // `exportPipeline` does its own owner-check (404 if not owned), same
  // outcome as `requireOwned` above.
  fastify.get<{ Params: { id: string } }>('/api/pipelines/:id/export', async (request) => {
    return exportPipeline(db, request.params.id, request.principal.ownerId);
  });
};
