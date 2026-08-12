import {
  CATALOG_VERSION,
  ConnectionExportDataSchema,
  ExportEnvelopeSchema,
  PipelineExportDataSchema,
  SCHEMA_VERSION,
  TriggerExportDataSchema,
  WebhookPublicConfigSchema,
  canonicalStringify,
  interpolationMode,
  pipelineVersionContentForm,
  resourceFilePaths,
  type Connection,
  type ExportEnvelope,
  type Node,
  type NodeExport,
  type Pipeline,
  type PipelineVersion,
  type PipelineVersionExport,
  type Trigger,
} from '@autonomy-studio/shared';
import {
  getLatestPipelineVersion,
  listConnections,
  listPipelineVersions,
  listPipelines,
  listTriggers,
} from '../repo/index.js';
import type { Db } from '../repo/types.js';

/**
 * #3 G3a — the workspace-git EXPORT fork: turn a workspace's DB working copy
 * into the canonical JSON files a Commit lands in the managed checkout. This
 * is DISTINCT from `portability/export.ts` (the PORTABLE, cross-workspace copy
 * primitive) in two load-bearing ways, both from Foundation Spec #3:
 *
 * 1. **Latest version only.** Per the settled working-copy model (#662 (a)):
 *    Commit serializes each pipeline's LATEST immutable version, not the whole
 *    DB version trail — git history IS the version trail, so bundling all
 *    versions would double-track it.
 * 2. **Internal refs are PRESERVED and remapped to `resourceId`s**, not nulled.
 *    A same-workspace re-import mints a NEW DB version id under the SAME
 *    `resourceId` (G1: "workspace-git import PRESERVES ids"), so a ref stored
 *    as a concrete DB id would dangle on the first round-trip. Literal
 *    `node.connectionId` → the connection's `resourceId`; literal
 *    `node.call.pipelineVersionId` / `trigger.pipelineVersionId` → that
 *    version's `resourceId`. A `${}` DYNAMIC ref (classified by the SSOT
 *    `interpolationMode`, exactly as export.ts does for `connectionId`) is
 *    PRESERVED verbatim — it routes on run values, not an env-specific row.
 *
 * The remap resolves every id through OWNER-SCOPED maps built from the owner's
 * own resources; a non-null id that fails to resolve to an owned row FAILS the
 * Commit loudly (never coerced to `null` — #473: an absent fact is not a benign
 * default). `null`-stays-`null` only when the source was already absent.
 *
 * `exportedAt` — the one volatile envelope field (`Date.now()` in export.ts) —
 * is normalized to `0` here (a valid `int`, so the file still re-parses through
 * `ExportEnvelopeSchema`) so identical DB content serializes to identical
 * bytes: the git file writer diffs these files and the G4/G5 import classifier
 * will hash them (the G1 built-block "exportedAt churn trap").
 */

/**
 * A resource references (via a NON-null, LITERAL id) another resource that
 * isn't in this owner's workspace — a corrupt/cross-owner id the serializer
 * refuses to paper over with a `null`. Surfaced by the Commit route as an
 * internal error (it means a broken DB reference, not user input).
 */
export class WorkspaceSerializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSerializeError';
  }
}

/** One serialized file: its repo-relative path and its canonical JSON bytes.
 *
 * `blobSha` (#3 G6b) is the git blob SHA of this file at the read ref — present
 * ONLY when the file came from the git reader (`readWorkspaceFilesAtRef`), so the
 * import can stamp a minted version's `source_blob_sha` provenance. It is absent
 * on the DB-snapshot path (`serializeWorkspace`, which never touches git); that
 * snapshot is only ever the reconcile BASELINE and never mints, so absent is
 * fine — no consumer of the snapshot reads `blobSha`. */
export interface WorkspaceFile {
  path: string;
  contents: string;
  blobSha?: string;
}

export interface OwnerRefMaps {
  /** Every owned pipeline VERSION's DB id → its stable `resourceId`. */
  versionResourceId: Map<string, string>;
  /** Every owned connection's DB id → its stable `resourceId`. */
  connectionResourceId: Map<string, string>;
}

