import { z } from 'zod';
import { FailureKindSchema, NodeRunStatusSchema } from '../engine/types.js';
import { RunStatusSchema } from './run.js';

/**
 * #1484 OR35 M2/M3 — one ACTIVITY RUN: a single attempt of one activity, in one
 * iteration of its container, as `GET /api/runs/:id/activity-runs` projects it
 * from the run's event log (`server/src/run/activity-runs.ts`).
 *
 * The status is the REDUCER's vocabulary (`NodeRunStatus`), so the page names it
 * with the same words the graph and the node table use (`nodeStatus.ts`). An
 * attempt that failed and is being retried reads `failure`: that attempt did
 * fail, and the retry is its own row.
 *
 * Names are not here. Naming an activity is the web layer's job
 * (`activityLabel.ts`), so a row carries ids and the page labels them from the
 * version that ran.
 */

/** Which iteration of its container an attempt ran in. */
export const ActivityRunIterationSchema = z.object({
  /** The ForEach or Until loop the activity sits in. */
  containerId: z.string(),
  /** 0-based. The page shows it 1-based. */
  index: z.number().int().nonnegative(),
  /** How many items a ForEach had; `null` for a loop, whose count is open. */
  count: z.number().int().nonnegative().nullable(),
  /** The item, when it reads as a short label (a scalar, or an object's
   * `name`); `null` otherwise. */
  item: z.string().nullable(),
});
export type ActivityRunIteration = z.infer<typeof ActivityRunIterationSchema>;

/** The run an Execute Pipeline attempt called, when it exists and is the
 * caller's. */
export const ActivityRunChildSchema = z.object({
  id: z.string(),
  pipelineName: z.string().nullable(),
  status: RunStatusSchema,
});
export type ActivityRunChild = z.infer<typeof ActivityRunChildSchema>;

export const ActivityRunErrorSchema = z.object({
  message: z.string(),
  /** `null` when the log did not state a kind: old `node.failed` rows parse
   * with a default of `permanent`, which would be a claim the log never made. */
  kind: FailureKindSchema.nullable(),
  /** The adapter's finer reason (`rate_limit`), when it gave one. */
  code: z.string().nullable(),
  connectionId: z.string().nullable(),
});
export type ActivityRunError = z.infer<typeof ActivityRunErrorSchema>;

const count = z.number().int().nonnegative().nullable();

export const ActivityRunSchema = z.object({
  /** Unique within the response: the attempt id, or a synthetic key for a row
   * that had no attempt (a skip, or an activity a rerun reused). */
  key: z.string(),
  /** The id the events carry: the doc node id, or a parallel ForEach's
   * per-item instance key (`w@2`). */
  nodeId: z.string(),
  /** The doc node id in the version that ran. */
  activityId: z.string(),
  attemptId: z.string().nullable(),
  /** 1-based, counting policy retries within this iteration. */
  attempt: z.number().int().positive().nullable(),
  status: NodeRunStatusSchema,
  /** Carried over from the run this one reran, not executed here. */
  reused: z.boolean(),
  /** Epoch ms of the first logged event of the attempt. */
  startedAt: z.number().int().nullable(),
  /** Epoch ms of the event that settled it; `null` while it is unsettled. */
  finishedAt: z.number().int().nullable(),
  durationMs: count,
  iteration: ActivityRunIterationSchema.nullable(),
  /** The branch an If or Switch took. */
  branch: z.string().nullable(),
  rowsRead: count,
  rowsWritten: count,
  bytesRead: count,
  bytesWritten: count,
  childRunId: z.string().nullable(),
  childRun: ActivityRunChildSchema.nullable(),
  error: ActivityRunErrorSchema.nullable(),
});
export type ActivityRun = z.infer<typeof ActivityRunSchema>;

export const ActivityRunsResponseSchema = z.object({
  runId: z.string(),
  rows: z.array(ActivityRunSchema),
});
export type ActivityRunsResponse = z.infer<typeof ActivityRunsResponseSchema>;
