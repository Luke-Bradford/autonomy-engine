import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { computeRunCost, type RunDetail } from '@autonomy-studio/shared';
import {
  getRun,
  listRunDiagnostics,
  listRunEvents,
  listRunSummaries,
} from '../repo/index.js';
import { listPendingExternalWaitsByRun } from '../repo/external-waits.js';
import { deriveExternalWaitToken } from '../webhooks/external-wait-token.js';
import { makeDocResolver } from '../run/driver.js';
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
  const resolveDoc = makeDocResolver(db);

  /**
   * R2 — the Monitor's list read-model. Returns `RunSummary[]`: every field of
   * the `Run` row PLUS the pipeline's name + version number and the trigger's
   * name, joined server-side so U10's list needn't N+1 its way to a human label.
   *
   * The response shape widened from `Run[]` to `RunSummary[]`, which is safe
   * because `RunSummarySchema` is a strict `RunSchema.extend` — additive only.
   * Any reader still parsing an element through `RunSchema` keeps working (zod
   * strips the extra keys); nothing about the existing fields moved or changed
   * meaning. The per-run route (`GET /api/runs/:id`) deliberately keeps
   * returning a bare `Run`: it has no list to de-N+1, and the detail page
   * already resolves the version doc itself via `/detail`.
   *
   * Rows come back newest-first with a total, deterministic tie-break; the
   * previous route promised an order the query never actually imposed.
   */
  fastify.get('/api/runs', async (request) => {
    const { pipelineVersionId, triggerId, parentRunId, rerunOf } = ListRunsQuerystringSchema.parse(
      request.query,
    );
    return listRunSummaries(db, {
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
   * SECURITY — the ownership proof is the RUN's. This route establishes two of
   * the three links itself: a version is reachable here ONLY via a run that
   * `requireOwned` has already cleared, and `runs.pipelineVersionId` is a
   * foreign key, so the version returned is necessarily the one that run is
   * bound to. The third link — that the run's owner owns the version's PIPELINE
   * — is upheld OUTSIDE this file: a run is created only from a trigger whose
   * `pipelineVersionId` passed `requireOwnedPipelineVersion` at create time
   * (`routes/triggers.ts`) and is immutable thereafter, or by copying an owned
   * run's binding (`run/reseed.ts`). Stated rather than assumed because the
   * version row itself carries NO `ownerId` — owner scoping rides the pipeline
   * FK — and `resolveDoc` therefore applies no owner filter of its own. Which is
   * exactly why this route must never accept a version id from the caller, and
   * the second reason R1 is a run-detail read-model rather than the
   * `GET /api/pipeline-versions/:id` the ticket first sketched.
   */
  fastify.get<{ Params: { id: string } }>('/api/runs/:id/detail', async (request) => {
    const run = requireOwned(
      getRun(db, request.params.id),
      request.principal,
      'run',
      request.params.id,
    );
    // `makeDocResolver` is the ONE production classifier of "gone" vs "present
    // but does not parse" (#508/#515), and the global handler already maps both
    // to a 409. Reaching it is a violated invariant either way —
    // `runs.pipelineVersionId` is `onDelete: 'restrict'` with `PRAGMA
    // foreign_keys` on, so a surviving run pins its version row — but the
    // classification is not this route's to re-derive, and a hand-rolled throw
    // got it wrong in both directions: a bare `Error` for the missing case, and
    // an escaping `ZodError` for the unparseable one, which the handler turns
    // into a 400 `validation_error` on a GET with no request body.
    const pipelineVersion = resolveDoc(run.pipelineVersionId);
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
