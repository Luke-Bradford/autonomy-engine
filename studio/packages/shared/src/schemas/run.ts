import { z } from 'zod';

export const RunStatusSchema = z.enum([
  'pending',
  'running',
  'success',
  'failure',
  'skipped',
  'waiting',
  'interrupted',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * One execution of a specific, immutable `PipelineVersion`. `leaseUntil` +
 * `heartbeatAt` back the boot-time reconciler's "could this `running` row
 * have survived a restart?" check (see the target architecture's Run &
 * execution model); both are epoch-ms, nullable until a run actually starts
 * executing.
 */
export const RunSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1).nullable(),
  pipelineVersionId: z.string().min(1),
  triggerId: z.string().min(1).nullable(),
  parentRunId: z.string().min(1).nullable(),
  params: z.record(z.string(), z.unknown()),
  status: RunStatusSchema,
  leaseUntil: z.number().int().nullable(),
  heartbeatAt: z.number().int().nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
});
export type Run = z.infer<typeof RunSchema>;

/**
 * Insert shape: server sets `id` + `startedAt`; `leaseUntil`/`heartbeatAt`/
 * `finishedAt` start `null` (the executor sets them as the run progresses,
 * not at creation); `status` defaults to `'pending'`.
 */
export const NewRunSchema = RunSchema.omit({
  id: true,
  status: true,
  leaseUntil: true,
  heartbeatAt: true,
  startedAt: true,
  finishedAt: true,
}).extend({
  status: RunStatusSchema.default('pending'),
});
// z.input, not z.infer/z.output — see the note on NewConnection in
// connection.ts for why every insert type in this package uses it (here it
// matters concretely: `status` has `.default('pending')`, so z.input is what
// keeps it optional for callers of `createRun`).
export type NewRun = z.input<typeof NewRunSchema>;

/**
 * The ONLY shape `updateRun` accepts: the run-lifecycle fields the
 * executor/boot-reconciler mutate as a run progresses. Every immutable
 * binding field (`pipelineVersionId`, `triggerId`, `parentRunId`, `params`,
 * `startedAt`) is deliberately absent — `.strict()` means a patch carrying
 * any of them (or any other unrecognized key) is rejected by `.parse()`
 * rather than silently stripped, so `updateRun` cannot be used to rewrite a
 * run's immutable bindings/provenance even by an `as any`/`as never` cast
 * around the TS type.
 */
export const RunLifecyclePatchSchema = RunSchema.pick({
  status: true,
  leaseUntil: true,
  heartbeatAt: true,
  finishedAt: true,
})
  .partial()
  .strict();
export type RunLifecyclePatch = z.infer<typeof RunLifecyclePatchSchema>;

/**
 * Append-only event log entry — the source of truth for run/node state (the
 * monitoring feed is a live tail of this table; late-joiners replay from it).
 * `seq` is monotonic per `runId`, assigned by the repository layer, never by
 * the caller. `payload` is intentionally `unknown`-shaped here: the event
 * envelope is generic across every `type` the engine/executor emit
 * (`node.started`, `node.output`, `run.finished`, …), each with its own
 * payload shape defined where that event is produced, not in this shared
 * envelope schema.
 */
export const RunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  type: z.string().min(1),
  payload: z.unknown(),
  ts: z.number().int(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

/** Insert shape: server sets `id`, `seq` (monotonic per run), and `ts`. */
export const NewRunEventSchema = RunEventSchema.omit({
  id: true,
  seq: true,
  ts: true,
});
export type NewRunEvent = z.input<typeof NewRunEventSchema>;

/**
 * #497 — WHERE THE PURE REDUCER'S `diagnostics` LAND.
 *
 * `reduce(state, event) → { state, commands, diagnostics }`. The first two are
 * durable (`run_events` + the `runs` row); the third had no production consumer
 * at all, so the "and say so" half of #480/#487/#488/#491 was written to nowhere.
 * This is that sink.
 *
 * NOT an engine event, and that is the load-bearing decision. `run_events` is a
 * log of FACTS; a diagnostic is a DERIVATION of (immutable doc + log). Storing a
 * derivation as a fact would put it in `EngineEventSchema` — re-folding every
 * already-bound log (the #443 authority question) — and make replay double-count
 * it (the fold re-derives the diagnostic AND meets the stored one). So it gets
 * its own table, off the event log, read by nothing the engine gates on.
 *
 * `phase` DISCRIMINATES THE DERIVATION, and is not decoration: `resume()` folds
 * NO event, so it is keyed at the log position it was derived AT — which is the
 * same `seq` as the fold that preceded it. Without `phase` in the key those two
 * distinct derivations collide, and the insert's `OR IGNORE` splices them into
 * one mis-attributed list.
 * - `fold`   — derived by folding the event at `seq`.
 * - `resume` — derived by `resume()` over the projection as of `seq`.
 * - `cap`    — the truncation marker (see `RUN_DIAGNOSTIC_CAP`), at `seq: -1`.
 */
export const RUN_DIAGNOSTIC_PHASES = ['fold', 'resume', 'cap'] as const;
export const RunDiagnosticPhaseSchema = z.enum(RUN_DIAGNOSTIC_PHASES);
export type RunDiagnosticPhase = z.infer<typeof RunDiagnosticPhaseSchema>;

export const RunDiagnosticSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  /**
   * The log position this was derived at. `-1` is the `cap` marker's sentinel —
   * deliberately BELOW every real `seq` (which start at 0), so the standard
   * `ORDER BY seq, ordinal` read surfaces "this list is incomplete" FIRST,
   * before the diagnostics it is a caveat on.
   */
  seq: z.number().int().gte(-1),
  phase: RunDiagnosticPhaseSchema,
  /** Index within the one `diagnostics[]` this row came from — ties the order. */
  ordinal: z.number().int().nonnegative(),
  message: z.string().min(1),
  ts: z.number().int(),
});
export type RunDiagnostic = z.infer<typeof RunDiagnosticSchema>;
