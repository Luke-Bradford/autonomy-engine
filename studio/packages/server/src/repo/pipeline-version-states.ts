import { and, eq, inArray, max, sql } from 'drizzle-orm';
import { PipelinePublishedEventSchema, type PipelineVersionState } from '@autonomy-studio/shared';
import { pipelineVersions, pipelines, workspaceEvents } from '../db/schema.js';
import type { Db } from './types.js';

/**
 * #1476 OR28 — every live pipeline's saved head and active version, in three
 * bounded reads rather than one `GET …/active` + versions read per row.
 *
 * The head is the highest SAVED version (`debug = false`, the
 * `getHeadVersionRef` rule — a Debug is never the head, #1395). The active
 * pointer is `getActivePublishedVersion`'s projection done for every pipeline
 * at once: the latest `pipeline.published` event per pipeline `resourceId` by
 * `seq` (the per-owner append order, never wall-clock). Events key on the
 * `resourceId`, not the row id, so the join is through it.
 *
 * An active version id is turned into a number only when it is a version OF
 * THAT PIPELINE; otherwise `version: null` — "not listed" — rather than another
 * pipeline's number. Owner-scoped throughout: authentication ≠ authorization.
 */
export function listPipelineVersionStates(db: Db, ownerId: string): PipelineVersionState[] {
  const heads = db
    .select({
      pipelineId: pipelines.id,
      resourceId: pipelines.resourceId,
      latestVersion: max(pipelineVersions.version),
    })
    .from(pipelines)
    .leftJoin(
      pipelineVersions,
      and(eq(pipelineVersions.pipelineId, pipelines.id), eq(pipelineVersions.debug, false)),
    )
    .where(and(eq(pipelines.ownerId, ownerId), eq(pipelines.archived, false)))
    .groupBy(pipelines.id)
    .all();

  const pipelineOf = sql<string>`json_extract(${workspaceEvents.payload}, '$.pipeline')`;
  const published = () =>
    and(eq(workspaceEvents.ownerId, ownerId), eq(workspaceEvents.type, 'pipeline.published'));
  const latestSeqs = db
    .select({ seq: max(workspaceEvents.seq) })
    .from(workspaceEvents)
    .where(published())
    .groupBy(pipelineOf);
  const activeByResource = new Map<string, string>();
  for (const row of db
    .select({ payload: workspaceEvents.payload })
    .from(workspaceEvents)
    .where(and(published(), inArray(workspaceEvents.seq, latestSeqs)))
    .all()) {
    const event = PipelinePublishedEventSchema.parse(row.payload);
    activeByResource.set(event.pipeline, event.to);
  }

  const activeIds = [...activeByResource.values()];
  const versionOf = new Map<string, { pipelineId: string; version: number }>();
  if (activeIds.length > 0) {
    for (const row of db
      .select({
        id: pipelineVersions.id,
        pipelineId: pipelineVersions.pipelineId,
        version: pipelineVersions.version,
      })
      .from(pipelineVersions)
      .where(inArray(pipelineVersions.id, activeIds))
      .all()) {
      versionOf.set(row.id, row);
    }
  }

  return heads.map((h) => {
    const versionId = h.resourceId === null ? undefined : activeByResource.get(h.resourceId);
    const found = versionId === undefined ? undefined : versionOf.get(versionId);
    return {
      pipelineId: h.pipelineId,
      latestVersion: h.latestVersion,
      active:
        versionId === undefined
          ? null
          : {
              versionId,
              version: found?.pipelineId === h.pipelineId ? found.version : null,
            },
    };
  });
}
