import {
  classifySinkAgreement,
  classifySourceAgreement,
  interpolationMode,
  projectMappingRows,
  type ActivityCatalogEntry,
  type Dataset,
  type DatasetDynamicReference,
  type DatasetReference,
  type DatasetReferenceBinding,
  type DatasetReferenceEnd,
  type DatasetReferencesResponse,
  type Node,
  type Pipeline,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { catalog } from '@autonomy-studio/shared';
import { getWorkspaceGit } from '../repo/workspace-git.js';
import { getActivePublishedVersion } from '../repo/workspace-events.js';
import { listPipelines } from '../repo/pipelines.js';
import { listPipelineVersions } from '../repo/pipeline-versions.js';
import { listTriggers } from '../repo/triggers.js';
import type { Db } from '../repo/types.js';

/** Injectable for tests, exactly as `run/connection-readiness.ts` does it. */
export type CatalogOverride = Pick<typeof catalog, 'get'>;

const ENDS: readonly DatasetReferenceEnd[] = ['source', 'sink'];

/**
 * #996 M9 (#1185) — the dataset→consumers REVERSE walk behind
 * `GET /api/datasets/:id/references`.
 *
 * §2.1's consequence 2 is that "editing a dataset can invalidate a pinned
 * mapping", and its second compensating control is "the dataset detail page
 * listing the pipelines whose mappings reference it and flagging those that no
 * longer agree. A dataset cannot cheaply know its consumers at save time, so
 * this is a read-side affordance, not a write-side gate." This is that walk. It
 * REFUSES NOTHING and is called from no gate.
 *
 * SHAPED LIKE `run/connection-readiness.ts`, for the same structural reason it
 * spells out: the dependency link lives INSIDE the version's JSON
 * (`Node.datasetIds`), not in a column, so there is no cheap reverse-join and
 * every candidate version's doc is walked.
 *
 * WHICH VERSIONS ARE CANDIDATES is the one real decision here, and it is a
 * bound, stated rather than hidden — the page says it too:
 *
 *   latest-of-each-pipeline ∪ active-published (git mode) ∪ trigger-pinned
 *
 * Those are the three ways a version fires on its own. `latest` is what a
 * DB-only workspace binds a new trigger to and what an author edits against;
 * `active` is what a GIT-mode workspace binds to instead (`resolveBindToActive`,
 * `routes/triggers.ts`), so omitting it would report "nothing references this"
 * over precisely the version that runs; `trigger` is needed because a trigger
 * records `pipelineVersionId` ONCE at creation and can therefore lag both.
 *
 * HISTORICAL versions bound by none of the three are deliberately EXCLUDED, and
 * this is where it differs from `readyVersionResourceIds`, which walks every
 * owned version. That one feeds a GATE, where missing a dispatchable version is
 * a correctness fault; this is a read surface, where two hundred versions of one
 * pipeline is noise that buries the answer. A rerun-from-failed of an old
 * version is the case this gives up, and it is not left unprotected: §7's
 * dispatch gate refuses it `permanent`, naming the column.
 */
export function datasetReferences(
  db: Db,
  ownerId: string,
  dataset: Dataset,
  activityCatalog: CatalogOverride = catalog,
): DatasetReferencesResponse {
  const references: DatasetReference[] = [];
  const dynamic: DatasetDynamicReference[] = [];

  for (const { pipeline, version, boundBy, triggerIds } of candidateVersions(db, ownerId)) {
    for (const node of version.nodes) {
      for (const { end, ref } of datasetRefsOfNode(node, activityCatalog.get(node.type))) {
        // A `${}` end resolves at dispatch and cannot be matched here. It is
        // REPORTED rather than skipped: it may well address this dataset, and
        // dropping it would let the page answer "nothing references this"
        // confidently and wrongly.
        if (interpolationMode(ref).mode !== 'literal') {
          dynamic.push({
            pipelineId: pipeline.id,
            pipelineName: pipeline.name,
            versionId: version.id,
            version: version.version,
            nodeId: node.id,
            nodeType: node.type,
            end,
          });
          continue;
        }
        if (ref !== dataset.id) continue;

        references.push({
          pipelineId: pipeline.id,
          pipelineName: pipeline.name,
          pipelineArchived: pipeline.archived,
          versionId: version.id,
          version: version.version,
          boundBy,
          triggerIds,
          nodeId: node.id,
          nodeType: node.type,
          end,
          ...agreementOf(node, end, dataset, activityCatalog.get(node.type)),
        });
      }
    }
  }
  return { references, dynamic };
}

interface Candidate {
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
function candidateVersions(db: Db, ownerId: string): Candidate[] {
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

/**
 * The dataset refs this node contributes, derived from the CATALOG — the
 * `connectionRefsOfNode` analogue, and gated for the same reason.
 *
 * Presence of `Node.datasetIds` alone is not enough on two counts. A stray
 * `datasetIds` on an activity that declares none has no mapping to read, so it
 * would be reported as an unreadable `copy`, which manufactures a fault rather
 * than finding one. And `datasetKinds.sink` is already OPTIONAL in the catalog
 * type (M12's `lookup` reads a source only), so an end must be asked for rather
 * than assumed.
 */
function datasetRefsOfNode(
  node: Node,
  entry: ActivityCatalogEntry | undefined,
): { end: DatasetReferenceEnd; ref: string }[] {
  const kinds = entry?.datasetKinds;
  if (kinds === undefined) return [];
  const bound = node.datasetIds;
  if (bound === undefined) return [];
  return ENDS.flatMap((end) => {
    if (end === 'sink' && kinds.sink === undefined) return [];
    // M12 slice 1 (#1220) — the `as string | undefined` this line used to carry
    // is gone: `NodeSchema.datasetIds.sink` is now genuinely optional, so the
    // narrowing is the real type rather than an assertion about one. A cast that
    // no longer casts is a claim the compiler has stopped checking.
    const ref = bound[end];
    return ref === undefined ? [] : [{ end, ref }];
  });
}

type Verdict = Pick<
  DatasetReference,
  'status' | 'agreement' | 'unreadable' | 'unnamedRows' | 'mappedRows'
>;

/**
 * The node's pinned mapping read against the dataset's DECLARED columns.
 *
 * The mapping is taken as an untyped blob and PROJECTED, not re-parsed with
 * `CopyMappingSchema`. Re-parsing is a recorded rejected alternative
 * (`catalog/copy-config.ts` ~:100): that schema is `.strict()` with a required
 * `type`, so it refuses far more than the cross-row rules the #444 write gate
 * actually admitted, and would report a pinned, runnable mapping as broken.
 * `unreadable` is therefore reserved for a mapping that is absent or is not an
 * array — the two states from which no reading can be made at all.
 */
function agreementOf(
  node: Node,
  end: DatasetReferenceEnd,
  dataset: Dataset,
  entry: ActivityCatalogEntry | undefined,
): Verdict {
  // #1221 M12 slice 2 — an activity that declares no SINK dataset moves nothing
  // between two ends, so it has no column mapping and no agreement to compute.
  // `lookup` is the first, and this rung exists because without it every lookup
  // node on this page would read as `unreadable — this node declares no column
  // mapping`: a fault manufactured out of a correct pipeline, which is precisely
  // what `datasetRefsOfNode`'s docblock above refuses to do by presence-gating.
  //
  // Decided from the CATALOG and not from the node, on `datasetRefsOfNode`'s own
  // reasoning: a node's shape is operator input, so reading "has no `mapping`
  // key" off it would let a `copy` whose mapping was deleted quietly downgrade
  // from a reported fault to "nothing to check here".
  //
  // The rule is "declares no sink dataset ⇒ no mapping", which is exact for
  // every entry that exists. An activity that one day declares a sink AND no
  // mapping, or a mapping AND no sink, breaks the correlation and must make the
  // fact explicit on the entry rather than widen this inference.
  if (entry !== undefined && entry.datasetKinds?.sink === undefined) {
    return {
      status: 'not_applicable',
      agreement: null,
      unreadable: null,
      unnamedRows: 0,
      mappedRows: 0,
    };
  }
  const mapping = node.config.mapping;
  if (!Array.isArray(mapping)) {
    return {
      status: 'unreadable',
      agreement: null,
      unreadable:
        mapping === undefined
          ? 'this node declares no column mapping'
          : 'this node’s column mapping is not a list of rows',
      unnamedRows: 0,
      mappedRows: 0,
    };
  }

  const projected = projectMappingRows(mapping);
  const agreement =
    end === 'source'
      ? classifySourceAgreement(
          projected.rows,
          dataset.columns.map((c) => c.name),
        )
      : classifySinkAgreement(projected.rows, dataset.columns);

  return {
    status: agreement.agrees ? 'agrees' : 'disagrees',
    agreement,
    unreadable: null,
    unnamedRows: projected.unnamed,
    mappedRows: projected.rows.length,
  };
}
