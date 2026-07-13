import { z } from 'zod';

export const TriggerModeSchema = z.enum(['manual', 'schedule', 'webhook', 'event', 'continuous']);
export type TriggerMode = z.infer<typeof TriggerModeSchema>;

export const ConcurrencyPolicySchema = z.enum(['queue', 'skip_if_running', 'parallel']);
export type ConcurrencyPolicy = z.infer<typeof ConcurrencyPolicySchema>;

export const ConcurrencySchema = z.object({
  policy: ConcurrencyPolicySchema,
  /** Only meaningful for `parallel`; omitted for `queue`/`skip_if_running`. */
  max: z.number().int().positive().optional(),
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
  pipelineVersionId: z.string().min(1),
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
