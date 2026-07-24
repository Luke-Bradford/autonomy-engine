import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  FireRequestSchema,
  NewTriggerSchema,
  SubstituteError,
  TriggerPublicSchema,
  canonicalStringify,
  windowBindingErrors,
  type ConcurrencyPolicy,
  type EventConfig,
  type Recurrence,
  type Trigger,
  type TriggerMode,
  type WindowConfig,
} from '@autonomy-studio/shared';
import {
  createSecret,
  createTrigger,
  deleteTrigger,
  getActivePublishedVersion,
  getLatestPipelineVersion,
  getPipeline,
  getPipelineVersion,
  getSecretByRef,
  getTrigger,
  getWorkspaceGit,
  listTriggers,
  updateSecretCiphertext,
  updateTrigger,
} from '../repo/index.js';
import { newId } from '../repo/ids.js';
import { encrypt } from '../secrets/secrets.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { requireOwned } from './util.js';
import { UnboundTriggerError } from '../run/launcher.js';
import { unreadyConnectionsForVersion } from '../run/connection-readiness.js';
import { exportTrigger } from '../portability/index.js';
import type { Principal } from '../auth/principal.js';
import type { Db } from '../repo/types.js';

/** `ownerId` is stamped from `request.principal`, never client-supplied. */
const TriggerWriteBodySchema = NewTriggerSchema.omit({ ownerId: true });

/**
 * #3 G6c-2 — the CREATE body only. A trigger always persists a CONCRETE
 * `pipelineVersionId` (#1 immutability; "unbound never fires"), so "bind to
 * active" is a creation-time CONVENIENCE that resolves ONCE server-side and
 * stores the resolved id — never a live-follow binding, never a stored "active"
 * indirection. The client supplies EXACTLY ONE of:
 *   - `pipelineVersionId` (a concrete id, or `null` for a deliberately unbound
 *     trigger — the pre-G6c-2 path, unchanged), or
 *   - `bindToActive: { pipelineId }` — resolve-once (git-mode → the `active`
 *     published version; DB-only → the latest immutable version).
 * The XOR keys on PRESENCE, not truthiness: `pipelineVersionId: null` is a
 * legitimate explicit "unbound" and counts as supplied (the same null-vs-absent
 * distinction `NewTriggerSchema` documents on its `.default(null)` fields). This
 * is a SEPARATE schema from `TriggerWriteBodySchema` on purpose: PATCH
 * (`.partial()` of the latter) stays concrete-only — bind-to-active is a
 * creation act, and leaking `bindToActive`/optional-`pipelineVersionId` into the
 * PATCH shape would let a patch silently re-resolve a pinned binding.
 */
const TriggerCreateBodySchema = TriggerWriteBodySchema.extend({
  pipelineVersionId: TriggerWriteBodySchema.shape.pipelineVersionId.optional(),
  bindToActive: z.object({ pipelineId: z.string().min(1) }).optional(),
}).superRefine((body, ctx) => {
  const hasConcrete = body.pipelineVersionId !== undefined;
  const hasBind = body.bindToActive !== undefined;
  if (hasConcrete && hasBind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'supply EITHER pipelineVersionId (a concrete binding, or null for unbound) OR ' +
        'bindToActive (resolve-once) — not both',
    });
  }
  if (!hasConcrete && !hasBind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'a trigger create must supply pipelineVersionId (a concrete binding, or ' +
        'null for unbound) or bindToActive (resolve-once)',
    });
  }
});

/**
 * #3 G6c-2 — resolve a `bindToActive: { pipelineId }` request to a concrete
 * `pipelineVersionId`, ONCE, at creation time. Owner-scoped (authentication ≠
 * authorization): a missing or foreign pipeline collapses to 404 via
 * `requireOwned`, never distinguishing "no such pipeline" from "not yours".
 *
 * Mode split (the settled DB-only fallback): a **git-mode** workspace (a repo
 * connected) resolves to the `active` PUBLISHED version — the G6c-1 projection
 * folded from the `pipeline.published` audit log; a **DB-only** workspace (the
 * git-optional default) has no `active` pointer and resolves to the LATEST
 * immutable version. A git-mode workspace with nothing published yet has no
 * active to bind — REFUSE (400) rather than silently birth an unbound trigger
 * or fall back to latest (which would defeat the publish gate); the same
 * "no binding" posture as `assertBindableIfEnabled`. The read is deliberately
 * OUTSIDE any transaction: resolve-once needs no compare-and-set (unlike CAS
 * Publish), it just snapshots whatever is active/latest now.
 */
