import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  computeRunCost,
  CompleteExternalWaitBodySchema,
  type CompleteExternalWaitBody,
  type PendingExternalWait,
  type RunDetail,
} from '@autonomy-studio/shared';
import { getRun, listRunDiagnostics, listRunEvents, listRunSummaries } from '../repo/index.js';
import {
  getExternalWaitByAttempt,
  listPendingExternalWaitsByRun,
} from '../repo/external-waits.js';
import { deriveExternalWaitToken } from '../webhooks/external-wait-token.js';
import { makeDocResolver } from '../run/driver.js';
import { NotFoundError } from '../errors.js';
import {
  ExternalWaitPayloadError,
  ExternalWaitSettledError,
} from '../run/external-wait-service.js';
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
 * `POST /api/runs` create route. TWO state-mutating actions live here, both of
 * them resuming an existing run rather than starting one: RS2's
 * `POST /api/runs/:id/rerun-from-failed` (a new run resuming a FAILED one) and
 * #901's `POST /api/runs/:id/external-waits/complete` (settle a parked wait on
 * THIS run). Every other route is read-only. Both mutators are owner-scoped
 * through the run and answer before their downstream drive finishes.
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
   * because `RunSummarySchema` is strictly ADDITIVE over `RunSchema` — it adds
   * keys and changes none.
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
   *
   * #900 — the response is `satisfies PendingExternalWait[]`, so the shared schema
   * the web client parses this through is a real CONTRACT rather than a client-side
   * assertion about a shape nothing on this side is held to. `api/runs.ts` names
   * that distinction on the sibling rerun route (#899, still open) and asks each to
   * be fixed as its route is opened; this is that route's turn. Projection only —
   * the row's stored token hash and `status` deliberately do not cross the wire.
   */
  fastify.get<{ Params: { id: string } }>('/api/runs/:id/external-waits', async (request) => {
    const run = requireOwned(
      getRun(db, request.params.id),
      request.principal,
      'run',
      request.params.id,
    );
    return listPendingExternalWaitsByRun(db, run.id).map(
      (wait) =>
        ({
          nodeId: wait.nodeId,
          attemptId: wait.attemptId,
          expiresAt: wait.expiresAt,
          callbackPath: `/api/external-wait/${deriveExternalWaitToken(fastify.masterKey, {
            runId: wait.runId,
            nodeId: wait.nodeId,
            attemptId: wait.attemptId,
          })}`,
        }) satisfies PendingExternalWait,
    );
  });

  /**
   * #901 — the OWNER completes one of their own run's parked external waits, from
   * inside the app: `POST /api/runs/:id/external-waits/complete`.
   *
   * The act the GET above only pointed at. #900 revealed the callback URL and left
   * the operator to leave the app and POST it by hand; this closes that path. It is
   * a SECOND DOOR onto the anonymous seam's settle, never a second settle: the
   * token is re-derived here (`HMAC(masterKey, …)`, exactly as the GET does) and
   * handed to the SAME `externalWaitCompleter`, so what completing a wait MEANS
   * cannot drift between the two.
   *
   * SECURITY — the two doors differ in disclosure, not in power, and each is right
   * for its caller:
   *   - AUTHZ: owner-scoped THROUGH the run (`requireOwned`), checked at the
   *     boundary before any lookup or producer work. Authentication is not
   *     authorization — `request.principal` proves who asks, `requireOwned` proves
   *     they own this run. A missing run and a run owned by someone else are the
   *     same 404.
   *   - THE TOKEN NEVER REACHES THE BROWSER. That is this route's reason to exist
   *     over the SPA calling `/api/external-wait/:token`: the capability stays
   *     server-side, so completing a wait from the app no longer requires shipping
   *     a live bearer credential through the client (and into any log, extension or
   *     screen-share that sees it). Neither the request nor the response carries a
   *     token or a `callbackPath`, and a test pins that.
   *   - DISCLOSURE: an owner is not a prober, so this route names the state —
   *     `already completed` (409), `expired` (410), a payload defect (422). The
   *     anonymous seam must keep collapsing every one of those to an identical 404;
   *     that no-oracle property protects an UNAUTHENTICATED token holder and is
   *     untouched here (`routes/external-wait.ts` states the same split).
   *
   * CAS ON `attemptId`, which is why the body carries it: a webhook that expires
   * re-parks under a NEW attempt, so addressing "the pending wait of node X" could
   * complete a different attempt than the one the operator composed a body for. The
   * lookup is the exact `(runId, nodeId, attemptId)` triple; a settled or unknown
   * row is refused rather than redirected onto its successor. Same shape #904
   * settled for a stale version write.
   *
   * `204`, NOT after the run finishes. The resumed run drives in the BACKGROUND
   * (`void drive`, the rerun route's convention two handlers down): the wait is
   * durably settled the moment the completer returns, while the run it unblocks may
   * bill LLM calls for minutes, and this server sets no `requestTimeout`. The
   * operator watches the resumption in the live run view.
   */
  fastify.post<{ Params: { id: string }; Body: CompleteExternalWaitBody }>(
    '/api/runs/:id/external-waits/complete',
    async (request, reply) => {
      const run = requireOwned(
        getRun(db, request.params.id),
        request.principal,
        'run',
        request.params.id,
      );
      const { nodeId, attemptId, payload } = CompleteExternalWaitBodySchema.parse(request.body);

      const row = getExternalWaitByAttempt(db, run.id, nodeId, attemptId);
      // An unknown triple is a 404 like any other missing resource — it names no
      // OTHER attempt's existence, so it is not the oracle the anonymous seam guards
      // against; the caller already owns the run.
      if (row === null) {
        throw new NotFoundError('external wait', `${nodeId}@${attemptId}`);
      }
      if (row.status === 'completed') {
        throw new ExternalWaitSettledError(
          `this wait was already completed (node '${nodeId}')`,
          409,
        );
      }
      if (row.status === 'expired') {
        throw new ExternalWaitSettledError(`this wait expired (node '${nodeId}')`, 410);
      }

      // Re-derived, never read from the row (which stores only a HASH) and never
      // served — the same derivation the GET performs, from the same master key.
      const token = deriveExternalWaitToken(fastify.masterKey, {
        runId: run.id,
        nodeId,
        attemptId,
      });
      // `Buffer.from(JSON.stringify(...))` rather than a second completer entry
      // point: the completer's `parseCallbackBody` is the ONE place a callback body
      // is normalised (a non-object collapses to `{}`), and routing through it keeps
      // both doors on that single policy. Round-tripping an already-parsed JSON
      // value through stringify/parse is identity.
      const { outcome, reason, drive } = await fastify.externalWaitCompleter.complete(
        token,
        Buffer.from(JSON.stringify(payload)),
      );

      if (outcome === 'invalid_payload') {
        // The node is still PARKED — nothing was appended — so the operator can fix
        // the body and send it again. `reason` is absent when the defect is the
        // node's own `config.outputs` rather than the payload (the completer logs
        // that server-side instead of leaking config text), hence the fallback.
        throw new ExternalWaitPayloadError(
          reason ?? 'the callback body does not match this node’s declared outputs',
        );
      }
      if (outcome === 'not_completable') {
        // STATE-NEUTRAL wording on purpose. The row was `pending` a moment ago, so
        // this is NOT simply "a race": the completer also returns it when the node
        // is no longer parked at that attempt (a back-edge reset or a new attempt),
        // when the run has already recorded a terminal fact, and when the pinned
        // pipeline version no longer resolves. Naming any one of those would be a
        // confident claim about which — the honest sentence covers the set.
        throw new ExternalWaitSettledError(
          `this wait is no longer completable — the run or the node has moved on (node '${nodeId}')`,
          409,
        );
      }
      // Fire-and-forget, like the rerun below: `driveRun` owns its own faults, so
      // `drive` never rejects and discarding it cannot orphan an error.
      void drive;
      return reply.status(204).send();
    },
  );

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
