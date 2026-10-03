import { z } from 'zod';

/**
 * #1481 OR32 — `POST /api/demo/seed`'s answer: where the demo's files live and
 * which pipelines it loaded, so a caller can open or run them without a second
 * list read. `created` counts every row the seed wrote (connections, datasets,
 * pipelines, their versions, triggers); `reused` counts the resources it found
 * already there. A second seed creates nothing.
 */
export const DemoSeedPipelineSchema = z.object({
  /** The demo's own stable key for the pipeline, `'1'`..`'5'`. */
  key: z.enum(['1', '2', '3', '4', '5']),
  name: z.string(),
  pipelineId: z.string(),
  versionId: z.string(),
  /** The pipeline's manual trigger. */
  triggerId: z.string(),
});
export type DemoSeedPipeline = z.infer<typeof DemoSeedPipelineSchema>;

export const DemoSeedResponseSchema = z.object({
  /** The absolute directory holding this owner's demo files and warehouse. */
  demoDir: z.string(),
  created: z.number().int().nonnegative(),
  reused: z.number().int().nonnegative(),
  pipelines: z.array(DemoSeedPipelineSchema),
  /** The orchestrator's hourly schedule — created DISABLED. */
  scheduleTriggerId: z.string(),
});
export type DemoSeedResponse = z.infer<typeof DemoSeedResponseSchema>;

/**
 * #1481 OR32 — `GET /api/demo`: whether ANY of the demo's resources exist for
 * the caller (an archived demo pipeline counts). The web offers Load when this
 * is false and Remove when it is true, so a part-removed or archived demo,
 * which a load refuses, still has a way out.
 */
export const DemoStatusSchema = z.object({ loaded: z.boolean() });
export type DemoStatus = z.infer<typeof DemoStatusSchema>;

/**
 * #1481 OR32 — `DELETE /api/demo`'s answer. `removed` counts the demo's
 * connections, datasets, pipelines and triggers deleted; `runsRemoved` counts
 * the run history that went with the pipelines.
 */
export const DemoRemoveResponseSchema = z.object({
  removed: z.number().int().nonnegative(),
  runsRemoved: z.number().int().nonnegative(),
});
export type DemoRemoveResponse = z.infer<typeof DemoRemoveResponseSchema>;
