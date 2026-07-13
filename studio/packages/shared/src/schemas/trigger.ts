import { z } from 'zod';

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
  params: z.record(z.string(), z.unknown()),
  mode: TriggerModeSchema,
  schedule: z.string().min(1).nullable(),
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
});
// z.input, not z.infer/z.output — see the note on NewConnection in
// connection.ts for why every insert type in this package uses it.
export type NewTrigger = z.input<typeof NewTriggerSchema>;

/**
 * `webhook.secretRef` with `secretRef` stripped — mirrors
 * `WebhookConfigSchema` minus its one required field, same shape a client
 * should see as `ConnectionPublicSchema` gives for a connection's
 * `secretRef`. NOTE: plain `.omit({ secretRef: true })` does NOT work here —
 * `WebhookConfigSchema`'s `.catchall(z.unknown())` re-admits any key not in
 * the declared shape (that's the whole point of a catchall: pass unknown
 * keys through), so an omitted-from-the-shape `secretRef` still round-trips
 * as an unrecognized/catchall key. A `.transform()` that deletes the key
 * from the parsed output is the only way to actually drop it.
 */
export const WebhookPublicConfigSchema = WebhookConfigSchema.transform((webhook) => {
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
