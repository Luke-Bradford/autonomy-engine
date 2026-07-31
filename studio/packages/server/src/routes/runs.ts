import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { computeRunCost, type RunDetail } from '@autonomy-studio/shared';
import {
  getPipelineVersion,
  getRun,
  listRunDiagnostics,
  listRunEvents,
  listRuns,
} from '../repo/index.js';
import { listPendingExternalWaitsByRun } from '../repo/external-waits.js';
import { deriveExternalWaitToken } from '../webhooks/external-wait-token.js';
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
  // RS6 — the rerun-history grouping filter: `?rerunOf=R1` lists R1's reruns.
  rerunOf: z.string().min(1).optional(),
});

/**
 * Runs are created by the engine/scheduler (P2-P4), so there is deliberately no
 * `POST /api/runs` create route. The one state-mutating action here is RS2's
 * `POST /api/runs/:id/rerun-from-failed` (start a new run resuming a FAILED one);
 * every other route is read-only.
 */
export const runsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.get('/api/runs', async (request) => {
    const { pipelineVersionId, triggerId, parentRunId, rerunOf } = ListRunsQuerystringSchema.parse(
      request.query,
    );
    return listRuns(db, {
      pipelineVersionId,
      triggerId,
      parentRunId,
      rerunOf,
      ownerId: request.principal.ownerId,
    });
  });

  fastify.get<{ Params: { id: string } }>('/api/runs/:id', async (request) => {
    return requireOwned(getRun(db, request.params.id), request.principal, 'run', request.params.id);
  });

  /**
   * R1 — the run-detail read-model: the run PLUS the immutable version doc it is
   * bound to, resolved server-side in one call (`RunDetailSchema`).
   *
   * U11's node-state overlay folds `createEngine(doc).projectRunState(events)`,
   * which needs `nodes`/`edges`/`containers`. A `Run` carries only
   * `pipelineVersionId`, and every version route is pipeline-SCOPED, so the page
   * had no way to reach the doc at all.
   *
   * SECURITY — the ownership proof is the RUN's, and it is transitive by
   * construction, not by assumption: a version is reachable here ONLY via a run
   * that `requireOwned` has already cleared, and `runs.pipelineVersionId` is a
   * foreign key, so the version returned is necessarily the one this run is
   * bound to. `getPipelineVersion` itself takes no owner filter (a
   * `PipelineVersion` row has no `ownerId` — owner scoping rides the pipeline
   * FK), which is exactly why this route must never accept a version id from the
   * caller. That is the second reason R1 is a run-detail read-model rather than
   * the `GET /api/pipeline-versions/:id` the ticket first sketched.
   */
  fastify.get<{ Params: { id: string } }>('/api/runs/:id/detail', async (request) => {
    const run = requireOwned(
      getRun(db, request.params.id),
      request.principal,
      'run',
      request.params.id,
    );
    const pipelineVersion = getPipelineVersion(db, run.pipelineVersionId);
    if (!pipelineVersion) {
      // NOT a 404. `runs.pipelineVersionId` is `onDelete: 'restrict'` and
      // `PRAGMA foreign_keys` is ON per connection, so a surviving run pins its
      // version row: this state is unreachable while the run exists. Reaching it
      // means a violated DB invariant, and answering "no such run" would launder
      // that into the same response an ownership refusal gives — a 500 says the
      // server is broken, which is the truth.
      throw new Error(
        `run ${run.id} is bound to pipeline version ${run.pipelineVersionId}, which does not exist`,
      );
    }
    return { run, pipelineVersion } satisfies RunDetail;
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
   * #2 L6 — the run-cost projection: SUMS the `costEstimate` stamped on this
   * run's `activity.metered` events (`computeRunCost`, the shared SSOT). Read
   * off the durable event log, deterministic, fail-closed — a genuine cost gap
   * (an unpriced MODEL, or `meteringStatus:'unknown'` usage) leaves `complete:false`
   * and its cost OUT of the total (never a manufactured 0). #2 L14: a subscription
   * `meteringStatus:'unpriced'` response is NOT a gap — it is counted separately
   * (`unpricedResponseCount`) and does NOT flip `complete`. Owner-scoped THROUGH
   * the run, exactly as `/events` is.
   */
  fastify.get<{ Params: { id: string } }>('/api/runs/:id/cost', async (request) => {
    const run = requireOwned(
      getRun(db, request.params.id),
      request.principal,
      'run',
      request.params.id,
    );
    return computeRunCost(listRunEvents(db, run.id));
  });

  /**
   * #497 — the reducer's EXPLANATIONS for this run: why an edge was ignored, a
   * container child neutralized, or which entities stalled it. Its DECISIONS are
   * `/events` (the durable log); these say why.
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

  /**
   * #4 A13 — the OWNER-scoped retrieval of a run's pending `webhook` external-wait
   * callback URLs. Until A16 injects the URL into an outbound trigger, this is how
   * the operator/an integration obtains the callback URL to hand to the external
   * system awaiting a human/callback decision.
   *
   * Owner-scoped THROUGH the run (`requireOwned`) — authentication is not
   * authorization: `request.principal` proves who is asking, `requireOwned` proves
   * they own the run whose parked nodes' capability tokens this returns. The token
   * is RE-DERIVED here (`HMAC(masterKey, ...)`, never read from a log or the row's
   * hash), so a live bearer credential is only ever handed to the run's OWNER, on
   * demand — never persisted in plaintext, never in the raw event feed.
   */
  fastify.get<{ Params: { id: string } }>('/api/runs/:id/external-waits', async (request) => {
    const run = requireOwned(
      getRun(db, request.params.id),
      request.principal,
      'run',
      request.params.id,
    );
    return listPendingExternalWaitsByRun(db, run.id).map((wait) => ({
      nodeId: wait.nodeId,
      attemptId: wait.attemptId,
      expiresAt: wait.expiresAt,
      callbackPath: `/api/external-wait/${deriveExternalWaitToken(fastify.masterKey, {
        runId: wait.runId,
        nodeId: wait.nodeId,
        attemptId: wait.attemptId,
      })}`,
    }));
  });

  /**
   * RS2 — start a RERUN-FROM-FAILED of a terminal FAILED run: a new run R2 that
   * copies R1's successful prefix (frontier) and resumes from the failure. Returns
   * `202 { runId }` with R2's id; R2 drives in the background (like a manual fire).
   *
   * Owner-scoped THROUGH the source run (`requireOwned`) — authentication is not
   * authorization: `request.principal` proves who asks, `requireOwned` proves they
   * own the run being reran. Authz is checked HERE, at the boundary, before the
   * producer runs. A non-existent OR not-owned run is the same `404` (no oracle).
   *
   * The producer's eligibility + version-resolution verdicts surface through the
   * global error handler: `RerunNotEligibleError` (no log / not terminated / it
   * succeeded) → 409, `DocUnresolvableError` (the pinned version is gone) → 409.
   * R2 reuses R1's params + version EXACTLY (no override body — param override is a
   * simple-rerun concern, not rerun-from-failed).
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/runs/:id/rerun-from-failed',
    async (request, reply) => {
      const run = requireOwned(
        getRun(db, request.params.id),
        request.principal,
        'run',
        request.params.id,
      );
      // `202` the moment R2 is durably created + its reseed pair committed; R2
      // drives in the BACKGROUND (like a manual fire), so a long rerun never holds
      // the request open. `drive` is intentionally not awaited (it owns its own
      // faults; a crash before it runs recovers via the boot reconciler).
      const { runId, drive } = await fastify.reseedService.rerunFromFailed(run.id);
      void drive;
      return reply.status(202).send({ runId });
    },
  );
};
