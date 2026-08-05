import { z } from 'zod';
import {
  PendingExternalWaitListSchema,
  RunDetailSchema,
  RunSchema,
  RunSummarySchema,
  RunEventSchema,
  type CompleteExternalWaitBody,
  type PendingExternalWait,
  type Run,
  type RunSummary,
  type RunDetail,
  type RunEvent,
  type RunSince,
  type RunStatus,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';

const RunListSchema = z.array(RunSummarySchema);
const RunEventListSchema = z.array(RunEventSchema);

/**
 * The run model the P6 live monitor sits on: a list, one run, its append-only
 * event log — and two writes.
 *
 * This client was read-only until the rerun action landed, and its docblock said
 * so. That is no longer true, so it does not say so: `rerunFromFailed` below
 * starts a new run. The narrower claim it replaces still holds and is the one
 * that matters — there is no `POST /api/runs`, so a run is never created from
 * WHOLE CLOTH here. Every run still originates in the engine/scheduler; a rerun
 * asks the server to resume an existing failed one, which is a different act
 * from authoring a run.
 *
 * #901 added the SECOND write, `completeExternalWait`, and it is the same kind of
 * act: it settles a wait the run is already parked on. So the invariant above is
 * the durable one — both writes RESUME an existing run, neither authors one — and
 * a future third write should be held to it rather than to a count.
 *
 * The live tail (`useRunStream`) rides the WebSocket beside these; the REST
 * replay here is what a page loads first, before (or without) tailing. Every
 * READ response is parsed through the SAME shared schema the server validates
 * against — a contract check, not a formality.
 */

/**
 * U26 — the filter axes `GET /api/runs` accepts from the Monitor. Every one is
 * OPTIONAL and every one only NARROWS: the owner scope is applied server-side
 * from the principal and is not expressible here, so no combination of these can
 * widen the list past the caller's own runs.
 *
 * `since` is a RELATIVE window (`24h`), not an epoch, and the server resolves it
 * against its own clock — the same clock that stamped `started_at`. Resolving it
 * here would offset the window by whatever this browser's clock skew is, and
 * would bake a moment into any shared link.
 */
export interface ListRunsQuery {
  status?: RunStatus;
  pipelineId?: string;
  triggerId?: string;
  since?: RunSince;
}

/**
 * Owner-scoped list of runs, newest-first — an order the server now genuinely
 * imposes (`started_at DESC, rowid DESC`). It did not before: `listRuns` issued
 * no `ORDER BY` at all, so this docblock's previous "newest-first as the server
 * returns them" described SQLite's incidental row order, not a promise. The
 * tie-break is `rowid` — insert order, so chronological — and NOT `id`, which
 * is a random nanoid and would order same-instant runs arbitrarily.
 *
 * R2 — each element is a `RunSummary`, the run row PLUS the pipeline name +
 * version number and trigger name the list renders. Strictly additive over
 * `Run`, so this is a widening, not a breaking change.
 */
export function listRuns(
  filters: ListRunsQuery = {},
  signal?: AbortSignal,
): Promise<RunSummary[]> {
  const query = new URLSearchParams();
  // Only SET axes reach the wire. An empty-string param is not "no filter" to
  // the server — `pipelineId`/`triggerId` are `min(1)`, so `?pipelineId=` is a
  // 400, and `since`/`status` are closed enums that refuse it too.
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, value);
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiFetch(`/api/runs${suffix}`, { schema: RunListSchema, signal });
}

/** One run by id (`GET /api/runs/:id`); 404 → `ApiError(404)`. */
export function getRun(id: string, signal?: AbortSignal): Promise<Run> {
  return apiFetch(`/api/runs/${encodeURIComponent(id)}`, { schema: RunSchema, signal });
}

/**
 * R1 — a run WITH the immutable version doc it is bound to, in one call
 * (`GET /api/runs/:id/detail`). The monitor's node-state overlay needs the doc
 * to fold `projectRunState`; a `Run` alone carries only `pipelineVersionId`, and
 * the version routes are pipeline-scoped. 404 → `ApiError(404)`, same as `getRun`.
 */
export function getRunDetail(id: string, signal?: AbortSignal): Promise<RunDetail> {
  return apiFetch(`/api/runs/${encodeURIComponent(id)}/detail`, {
    schema: RunDetailSchema,
    signal,
  });
}

/**
 * A run's durable append-only event log (`GET /api/runs/:id/events`), `seq`
 * ascending. This is the REST replay; the live WebSocket streams the very same
 * envelopes, so a page can render history from here and dedupe live frames by
 * `seq`.
 */
export function getRunEvents(id: string, signal?: AbortSignal): Promise<RunEvent[]> {
  return apiFetch(`/api/runs/${encodeURIComponent(id)}/events`, {
    schema: RunEventListSchema,
    signal,
  });
}

