import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  NewPipelineSchema,
  NewPipelineVersionSchema,
  canonicalStringify,
  rollupFromAggregates,
} from '@autonomy-studio/shared';
import {
  aggregatePipelineCost,
  archivePipeline,
  createPipeline,
  createPipelineVersion,
  deletePipeline,
  getPipeline,
  listPipelineVersions,
  listPipelinesPage,
  updatePipeline,
} from '../repo/index.js';
import { NotFoundError } from '../errors.js';
import { pageArgsFromQuery, requireOwned } from './util.js';
import { exportPipeline } from '../portability/index.js';

/** `ownerId` is stamped from `request.principal`, never client-supplied. */
const PipelineWriteBodySchema = NewPipelineSchema.omit({ ownerId: true });

/**
 * PATCH body: like the write shape but with NO `.default()` on `concurrency` —
 * `.partial()` over a defaulted field still APPLIES the default, so a rename
 * PATCH would silently manufacture `concurrency: null` and clear the cap
 * (#473's shape: an absent fact must never become a value). Absent = preserve;
 * explicit `null` = clear; the positive-int write rule still holds.
 */
const PipelinePatchBodySchema = PipelineWriteBodySchema.extend({
  concurrency: z.number().int().positive().nullable(),
}).partial();

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
    const body = PipelinePatchBodySchema.parse(request.body);
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

  /**
   * #3 G5a (Foundation Spec #3 reshape item ②) — ARCHIVE a pipeline
   * (soft-delete). Unlike DELETE (which hard-deletes and 409s once runs exist),
   * archive PRESERVES the immutable versions + runs, drops the pipeline off the
   * default list, disables every dependent trigger, and bars dispatch (the
   * launcher refuses an archived pipeline). This is the manual counterpart to
   * the G5b import delete-classification, sharing the `archivePipeline` service.
   *
   * Idempotent: archiving an archived pipeline returns 200 with the same shape.
   * `requireOwned` enforces authorization (authentication ≠ authorization); the
   * post-commit `scheduler.sync()` drops the now-disabled triggers' pending
   * wakeups (the composite reconciler — schedule + tumbling).
   */
  fastify.post<{ Params: { id: string } }>('/api/pipelines/:id/archive', async (request) => {
    const existing = requireOwned(
      getPipeline(db, request.params.id),
      request.principal,
      'pipeline',
      request.params.id,
    );
    const result = archivePipeline(db, existing.id);
    // `existing` was owner-checked above, so a null here means it vanished
    // between the read and the archive (a concurrent delete) — surface as 404,
    // never a manufactured success.
    if (!result) throw new NotFoundError('pipeline', existing.id);
    fastify.scheduler.sync();
    return result.pipeline;
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
   * #2 L6 / #599 — the per-PIPELINE cost rollup: SUMS `costEstimate` across EVERY
   * run of the pipeline (all versions). A BOUNDED SQL aggregation
   * (`aggregatePipelineCost`, #599) — a fixed number of scalar queries whose
   * result is O(1), rather than loading every metered event (runs × LLM-calls,
   * unbounded) into memory — then the shared fail-closed SSOT derivation
   * (`rollupFromAggregates`). Fail-closed: a genuine cost gap (an unpriced MODEL, or
   * `meteringStatus:'unknown'` usage) leaves the rollup `complete:false` (and its
   * run counted in `incompleteRunCount`); the total is an honest lower bound, never
   * manufactured-0-padded. #2 L14: a subscription `meteringStatus:'unpriced'`
   * response is NOT a gap — counted separately (`unpricedResponseCount`), it does
   * not flip `complete` or count its run as incomplete.
   *
   * Owner-scoped in TWO places (authentication ≠ authorization): `requireOwned`
   * on the pipeline, AND `aggregatePipelineCost` filters on the RUNS' own
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
    return rollupFromAggregates(aggregatePipelineCost(db, pipeline.id, request.principal.ownerId));
  });

  // Deliberately NO update/delete route for a specific version: PipelineVersion
  // is immutable once written (see `repo/pipeline-versions.ts` — the module
  // exports no `updatePipelineVersion`/delete at all). A new version is
  // always a new POST to `.../versions`.

  // Version-stamped JSON export (P1c), the pipeline + ALL of its versions.
  // `exportPipeline` does its own owner-check (404 if not owned), same
  // outcome as `requireOwned` above. #3 G1: the body is CANONICAL JSON
  // (sorted keys, stable bytes) — identical content downloads as identical
  // bytes, so exports diff cleanly; `.type()` is required, a bare
  // `send(string)` would ship text/plain.
  fastify.get<{ Params: { id: string } }>('/api/pipelines/:id/export', async (request, reply) => {
    const envelope = exportPipeline(db, request.params.id, request.principal.ownerId);
    return reply.type('application/json').send(canonicalStringify(envelope));
  });
};
