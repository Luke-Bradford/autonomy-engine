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
  leaseUntil: z.number().nullable(),
  heartbeatAt: z.number().nullable(),
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
