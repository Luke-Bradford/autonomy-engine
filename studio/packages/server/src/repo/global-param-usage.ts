import { eq } from 'drizzle-orm';
import type { GlobalParamUsage } from '@autonomy-studio/shared';
import { pipelineVersions } from '../db/schema.js';
import { getGlobalReads, getHeadVersionRef } from './pipeline-versions.js';
import { getPipeline, listPipelines } from './pipelines.js';
import { listTriggers } from './triggers.js';
import type { Db } from './types.js';

/**
 * #844 GL3 (spec GL-D4) — what reads the global `name` of `ownerId`, from the
 * versions' recorded `global_reads` (never a re-scan of the docs): each pipeline
 * whose LATEST version reads it, and each trigger whose PINNED version does. A
 * reference matches a name exactly, so this does too.
 *
 * Advisory, for the delete confirmation. Column-only reads: a legacy doc that no
 * longer parses cannot break it, but a `global_reads` column that does not decode
 * still throws, rather than report a reader as absent.
 */
export function globalParamUsage(db: Db, ownerId: string, name: string): GlobalParamUsage {
  const reads = (versionId: string): boolean =>
    (getGlobalReads(db, versionId) ?? []).some((r) => r.name === name);

  const pipelines: GlobalParamUsage['pipelines'] = [];
  for (const p of listPipelines(db, ownerId)) {
    const head = getHeadVersionRef(db, p.id);
    if (head === null || !reads(head.id)) continue;
    pipelines.push({
      pipelineId: p.id,
      pipelineName: p.name,
      versionId: head.id,
      version: head.version,
    });
  }

  const triggers: GlobalParamUsage['triggers'] = [];
  for (const t of listTriggers(db, { ownerId })) {
    if (t.pipelineVersionId === null || !reads(t.pipelineVersionId)) continue;
    const pinned = db
      .select({ pipelineId: pipelineVersions.pipelineId, version: pipelineVersions.version })
      .from(pipelineVersions)
      .where(eq(pipelineVersions.id, t.pipelineVersionId))
      .get();
    if (pinned === undefined) continue;
    triggers.push({
      triggerId: t.id,
      triggerName: t.name,
      enabled: t.enabled,
      pipelineName: getPipeline(db, pinned.pipelineId)?.name ?? pinned.pipelineId,
      versionId: t.pipelineVersionId,
      version: pinned.version,
    });
  }
  return { pipelines, triggers };
}
