import type { FastifyPluginAsync } from 'fastify';

/**
 * #4 A13 — the webhook external-wait CALLBACK endpoint: `POST /api/external-wait/:token`.
 *
 * An EXTERNAL caller (no session/principal) resumes a parked `webhook` node by
 * proving it holds the node's capability token — the token, carried in the URL, IS
 * the authorization AND the correlation to exactly one parked (runId, nodeId,
 * attemptId). It is a 256-bit-strength derived secret (`HMAC(masterKey, ...)`), so
 * it is unguessable; the server matches it by SHA-256 hash against the
 * `external_waits` row (the raw token is never stored) and, if the row is still
 * `pending` and the node still parked at that attempt, appends
 * `externalWait.completed` (succeeding the node) inside one transaction, then drives
 * the run.
 *
 * FAIL-CLOSED + no state oracle: every non-completable case — unknown token, an
 * already-completed/expired wait, a node no longer parked, a terminal run — returns
 * the IDENTICAL `404`, so a token never reveals whether it ever existed or was
 * already used (the same "authenticate first, single opaque response" discipline as
 * the webhook-trigger route). Replay is safe: the row's guarded `pending`→`completed`
 * settle + the reducer's `external_wait_pending`-at-attempt fold make a second
 * callback an inert `404`.
 *
 * #4 A16 — the callback body is now a TYPED output. It is validated against the
 * webhook's declared `config.outputs` contract (`checkInboundOutputs`, at the
 * boundary) and, on success, the declared-key-filtered payload is lowered into the
 * `externalWait.completed` event so `${nodes.webhook.output.decision}` resolves
 * downstream. A body that FAILS the contract returns `422` — but ONLY to a holder
 * of a live token for a currently-parked node (the validation runs after the token
 * + parked checks), so `422` is not a state oracle; the node stays parked so the
 * caller can retry before the expiry alarm bounds the wait. A webhook that declares
 * no outputs still accepts any/empty body and completes with `{}` (A13 behaviour).
 *
 * #901 — this is no longer the ONLY door onto the settle. `POST /api/runs/:id/
 * external-waits/complete` (`routes/runs.ts`) lets the run's OWNER complete a parked
 * wait from inside the app, re-deriving the token server-side so it never reaches
 * the browser. It shares this route's completer — one settle path, two doors — and
 * differs only in DISCLOSURE, which is a property of the caller, not of completing:
 * an owner is not a prober, so that route distinguishes "already completed" (409)
 * from "expired" (410) where this one must not. The no-oracle collapse below is
 * therefore untouched, and its default-deny shape (`completed`/`invalid_payload`
 * named, EVERYTHING else 404) is what keeps a future outcome from leaking by
 * omission.
 *
 * DEFERRED, deliberately and not forgotten: the `422`/`404` bodies here are sent
 * directly rather than through the central error handler, so they do not match
 * `ApiErrorBodySchema` and `messageFromBody` reduces them to `request failed (4xx)`,
 * discarding `detail`. That cost bought nothing once #901 gave the app an
 * owner-scoped door with conforming errors — this seam's clients are external
 * callers, not `apiFetch`. Reshaping it is a contract change to a published
 * external surface and belongs in its own ticket.
 *
 * Its own plugin (like `routes/webhooks.ts`) so its `*` content-type parser — which
 * buffers any/empty body without a JSON-parse error on a callback that sends none —
 * is scoped here and never changes how other routes parse `application/json`. The
 * default `bodyLimit` still applies, so an oversize body is a framework-level `413`
 * before this handler runs — the untrusted body can never be unbounded.
 */
export const externalWaitRoutes: FastifyPluginAsync = async (fastify) => {
  // Buffer EVERY content type (incl. `application/json`, `text/plain` and no body):
  // a callback may POST empty, JSON, or a non-JSON body, and a parse error must not
  // pre-empt the token check — so parsing is deferred to the completer, uniformly.
  // Fastify 5 ships EXACT-match default parsers for BOTH `application/json` and
  // `text/plain`, and an exact match beats the `*` catch-all — so either would
  // otherwise (a) hand the completer a parsed object/string instead of a Buffer and
  // (b) for JSON, reject a malformed body with a 400 BEFORE the token check (a
  // would-be oracle). `removeAllContentTypeParsers` clears them in THIS plugin scope
  // only (encapsulated), so `*` truly buffers every body and other routes keep
  // default JSON parsing + validation. `bodyLimit` still bounds the buffer (413).
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  fastify.post<{ Params: { token: string } }>(
    '/api/external-wait/:token',
    async (request, reply) => {
      const body = request.body instanceof Buffer ? request.body : undefined;
      const { outcome, reason, drive } = await fastify.externalWaitCompleter.complete(
        request.params.token,
        body,
      );
      if (outcome === 'completed') {
        // AWAITED, unlike the owner-scoped sibling (#901), which answers the moment
        // the settle commits. Kept because this route has always answered only once
        // the resumed run came to rest, and an external caller's retry/alerting
        // behaviour may be built on that; the split exists to let the SPA not hang,
        // not to change what this seam does. `drive` never rejects.
        await drive;
        return reply.status(204).send();
      }
      if (outcome === 'invalid_payload') {
        // A live token for a parked node, but the body failed the declared
        // contract — the ONLY case a valid holder can distinguish (not an oracle),
        // so `detail` names the offending field to guide the caller's retry.
        return reply.status(422).send({
          error: 'callback body does not match the declared output schema',
          detail: reason,
        });
      }
      // One fail-closed response for every non-completable case (no state oracle).
      return reply.status(404).send({ error: 'not found' });
    },
  );
};
