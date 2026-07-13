import {
  ConnectionPublicSchema,
  TriggerPublicSchema,
  parseAndUpgradeEnvelope,
  type ExportEnvelope,
  type ImportAttentionItem,
  type ImportResult,
  type NewPipelineVersion,
  type Node,
  type NodeExport,
} from '@autonomy-studio/shared';
import {
  createConnection,
  createPipeline,
  createPipelineVersion,
  createTrigger,
} from '../repo/index.js';
import type { Db } from '../repo/types.js';

/** The inverse of `stripNodeConnectionId` in `export.ts`: a `null`
 * `connectionId` (every export nulls it) becomes an OMITTED key — the
 * live-row `NodeSchema.connectionId` is `optional()`, never `null`. */
function toDbNode(node: NodeExport): Node {
  const { connectionId, ...rest } = node;
  return connectionId === null ? rest : { ...rest, connectionId };
}

function importPipelineEnvelope(
  db: Db,
  ownerId: string,
  envelope: Extract<ExportEnvelope, { kind: 'pipeline' }>,
): ImportResult {
  const {
    pipeline: exportedPipeline,
    versions: exportedVersions,
    strippedConnectionRefs,
  } = envelope.data;
  const pipeline = createPipeline(db, { ownerId, name: exportedPipeline.name });

  // Only nodes actually recorded here HAD a connection stripped on export —
  // every node's `connectionId` is nulled by export regardless (see
  // `stripNodeConnectionId`), so checking `connectionId === null` here would
  // false-positive-flood nodes that never referenced a connection at all.
  const attention: ImportAttentionItem[] = strippedConnectionRefs.map((nodeId) => ({
    type: 'unresolvedConnectionRef',
    nodeId,
  }));
  const versions = exportedVersions.map((exportedVersion) => {
    const nodes = exportedVersion.nodes.map(toDbNode);
    const input: NewPipelineVersion = {
      pipelineId: pipeline.id,
      params: exportedVersion.params,
      outputs: exportedVersion.outputs,
      nodes,
      edges: exportedVersion.edges,
      catalogVersion: exportedVersion.catalogVersion,
    };
    return createPipelineVersion(db, input);
  });

  return { kind: 'pipeline', pipeline, versions, attention };
}

function importConnectionEnvelope(
  db: Db,
  ownerId: string,
  envelope: Extract<ExportEnvelope, { kind: 'connection' }>,
): ImportResult {
  const {
    id,
    createdAt,
    updatedAt,
    ownerId: exportedOwnerId,
    requiresSecret,
    ...rest
  } = envelope.data;
  void id;
  void createdAt;
  void updatedAt;
  void exportedOwnerId;

  // Never import a secret: `secretRef` was never in the export (see
  // `ConnectionExportDataSchema`), so the imported connection always starts
  // with none — `requiresSecret` just tells the caller whether the ORIGINAL
  // connection had one, so they know to enter a fresh one.
  const created = createConnection(db, { ...rest, ownerId, secretRef: null });
  const attention: ImportAttentionItem[] = requiresSecret ? [{ type: 'requiresSecret' }] : [];

  return { kind: 'connection', connection: ConnectionPublicSchema.parse(created), attention };
}

function importTriggerEnvelope(
  db: Db,
  ownerId: string,
  envelope: Extract<ExportEnvelope, { kind: 'trigger' }>,
): ImportResult {
  const {
    id,
    createdAt,
    updatedAt,
    ownerId: exportedOwnerId,
    pipelineVersionId: exportedPipelineVersionId,
    webhook: exportedWebhook,
    ...rest
  } = envelope.data;
  void id;
  void createdAt;
  void updatedAt;
  void exportedOwnerId;
  void exportedPipelineVersionId;

  const attention: ImportAttentionItem[] = [{ type: 'unboundPipelineVersion' }];
  if (exportedWebhook !== null) attention.push({ type: 'requiresWebhookSecret' });

  // Cross-entity refs ALWAYS stay null on import, regardless of what the
  // envelope carried — the importer re-binds via the normal PATCH route.
  // `webhook` is likewise always null: a webhook trigger's `secretRef` is
  // never exported/imported (same reasoning as a connection secret), so
  // there is no valid `WebhookConfigSchema` value to reconstruct here.
  //
  // `enabled` is ALSO forced false here, regardless of what the envelope
  // carried: an imported trigger is unbound (`pipelineVersionId: null`)
  // by construction, so `enabled: true` + unbound would otherwise rest
  // solely on the future P4 scheduler's null-check to never fire it.
  // Defense-in-depth — the importer must explicitly rebind + re-enable via
  // the normal routes before this trigger can run. The P4 scheduler must
  // STILL refuse to fire a null-bound trigger; that null-check remains the
  // primary guarantee, this is a belt-and-braces second line of defense.
  const created = createTrigger(db, {
    ...rest,
    ownerId,
    pipelineVersionId: null,
    webhook: null,
    enabled: false,
  });

  return { kind: 'trigger', trigger: TriggerPublicSchema.parse(created), attention };
}

/**
 * The one import entry point: `parseAndUpgradeEnvelope`s `raw` (throws
 * `ImportError` — mapped to a 400 by the global error handler — on anything
 * it refuses), then creates the entity/entities it describes with BRAND-NEW
 * ids, owned by `ownerId`, via the same repo functions every CRUD route uses
 * (so every repo invariant + Zod parse applies exactly as it would for a
 * hand-authored create). Never reuses an exported id, never imports a
 * secret, and always leaves cross-entity refs (a pipeline node's
 * `connectionId`, a trigger's `pipelineVersionId`) null for the importer to
 * rebind afterward via the normal routes.
 */
export function importEnvelope(db: Db, ownerId: string, raw: unknown): ImportResult {
  const envelope = parseAndUpgradeEnvelope(raw);
  switch (envelope.kind) {
    case 'pipeline':
      return importPipelineEnvelope(db, ownerId, envelope);
    case 'connection':
      return importConnectionEnvelope(db, ownerId, envelope);
    case 'trigger':
      return importTriggerEnvelope(db, ownerId, envelope);
  }
}
