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
 * callback an inert `404`. The completion payload is IGNORED in A13 (the node
 * succeeds with no output); a declared `outputSchema`→`config.outputs` is A16.
 *
 * Its own plugin (like `routes/webhooks.ts`) so its `*` content-type parser — which
 * accepts any/empty body without a JSON-parse error on a callback that sends none —
 * is scoped here and never changes how other routes parse `application/json`.
 */
export const externalWaitRoutes: FastifyPluginAsync = async (fastify) => {
  // Accept any content type (incl. no body): A13 ignores the payload, and a callback
  // may POST empty or a non-JSON body — a JSON-parse error must not pre-empt the
  // token check. Scoped to this plugin, so other routes keep default JSON parsing.
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, _body, done) =>
    done(null, undefined),
  );

  fastify.post<{ Params: { token: string } }>(
    '/api/external-wait/:token',
    async (request, reply) => {
      const outcome = await fastify.externalWaitCompleter.complete(request.params.token);
      if (outcome === 'completed') {
        return reply.status(204).send();
      }
      // One fail-closed response for every non-completable case (no state oracle).
      return reply.status(404).send({ error: 'not found' });
    },
  );
};