function buildOwnerRefMaps(db: Db, pipelines: Pipeline[], connections: Connection[]): OwnerRefMaps {
  const versionResourceId = new Map<string, string>();
  for (const pipeline of pipelines) {
    for (const version of listPipelineVersions(db, pipeline.id)) {
      versionResourceId.set(version.id, version.resourceId);
    }
  }
  const connectionResourceId = new Map<string, string>();
  for (const connection of connections) {
    connectionResourceId.set(connection.id, connection.resourceId);
  }
  return { versionResourceId, connectionResourceId };
}

/**
 * Remap a STORED DB node's concrete ids back to stable `resourceId`s (the
 * forward direction serialize uses), so a stored version can be compared to a
 * branch version in the SAME resourceId-space. `${}` dynamic refs stay verbatim;
 * an absent `connectionId` becomes `null` (the export shape). An id absent from
 * the owner-scoped reverse map is kept as-is (defensive — an owned row's refs
 * always map; a mismatch just makes the content forms differ, never a false
 * "unchanged"). Reads no DB — pure over the passed maps.
 *
 * That defensiveness is load-bearing rather than belt-and-braces, and it is why
 * this lives here rather than being re-derived from `serializePipeline`: a
 * HISTORIC version can name a connection that has since been hard-deleted, and
 * `remapRef` (the commit-direction path) THROWS on an unmapped literal. Throwing
 * is right when writing a branch — a commit must not emit a dangling ref — and
 * wrong when merely comparing two versions, where the honest answer is "these
 * forms differ".
 */
function forwardRemapNode(
  node: Node,
  connRidByDbId: Map<string, string>,
  versionRidByDbId: Map<string, string>,
): NodeExport {
  const { connectionId, call, ...rest } = node;
  let connExport: string | null;
  if (connectionId === undefined) connExport = null;
  else if (interpolationMode(connectionId).mode !== 'literal') connExport = connectionId;
  else connExport = connRidByDbId.get(connectionId) ?? connectionId;

  const exported: NodeExport = { ...rest, connectionId: connExport };
  if (call) {
    const ref = call.pipelineVersionId;
    const refExport =
      interpolationMode(ref).mode !== 'literal' ? ref : (versionRidByDbId.get(ref) ?? ref);
    exported.call = { ...call, pipelineVersionId: refExport };
  }
  return exported;
}

/** The content form of a STORED DB version, in resourceId-space — the baseline
 * the branch's incoming version is compared against to decide "mint a new
 * version vs no-op vs a divergent-content contradiction". Uses the reverse maps
 * so archived pipelines' versions (omitted from the serialize snapshot) are
 * comparable too.
 *
 * #983 — lives here, beside the export direction it inverts, because the reconcile
 * PREVIEW and the reconcile APPLY both have to answer "is the branch's version
 * byte-identical to the row its id names", and two implementations of that
 * question could disagree about the one comparison the whole `superseded`
 * decision turns on. Exported for the same reason `serializeTrigger` is.
 */
export function dbVersionForm(
  version: PipelineVersion,
  connRidByDbId: Map<string, string>,
  versionRidByDbId: Map<string, string>,
): string {
  const exportForm = {
    ...version,
    nodes: version.nodes.map((n) => forwardRemapNode(n, connRidByDbId, versionRidByDbId)),
  } as PipelineVersionExport;
  return pipelineVersionContentForm(exportForm);
}

/** #983 — one owned pipeline version, as the reconcile preview needs to see it:
 * which pipeline owns it, and its stored content form in resourceId-space. */
export interface OwnedVersionForm {
  pipelineResourceId: string;
  contentForm: string;
}

/**
 * #983 — the owned pipeline VERSIONS named by `versionResourceIds`, keyed by
 * `resourceId`. This is the lookup the reconcile APPLY does inline
 * (`versionRowByRid`), lifted so the read-only PREVIEW can reach the same facts
 * and stop reporting `update` for a version this workspace already holds.
 *
 * Scoped to the ids the caller asks for — in practice the handful the incoming
 * BRANCH names — rather than every version ever authored: the identity walk is
 * the same one `buildOwnerRefMaps` already does, but a content form per owned
 * version would make the cost of previewing grow with a workspace's whole
 * history, for rows no preview will look at. The apply keeps that cost lazy for
 * the same reason.
 *
 * Covers ARCHIVED pipelines' versions too (`listPipelines` is unfiltered), so a
 * version is judged against the row that owns it even when the serialize
 * snapshot omits that row.
 */
