import {
  type DatasetReferenceBinding,
  type Pipeline,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { getWorkspaceGit } from './workspace-git.js';
import { getActivePublishedVersion } from './workspace-events.js';
import { listPipelines } from './pipelines.js';
import { listPipelineVersions } from './pipeline-versions.js';
import { listTriggers } from './triggers.js';
import type { Db } from './types.js';

/**
 * WHICH PIPELINE VERSIONS AN OPERATOR-FACING "WHAT USES THIS?" READ WALKS:
 *
 *   latest-of-each-pipeline ∪ active-published (git mode) ∪ trigger-pinned
 *
 * — the three ways a version fires on its own. The rationale, and what it
 * deliberately gives up (historical versions none of the three binds), is
 * stated where it was first decided: `datasetReferences` in
 * `datamove/dataset-references.ts` (M9). Lifted here by #1252 so the connection
 * dependents read (`run/connection-readiness.ts`) answers the same question
 * with the same set rather than a third opinion of its own.
 *
 * A READ-SURFACE set, not a gate's: it is unfiltered by `enabled`, and its
 * `listPipelines(db, ownerId)` root omits shared (null-owner) pipelines. A walk
 * that must be at parity with a WRITE (`regateTriggersForConnection`) must not
 * use it — see `connectionDependents`.
 *
 * `boundBy` reuses M9's `DatasetReferenceBinding` enum because it IS that enum
 * — the name is M9's, the three reasons are this function's.
 */
export interface Candidate {
  readonly pipeline: Pipeline;
  readonly version: PipelineVersion;
  readonly boundBy: DatasetReferenceBinding[];
  readonly triggerIds: string[];
}

/**
 * ONE `listPipelineVersions` pass per pipeline, and the rest resolved out of it
 * by id.
 *
 * Not an optimisation of a cheap call — `getLatestPipelineVersion` DELEGATES to
 * `listPipelineVersions` and so already parses every version's whole doc
 * (`repo/pipeline-versions.ts`, whose sibling docblock warns about exactly that
 * O(versions × doc) cost). Calling it per pipeline and `getPipelineVersion` per
 * trigger would re-parse docs this function has already parsed.
 */
export function candidateVersions(db: Db, ownerId: string): Candidate[] {
  // Owner-scoped on BOTH sides. `listPipelines(db, ownerId)` also excludes
  // null-owner (shared) pipelines, which are therefore never listed — stated
  // because it is a real bound, not because it is a leak: a shared pipeline
  // belongs to no owner's Manage view.
  const gitMode = getWorkspaceGit(db, ownerId) !== null;
  // Filtered in SQL, per `ListTriggersFilter.ownerId`'s docblock ("never loaded
  // then filtered in the route").
  const triggersByVersion = new Map<string, string[]>();
  for (const trigger of listTriggers(db, { ownerId })) {
    if (trigger.pipelineVersionId === null) continue;
    const pinned = triggersByVersion.get(trigger.pipelineVersionId);
    if (pinned) pinned.push(trigger.id);
    else triggersByVersion.set(trigger.pipelineVersionId, [trigger.id]);
  }

  const candidates: Candidate[] = [];
  for (const pipeline of listPipelines(db, ownerId)) {
    const versions = listPipelineVersions(db, pipeline.id);
    if (versions.length === 0) continue;

    const reasons = new Map<string, DatasetReferenceBinding[]>();
    const add = (versionId: string, reason: DatasetReferenceBinding): void => {
      const existing = reasons.get(versionId);
      if (existing) existing.push(reason);
      else reasons.set(versionId, [reason]);
    };

    // `listPipelineVersions` is ordered oldest-first, so the last row is latest.
    add(versions[versions.length - 1]!.id, 'latest');
    if (gitMode) {
      const active = getActivePublishedVersion(db, ownerId, pipeline.resourceId);
      // `to` is the published version's DB id — the value `resolveBindToActive`
      // hands straight to a trigger's `pipelineVersionId`.
      if (active !== null) add(active.to, 'active');
    }
    for (const version of versions) {
      if (triggersByVersion.has(version.id)) add(version.id, 'trigger');
    }

    for (const version of versions) {
      const boundBy = reasons.get(version.id);
      if (boundBy === undefined) continue;
      candidates.push({
        pipeline,
        version,
        boundBy,
        triggerIds: triggersByVersion.get(version.id) ?? [],
      });
    }
  }
  return candidates;
}

