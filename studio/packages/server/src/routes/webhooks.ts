import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isWithinRunWindows, SubstituteError, type Trigger } from '@autonomy-studio/shared';
import { getTrigger, getSecretByRef } from '../repo/index.js';
import {
  claimWebhookDelivery,
  deleteWebhookDelivery,
  DuplicateWebhookDeliveryError,
  finalizeWebhookDelivery,
  getWebhookDelivery,
} from '../repo/webhook-deliveries.js';
import { decrypt } from '../secrets/secrets.js';
import { UnboundTriggerError } from '../run/launcher.js';
import { verifyWebhook } from '../webhooks/verify.js';

/**
 * P4c — the WEBHOOK firing endpoint: `POST /api/webhooks/:triggerId`. An
 * EXTERNAL caller (no session/principal) fires a `webhook`-mode trigger by
 * proving it holds the trigger's per-trigger secret (HMAC signature over the
 * raw body + a signed timestamp — see `../webhooks/verify.ts`).
 *
 * Like the P4b scheduler, this is AUTOMATIC firing, so it enforces the same
 * gates the scheduler does and funnels through the ONE shared run launcher:
 *
 *   1. **Authenticate first** — an unauthenticated caller learns NOTHING about
 *      the trigger's state (enabled? in-window? already fired?). Every auth
 *      failure is a single fail-closed `401`; the specific reason is logged
 *      server-side only, never returned or echoed. The secret is resolved
 *      just-in-time from `webhook.secretRef` and never logged.
 *   2. **Gate** — a disabled trigger or one outside its run windows SKIPS
 *      (automatic firing is gated; a manual "run now" is the explicit override
 *      and is NOT gated). A gated skip records NO delivery, so the SAME key
 *      retried once the trigger is enabled / in-window still fires.
 *   3. **Idempotency + replay** — a delivery is CLAIMED under the
 *      `(triggerId, idempotencyKey)` UNIQUE index BEFORE firing, so a replayed
 *      or concurrent-duplicate delivery is served as `duplicate` and fired at
 *      most once (durable across a restart). The key is the caller's
 *      `x-webhook-idempotency-key`, else the request signature itself.
 *   4. **Fire** — through the launcher, which enforces "unbound never fires"
 *      and concurrency admission (started / queued / skipped).
 *
 * Encapsulated as its own plugin so its raw-body content-type parser (needed to
 * HMAC the EXACT received bytes) is scoped here and never changes how any other
 * route parses `application/json`.
 */

/** A JSON-shaped success body (all post-auth outcomes are `202 Accepted`). */
interface WebhookFireResponse {
  outcome: 'started' | 'queued' | 'skipped' | 'duplicate';
  runId?: string;
  reason?: string;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export const webhooksRoutes: FastifyPluginAsync = async (fastify) => {
  const { db, masterKey } = fastify;

  // Raw-body parser, SCOPED to this plugin (encapsulated): the signature is
  // computed over the exact received bytes, so the body must NOT be parsed /
  // re-serialized first. Registering for `application/json` (the common webhook
  // content type) AND `*` (anything else, incl. no body) overrides only within
  // this plugin — other routes keep Fastify's default JSON parsing.
  const rawParser = (
    _req: FastifyRequest,
    body: Buffer,
    done: (err: Error | null, body?: Buffer) => void,
  ): void => done(null, body);
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, rawParser);
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, rawParser);

  fastify.post<{ Params: { triggerId: string }; Body: Buffer }>(
    '/api/webhooks/:triggerId',
    async (request, reply) => {
      const { triggerId } = request.params;
      const trigger = getTrigger(db, triggerId);

      // The webhook endpoint exists ONLY for a webhook-mode trigger. Collapse
      // "not found" and "not a webhook trigger" into one 404 (no existence
      // oracle for a caller who can't authenticate).
      if (trigger === null || trigger.mode !== 'webhook') {
        return reply.status(404).send({ error: 'not found' });
      }

      // --- 1. Authenticate (fail-closed 401; log the real reason server-side).
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const authFail = (reason: string): FastifyReply => {
        request.log.warn({ triggerId, reason }, 'webhook: authentication rejected');
        return reply.status(401).send({ error: 'webhook signature verification failed' });
      };

      if (trigger.webhook === null) return authFail('no webhook secret configured');
      const secretRow = getSecretByRef(db, trigger.webhook.secretRef);
      if (secretRow === null) return authFail('webhook secret ref does not resolve');
      let secret: string;
      try {
        secret = await decrypt(secretRow.ciphertext, masterKey);
      } catch {
        return authFail('webhook secret could not be decrypted');
      }

      const verdict = verifyWebhook({
        secret,
        rawBody,
        headers: {
          timestamp: firstHeader(request.headers['x-webhook-timestamp']),
          signature: firstHeader(request.headers['x-webhook-signature']),
        },
        nowMs: Date.now(),
      });
      if (!verdict.ok) return authFail(verdict.reason);

      // --- 2. Gate (automatic firing): disabled / out-of-window → skip, no
      // delivery recorded (a retry once enabled / in-window still fires).
      if (!trigger.enabled) {
        return reply
          .status(202)
          .send({ outcome: 'skipped', reason: 'trigger disabled' } satisfies WebhookFireResponse);
      }
      if (!isWithinRunWindows(trigger.runWindows, new Date())) {
        return reply
          .status(202)
          .send({ outcome: 'skipped', reason: 'outside run window' } satisfies WebhookFireResponse);
      }

      // --- 3. Idempotency + replay: claim the delivery BEFORE firing.
      const idempotencyKey =
        firstHeader(request.headers['x-webhook-idempotency-key']) ||
        // Fall back to the signature: deterministic in secret+timestamp+body,
        // so a verbatim replay collides but a freshly-signed event does not.
        (firstHeader(request.headers['x-webhook-signature']) as string);

      let deliveryId: string;
      try {
        deliveryId = claimWebhookDelivery(db, { triggerId, idempotencyKey }).id;
      } catch (err) {
        if (err instanceof DuplicateWebhookDeliveryError) {
          const existing = getWebhookDelivery(db, triggerId, idempotencyKey);
          return reply.status(202).send({
            outcome: 'duplicate',
            runId: existing?.runId ?? undefined,
          } satisfies WebhookFireResponse);
        }
        throw err;
      }

      // --- 4. Fire through the shared launcher, seeding `${trigger.body}`
      // (#5 S8 — the first production feeder of the S12a context seam) from
      // the SAME verified bytes the signature covered.
      return fireClaimed(fastify, trigger, deliveryId, deriveBody(rawBody), reply);
    },
  );
};