export function ownedVersionForms(
  db: Db,
  ownerId: string,
  versionResourceIds: ReadonlySet<string>,
): Map<string, OwnedVersionForm> {
  const forms = new Map<string, OwnedVersionForm>();
  if (versionResourceIds.size === 0) return forms;

  const pipelines = listPipelines(db, ownerId);
  const maps = buildOwnerRefMaps(db, pipelines, listConnections(db, ownerId));
  for (const pipeline of pipelines) {
    for (const version of listPipelineVersions(db, pipeline.id)) {
      if (!versionResourceIds.has(version.resourceId)) continue;
      forms.set(version.resourceId, {
        pipelineResourceId: pipeline.resourceId,
        contentForm: dbVersionForm(version, maps.connectionResourceId, maps.versionResourceId),
      });
    }
  }
  return forms;
}

/**
 * Remaps a LITERAL DB id to a `resourceId` via an owner-scoped map. A `${}`
 * dynamic value is returned unchanged (portable already). `null` stays `null`.
 * A non-null literal absent from the map throws — never a silent `null`.
 */
function remapRef(
  value: string | null | undefined,
  map: Map<string, string>,
  describe: () => string,
): string | null {
  if (value == null) return null;
  if (interpolationMode(value).mode !== 'literal') return value; // dynamic — preserve verbatim
  const resourceId = map.get(value);
  if (resourceId === undefined) throw new WorkspaceSerializeError(describe());
  return resourceId;
}

function remapNode(node: Node, maps: OwnerRefMaps): NodeExport {
  const { connectionId, call, ...rest } = node;
  const mappedConnectionId = remapRef(
    connectionId,
    maps.connectionResourceId,
    () => `node "${node.id}" references a connection not owned by this workspace`,
  );

  const exported: NodeExport = { ...rest, connectionId: mappedConnectionId };
  if (call) {
    // call.pipelineVersionId is non-nullable; remapRef never returns null for a
    // non-null literal input (it either maps it or throws), so the `!` is sound.
    exported.call = {
      ...call,
      pipelineVersionId: remapRef(
        call.pipelineVersionId,
        maps.versionResourceId,
        () => `node "${node.id}" call references a pipeline version not owned by this workspace`,
      )!,
    };
  }
  return exported;
}

function serializePipeline(
  pipeline: Pipeline,
  latest: PipelineVersion,
  maps: OwnerRefMaps,
): ExportEnvelope {
  const versionExport: PipelineVersionExport = {
    ...latest,
    nodes: latest.nodes.map((node) => remapNode(node, maps)),
  };
  return ExportEnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    kind: 'pipeline',
    exportedAt: 0,
    // A workspace-git file preserves refs (nothing is stripped), so nothing
    // needs a connection REBIND on import: strippedConnectionRefs is empty.
    data: PipelineExportDataSchema.parse({
      pipeline,
      versions: [versionExport],
      strippedConnectionRefs: [],
    }),
  });
}

function serializeConnection(connection: Connection): ExportEnvelope {
  const { secretRef, ...rest } = connection;
  return ExportEnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    kind: 'connection',
    exportedAt: 0,
    data: ConnectionExportDataSchema.parse({ ...rest, requiresSecret: secretRef !== null }),
  });
}

/**
 * #3 G5c-2 — EXPORTED (was module-private) so the reconcile APPLY can compute a
 * stored trigger's DB-side content form as `triggerContentForm(serializeTrigger(
 * existing, maps).data)` — the EXACT inverse it is reversing, webhook-secret
 * strip and binding remap included, guaranteed in lockstep with what Commit
 * emits (no parallel reimplementation to drift). For a VALID stored trigger the
 * binding is always in `maps.versionResourceId` (seeded from all versions, incl.
 * archived), so `remapRef` never throws on that path.
 */
