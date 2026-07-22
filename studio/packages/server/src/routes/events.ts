import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  isWithinRunWindows,
  jsonReplaySafetyErrors,
  SubstituteError,
  type Trigger,
} from '@autonomy-studio/shared';
import { listTriggers } from '../repo/index.js';
import {
  claimWebhookDelivery,
  deleteWebhookDelivery,
  DuplicateWebhookDeliveryError,
  finalizeWebhookDelivery,
  getWebhookDelivery,
} from '../repo/webhook-deliveries.js';
import { BadRequestError } from '../errors.js';
import { UnboundTriggerError } from '../run/launcher.js';

/**
 * #5 S8 — the named-event INGESTION channel: `POST /api/events {name,
 * payload?, idempotencyKey?}` publishes one event onto a named channel, and
 * every `event`-mode trigger of the CALLER'S owner subscribed to that name
 * (`trigger.event.name === name`) fires through the ONE shared run launcher,
 * with `payload` seeding the run's durable `${trigger.body}`.
 *
 * This is the spec's "event bus (an inbound, authed, correlated signal)" v1:
 * the only event SOURCE today is this first-party authed endpoint (webhook
 * ingress stays the separate per-trigger HMAC endpoint); later breadth
 * (file/queue/db-change watchers — an explicit spec non-goal for now) becomes
 * additional PUBLISHERS onto the same fan-out, not new trigger plumbing.
 *
 * Contrasts with the public webhook endpoint, deliberately:
 * - **Auth**: normal session/principal auth (the `onRequest` seam), NOT HMAC —
 *   there is no per-trigger secret to provision, and the caller is trusted to
 *   the same degree as any other API user. Fan-out is OWNER-scoped: a publish
 *   can only ever fire the caller's own triggers.
 * - **Errors are surfaced**: a malformed publish (bad shape, or a non-finite
 *   number anywhere in `payload` — #547; `1e999` is valid JSON that
 *   `JSON.stringify` would silently persist as `null`) is a plain 400 BEFORE
 *   any fan-out. A first-party caller gets the real error (the manual-fire
 *   precedent); the webhook route's record-skip asymmetry exists for
 *   third-party senders that must not get an existence oracle or a retry storm.
 * - **Dedup is opt-in**: with an `idempotencyKey`, each (trigger, key) pair is
 *   claimed in the SAME durable `webhook_deliveries` ledger the webhook
 *   endpoint uses (it is trigger-scoped, not webhook-specific), so an
 *   at-least-once publisher's replay is served `duplicate` and fired at most
 *   once. WITHOUT a key there is NO dedup — every publish is a fresh event.
 *   That is a documented decision, not an accident: a first-party caller
 *   controls its own submits, and there is no signature to fall back on.
 *
 * Per-subscriber outcomes are INDEPENDENT: one subscriber's failure (an
 * unresolvable `${trigger.body.x}` binding, an unexpected fault) never aborts
 * the fan-out — every matched trigger reports its own terminal outcome and the
 * response is always a 202 with the full list.
 */

const PublishEventSchema = z.object({
  name: z.string().min(1),
  payload: z.unknown().optional(),
  idempotencyKey: z.string().min(1).optional(),
});

/** One subscriber's outcome. `duplicate` and `error` are RESPONSE-only values
 * (the stored delivery-ledger outcome enum stays `pending|started|queued|
 * skipped` — a duplicate is served from the existing row; an errored claim is
 * released). */
interface EventFireResult {
  triggerId: string;
  outcome: 'started' | 'queued' | 'skipped' | 'duplicate' | 'error';
  runId?: string;
  reason?: string;
}

