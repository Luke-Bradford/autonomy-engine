import { z } from 'zod';
import { DependentTriggerSchema, DynamicDependentNodeSchema } from './connection-dependents.js';

/**
 * #1397 OR6 — `GET /api/pipelines/:id/dependents`: what deleting this pipeline
 * takes with it, read BEFORE the delete so the confirmation can name it.
 *
 * - `hasRuns` — any run of ANY of its versions, debug versions included. The
 *   delete is then refused (`runs.pipeline_version_id` is FK-restrict), so the
 *   surface says so instead of asking a question whose answer is a 409.
 * - `debugRunsOnly` — every one of those runs is of a DEBUG version (false when
 *   there are none). Those runs go after the server's debug window, and the
 *   pipeline can be deleted then (#1433), so the refusal says which it is.
 * - `debugRetentionDays` — that window, `DEBUG_RETENTION_DAYS` (`null` = kept
 *   forever), as the debug route reports it.
 * - `triggers` — every trigger bound to one of its versions, enabled or not.
 *   `triggers.pipeline_version_id` CASCADES, so a delete removes them outright
 *   (not "switches them off", as a connection delete does).
 * - `callers` / `dynamicCallers` — `call_pipeline` nodes in OTHER pipelines that
 *   name one of its versions literally, or by a `${}` that may resolve to one.
 *   The set walked is `candidateVersions` (the settled "what uses this?" set),
 *   minus archived pipelines, which cannot run. The node shape is the
 *   connection read's, reused rather than restated.
 */
export const PipelineDependentsResponseSchema = z.object({
  hasRuns: z.boolean(),
  debugRunsOnly: z.boolean(),
  debugRetentionDays: z.number().nonnegative().nullable(),
  triggers: z.array(DependentTriggerSchema),
  callers: z.array(DynamicDependentNodeSchema),
  dynamicCallers: z.array(DynamicDependentNodeSchema),
});
export type PipelineDependentsResponse = z.infer<typeof PipelineDependentsResponseSchema>;
