import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  ActivePipelineVersionResponseSchema,
  CreatePipelineVersionBodySchema,
  DebugRunRequestSchema,
  ManualRunRequestSchema,
  NewPipelineSchema,
  PipelineFolderSchema,
  PublishPipelineBodySchema,
  PublishPipelineResultSchema,
  ParamResolveError,
  canonicalStringify,
  resolveRunParams,
  rollupFromAggregates,
  type ActivePipelineVersion,
  type DebugRunResult,
  type FireResult,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { deleteUnrunDebugVersion } from '../repo/debug-versions.js';
import { pipelineDependents } from '../repo/pipeline-dependents.js';
import {
  aggregatePipelineCost,
  appendWorkspaceEvent,
  archivePipeline,
  createPipeline,
  createPipelineVersion,
  deletePipeline,
  getActivePublishedVersion,
  getHeadVersionRef,
  getPipeline,
  getPipelineVersion,
  getWorkspaceGit,
  isDebugVersion,
  listPipelineVersions,
  listPipelinesPage,
  restorePipeline,
  updatePipeline,
} from '../repo/index.js';
import { BadRequestError, NotFoundError, PublishRefusedError, StaleWriteError } from '../errors.js';
import { GlobalStartError, resolveRunGlobals } from '../run/globals.js';
import { ArchivedPipelineError } from '../run/launcher.js';
import { pageArgsFromQuery, requireOwned } from './util.js';
import { exportPipeline } from '../portability/index.js';

/** `ownerId` is stamped from `request.principal`, never client-supplied. */
const PipelineWriteBodySchema = NewPipelineSchema.omit({ ownerId: true });

/**
 * PATCH body: like the write shape but with NO `.default()` on `concurrency` or
 * `folder` — `.partial()` over a defaulted field still APPLIES the default, so a
 * rename PATCH would silently manufacture `concurrency: null` and clear the cap,
 * and `folder: null` and unfile the pipeline (#473's shape: an absent fact must
 * never become a value). Absent = preserve; explicit `null` = clear; the write
 * rules still hold.
 */
const PipelinePatchBodySchema = PipelineWriteBodySchema.extend({
  concurrency: z.number().int().positive().nullable(),
  folder: PipelineFolderSchema.nullable(),
}).partial();

/**
 * #1058 — the list route's non-pagination query params. Parsed SEPARATELY from
 * `pageArgsFromQuery`, the `ListRunsQuerystringSchema` idiom, because
 * `PaginationQuerySchema` is deliberately non-strict and IGNORES unknown keys:
 * without its own parse, `?archvied=true` would quietly hand back the LIVE list
 * while the caller read it as the archived one.
 *
 * A closed two-value ENUM, and that is load-bearing rather than fussy. Both
 * obvious alternatives fail OPEN — they turn a typo into a wrong-but-plausible
 * answer instead of a 400:
 *
 *  - `z.coerce.boolean()` maps the string `"false"` to `true` (every non-empty
 *    string is truthy), so the one value meaning "no" would mean "yes";
 *  - zod 4's `z.stringbool()` accepts `yes`/`1`/`on`/`y`/`enabled` as well, so
 *    the accepted vocabulary would be wider than the one documented here.
 *
 * Absent means live-only, matching the pre-#1058 default.
 */
const ListPipelinesQuerystringSchema = z.object({
  archived: z.enum(['true', 'false']).optional(),
});

