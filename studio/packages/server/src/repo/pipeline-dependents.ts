import { eq } from 'drizzle-orm';
import { interpolationMode, type PipelineDependentsResponse } from '@autonomy-studio/shared';
import { pipelineVersions, runs } from '../db/schema.js';
import { candidateVersions } from './candidate-versions.js';
import { listTriggersByPipeline } from './triggers.js';
import type { Db } from './types.js';

/**
 * #1397 OR6 — what deleting `pipelineId` takes with it (see
 * `PipelineDependentsResponseSchema` for what each bucket means).
 *
 * The version ids are read straight off `pipeline_versions` rather than through
 * `listPipelineVersions`, which hides DEBUG versions: a debug version's runs are
 * kept for the retention window and block the delete exactly like any other
 * run, so `hasRuns` must see them or the dialog asks a question the server then
 * refuses.
 */
export function pipelineDependents(
  db: Db,
  ownerId: string,
  pipelineId: string,
): PipelineDependentsResponse {
  const hasRuns =
    db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
      .where(eq(pipelineVersions.pipelineId, pipelineId))
      .limit(1)
      .all().length > 0;

  const versionIds = new Set(
    db
      .select({ id: pipelineVersions.id })
      .from(pipelineVersions)
      .where(eq(pipelineVersions.pipelineId, pipelineId))
      .all()
      .map((row) => row.id),
  );

  const triggers = listTriggersByPipeline(db, pipelineId).map((t) => ({ id: t.id, name: t.name }));

  const callers: PipelineDependentsResponse['callers'] = [];
  const dynamicCallers: PipelineDependentsResponse['dynamicCallers'] = [];
  for (const { pipeline, version } of candidateVersions(db, ownerId)) {
    // A self-call goes with the pipeline; an archived caller cannot run, so it
    // breaks nothing (the connection read's rule, `dependentNodes`).
    if (pipeline.id === pipelineId || pipeline.archived) continue;
    for (const node of version.nodes) {
      if (node.call === undefined) continue;
      const where = {
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        versionId: version.id,
        version: version.version,
        nodeId: node.id,
        nodeType: node.type,
      };
      if (interpolationMode(node.call.pipelineVersionId).mode !== 'literal') {
        dynamicCallers.push(where);
      } else if (versionIds.has(node.call.pipelineVersionId)) {
        callers.push(where);
      }
    }
  }
  return { hasRuns, triggers, callers, dynamicCallers };
}
