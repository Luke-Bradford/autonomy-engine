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
