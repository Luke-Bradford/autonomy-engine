import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { NewTriggerSchema, TriggerPublicSchema, type Trigger } from '@autonomy-studio/shared';
import {
  createSecret,
  createTrigger,
  deleteTrigger,
  getPipeline,
  getPipelineVersion,
  getSecretByRef,
  getTrigger,
  listTriggers,
  updateSecretCiphertext,
  updateTrigger,
} from '../repo/index.js';
import { newId } from '../repo/ids.js';
import { encrypt } from '../secrets/secrets.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { requireOwned } from './util.js';
import { UnboundTriggerError } from '../run/launcher.js';
import { exportTrigger } from '../portability/index.js';
import type { Principal } from '../auth/principal.js';
import type { Db } from '../repo/types.js';

/** `ownerId` is stamped from `request.principal`, never client-supplied. */
const TriggerWriteBodySchema = NewTriggerSchema.omit({ ownerId: true });

function toPublic(trigger: Trigger) {
  return TriggerPublicSchema.parse(trigger);
}

/**
 * Closes the cross-owner reference seam on a trigger's `pipelineVersionId`:
 * the DB's FK on `triggers.pipeline_version_id` only proves the row EXISTS,
 * not that the caller owns it — a client could otherwise bind a trigger to
 * someone else's pipeline version, and the `201` (owned/valid) vs `409`
 * (missing, FK violation) split would let them probe which version ids
 * exist. Resolving version -> pipeline and running it through the same
 * `requireOwned` used everywhere else collapses "doesn't exist" and "exists
 * but isn't yours" into the same 404, matching every other resource in this
 * API (see `util.ts`).
 *
 * `null` (an unbound trigger — see `TriggerSchema.pipelineVersionId`) is
 * always a no-op here: there is nothing to own-check, and creating/patching a
 * trigger to `null` is always allowed regardless of who's asking.
 */
function requireOwnedPipelineVersion(
  db: Db,
  pipelineVersionId: string | null,
  principal: Principal,
): void {
  if (pipelineVersionId === null) return;
  const version = getPipelineVersion(db, pipelineVersionId);
  if (!version) throw new NotFoundError('pipelineVersion', pipelineVersionId);
  requireOwned(
    getPipeline(db, version.pipelineId),
    principal,
    'pipelineVersion',
    pipelineVersionId,
  );
}

/**
 * "unbound trigger never fires" — the WRITE-boundary second line of defense.
 * `pipelineVersionId` is nullable (an imported/draft trigger is unbound), so
 * an ENABLED trigger MUST carry a binding: enabling an unbound trigger is
 * refused here so the API can't create a runnable-but-unbindable trigger. The
 * import path forces `enabled:false` (arrives inert); the PRIMARY guarantee
 * remains the P4 scheduler refusing to fire a null-bound trigger.
 */
function assertBindableIfEnabled(enabled: boolean, pipelineVersionId: string | null): void {
  if (enabled && pipelineVersionId === null) {
    throw new BadRequestError(
      'an enabled trigger must have a pipelineVersionId — bind a pipeline version or set enabled:false',
    );
  }
}

