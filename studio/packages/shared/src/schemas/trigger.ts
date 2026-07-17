import { z } from 'zod';
import { validateTriggerBindings } from '../engine/params.js';
import { RecurrenceSchema, RecurrenceWriteSchema } from './recurrence.js';

export const TriggerModeSchema = z.enum(['manual', 'schedule', 'webhook', 'event', 'continuous']);
export type TriggerMode = z.infer<typeof TriggerModeSchema>;

export const ConcurrencyPolicySchema = z.enum(['queue', 'skip_if_running', 'parallel']);
export type ConcurrencyPolicy = z.infer<typeof ConcurrencyPolicySchema>;

/**
 * STORED/READ shape — deliberately LENIENT (no cross-field refinement) so it
 * parses ANY historically-valid row. `max` is `positive().optional()`. The
 * cross-field rule (parallel⇒max, single-slot⇒no-max) is a WRITE concern
 * (`ConcurrencyWriteSchema`), NOT enforced here: tightening the stored-shape
 * schema would make a trigger row persisted under an older, looser schema throw
 * on READ (`getTrigger`/`listTriggers` parse via `TriggerSchema`) rather than
 * merely being defended against at fire-time. The launcher's fail-closed
 * fire-time guard is the runtime backstop for such a legacy/corrupted row.
 */
export const ConcurrencySchema = z.object({
  policy: ConcurrencyPolicySchema,
  /** The cap on simultaneous runs — only meaningful for `parallel`. */
  max: z.number().int().positive().optional(),
});
export type Concurrency = z.infer<typeof ConcurrencySchema>;

/**
 * WRITE-boundary shape — the stored shape PLUS the cross-field rule enforced on
 * every CREATE/UPDATE (via `NewTriggerSchema`): `parallel` REQUIRES a positive
 * `max` (an omitted cap would be an unbounded fan-out footgun) and
 * `queue`/`skip_if_running` FORBID `max` (both are implicitly single-slot, so a
 * `max` is meaningless and rejected rather than silently ignored). Shared so the
 * client can pre-validate the same way the server does.
 */
export const ConcurrencyWriteSchema = ConcurrencySchema.superRefine((c, ctx) => {
  if (c.policy === 'parallel' && c.max === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['max'],
      message: 'parallel concurrency requires a positive `max` (the cap on simultaneous runs)',
    });
  }
  if (c.policy !== 'parallel' && c.max !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['max'],
      message: `\`max\` is only valid for the 'parallel' policy, not '${c.policy}'`,
    });
  }
});

/**
 * `[{start,end,days?}]` in UTC, fail-CLOSED, wraps past midnight (e.g.
 * `start: "22:00", end: "02:00"`) — enforced by the engine, not this schema;
 * this schema only checks shape. `days` is ISO-ish 0=Sunday..6=Saturday.
 */
export const RunWindowSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1),
  days: z.array(z.number().int().min(0).max(6)).optional(),
});
export type RunWindow = z.infer<typeof RunWindowSchema>;

/** `{secretRef, ...}` — per-trigger webhook secret + whatever else a webhook
 * trigger needs (idempotency-key handling, replay-protection config); kept
 * open-ended with `secretRef` as the one required field. */
export const WebhookConfigSchema = z
  .object({
    secretRef: z.string().min(1),
  })
  .catchall(z.unknown());
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

/**
 * STORED/READ param shape — the raw record, deliberately LENIENT (no binding
 * validation) so it parses any historically-valid row. Binding validation is a
 * WRITE concern (`TriggerParamsWriteSchema`), NOT enforced on read: tightening
 * the stored schema would make a trigger row persisted before the S12b gate
 * throw on `getTrigger`/`listTriggers` rather than merely being refused at the
 * write boundary (same reasoning as `ConcurrencySchema` above). At fire time,
 * an unresolvable stored binding fails SAFE (`resolveTriggerBindings` throws).
 */
export const TriggerParamsSchema = z.record(z.string(), z.unknown());

/**
 * WRITE-boundary param shape (#5 S12b): the stored record PLUS static validation
 * that every expression-valued binding parses AND references ONLY the
 * `${trigger.*}` root (the sole facts that exist at fire time). A
 * `${params.*}`/`${nodes.*}`/`${run.*}` binding is refused here so a trigger can
 * never be created/updated to bind a param to state that does not exist when it
 * fires. Reuses `validateTriggerBindings` (the shared checker) so the canvas /
 * any client and the server refuse identically. A ZodEffects FIELD on
 * `NewTriggerSchema` (like `ConcurrencyWriteSchema`), so the write object stays a
 * ZodObject and `.omit()`/`.partial()` keep working on the write path.
 */
export const TriggerParamsWriteSchema = TriggerParamsSchema.superRefine((params, ctx) => {
  for (const message of validateTriggerBindings(params)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  }
});

/**
 * First-class trigger: binds ONE pipeline version + param values + firing
 * mode + concurrency policy. Many triggers can point at one pipeline
 * (version). "Assign" in the UI = create a trigger.
 */
