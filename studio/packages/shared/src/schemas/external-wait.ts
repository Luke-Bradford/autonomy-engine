import { z } from 'zod';

/**
 * #4 A13 — the lifecycle of an `external_waits` correlation row: the durable link
 * between a parked `webhook` node and the inbound HTTP callback that resumes it.
 *
 * `pending` — the webhook node is parked (`external_wait_pending`) and this row is
 *   its live correlation: a valid callback for its token will complete it, and its
 *   expiry alarm will expire it. `completed` / `expired` are TERMINAL and settled
 *   from `pending` exactly once (`WHERE status = 'pending'`), so a completed row is
 *   never downgraded to expired by a late-firing timeout alarm, nor vice-versa.
 *
 * Like `webhook_deliveries` and `scheduled_wakeups`, this is driver INFRA — a row
 * maps a token HASH to a parked (runId, nodeId, attemptId) and carries no plaintext
 * secret (the raw token is derived, not stored). The event log stays the domain
 * truth; this row is how an unauthenticated inbound route finds which parked attempt
 * a presented token authorises.
 *
 * The ROW is still never served. `PendingExternalWaitSchema` below is a PROJECTION of
 * it — this paragraph used to say "never part of any resource response", which stopped
 * being true when #900 gave the projection a client, so it says the narrower thing that
 * is actually true. Nothing of the row's own shape crosses the wire: the stored token
 * hash and the `status` column do not appear in the projection, and the `callbackPath`
 * that does is DERIVED per request, never read from storage.
 */
export const ExternalWaitStatusSchema = z.enum(['pending', 'completed', 'expired']);
export type ExternalWaitStatus = z.infer<typeof ExternalWaitStatusSchema>;

/**
 * #4 A16 — one PENDING external wait, as `GET /api/runs/:id/external-waits` serves it.
 *
 * The owner-side half of the human-approval loop: A16 parks a `webhook` node until an
 * inbound callback resumes it, and this is how the operator who owns the run finds out
 * WHERE that callback goes. Shared FE/BE so the web client validates the response
 * through the same schema the route's return type is pinned to (`routes/runs.ts`) —
 * the treatment `FireResultSchema` already gets, and the one `api/runs.ts` records as
 * owed for the sibling rerun route (#899, still open: this fixes THIS route only).
 *
 * `callbackPath` is server-RELATIVE (`/api/external-wait/<token>`), matching the
 * webhook-trigger route's `deliveryUrl`. The token in it is a derived capability, not
 * an identifier: whoever holds it can complete this wait. It is safe to serve here
 * because the route is owner-scoped (`requireOwned`) — but a client that renders it
 * is rendering a live credential, and should treat it as one.
 *
 * `nodeId` is the PARKED node's id, which for a parallel `foreach` body is an instance
 * key (`w@1`), not a doc id — resolve it through `resolveDocNode`/`docNodeIdOf` before
 * looking it up in a pipeline doc.
 *
 * `expiresAt` is epoch ms and never null: A13 requires a webhook's timeout, so a parked
 * wait always has a live expiry alarm. Constrained to a positive INTEGER rather than a
 * bare number, so the schema says what that paragraph says — a bare `z.number()` admits
 * `-1`, `3.7` and `NaN`, and a reader would then have to re-assert the range at every
 * call site to get back what the contract was supposed to have guaranteed.
 */
export const PendingExternalWaitSchema = z.object({
  nodeId: z.string().min(1),
  attemptId: z.string().min(1),
  expiresAt: z.number().int().positive(),
  callbackPath: z.string().min(1),
});
export type PendingExternalWait = z.infer<typeof PendingExternalWaitSchema>;

/** The `GET /api/runs/:id/external-waits` response — pending waits, possibly none. */
export const PendingExternalWaitListSchema = z.array(PendingExternalWaitSchema);

/**
 * #901 — the `POST /api/runs/:id/external-waits/complete` request: the OWNER
 * completing one of their own run's parked waits from inside the app.
 *
 * The sibling of the projection above, and the reason the pair exists. #900 gave
 * the operator the callback URL and nothing to do with it but leave the app; this
 * is the act. It is a SECOND door onto the same settle path, not a second settle
 * path — the route re-derives the capability token internally and drives it
 * through the very completer the anonymous `POST /api/external-wait/:token` seam
 * uses, so the two can never diverge on what completing a wait MEANS.
 *
 * Shared FE/BE for the reason `PendingExternalWaitSchema` is: the route pins its
 * body to this schema and the client builds its request from the same type, so
 * the contract is a contract rather than two hopeful shapes. (`api/runs.ts`
 * records the sibling rerun route as still owing this — #899.)
 *
 * `attemptId` is REQUIRED and is the CAS BASIS, not decoration. A webhook node
 * that expires and re-parks mints a NEW attempt, and `nodeId` alone would then
 * address whichever row happens to be pending NOW — so a body composed for the
 * attempt the operator was LOOKING at could complete a different one. The same
 * shape #904 settled for a version write: name the thing you acted on, and be
 * refused if it moved. `PendingExternalWaitSchema` already carries `attemptId`
 * to the client, so this costs the caller nothing it does not already hold.
 *
 * `nodeId` rides in the BODY rather than the path deliberately. A parked id may
 * be a `foreach` instance key (`w@1`), and node ids are unconstrained
 * (`z.string().min(1)`), so a path segment would put an unbounded charset through
 * URL encoding for no gain — the run id in the path is already the only
 * authorization-bearing identifier.
 *
 * `payload` is REQUIRED with NO `.default()`. The client always sends an object
 * (an empty editor is `{}`), so an ABSENT payload is a malformed request rather
 * than an empty one, and manufacturing `{}` for it would be exactly the fail-open
 * default #473/#904 outlawed — silently completing a wait with no outputs when
 * the caller meant to send some. What the payload must CONTAIN is not this
 * schema's business: the declared-output contract is checked at the boundary by
 * `checkInboundOutputs` against the node's own `config.outputs`, and a webhook
 * declaring no outputs still accepts (and stores nothing from) any object.
 */
export const CompleteExternalWaitBodySchema = z.object({
  /* BOUNDED, unlike `Node.id` itself. Both are opaque correlation ids the route
     looks a row up by, and a miss is the one branch that handles unresolved caller
     text — so an unbounded field here is a `bodyLimit`-sized string travelling
     through validation and logging for no reason. Generous enough that no real id
     (a `n_<uuid>`, a `w@1` instance key, an imported doc's own naming) comes near. */
  nodeId: z.string().min(1).max(512),
  attemptId: z.string().min(1).max(512),
  payload: z.record(z.string(), z.unknown()),
});
export type CompleteExternalWaitBody = z.infer<typeof CompleteExternalWaitBodySchema>;