/**
 * #4 A16 / #900 — a run's PENDING external waits, each with the callback path that
 * resumes it (`GET /api/runs/:id/external-waits`).
 *
 * Read-only, and owner-scoped on the server (`requireOwned` through the run). The
 * `callbackPath` in each element is a live CAPABILITY: whoever holds it can complete
 * that wait. So a caller must treat the result as credential material — do not log
 * it, do not put it in a URL, and reveal it on demand rather than painting it onto
 * the page (`RunDetailPage`, following `TriggersPage`'s webhook-secret reveal).
 *
 * A run parked on a TIMER rather than a callback returns `[]`, not a 404 — so an
 * empty list means "owes no callback", never "something went wrong".
 */
export function listExternalWaits(
  id: string,
  signal?: AbortSignal,
): Promise<PendingExternalWait[]> {
  return apiFetch(`/api/runs/${encodeURIComponent(id)}/external-waits`, {
    schema: PendingExternalWaitListSchema,
    signal,
  });
}

/**
 * #901 — complete one of this run's parked external waits, as its OWNER.
 *
 * The sibling of the read above, and what makes that read actionable: #900 could
 * only reveal the callback path and send the operator out of the app to POST it.
 *
 * NO TOKEN is sent. The capability is re-derived server-side from `(runId, nodeId,
 * attemptId)`, so the client never has to hold a live credential to resume its own
 * run — which is the entire reason this exists rather than the SPA POSTing the
 * revealed `callbackPath` itself.
 *
 * `attemptId` is the CAS basis, not decoration: a webhook that expires re-parks
 * under a new attempt, and the server refuses a body composed for an attempt that
 * has moved rather than settling its successor (#904's shape).
 *
 * Resolves on `204`. It does NOT mean the run has finished — the server answers as
 * soon as the wait is durably settled and drives the resumed run in the background,
 * so the run view's live stream is where the rest shows up. Rejects with the shared
 * error contract on `external_wait_payload` (422 — the body failed the node's
 * declared outputs, the node is still parked, fix it and send again) and
 * `external_wait_settled` (409/410 — the wait is gone).
 */
export function completeExternalWait(
  runId: string,
  body: CompleteExternalWaitBody,
  signal?: AbortSignal,
): Promise<void> {
  return apiFetch(`/api/runs/${encodeURIComponent(runId)}/external-waits/complete`, {
    method: 'POST',
    body,
    signal,
  });
}

/**
 * The accepted-rerun body. Declared HERE rather than in `@autonomy-studio/shared`,
 * which is the exception to this module's shared-schema rule and is called out
 * rather than glossed: the route replies with an inline object literal
 * (`reply.status(202).send({ runId })` — `server/src/routes/runs.ts`), so there
 * is no shared response schema to borrow, and one introduced for the client
 * alone would look like a contract check while checking nothing on the server
 * side. This stays a local shape assertion: it proves the field arrived and is a
 * non-empty string, and nothing more.
 *
 * The honest caveat is that the SIBLING `202 { runId }` route did better. `POST
 * /api/triggers/:id/fire` has `FireResultSchema` in shared, and the server's
 * `FireResult` type is derived from it (`server/src/run/launcher.ts`) — which is
 * exactly the cure for the objection above. Matching that is ~2 lines in shared
 * plus a `satisfies` on the route, and it is deferred here only to keep this
 * change client-only, because the argument for building it at all rests on
 * touching no server code. Worth doing the next time that route is opened —
 * tracked as **#899**, and already done for the external-waits route above
 * (`PendingExternalWaitSchema`), which is what that fix looks like.
 */
const RerunAcceptedSchema = z.object({ runId: z.string().min(1) });

/**
 * RS2 — start a rerun-from-failed of a terminal FAILED run.
 *
 * The server computes the reusable frontier from the source run's log, appends
 * the reseed pair, and returns `202 { runId }` for the NEW run (R2) as soon as
 * it is durably created — R2 then drives in the background, so this resolves
 * long before the rerun finishes. The caller's job is to send the operator to
 * R2's page and let the live tail take over.
 *
 * R2 reuses R1's params and pipeline version EXACTLY; there is deliberately no
 * override body. The copied frontier outputs were computed under R1's params, so
 * mixing new params with old cached outputs would be a silent inconsistency —
 * param override belongs to a simple full rerun (F11), which copies nothing.
 *
 * Eligibility is the SERVER's to decide, from the event log. Both refusals
 * arrive as `ApiError(409)` carrying a human-readable reason:
 *  - `RerunNotEligibleError` — no log, not terminated, or it succeeded;
 *  - `DocUnresolvableError` — the pinned immutable version no longer resolves.
 * Surface that message verbatim; do not second-guess it (see `rerunAction.ts`).
 */
export function rerunFromFailed(id: string, signal?: AbortSignal): Promise<{ runId: string }> {
  return apiFetch(`/api/runs/${encodeURIComponent(id)}/rerun-from-failed`, {
    method: 'POST',
    schema: RerunAcceptedSchema,
    signal,
  });
}