export const TriggerSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1).nullable(),
  name: z.string().min(1),
  /**
   * Nullable: an "unbound" trigger transiently has no pipeline version bound
   * (freshly imported via `packages/server/src/portability` — a standalone
   * Trigger export always nulls this, since a foreign workspace's version id
   * is meaningless — or authored before its pipeline exists). Nothing in
   * P1-P3 reads this field to actually fire a run (no scheduler/executor
   * exists yet), so an unbound trigger is inert until the operator rebinds
   * it via `PATCH /api/triggers/:id`; a future scheduler (P4) must refuse to
   * fire a trigger with a null binding.
   */
  pipelineVersionId: z.string().min(1).nullable(),
  params: TriggerParamsSchema,
  mode: TriggerModeSchema,
  /**
   * The compiled cron string the firing chain reads (`isSchedulable`,
   * `nextOccurrence`, the `schedule_changed` freshness compare). When
   * `recurrence` is set this is a DERIVED cache of it (the repo write path
   * recompiles it on every write, so the two can never diverge); when
   * `recurrence` is null it is the raw cron escape-hatch a power user authored.
   */
  schedule: z.string().min(1).nullable(),
  /**
   * #5 S5b-1 — the ADF-style structured recurrence (`{frequency, interval,
   * schedule?}`), the authoring representation the UI round-trips and re-edits.
   * Null for a raw-cron / non-schedule trigger. Read-lenient (stored shape);
   * write validation + the recurrence↔schedule derivation live on the write
   * path (`RecurrenceWriteSchema` + the repo). Bounds (start/end/timeZone) are
   * S5b-2 (#549).
   */
  recurrence: RecurrenceSchema.nullable(),
  webhook: WebhookConfigSchema.nullable(),
  concurrency: ConcurrencySchema,
  runWindows: z.array(RunWindowSchema).nullable(),
  enabled: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

// WRITE shape: strips server-set fields AND swaps in `ConcurrencyWriteSchema`,
// so every CREATE/UPDATE (routes, `createTrigger`, import) enforces the
// cross-field concurrency rule while the stored `TriggerSchema` stays lenient
// on read (see `ConcurrencySchema`).
export const NewTriggerSchema = TriggerSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  concurrency: ConcurrencyWriteSchema,
  // Expression-valued param bindings are validated on the WRITE path only
  // (#5 S12b) — see `TriggerParamsWriteSchema`.
  params: TriggerParamsWriteSchema,
  // #5 S5b-1: recurrence's intra-object rules (interval=1, per-frequency field
  // validity) are enforced here as a FIELD-level effect so `NewTriggerSchema`
  // stays a ZodObject (`.omit`/`.partial` on the routes keep working). The
  // CROSS-field rules (recurrence⇒mode=schedule; schedule is derived, not
  // co-authored) can't see other fields from here — they live in the repo write
  // path + route (against the merged/effective row).
  //
  // `.nullable().optional()` — NOT `.default(null)` — is load-bearing for PATCH:
  // it gives a clean THREE-state field (verified empirically: `.default(null)`
  // is APPLIED by `.partial()`, so an unrelated PATCH would parse `recurrence:
  // null` and silently CLEAR an existing recurrence). Here: OMITTED → `undefined`
  // (untouched), explicit `null` → clear, object → set. A NEW authoring field, so
  // omission is backward-compatible for existing clients/payloads. The stored
  // `TriggerSchema.recurrence` stays required-nullable — every persisted row
  // carries the column explicitly.
  recurrence: RecurrenceWriteSchema.nullable().optional(),
});
// z.input, not z.infer/z.output — see the note on NewConnection in
// connection.ts for why every insert type in this package uses it.
export type NewTrigger = z.input<typeof NewTriggerSchema>;

/**
 * `webhook.secretRef` with `secretRef` stripped — mirrors
 * `WebhookConfigSchema` with its one required field relaxed to optional and
 * then stripped — same shape a client should see as `ConnectionPublicSchema`
 * gives for a connection's `secretRef`. NOTE: plain `.omit({ secretRef: true })`
 * does NOT work here —
 * a `.catchall(z.unknown())` re-admits any key not in the declared shape
 * (that's the whole point of a catchall: pass unknown keys through), so an
 * omitted-from-the-shape `secretRef` still round-trips as an
 * unrecognized/catchall key. A `.transform()` that deletes the key from the
 * parsed output is the only way to actually drop it.
 *
 * IDEMPOTENT by design: `secretRef` is OPTIONAL on the INPUT here (unlike the
 * stored `WebhookConfigSchema`, where it is required). This projection must
 * accept BOTH a full stored config (server-side `toPublic`, secretRef present
 * → stripped) AND an already-public config that has no `secretRef` (a client
 * re-parsing a `TriggerPublic` response through the same shared schema — the
 * web API client does exactly this). If `secretRef` were required here, that
 * second parse would throw `expected string, received undefined`, breaking
 * every list/edit of a webhook trigger once its secret has been provisioned.
 */
export const WebhookPublicConfigSchema = WebhookConfigSchema.extend({
  // Derived from `WebhookConfigSchema` (single source of truth) rather than
  // re-declaring the shape: any future required field added to the stored
  // config is inherited here automatically, and `secretRef`'s own
  // `.min(1)` structural check is preserved (an empty secretRef is still
  // rejected). The ONLY relaxation is making `secretRef` OPTIONAL for the
  // idempotent re-parse case documented above. `.extend()` on a `.catchall`
  // object keeps the catchall, so unknown keys still pass through.
  secretRef: z.string().min(1).optional(),
}).transform((webhook) => {
  const { secretRef, ...rest } = webhook;
  void secretRef;
  return rest;
});
export type WebhookPublicConfig = z.infer<typeof WebhookPublicConfigSchema>;

/**
 * Client-facing projection with `webhook.secretRef` stripped, so a trigger
 * response never reveals which secret record backs its webhook. It's an
 * opaque ref rather than secret material, but this keeps the hardening
 * symmetric with `ConnectionPublicSchema` (defense-in-depth, not because the
 * ref alone is exploitable).
 */
export const TriggerPublicSchema = TriggerSchema.extend({
  webhook: WebhookPublicConfigSchema.nullable(),
});
export type TriggerPublic = z.infer<typeof TriggerPublicSchema>;
