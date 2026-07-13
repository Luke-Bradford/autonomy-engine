import { z } from 'zod';

export const TriggerModeSchema = z.enum(['manual', 'schedule', 'webhook', 'event', 'continuous']);
export type TriggerMode = z.infer<typeof TriggerModeSchema>;

export const ConcurrencyPolicySchema = z.enum(['queue', 'skip_if_running', 'parallel']);
export type ConcurrencyPolicy = z.infer<typeof ConcurrencyPolicySchema>;

export const ConcurrencySchema = z
  .object({
    policy: ConcurrencyPolicySchema,
    /**
     * The cap on simultaneous runs — REQUIRED for `parallel` (an omitted cap
     * would be an unbounded fan-out footgun), and FORBIDDEN for
     * `queue`/`skip_if_running` (both are implicitly single-slot, so a `max`
     * there is meaningless and rejected rather than silently ignored). The
     * P4 scheduler/launcher reads this to admit or gate a fire.
     */
    max: z.number().int().positive().optional(),
  })
  .superRefine((c, ctx) => {
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
export type Concurrency = z.infer<typeof ConcurrencySchema>;

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

export const NewTriggerSchema = TriggerSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
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
