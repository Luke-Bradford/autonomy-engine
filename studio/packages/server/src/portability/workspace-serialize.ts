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

/** One serialized file: its repo-relative path and its canonical JSON bytes. */
export interface WorkspaceFile {
  path: string;
  contents: string;
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