export const triggersRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.post('/api/triggers', async (request, reply) => {
    const body = TriggerWriteBodySchema.parse(request.body);
    assertBindableIfEnabled(body.enabled, body.pipelineVersionId);
    requireOwnedPipelineVersion(db, body.pipelineVersionId, request.principal);
    const created = createTrigger(db, { ...body, ownerId: request.principal.ownerId });
    // Reconcile the scheduler so a newly-enabled schedule trigger starts ticking
    // without waiting for a restart (a no-op for a non-schedule trigger).
    fastify.scheduler.sync();
    reply.status(201).send(toPublic(created));
  });

  fastify.get('/api/triggers', async (request) => {
    return listTriggers(db, { ownerId: request.principal.ownerId }).map(toPublic);
  });

  fastify.get<{ Params: { id: string } }>('/api/triggers/:id', async (request) => {
    const row = requireOwned(
      getTrigger(db, request.params.id),
      request.principal,
      'trigger',
      request.params.id,
    );
    return toPublic(row);
  });

  fastify.patch<{ Params: { id: string } }>('/api/triggers/:id', async (request) => {
    const existing = requireOwned(
      getTrigger(db, request.params.id),
      request.principal,
      'trigger',
      request.params.id,
    );
    const body = TriggerWriteBodySchema.partial().parse(request.body);
    if (body.pipelineVersionId !== undefined) {
      requireOwnedPipelineVersion(db, body.pipelineVersionId, request.principal);
    }
    // Guard the EFFECTIVE post-patch state (a patch touching only `enabled`
    // must still be checked against the existing binding, and vice versa).
    const effEnabled = body.enabled ?? existing.enabled;
    const effPipelineVersionId =
      body.pipelineVersionId !== undefined ? body.pipelineVersionId : existing.pipelineVersionId;
    assertBindableIfEnabled(effEnabled, effPipelineVersionId);
    const updated = updateTrigger(db, existing.id, body);
    if (!updated) throw new NotFoundError('trigger', existing.id);
    // Reconcile: a patch may enable/disable, rebind, change the cron, or switch
    // mode — each of which adds, drops, or re-schedules this trigger's cron.
    fastify.scheduler.sync();
    return toPublic(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/api/triggers/:id', async (request, reply) => {
    const existing = requireOwned(
      getTrigger(db, request.params.id),
      request.principal,
      'trigger',
      request.params.id,
    );
    deleteTrigger(db, existing.id);
    // Reconcile so the deleted trigger's cron (if any) is stopped immediately.
    fastify.scheduler.sync();
    reply.status(204).send();
  });

  // Version-stamped JSON export (P1c). `exportTrigger` does its own
  // owner-check (404 if not owned), same outcome as `requireOwned` above.
  fastify.get<{ Params: { id: string } }>('/api/triggers/:id/export', async (request) => {
    return exportTrigger(db, request.params.id, request.principal.ownerId);
  });

  /**
   * P4a — manual fire ("run now"). An explicit operator action, deliberately
   * INDEPENDENT of the trigger's `enabled` flag (that flag gates AUTOMATIC
   * firing — schedule/webhook — whereas a manual fire is a direct request, the
   * same "Trigger now"/"Debug" affordance ADF-style tools give a paused
   * trigger) and independent of `mode` (you may manually fire a scheduled
   * trigger). The launcher still enforces the two invariants for EVERY fire
   * path: an unbound trigger is refused (400), and the trigger's concurrency
   * policy decides started/queued/skipped.
   *
   * `202 Accepted`: an admitted run drives in the BACKGROUND (watch it live in
   * P6); a `queued`/`skipped` outcome is still a well-defined success.
   */
  fastify.post<{ Params: { id: string } }>('/api/triggers/:id/fire', async (request, reply) => {
    const trigger = requireOwned(
      getTrigger(db, request.params.id),
      request.principal,
      'trigger',
      request.params.id,
    );
    try {
      const result = fastify.runLauncher.fire(trigger);
      reply.status(202).send(result);
    } catch (err) {
      if (err instanceof UnboundTriggerError) {
        throw new BadRequestError(err.message);
      }
      throw err;
    }
  });

  /**
   * P4c — provision (or rotate) a webhook trigger's per-trigger secret. The
   * server MINTS a high-entropy secret, stores only its ciphertext, and returns
   * the plaintext EXACTLY ONCE (never persisted in plaintext, never logged, and
   * never readable again — like a personal access token). The caller signs its
   * `POST /api/webhooks/:id` requests with this secret (see
   * `../webhooks/verify.ts`). Rotating replaces the ciphertext IN PLACE under
   * the trigger's existing `secretRef`, so old signatures stop verifying at
   * once. Owner-scoped; only valid for a `webhook`-mode trigger.
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/triggers/:id/webhook-secret',
    async (request, reply) => {
      const { masterKey } = fastify;
      const trigger = requireOwned(
        getTrigger(db, request.params.id),
        request.principal,
        'trigger',
        request.params.id,
      );
      if (trigger.mode !== 'webhook') {
        throw new BadRequestError("a webhook secret can only be set on a 'webhook'-mode trigger");
      }
      // 32 bytes = 256 bits of entropy, URL-safe.
      const secret = randomBytes(32).toString('base64url');
      const ciphertext = await encrypt(secret, masterKey);

      const existing = trigger.webhook ? getSecretByRef(db, trigger.webhook.secretRef) : null;
      let secretRef: string;
      if (existing) {
        // Rotate in place — the trigger's `secretRef` is stable across a rotation.
        updateSecretCiphertext(db, existing.id, ciphertext);
        secretRef = existing.ref;
      } else {
        secretRef = createSecret(db, { ref: newId('whsecref'), ciphertext }).ref;
      }

      const updated = updateTrigger(db, trigger.id, {
        webhook: { ...(trigger.webhook ?? {}), secretRef },
      });
      if (!updated) throw new NotFoundError('trigger', trigger.id);

      // The plaintext `secret` is returned ONCE and never again — the operator
      // must copy it now. `deliveryUrl` is where signed deliveries are POSTed.
      reply.status(200).send({ secret, deliveryUrl: `/api/webhooks/${trigger.id}` });
    },
  );
};
