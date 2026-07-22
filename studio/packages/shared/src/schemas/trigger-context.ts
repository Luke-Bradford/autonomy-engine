import { z } from 'zod';

/**
 * The run's fire-time TRIGGER context (#5 S12), folded from the durable
 * `run.triggerContext` seed event and read by `${trigger.<field>}`.
 *
 * `triggerId` is the firing trigger — always present, because a context EXISTS
 * only for a trigger-launched run; a run with no trigger (a child `call_pipeline`
 * run, or a pre-S12 log) has `RunState.triggerContext === null` entirely, not a
 * context with a null id. `scheduledTime` is the INTENDED scheduled occurrence
 * (ISO-8601 UTC) for a `schedule` fire — the row's `dueAt`, never the
 * possibly-late actual delivery — and `null` for a manual/webhook/event fire.
 * `body` is the fire payload (webhook/event/run-now); `unknown` so it stays
 * deep-addressable as `json` and carries no static shape.
 *
 * Deliberately NOT `.datetime()` on `scheduledTime` — a durable field with a
 * format enum is a back-compat trap (same reasoning as `run.started.startedAt`).
 *
 * Lives in `schemas/` (not `engine/`) because it is a persisted DOMAIN shape:
 * the engine folds it into `RunState`, AND (#5 S6a) a durably `queued` run row
 * carries it in a `trigger_context` column so a fire held in the admission queue
 * still seeds `${trigger.scheduledTime}` with the occurrence that fired it when
 * it is finally admitted. Keeping the SSOT here lets `schemas/run.ts` reference
 * it without inverting the `schemas → engine` layering (engine depends on
 * schemas, never the reverse).
 */
export const TriggerContextSchema = z.object({
  triggerId: z.string(),
  scheduledTime: z.string().nullable(),
  body: z.unknown(),
});
export type TriggerContext = z.infer<typeof TriggerContextSchema>;