/**
 * #5 S8 — the delivery body → `${trigger.body}` lowering, from the exact bytes
 * the HMAC verified: empty → `undefined` (the context seed records null — no
 * manufactured value); valid JSON → the parsed value (the common webhook case,
 * `${trigger.body.x}` deep-addresses it); anything else → the raw UTF-8 STRING.
 * The string fallback is deliberate: it is the honest representation of a
 * non-JSON delivery (`${trigger.body}` yields the text), and a `${trigger.body.x}`
 * deep-address on it fails SAFE through the launcher's `SubstituteError` →
 * record-skip path rather than silently seeding null. A non-finite JSON number
 * (`1e999` → `Infinity`) survives this parse but is refused by the launcher's
 * replay-safety backstop (#547) before anything durable is written.
 */
function deriveBody(rawBody: Buffer): unknown {
  if (rawBody.length === 0) return undefined;
  const text = rawBody.toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Fire a claimed delivery and finalize its ledger row, or release the claim on
 * an unexpected fault so a corrected retry of the same key is not deduped. */
function fireClaimed(
  fastify: Parameters<FastifyPluginAsync>[0],
  trigger: Trigger,
  deliveryId: string,
  body: unknown,
  reply: FastifyReply,
): FastifyReply {
  const { db } = fastify;
  let result;
  try {
    result = fastify.runLauncher.fire(trigger, { body });
  } catch (err) {
    // #5 S12b — a trigger param binding that cannot resolve is a PERMANENT
    // config defect (e.g. a `${trigger.body.x}` deep-address on a body this
    // delivery does not carry), NOT a transient fault — and #547's non-finite
    // fire-body refusal (`1e999` in the payload) rides the same class. RELEASING
    // the claim would let the sender's verbatim retry (same idempotency key)
    // re-fire and re-throw in a storm. Instead RECORD the delivery as `skipped`
    // (so the same key dedupes) and 202 — the deliberate asymmetry the
    // concurrency-skip below already uses. A corrected, genuinely-new event
    // re-signs with a new key and fires. The detail is logged server-side,
    // never returned.
    if (err instanceof SubstituteError) {
      fastify.log.warn(
        { err, triggerId: trigger.id, deliveryId },
        'webhook fire: unresolvable trigger param binding — recording skip',
      );
      finalizeWebhookDelivery(db, deliveryId, { outcome: 'skipped', runId: null });
      return reply.status(202).send({
        outcome: 'skipped',
        reason: 'trigger param binding could not be resolved',
      } satisfies WebhookFireResponse);
    }
    // Release the claim so the same key can be retried after the cause is fixed.
    deleteWebhookDelivery(db, deliveryId);
    if (err instanceof UnboundTriggerError) {
      // Defense-in-depth: the write API refuses to enable an unbound trigger,
      // so an enabled-but-unbound webhook should not exist — but "unbound never
      // fires" is honoured here regardless.
      return reply.status(422).send({ error: 'trigger has no bound pipeline version' });
    }
    throw err;
  }
  // Finalize the claim with the launcher's outcome. NOTE the deliberate
  // asymmetry with a GATE skip (disabled / out-of-window, above): a gate skip
  // records NO delivery so the same key retries once the trigger is
  // enabled/in-window, whereas a CONCURRENCY skip here (`skip_if_running` /
  // `parallel` cap / full `queue`) IS recorded — the delivery WAS admitted and
  // the trigger decided, so the same logical event must not re-fire just
  // because a slot later frees (a genuinely new event re-signs with a new
  // timestamp → new idempotency key → fires).
  finalizeWebhookDelivery(db, deliveryId, {
    outcome: result.outcome,
    runId: result.runId ?? null,
  });
  return reply.status(202).send({
    outcome: result.outcome,
    runId: result.runId,
    reason: result.reason,
  } satisfies WebhookFireResponse);
}
