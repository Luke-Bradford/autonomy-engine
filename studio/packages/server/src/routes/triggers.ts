import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import {
  FireRequestSchema,
  NewTriggerSchema,
  SubstituteError,
  TriggerPublicSchema,
  type EventConfig,
  type Recurrence,
  type Trigger,
  type TriggerMode,
} from '@autonomy-studio/shared';
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

/**
 * #5 S5b-1 — the recurrence CROSS-field rules, checked against the EFFECTIVE
 * post-write state (mirrors `assertBindableIfEnabled`; a top-level Zod refine
 * can't see across fields on a `.partial()` PATCH body). Two invariants:
 *   - a recurrence only makes sense on a `schedule` trigger (it IS the schedule);
 *   - `schedule` is DERIVED from `recurrence` (repo `deriveSchedule`), so a write
 *     must not also author a raw cron `schedule` — that would be ignored/overwritten.
 * The repo derivation is the runtime guarantee; these give a clean 400 up front.
 */
function assertRecurrenceConsistent(
  mode: TriggerMode,
  recurrence: Recurrence | null,
  rawScheduleAuthored: boolean,
): void {
  if (recurrence === null) return;
  if (mode !== 'schedule') {
    throw new BadRequestError(
      "a recurrence is only valid on a 'schedule' trigger — set mode:'schedule' or remove the recurrence",
    );
  }
  if (rawScheduleAuthored) {
    throw new BadRequestError(
      'provide either a `recurrence` or a raw cron `schedule`, not both — `schedule` is derived from `recurrence`',
    );
  }
}

/**
 * #5 S8 — the event-config CROSS-field rules, checked against the EFFECTIVE
 * post-write state (the `assertRecurrenceConsistent` pattern; a Zod refine
 * can't see across fields on a `.partial()` PATCH body). Two invariants:
 *   - an event subscription only makes sense on an `event` trigger (it IS what
 *     the mode fires on);
 *   - an ENABLED event trigger MUST carry a subscription — enabled-but-
 *     unsubscribable is inert by construction (nothing can ever fan out to
 *     it), the same refusal shape as `assertBindableIfEnabled` for unbound.
 * NOTE this is a (deliberate) behaviour change for a pre-S8 `mode:'event'` row
 * (inert then, `event: NULL` post-migration): while ENABLED, any patch that
 * leaves it subscription-less is refused until it is configured or disabled.
 */
function assertEventConsistent(
  mode: TriggerMode,
  event: EventConfig | null,
  enabled: boolean,
): void {
  if (event !== null && mode !== 'event') {
    throw new BadRequestError(
      "an event subscription is only valid on an 'event' trigger — set mode:'event' or remove `event`",
    );
  }
  if (mode === 'event' && enabled && event === null) {
    throw new BadRequestError(
      'an enabled event trigger must carry an `event` subscription ({name}) — configure it or disable the trigger',
    );
  }
}

export const triggersRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.post('/api/triggers', async (request, reply) => {
    const body = TriggerWriteBodySchema.parse(request.body);
    assertBindableIfEnabled(body.enabled, body.pipelineVersionId);
    assertRecurrenceConsistent(body.mode, body.recurrence ?? null, body.schedule !== null);
    assertEventConsistent(body.mode, body.event ?? null, body.enabled);
    requireOwnedPipelineVersion(db, body.pipelineVersionId, request.principal);
    const created = createTrigger(db, { ...body, ownerId: request.principal.ownerId });
    // Reconcile the durable `schedule_tick` rows so a newly-enabled schedule
    // trigger is seeded immediately (a no-op for a non-schedule trigger).
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
    // Recurrence 3-state on the PATCH body: undefined = untouched (keep existing),
    // null = clear, object = set. `body.schedule` (a non-null string) is an
    // author-supplied raw cron in THIS patch.
    const effMode = body.mode ?? existing.mode;
    const effRecurrence = body.recurrence !== undefined ? body.recurrence : existing.recurrence;
    assertRecurrenceConsistent(effMode, effRecurrence, typeof body.schedule === 'string');
    // Same 3-state PATCH semantics as recurrence: undefined = untouched.
    const effEvent = body.event !== undefined ? body.event : existing.event;
    assertEventConsistent(effMode, effEvent, effEnabled);
    const updated = updateTrigger(db, existing.id, body);
    if (!updated) throw new NotFoundError('trigger', existing.id);
    // Reconcile: a patch may enable/disable, rebind, change the schedule, or
    // switch mode — each of which seeds, cancels, or re-seeds this trigger's
    // durable `schedule_tick` row.
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
    // Reconcile so the deleted trigger's pending `schedule_tick` row (if any) is
    // cancelled immediately.
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
   *
   * #5 S12b — the optional `{ params }` body is the RUN-NOW override layer, the
   * top of the precedence stack (pipeline-default < trigger-binding < run-now).
   * A malformed trigger param binding surfaces SYNCHRONOUSLY here as a 400
   * (`SubstituteError`, before any run row is created); an undeclared/type-bad
   * RUN-NOW override instead surfaces as an interrupted run at run start
   * (`resolveRunParams`), consistent with a bad trigger-authored param today.
   */
  fastify.post<{ Params: { id: string } }>('/api/triggers/:id/fire', async (request, reply) => {
    const trigger = requireOwned(
      getTrigger(db, request.params.id),
      request.principal,
      'trigger',
      request.params.id,
    );
    // A body is optional; `{}` (or none) means a plain "run now".
    const body = FireRequestSchema.parse(request.body ?? {});
    try {
      const result = fastify.runLauncher.fire(trigger, { runNowParams: body.params });
      reply.status(202).send(result);
    } catch (err) {
      if (err instanceof UnboundTriggerError) {
        throw new BadRequestError(err.message);
      }
      // A trigger param binding that cannot resolve for this fire is a bad
      // request (a misconfigured binding, or a `${trigger.body.x}` deep-address
      // on a manual fire's null body) — the message is client-safe (never echoes
      // a resolved value).
      if (err instanceof SubstituteError) {
        throw new BadRequestError(`trigger param binding could not be resolved: ${err.message}`);
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
