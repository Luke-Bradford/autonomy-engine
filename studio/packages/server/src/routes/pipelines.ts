import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ActivePipelineVersionResponseSchema,
  NewPipelineSchema,
  NewPipelineVersionSchema,
  PublishPipelineBodySchema,
  PublishPipelineResultSchema,
  canonicalStringify,
  rollupFromAggregates,
  type ActivePipelineVersion,
} from '@autonomy-studio/shared';
import {
  aggregatePipelineCost,
  appendWorkspaceEvent,
  archivePipeline,
  createPipeline,
  createPipelineVersion,
  deletePipeline,
  getActivePublishedVersion,
  getPipeline,
  getPipelineVersion,
  getWorkspaceGit,
  listPipelineVersions,
  listPipelinesPage,
  updatePipeline,
} from '../repo/index.js';
import { NotFoundError, PublishRefusedError } from '../errors.js';
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
    // Whether the pipeline was ALREADY archived before this call — the
    // idempotency signal for the audit event below. `archivePipeline` is a no-op
    // in effect when re-archiving, so it cannot tell us on its own.
    const wasArchived = existing.archived;
    // Archive + the audit event land in ONE transaction (archivePipeline's own
    // tx nests as a SAVEPOINT): the `pipeline.archived` fact commits or rolls
    // back ATOMICALLY with the archive — never a committed archive with a lost
    // audit fact (the fail-safe direction, the run_events precedent).
    const result = db.transaction(() => {
      const r = archivePipeline(db, existing.id);
      if (r === null) return null;
      // #3 G6a — emit only on a REAL state change. Re-archiving an
      // already-archived pipeline is an idempotent no-op (its dependent triggers
      // were disabled the first time) and must not double-count in the audit log;
      // an import-driven archive is captured in `import.applied.archived[]`, so
      // this manual seam is the sole `pipeline.archived` writer.
      if (!wasArchived) {
        appendWorkspaceEvent(db, request.principal.ownerId, {
          type: 'pipeline.archived',
          resourceId: r.pipeline.resourceId,
          name: r.pipeline.name,
          disabledTriggerIds: r.disabledTriggerIds,
          by: request.principal.id,
        });
      }
      return r;
    });
    // `existing` was owner-checked above, so a null here means it vanished
    // between the read and the archive (a concurrent delete) — surface as 404,
    // never a manufactured success.
    if (!result) throw new NotFoundError('pipeline', existing.id);
    fastify.scheduler.sync();
    return result.pipeline;
  });

  /**
   * #3 G6c-1 — CAS Publish: promote an immutable version to the pipeline's
   * `active`/deployable pointer. The pointer is a PROJECTION of the
   * `pipeline.published` workspace-audit log (never a stored mutable row), so
   * this appends an event; `getActivePublishedVersion` folds the latest.
   *
   * Publish is a GIT-MODE concept (a DB-only workspace has no active pointer —
   * it binds-to-latest, that is G6c-2) and only from a version whose git
   * provenance is known (`source_commit`/`source_blob_sha`, G6b). The
   * compare-and-set (`expectedActiveVersionId` must equal the currently-projected
   * active) refuses a stale publish — "pull/import first". The CAS read + the
   * append run in ONE `db.transaction` (the append nests as a SAVEPOINT), so
   * they observe one SQLite snapshot: with better-sqlite3's single-writer model
   * no concurrent publish can interleave between the read and the append.
   *
   * `requireOwned` enforces authorization (authentication ≠ authorization); a
   * version of another pipeline / owner surfaces as a 404, never a publish.
   */
  fastify.post<{ Params: { id: string } }>('/api/pipelines/:id/publish', async (request) => {
    const pipeline = requireOwned(
      getPipeline(db, request.params.id),
      request.principal,
      'pipeline',
      request.params.id,
    );
    const { toVersionId, expectedActiveVersionId } = PublishPipelineBodySchema.parse(request.body);
    const ownerId = request.principal.ownerId;

    if (getWorkspaceGit(db, ownerId) === null) {
      throw new PublishRefusedError(
        `pipeline "${pipeline.id}" cannot be published: no git repo is connected to this workspace`,
      );
    }
    if (pipeline.archived) {
      throw new PublishRefusedError(
        `pipeline "${pipeline.id}" is archived and cannot be published`,
      );
    }

    const version = getPipelineVersion(db, toVersionId);
    // Not-found AND not-this-pipeline both collapse to 404 (never distinguish
    // "no such version" from "not this pipeline's" — the authz-leak rule).
    if (version === null || version.pipelineId !== pipeline.id) {
      throw new NotFoundError('pipeline version', toVersionId);
    }
    // CAS publishes only from a version whose git source commit/blob is KNOWN
    // (G6b). A NON-git-minted version (authored via the versions route, portable
    // import) has null provenance and is not a deployable git artifact.
    if (version.sourceCommit === null || version.sourceBlobSha === null) {
      throw new PublishRefusedError(
        `pipeline version "${toVersionId}" has no git provenance and cannot be published`,
      );
    }
    const commit = version.sourceCommit;
    const blob = version.sourceBlobSha;

    const result = db.transaction(() => {
      const current = getActivePublishedVersion(db, ownerId, pipeline.resourceId)?.to ?? null;
      if (current !== expectedActiveVersionId) {
        throw new PublishRefusedError(
          `stale publish for pipeline "${pipeline.id}": the active version has moved — pull/import first`,
        );
      }
      // Re-publishing the already-active version changes nothing: emit NO event
      // (the audit records EFFECT, not attempts — the `import.applied` rule).
      if (toVersionId === current) {
        return { published: false, active: { versionId: current, commit, blob } };
      }
      appendWorkspaceEvent(db, ownerId, {
        type: 'pipeline.published',
        pipeline: pipeline.resourceId,
        from: expectedActiveVersionId,
        to: toVersionId,
        commit,
        blob,
        by: request.principal.id,
      });
      return { published: true, active: { versionId: toVersionId, commit, blob } };
    });
    // Parse at the API boundary (the workspace-git commit-route convention):
    // enforces the declared response contract and strips any stray field.
    return PublishPipelineResultSchema.parse(result);
  });

  /**
   * #3 G6c-1 — the current `active` pointer for a pipeline, projected from the
   * audit log. Deliberately NOT git-gated: a DB-only workspace (no active
   * pointer, never published) answers `{ active: null }` rather than 404, the
   * same "records-history-even-DB-only" stance as `GET /api/workspace/audit`.
   */
  fastify.get<{ Params: { id: string } }>('/api/pipelines/:id/active', async (request) => {
    const pipeline = requireOwned(
      getPipeline(db, request.params.id),
      request.principal,
      'pipeline',
      request.params.id,
    );
    const published = getActivePublishedVersion(db, request.principal.ownerId, pipeline.resourceId);
    const active: ActivePipelineVersion | null = published
      ? { versionId: published.to, commit: published.commit, blob: published.blob }
      : null;
    return ActivePipelineVersionResponseSchema.parse({ active });
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
