import { z } from 'zod';

/**
 * #1481 OR32 — `POST /api/demo/seed`'s answer: where the demo's files live and
 * which pipelines it loaded, so a caller can open or run them without a second
 * list read. `created`/`reused` count every resource the seed manages
 * (connections, datasets, pipelines, triggers); a second seed reuses them all.
 */
export const DemoSeedPipelineSchema = z.object({
  /** The demo's own stable key for the pipeline, `'1'`..`'5'`. */
  key: z.string(),
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