export const pipelinesRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  // #1395 — the two pre-start checks the editor's Run and Debug share, each a
  // 400 naming what is wrong before any run row exists. `resolveRunParams` is
  // pure and never echoes a secret's value.
  const refuseUnresolvableParams = (
    doc: Pick<PipelineVersion, 'params'>,
    params: Record<string, unknown>,
  ): void => {
    try {
      resolveRunParams(doc, params);
    } catch (err) {
      if (err instanceof ParamResolveError) {
        throw new BadRequestError(`the run cannot start: ${err.message}`);
      }
      throw err;
    }
  };
  const refuseUnresolvableGlobals = (ownerId: string, pipelineVersionId: string): void => {
    try {
      resolveRunGlobals(db, { ownerId, pipelineVersionId });
    } catch (err) {
      if (err instanceof GlobalStartError) {
        throw new BadRequestError(`the run cannot start: ${err.message}`);
      }
      throw err;
    }
  };

  fastify.post('/api/pipelines', async (request, reply) => {
    const body = PipelineWriteBodySchema.parse(request.body);
    const created = createPipeline(db, { ...body, ownerId: request.principal.ownerId });
    reply.status(201).send(created);
  });

  fastify.get('/api/pipelines', async (request) => {
    // #534 — keyset-paginated envelope `{ items, nextCursor }`.
    // #1058 — plus the archived selector, parsed ALONGSIDE the pagination args
    // (the `ListRunsQuerystringSchema` idiom) rather than inside them.
    const { archived } = ListPipelinesQuerystringSchema.parse(request.query);
    return listPipelinesPage(db, request.principal.ownerId, pageArgsFromQuery(request.query), {
      archived: archived === 'true',
    });
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

  /**
   * #1397 OR6 — what a DELETE would take with it (`pipelineDependents`), read
   * by the delete confirmation so it can name the consequences up front.
   */
  fastify.get<{ Params: { id: string } }>('/api/pipelines/:id/dependents', async (request) => {
    const pipeline = requireOwned(
      getPipeline(db, request.params.id),
      request.principal,
      'pipeline',
      request.params.id,
    );
    return pipelineDependents(db, request.principal.ownerId, pipeline.id);
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
    // #1485 — `triggers.pipeline_version_id` is ON DELETE CASCADE, so the
    // delete took this pipeline's triggers with it. Reconcile so their pending
    // `schedule_tick` rows are cancelled now, as `DELETE /api/triggers/:id` does.
    fastify.scheduler.sync();
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
   * #907 — RESTORE an archived pipeline (the inverse of archive), and the
   * reason it ships in the same change as the versions route's archived
   * refusal rather than later.
   *
   * `restorePipeline` has existed since #3 G5c, but its only caller was the
   * git-import apply — there was no HTTP route. Refusing to save on an
   * archived pipeline without this would therefore be a ONE-WAY TRAP: an
   * operator who archived over the API could never author that pipeline from
   * the app again, only by round-tripping through a git import. A refusal is
   * safe exactly when the way back is reachable by the same person.
   *
   * WHAT A RESTORE DOES NOT DO: re-enable the triggers the archive disabled.
   * That is `restorePipeline`'s settled contract (re-enabling is authoring
   * intent, gated by the G7/G8 binding+secret readiness reconcile) and it is
   * the safe direction — a restore that silently re-armed a nightly schedule
   * would fire a pipeline the operator had told the system they were done
   * with. So restore returns the pipeline to an EDITABLE state, not a running
   * one.
   *
   * Idempotent: restoring a live pipeline returns 200 with the same shape and
   * emits no event. `requireOwned` enforces authorization (authentication ≠
   * authorization); the post-commit `scheduler.sync()` mirrors the archive
   * route's contract — it reconciles nothing today, since no trigger state
   * changed, but it keeps this route honest if the G7/G8 re-enable path ever
   * lands here, and matches the import apply's unconditional sync.
   */
  fastify.post<{ Params: { id: string } }>('/api/pipelines/:id/restore', async (request) => {
    const existing = requireOwned(
      getPipeline(db, request.params.id),
      request.principal,
      'pipeline',
      request.params.id,
    );
    // Whether the pipeline was archived BEFORE this call — the idempotency
    // signal for the audit event, exactly as the archive route captures it:
    // `restorePipeline` is a no-op in effect when re-restoring, so it cannot
    // tell us on its own.
    const wasArchived = existing.archived;
    // Restore + the audit event land in ONE transaction, so the
    // `pipeline.restored` fact commits or rolls back ATOMICALLY with the
    // restore — never a committed restore with a lost audit fact.
    const restored = db.transaction(() => {
      const p = restorePipeline(db, existing.id);
      if (p === null) return null;
      // Emit only on a REAL state change — the audit records EFFECT, not
      // attempts (the `import.applied` rule its sibling archive follows).
      if (wasArchived) {
        appendWorkspaceEvent(db, request.principal.ownerId, {
          type: 'pipeline.restored',
          resourceId: p.resourceId,
          name: p.name,
          by: request.principal.id,
        });
      }
      return p;
    });
    // `existing` was owner-checked above, so a null here means it vanished
    // between the read and the restore (a concurrent delete) — surface as 404,
    // never a manufactured success.
    if (!restored) throw new NotFoundError('pipeline', existing.id);
    fastify.scheduler.sync();
    return restored;
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
    // #1395 — a DEBUG version is the editor's throwaway draft, deleted after
    // `DEBUG_RETENTION_DAYS`. Refused BY NAME, not left to the provenance check
    // below that happens to catch it today: the exclusion is a rule, and a rule
    // resting on a coincidence stops holding when the coincidence does.
    if (isDebugVersion(db, version.id) === true) {
      throw new PublishRefusedError(
        `pipeline version "${toVersionId}" is a debug version and cannot be published — save the pipeline and publish a saved version`,
      );
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
        // #1077 — captured HERE, at write time, so the entry keeps naming what
        // was published even after the pipeline is renamed. See the schema's
        // docblock for why a read-time join would be the wrong fact.
        name: pipeline.name,
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
      const { basedOnVersionId, ...doc } = CreatePipelineVersionBodySchema.parse(request.body);
      /* #907 — an archived pipeline refuses new versions, as publish already
         does on the same resource. Archive is a "stop editing this", not
         merely a "stop running this": it drops the pipeline off the default
         list, disables every dependent trigger, and the launcher bars
         dispatch. Continuing to accept saves against something the product
         presents as deleted lets an author work for twenty minutes on a
         resource nothing will ever run, with nothing said.

         Checked AFTER the body parse, matching publish's order, so a malformed
         doc is still a 400 — the archive state does not change what a valid
         request looks like.

         ROUTE-SCOPED, and deliberately so. The git-import apply mints versions
         through the repo function `createPipelineVersion` directly and handles
         an archived pipeline by RESTORING it first
         (`portability/workspace-apply.ts`), which is the right behaviour for a
         branch that has the pipeline back — a rule about an INTERACTIVE save
         belongs on the interactive surface, the same placement argument the
         #904 CAS below makes.

         Not a one-way trap: `POST /api/pipelines/:id/restore` above is the way
         back, and this message names it. */
      if (pipeline.archived) {
        throw new PublishRefusedError(
          `pipeline "${pipeline.id}" is archived and cannot be edited — unarchive it first`,
        );
      }
      // #904 — CAS on the head, in the same transaction as the mint.
      //
      // Without it, `createPipelineVersion` takes `max(version)+1`
      // unconditionally: two authors with the same pipeline open both save, and
      // the second one's version becomes the head carrying NONE of the first's
      // work. Nothing was destroyed (versions are immutable) but the first
      // author's save is silently orphaned off the head, and neither of them is
      // told — the classic lost update.
      //
      // The check lives HERE and not in `createPipelineVersion`, exactly as the
      // publish CAS lives in its route: the repo function is also the write path
      // for import, workspace-apply and the git reconcile, none of which have —
      // or should be made to invent — an author's basis. This is a rule about an
      // INTERACTIVE save, so it belongs on the interactive surface.
      //
      // The transaction is for symmetry with publish and to state the intent;
      // it is not what makes this atomic. better-sqlite3 is one synchronous
      // connection and there is no `await` between the head read and the
      // insert, so nothing can interleave either way. `createPipelineVersion`'s
      // own transaction composes rather than conflicts because better-sqlite3
      // drops to a SAVEPOINT when it is already inside one (drizzle delegates
      // straight to it here — the callback's `tx` is deliberately unused, so
      // drizzle's own savepoint path is never the one taken).
      const created = db.transaction(() => {
        const head = getHeadVersionRef(db, pipeline.id);
        const headId = head?.id ?? null;
        if (headId !== basedOnVersionId) {
          // Names the head's version NUMBER, never the caller's
          // `basedOnVersionId` — an error may echo only ids this handler
          // resolved and owner-checked itself.
          throw new StaleWriteError(
            head === null
              ? `stale save for pipeline "${pipeline.id}": it has no versions yet, but the save declared a basis`
              : `stale save for pipeline "${pipeline.id}": it is now at v${String(head.version)}, which is not the version this save was based on — reload or save again from v${String(head.version)}`,
          );
        }
        return createPipelineVersion(db, { ...doc, pipelineId: pipeline.id });
      });
      reply.status(201).send(created);
    },
  );

  /**
   * #1395 OR4 — `POST /api/pipelines/:id/runs`: run one saved version of this
   * pipeline now, with no trigger (the editor's Run button). `202` with a
   * `FireResult`: `started` + `runId` (the run drives in the background), or
   * `skipped` + `reason` when the pipeline is at its concurrency cap or the
   * server is stopping.
   *
   * Checks, in order, each before a run row exists:
   *  - the pipeline is the caller's (`requireOwned`) and the version is THIS
   *    pipeline's — a missing version and another pipeline's both read 404, the
   *    publish route's no-leak rule;
   *  - the params resolve against the version's declared params. DELIBERATELY
   *    stricter than a trigger fire, which lets a bad run-now value surface as an
   *    interrupted run (`triggers.ts`): here the operator is at the form that
   *    typed the value, so a 400 naming the param is the useful answer.
   *    `resolveRunParams` is pure and never echoes a secret's value;
   *  - the globals the version reads resolve (the fire route's GL3 pre-check);
   *  - the pipeline is not archived (409) — ahead of the params, as `fire()`
   *    orders it, so the refusal the operator can act on is the one they see;
   *  - the launcher's dispatch gates: archived again, and the cap → skipped.
   */
  fastify.post<{ Params: { id: string } }>('/api/pipelines/:id/runs', async (request, reply) => {
    const pipeline = requireOwned(
      getPipeline(db, request.params.id),
      request.principal,
      'pipeline',
      request.params.id,
    );
    const body = ManualRunRequestSchema.parse(request.body ?? {});
    const version = getPipelineVersion(db, body.pipelineVersionId);
    if (version === null || version.pipelineId !== pipeline.id) {
      throw new NotFoundError('pipeline version', body.pipelineVersionId);
    }
    // Archived first, as `fire()` orders it: it is the refusal the operator can
    // act on, so a bad param must not mask it. The launcher checks again at
    // dispatch.
    if (pipeline.archived) {
      throw new ArchivedPipelineError(null, pipeline.id);
    }
    const params = body.params ?? {};
    refuseUnresolvableParams(version, params);
    refuseUnresolvableGlobals(request.principal.ownerId, version.id);
    const result: FireResult = fastify.runLauncher.runNow({
      ownerId: request.principal.ownerId,
      pipelineVersionId: version.id,
      params,
    });
    return reply.status(202).send(result);
  });

  /**
   * #1395 OR4 — `POST /api/pipelines/:id/debug-runs`: run the editor's UNSAVED
   * draft (the Debug button). The draft is minted as a hidden DEBUG version
   * (`createPipelineVersion(…, { debug: true })`): the same write gate as a save,
   * so a draft that could not be saved cannot be debugged either, but numbered
   * apart, absent from every version listing and the head, unbindable by a
   * trigger, and deleted with its runs after `DEBUG_RETENTION_DAYS`
   * (`repo/debug-versions.ts`). `202` with a `DebugRunResult`.
   *
   * The same checks as Run, in the same order, and a version exists only if the
   * run started:
   *  - ownership, then archived (409);
   *  - params against the DRAFT's declared params — pure, before anything is
   *    written;
   *  - mint + the globals pre-check in ONE transaction, so a refused globals
   *    check (or an invalid doc, 400) rolls the version back;
   *  - `runNow` last. It never queues; a `skipped` or a throw deletes the
   *    version it was minted for, which has no run to keep.
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/pipelines/:id/debug-runs',
    async (request, reply) => {
      const pipeline = requireOwned(
        getPipeline(db, request.params.id),
        request.principal,
        'pipeline',
        request.params.id,
      );
      if (pipeline.archived) {
        throw new ArchivedPipelineError(null, pipeline.id);
      }
      const body = DebugRunRequestSchema.parse(request.body ?? {});
      const params = body.params ?? {};
      refuseUnresolvableParams(body.version, params);
      const ownerId = request.principal.ownerId;
      // better-sqlite3 drops `createPipelineVersion`'s own transaction to a
      // SAVEPOINT inside this one (see the save route above).
      const version = db.transaction(() => {
        const minted = createPipelineVersion(
          db,
          { ...body.version, pipelineId: pipeline.id },
          { debug: true },
        );
        refuseUnresolvableGlobals(ownerId, minted.id);
        return minted;
      });
      let result: FireResult;
      try {
        result = fastify.runLauncher.runNow({ ownerId, pipelineVersionId: version.id, params });
      } catch (err) {
        deleteUnrunDebugVersion(db, version.id);
        throw err;
      }
      const retentionDays = fastify.debugRetentionDays;
      if (result.outcome !== 'started') {
        deleteUnrunDebugVersion(db, version.id);
        return reply.status(202).send({ ...result, retentionDays } satisfies DebugRunResult);
      }
      return reply
        .status(202)
        .send({ ...result, pipelineVersion: version, retentionDays } satisfies DebugRunResult);
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
   * ITS WEB CALLER, at last, is the Runs list under the `?pipeline=` filter
   * (#931, U27's "Monitor" placement): `getPipelineCost` → `pipelineCostSummary`.
   * This note used to say the route had none, which was true from #599 until that
   * landed. The other cost surfaces read neither this route nor each other —
   * #866 renders per-NODE cost on the drill-in and #930 the whole run's, both
   * folded client-side from the event stream, and the run LIST's column comes from
   * `aggregateRunCosts`, this aggregation's per-run twin, sharing its predicates
   * and its one fail-closed derivation site but grouped by run.
   *
   * WHAT THIS ROLLUP EXCLUDES, and the caller is required to say so: a
   * `call_pipeline` child runs against the CALLED pipeline's version
   * (`run/child.ts`), so the scope filter above puts its spend in that pipeline's
   * rollup and never in its caller's. An understatement, and a safe one — every
   * excluded penny is counted under some pipeline — but only once it is legible,
   * which is #932's rule at run scope applied here.
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