export const eventsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.post('/api/events', async (request, reply) => {
    const body = PublishEventSchema.parse(request.body);

    // #547 — refuse a non-finite number ANYWHERE in the payload up front, as a
    // clean 400 naming the path. (The launcher's `assertJsonReplaySafe`
    // backstop would catch it per-trigger anyway; failing the whole publish
    // once is the honest first-party behaviour.)
    const [replayIssue] = jsonReplaySafetyErrors('payload', body.payload ?? null);
    if (replayIssue !== undefined) throw new BadRequestError(replayIssue);

    // Subscribers: the caller's own `event`-mode triggers on this channel.
    // `mode` filters in SQL; the per-name match reads the parsed rows (a
    // `json_extract` on the JSON column buys nothing at this row count).
    // Matching is by name ONLY — a disabled subscriber is still REPORTED (as a
    // gate skip below), so the operator can see why nothing fired.
    const subscribers = listTriggers(db, {
      ownerId: request.principal.ownerId,
      mode: 'event',
    }).filter((t) => t.event !== null && t.event.name === body.name);

    const results: EventFireResult[] = subscribers.map((trigger) =>
      fireSubscriber(fastify, trigger, body.payload, body.idempotencyKey),
    );

    return reply.status(202).send({ results });
  });
};

/**
 * Fire ONE subscriber; never throws (the fan-out must report every sibling).
 * Mirrors the webhook route's gate/claim/fire/finalize sequence and its
 * asymmetries: a GATE skip (disabled / out-of-window) records NO delivery (the
 * same key retried once enabled/in-window still fires), while a post-admission
 * skip (unresolvable binding — a PERMANENT config defect) IS recorded under
 * the key so a verbatim replay dedupes instead of re-throwing in a storm.
 */
function fireSubscriber(
  fastify: Parameters<FastifyPluginAsync>[0],
  trigger: Trigger,
  payload: unknown,
  idempotencyKey: string | undefined,
): EventFireResult {
  const { db } = fastify;
  const base = { triggerId: trigger.id };

  // --- Gate (automatic firing, the webhook/scheduler parity).
  if (!trigger.enabled) {
    return { ...base, outcome: 'skipped', reason: 'trigger disabled' };
  }
  if (!isWithinRunWindows(trigger.runWindows, new Date())) {
    return { ...base, outcome: 'skipped', reason: 'outside run window' };
  }

  // --- Claim (only when the publisher opted into dedup).
  let deliveryId: string | null = null;
  if (idempotencyKey !== undefined) {
    try {
      deliveryId = claimWebhookDelivery(db, { triggerId: trigger.id, idempotencyKey }).id;
    } catch (err) {
      if (err instanceof DuplicateWebhookDeliveryError) {
        const existing = getWebhookDelivery(db, trigger.id, idempotencyKey);
        return { ...base, outcome: 'duplicate', runId: existing?.runId ?? undefined };
      }
      throw err; // claim-layer faults are unexpected — let the error handler 500
    }
  }

  // --- Fire through the shared launcher; per-subscriber outcomes only.
  try {
    const result = fastify.runLauncher.fire(trigger, { body: payload });
    if (deliveryId !== null) {
      finalizeWebhookDelivery(db, deliveryId, {
        outcome: result.outcome,
        runId: result.runId ?? null,
      });
    }
    return { ...base, outcome: result.outcome, runId: result.runId, reason: result.reason };
  } catch (err) {
    if (err instanceof SubstituteError) {
      // Permanent config defect (bad binding for THIS event's shape): record
      // the delivery as skipped (replay dedupes) and report it.
      fastify.log.warn(
        { err, triggerId: trigger.id },
        'event fire: unresolvable trigger param binding — recording skip',
      );
      if (deliveryId !== null) {
        finalizeWebhookDelivery(db, deliveryId, { outcome: 'skipped', runId: null });
      }
      return { ...base, outcome: 'skipped', reason: 'trigger param binding could not be resolved' };
    }
    // Anything else: release the claim (a corrected retry of the same key must
    // not be deduped) and report — never abort siblings mid-fan-out.
    if (deliveryId !== null) deleteWebhookDelivery(db, deliveryId);
    if (err instanceof UnboundTriggerError) {
      // Defense-in-depth: the write API refuses to enable an unbound trigger.
      return { ...base, outcome: 'skipped', reason: 'trigger has no bound pipeline version' };
    }
    fastify.log.error({ err, triggerId: trigger.id }, 'event fire: unexpected fault');
    return { ...base, outcome: 'error' };
  }
}
