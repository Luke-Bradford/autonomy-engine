import { and, eq, inArray, max } from 'drizzle-orm';
import type { PipelineVersionState } from '@autonomy-studio/shared';
import { pipelineVersions, pipelines } from '../db/schema.js';
import type { Db } from './types.js';
import { listActivePublishedVersionIds } from './workspace-events.js';

/**
 * #1476 OR28 — every live pipeline's saved head and active version, in three
 * bounded reads rather than one `GET …/active` + versions read per row.
 *
 * The head is the highest SAVED version (`debug = false`, the
 * `getHeadVersionRef` rule — a Debug is never the head, #1395). The active
 * pointer is `listActivePublishedVersionIds`, `getActivePublishedVersion`'s
 * projection for every live pipeline at once. Events key on the `resourceId`,
 * not the row id, so the join is through it.
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

  const activeByResource = listActivePublishedVersionIds(
    db,
    ownerId,
    heads.flatMap((h) => (h.resourceId === null ? [] : [h.resourceId])),
  );

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
      // A Debug is never published (#1395); were one named, it reads "not listed".
      .where(and(inArray(pipelineVersions.id, activeIds), eq(pipelineVersions.debug, false)))
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