export function serializeTrigger(trigger: Trigger, maps: OwnerRefMaps): ExportEnvelope {
  const webhook = trigger.webhook ? WebhookPublicConfigSchema.parse(trigger.webhook) : null;
  const pipelineVersionId = remapRef(
    trigger.pipelineVersionId,
    maps.versionResourceId,
    () => `trigger "${trigger.id}" binds a pipeline version not owned by this workspace`,
  );
  return ExportEnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    kind: 'trigger',
    exportedAt: 0,
    data: TriggerExportDataSchema.parse({ ...trigger, pipelineVersionId, webhook }),
  });
}

/**
 * Serializes an owner's whole workspace to canonical JSON files (see the module
 * doc). Pure over the DB — no filesystem or git effect; the Commit route writes
 * the returned files. A version-less pipeline (a shell with no committable
 * version yet) is skipped — there is nothing runnable to serialize; its file
 * appears once it has a version.
 *
 * #666 / #3 G5b — an ARCHIVED pipeline (soft-deleted, G5a) is OMITTED, and so
 * is every trigger bound to one of its versions. Git represents archive as file
 * ABSENCE (the G5b reconcile's delete-classification), so leaving an archived
 * pipeline (or its now-disabled dependent trigger) in the serialized set would
 * RESURRECT it on the next Commit → import round-trip. The version ref map is
 * still built over ALL pipelines (incl. archived), so a LIVE pipeline's
 * `call_pipeline` node or a live trigger that references an archived version
 * still remaps faithfully to that version's (real) `resourceId` — the resulting
 * dangling reference on import is G7's "absent → disabled" charter, not a
 * serialize-time drop.
 */
export function serializeWorkspace(db: Db, ownerId: string): WorkspaceFile[] {
  const allPipelines = listPipelines(db, ownerId);
  const connections = listConnections(db, ownerId);
  const triggers = listTriggers(db, { ownerId });
  // Ref map over ALL pipelines (incl. archived) so a live ref to an archived
  // version still resolves (faithful; dangle-on-import is G7's concern).
  const maps = buildOwnerRefMaps(db, allPipelines, connections);

  // Every version DB id that belongs to an archived pipeline — used to omit the
  // archived pipelines themselves and their dependent triggers.
  const archivedVersionIds = new Set<string>();
  for (const pipeline of allPipelines) {
    if (!pipeline.archived) continue;
    for (const version of listPipelineVersions(db, pipeline.id)) {
      archivedVersionIds.add(version.id);
    }
  }

  const livePipelines = allPipelines.filter((pipeline) => !pipeline.archived);
  // A trigger concretely bound to an archived pipeline's version is omitted
  // alongside it (a `null`/`${}` dynamic binding never matches a DB version id,
  // so it is kept). Slug-collision suffixing is computed over the EMITTED sets
  // only, so an archived resource can never perturb a kept resource's path.
  const liveTriggers = triggers.filter(
    (trigger) =>
      trigger.pipelineVersionId === null || !archivedVersionIds.has(trigger.pipelineVersionId),
  );

  const files: WorkspaceFile[] = [];

  const pipelinePaths = resourceFilePaths(
    'pipeline',
    livePipelines.map((p) => ({ resourceId: p.resourceId, name: p.name })),
  );
  for (const pipeline of livePipelines) {
    const latest = getLatestPipelineVersion(db, pipeline.id);
    if (!latest) continue;
    files.push({
      path: pipelinePaths.get(pipeline.resourceId)!,
      contents: canonicalStringify(serializePipeline(pipeline, latest, maps)),
    });
  }

  const connectionPaths = resourceFilePaths(
    'connection',
    connections.map((c) => ({ resourceId: c.resourceId, name: c.name })),
  );
  for (const connection of connections) {
    files.push({
      path: connectionPaths.get(connection.resourceId)!,
      contents: canonicalStringify(serializeConnection(connection)),
    });
  }

  const triggerPaths = resourceFilePaths(
    'trigger',
    liveTriggers.map((t) => ({ resourceId: t.resourceId, name: t.name })),
  );
  for (const trigger of liveTriggers) {
    files.push({
      path: triggerPaths.get(trigger.resourceId)!,
      contents: canonicalStringify(serializeTrigger(trigger, maps)),
    });
  }

  return files;
}