function resolveBindToActive(db: Db, principal: Principal, pipelineId: string): string {
  const pipeline = requireOwned(getPipeline(db, pipelineId), principal, 'pipeline', pipelineId);
  if (getWorkspaceGit(db, principal.ownerId) !== null) {
    const active = getActivePublishedVersion(db, principal.ownerId, pipeline.resourceId);
    if (active === null) {
      throw new BadRequestError(
        `cannot bind trigger to active: pipeline "${pipelineId}" has no active published ` +
          `version — publish a version first, or bind a concrete pipelineVersionId`,
      );
    }
    return active.to;
  }
  const latest = getLatestPipelineVersion(db, pipeline.id);
  if (latest === null) {
    throw new BadRequestError(
      `cannot bind trigger to latest: pipeline "${pipelineId}" has no versions`,
    );
  }
  return latest.id;
}

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

/**
 * #5 S9 — the window-config CROSS-field rules, checked against the EFFECTIVE
 * post-write state (the `assertEventConsistent` pattern). Three invariants:
 *   - a window geometry only makes sense on a `tumbling` trigger (it IS what
 *     the mode fires on);
 *   - an ENABLED tumbling trigger MUST carry a window — enabled-but-windowless
 *     is inert by construction (no chain can ever seed), the same refusal
 *     shape as `assertBindableIfEnabled`/`assertEventConsistent`;
 *   - a tumbling trigger's concurrency policy must be `queue`:
 *     `skip_if_running` would SKIP a window's one materialization and strand
 *     it forever (a tumbling window must eventually run — that is the mode's
 *     whole contract), and `parallel` is the wrong knob — #5 S11a puts
 *     per-window concurrency in `window.maxConcurrentWindows` (policy =
 *     overflow DISPOSITION, the window cap = slot count; the launcher's
 *     admission reads the cap). Refused up front rather than silently
 *     mis-firing.
 */
function assertWindowConsistent(
  mode: TriggerMode,
  window: WindowConfig | null,
  enabled: boolean,
  concurrencyPolicy: ConcurrencyPolicy,
): void {
  if (window !== null && mode !== 'tumbling') {
    throw new BadRequestError(
      "a window config is only valid on a 'tumbling' trigger — set mode:'tumbling' or remove `window`",
    );
  }
  if (mode === 'tumbling' && enabled && window === null) {
    throw new BadRequestError(
      'an enabled tumbling trigger must carry a `window` config ({frequency, interval, startTime}) — configure it or disable the trigger',
    );
  }
  if (mode === 'tumbling' && concurrencyPolicy !== 'queue') {
    throw new BadRequestError(
      "a tumbling trigger's concurrency policy must be 'queue' — a skipped window would strand forever; for per-window concurrency set `window.maxConcurrentWindows` (#5 S11a)",
    );
  }
}

/**
 * #5 S11b — the MODE-scoped half of the window-field binding rule, checked
 * against the EFFECTIVE post-write state (the `assertWindowConsistent`
 * pattern): `${trigger.windowStart/End}` bindings are legal ONLY on a
 * `tumbling` trigger — no other mode ever fires with window bounds, so the
 * binding would silently resolve `null` forever. The FIELD-level write schema
 * (`TriggerParamsWriteSchema`) is deliberately window-lenient (it cannot see
 * `mode`); this is where the context becomes known. `windowBindingErrors` is
 * the shared set-difference primitive — a pre-gate stored binding's UNRELATED
 * defects never leak in, so a mode/enabled-only PATCH on such a row is refused
 * only for window refs, never for noise it did not introduce. No legal write
 * path predates this rule with a violating row (window fields were unknown —
 * refused — before S11b), and the import path refuses the one hand-crafted
 * source, so this assert can never brick a legitimately-created trigger.
 */
function assertWindowBindingsConsistent(mode: TriggerMode, params: Record<string, unknown>): void {
  if (mode === 'tumbling') return;
  const offending = windowBindingErrors(params);
  if (offending.length > 0) {
    throw new BadRequestError(
      `\${trigger.windowStart/End} bindings are only valid on a 'tumbling' trigger ` +
        `(no other mode fires with window bounds): ${offending.join('; ')}`,
    );
  }
}

