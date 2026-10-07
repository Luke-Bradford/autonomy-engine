import { z } from 'zod';
import { RunStatusSchema, type RunStatus } from './run.js';
import { TriggerModeSchema } from './trigger.js';

/**
 * #1569 OR37 — the pipelines grid's run window: the success rate, run count and
 * durations are over the runs that STARTED in the last this-many days. One
 * constant, read by the server's query and named by the grid's headers.
 */
export const PIPELINE_SUMMARY_WINDOW_DAYS = 7;

/**
 * #1569 — how a finished run counts toward a pipeline's success rate. `failed`
 * is every way a run did not do its job: `interrupted` is a failure, as the
 * Monitor's tone says. `cancelled` (stopped on purpose) and `skipped` are
 * neither, so they are left out of the rate rather than dragging it down.
 */
export const SUMMARY_SUCCEEDED_STATUSES = ['success'] as const satisfies readonly RunStatus[];
export const SUMMARY_FAILED_STATUSES = [
  'failure',
  'interrupted',
] as const satisfies readonly RunStatus[];

/**
 * #1569 OR37 — one live pipeline's row facts for the pipelines grid, read in one
 * owner-scoped batch (`GET /api/pipelines/summaries`), never per row. The
 * Monitor's M5 overview reads the same model.
 *
 * Runs bound to a Debug version are not counted: they are the editor's
 * unsaved-draft runs (ADF's Debug/Triggered split), so "last run" and the rate
 * describe the saved pipeline. No run params or outputs are carried.
 */
export const PipelineSummarySchema = z.object({
  pipelineId: z.string().min(1),
  /** The newest run by start time, `null` when it has never run. */
  lastRun: z
    .object({
      runId: z.string().min(1),
      status: RunStatusSchema,
      startedAt: z.number().int(),
      finishedAt: z.number().int().nullable(),
    })
    .nullable(),
  /** Over runs started in the last `days` days. */
  window: z.object({
    days: z.number().int().positive(),
    /** Every run started in the window, finished or not. */
    runs: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    /** `succeeded / (succeeded + failed)`, `null` when neither happened. */
    successRate: z.number().min(0).max(1).nullable(),
    /** Nearest-rank percentiles of the succeeded and failed runs' durations. */
    p50Ms: z.number().int().nonnegative().nullable(),
    p95Ms: z.number().int().nonnegative().nullable(),
  }),
  /** Triggers bound to any version of the pipeline. */
  triggers: z.object({
    total: z.number().int().nonnegative(),
    enabled: z.number().int().nonnegative(),
    items: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        mode: TriggerModeSchema,
        enabled: z.boolean(),
      }),
    ),
  }),
  /** The earliest armed schedule or tumbling-window fire, `null` when none. */
  nextFireAt: z.number().int().nullable(),
  /** Node count of the latest saved version, `null` when nothing is saved. */
  activities: z.number().int().nonnegative().nullable(),
  /** The later of the pipeline row's last change and its latest saved version. */
  modifiedAt: z.number().int(),
});
export type PipelineSummary = z.infer<typeof PipelineSummarySchema>;

/** `GET /api/pipelines/summaries` — one entry per live (unarchived) pipeline. */
export const PipelineSummariesResponseSchema = z.object({
  items: z.array(PipelineSummarySchema),
});
export type PipelineSummariesResponse = z.infer<typeof PipelineSummariesResponseSchema>;
