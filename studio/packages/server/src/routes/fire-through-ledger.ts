import type { FastifyBaseLogger } from 'fastify';
import { SubstituteError } from '@autonomy-studio/shared';
import {
  claimWebhookDelivery,
  deleteWebhookDelivery,
  DuplicateWebhookDeliveryError,
  finalizeWebhookDelivery,
  getWebhookDelivery,
} from '../repo/webhook-deliveries.js';
import {
  ArchivedPipelineError,
  SHUTDOWN_SKIP_REASON,
  UnboundTriggerError,
  type FireResult,
} from '../run/launcher.js';
import type { Db } from '../repo/types.js';

/**
 * #5 S8 — the ONE encoding of "fire a trigger through the durable delivery
 * ledger", shared by the webhook endpoint (`routes/webhooks.ts`, key always
 * present) and the events fan-out (`routes/events.ts`, key opt-in). The
 * load-bearing asymmetries live HERE, once:
 *
 * - **Claim before fire.** With a key, the delivery is claimed under the
 *   `(triggerId, idempotencyKey)` UNIQUE index BEFORE firing, so a replayed or
 *   concurrent-duplicate delivery is served `duplicate` and fired at most once
 *   (durable across restart). A claim-layer fault other than the duplicate
 *   propagates — there is no row to release, and the caller decides how a
 *   genuinely unexpected DB fault surfaces.
 * - **A PERMANENT post-admission refusal is FINALIZED under the key.** An
 *   unresolvable `${trigger.body.x}` binding — or the #547 non-finite /
 *   depth-bound refusal on the fire body — is a config-vs-payload defect for
 *   THIS event's shape: recording `skipped` makes the sender's verbatim retry
 *   dedupe instead of re-throwing in a storm. (A genuinely-new event carries a
 *   new key and fires.) Concurrency skips ride the same finalize: the trigger
 *   DECIDED, so the same logical event must not re-fire just because a slot
 *   later frees.
 * - **A TRANSIENT refusal RELEASES the claim.** The launcher's shutdown skip
 *   (`SHUTDOWN_SKIP_REASON`) is not a decision about the event — finalizing it
 *   would serve the post-restart retry of the same key as `duplicate` and
 *   silently lose the event. Same for an unbound trigger (defense-in-depth;
 *   the write API refuses to enable one) and any unexpected fault: release,
 *   so a corrected retry of the same key is not deduped.
 *
 * Gate skips (disabled / out-of-window) deliberately live at the CALLERS,
 * before any claim — they record nothing, so the same key retried once the
 * trigger is enabled / in-window still fires.
 */

/** The caller-facing outcome, discriminated so each route maps it to its own
 * response shape (the webhook endpoint 422s `unbound`; the fan-out reports it
 * as a skip). */
export type LedgerFireOutcome =
  | { kind: 'fired'; result: FireResult }
  | { kind: 'duplicate'; runId: string | null }
  | { kind: 'binding_skip' }
  | { kind: 'archived' }
  | { kind: 'unbound' };

export interface LedgerFireInput {
  triggerId: string;
  /** `null` = the caller opted out of dedup (a key-less events publish). */
  idempotencyKey: string | null;
  /** The actual fire, deferred so the claim strictly precedes it. */
  fire: () => FireResult;
}

export function fireTriggerThroughLedger(
  db: Db,
  log: FastifyBaseLogger,
  input: LedgerFireInput,
): LedgerFireOutcome {
  const { triggerId, idempotencyKey } = input;

  let deliveryId: string | null = null;
  if (idempotencyKey !== null) {
    try {
      deliveryId = claimWebhookDelivery(db, { triggerId, idempotencyKey }).id;
    } catch (err) {
      if (err instanceof DuplicateWebhookDeliveryError) {
        const existing = getWebhookDelivery(db, triggerId, idempotencyKey);
        return { kind: 'duplicate', runId: existing?.runId ?? null };
      }
      throw err;
    }
  }
  const release = (): void => {
    if (deliveryId !== null) deleteWebhookDelivery(db, deliveryId);
  };

  try {
    const result = input.fire();
    if (result.outcome === 'skipped' && result.reason === SHUTDOWN_SKIP_REASON) {
      // Transient, not a decision about the event — release so the same key
      // fires after restart.
      release();
      return { kind: 'fired', result };
    }
    if (deliveryId !== null) {
      finalizeWebhookDelivery(db, deliveryId, {
        outcome: result.outcome,
        runId: result.runId ?? null,
      });
    }
    return { kind: 'fired', result };
  } catch (err) {
    if (err instanceof SubstituteError) {
      log.warn({ err, triggerId }, 'trigger fire: unresolvable fire-time input — recording skip');
      if (deliveryId !== null) {
        finalizeWebhookDelivery(db, deliveryId, { outcome: 'skipped', runId: null });
      }
      return { kind: 'binding_skip' };
    }
    if (err instanceof ArchivedPipelineError) {
      // #3 G5a — a PERMANENT decision (the pipeline is archived, it won't fire
      // again), so FINALIZE the delivery as `skipped` under the key, exactly
      // like the binding/concurrency decisions above — NOT release. A verbatim
      // retry of the same key then dedupes instead of re-attempting an archived
      // pipeline forever. (A genuinely-new event carries a new key.)
      log.warn({ err, triggerId }, 'trigger fire: pipeline archived — recording skip');
      if (deliveryId !== null) {
        finalizeWebhookDelivery(db, deliveryId, { outcome: 'skipped', runId: null });
      }
      return { kind: 'archived' };
    }
    release();
    if (err instanceof UnboundTriggerError) return { kind: 'unbound' };
    throw err;
  }
}