/**
 * #3 G8b — the enable-time connection-readiness gate (git-publish spec 120-123):
 * an ENABLED trigger cannot bind a pipeline version whose connections are not
 * ready to dispatch (missing / disabled / missing-secret). Only enforced while
 * `enabled` (a paused trigger may be authored ahead of provisioning its secrets),
 * and only for a concrete binding (`assertBindableIfEnabled` already refuses an
 * enabled+unbound trigger). Runs AFTER `requireOwnedPipelineVersion`, so a
 * foreign version id 404s before its nodes are scanned; the scan is itself
 * owner-scoped (`unreadyConnectionsForVersion`) so a foreign connection folds to
 * `missing`, never confirming another owner's connection. This is the
 * authoring-surface companion to the executor's fire-time dispatch gate (G8a) —
 * the git-import enable path is gated separately (G8b-2); the dispatch gate
 * backstops both.
 *
 * SCOPE: this gate covers secret-READINESS only. Connection KIND-compatibility
 * (an `llm_call` node bound to a ready but wrong-kind connection) stays a
 * dispatch-time refusal (`CONNECTION_KIND_INVALID`), deliberately not checked
 * here — a version is immutable but a connection's kind is mutable, and a
 * `connectionId` may be `${}`-dynamic, so kind-validity can only be judged at
 * fire time (the same reason readiness is not checked at version SAVE).
 *
 * The check is against the FULL effective binding, not just the field this
 * request touches — deliberately conservative: an enabled trigger's binding must
 * be wholly ready. (A connection cannot yet drift to unready under a live enabled
 * trigger — there is no disable / secret-removal API until G8b-2 — so this never
 * refuses a benign unrelated PATCH today; the dispatch gate keeps it safe if it
 * ever could.)
 */
function assertConnectionsReadyIfEnabled(
  db: Db,
  ownerId: string,
  enabled: boolean,
  pipelineVersionId: string | null,
): void {
  if (!enabled || pipelineVersionId === null) return;
  const unready = unreadyConnectionsForVersion(db, ownerId, pipelineVersionId);
  if (unready.length > 0) {
    const detail = unready.map((u) => `'${u.connectionId}' (${u.reason})`).join(', ');
    throw new BadRequestError(
      `an enabled trigger cannot bind a pipeline version whose connections are not ready: ${detail}. ` +
        `Supply the missing secret or enable the connection, then enable the trigger.`,
    );
  }
}

export const triggersRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.post('/api/triggers', async (request, reply) => {
    const { bindToActive, ...body } = TriggerCreateBodySchema.parse(request.body);
    // #3 G6c-2 — resolve-once: `bindToActive` resolves to a concrete id (git →
    // active, DB-only → latest); otherwise the client supplied one directly
    // (a string, or null for unbound). The XOR is enforced by the schema.
    const pipelineVersionId = bindToActive
      ? resolveBindToActive(db, request.principal, bindToActive.pipelineId)
      : (body.pipelineVersionId ?? null);
    assertBindableIfEnabled(body.enabled, pipelineVersionId);
    assertRecurrenceConsistent(body.mode, body.recurrence ?? null, body.schedule !== null);
    assertEventConsistent(body.mode, body.event ?? null, body.enabled);
    assertWindowConsistent(body.mode, body.window ?? null, body.enabled, body.concurrency.policy);
    assertWindowBindingsConsistent(body.mode, body.params);
    requireOwnedPipelineVersion(db, pipelineVersionId, request.principal);
    assertConnectionsReadyIfEnabled(db, request.principal.ownerId, body.enabled, pipelineVersionId);
    const created = createTrigger(db, {
      ...body,
      pipelineVersionId,
      ownerId: request.principal.ownerId,
    });
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
    assertConnectionsReadyIfEnabled(
      db,
      request.principal.ownerId,
      effEnabled,
      effPipelineVersionId,
    );
    // Recurrence 3-state on the PATCH body: undefined = untouched (keep existing),
    // null = clear, object = set. `body.schedule` (a non-null string) is an
    // author-supplied raw cron in THIS patch.
    const effMode = body.mode ?? existing.mode;
    const effRecurrence = body.recurrence !== undefined ? body.recurrence : existing.recurrence;
    assertRecurrenceConsistent(effMode, effRecurrence, typeof body.schedule === 'string');
    // Same 3-state PATCH semantics as recurrence: undefined = untouched.
    const effEvent = body.event !== undefined ? body.event : existing.event;
    assertEventConsistent(effMode, effEvent, effEnabled);
    // #5 S9 — same 3-state; concurrency is all-or-nothing on a PATCH (no
    // partial concurrency object), so the effective policy is body-or-existing.
    const effWindow = body.window !== undefined ? body.window : existing.window;
    const effPolicy =
      body.concurrency !== undefined ? body.concurrency.policy : existing.concurrency.policy;
    assertWindowConsistent(effMode, effWindow, effEnabled, effPolicy);
    // #5 S11b — same effective-state posture: a mode switch away from tumbling
    // must also drop any window-field bindings in the SAME patch.
    assertWindowBindingsConsistent(effMode, body.params ?? existing.params);
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
  // #3 G1: canonical-JSON body (see the pipelines export route).
  fastify.get<{ Params: { id: string } }>('/api/triggers/:id/export', async (request, reply) => {
    const envelope = exportTrigger(db, request.params.id, request.principal.ownerId);
    return reply.type('application/json').send(canonicalStringify(envelope));
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
