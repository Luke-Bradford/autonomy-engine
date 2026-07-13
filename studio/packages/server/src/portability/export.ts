import {
  CATALOG_VERSION,
  ConnectionExportDataSchema,
  ExportEnvelopeSchema,
  PipelineExportDataSchema,
  SCHEMA_VERSION,
  TriggerExportDataSchema,
  WebhookPublicConfigSchema,
  type ConnectionExportData,
  type ExportEnvelope,
  type Node,
  type NodeExport,
  type PipelineVersion,
  type PipelineVersionExport,
  type TriggerExportData,
} from '@autonomy-studio/shared';
import { getConnection, getPipeline, getTrigger, listPipelineVersions } from '../repo/index.js';
import { NotFoundError } from '../errors.js';
import type { Db } from '../repo/types.js';

/** Every node's `connectionId` is nulled on export — a connection id from
 * another workspace is meaningless; the importer re-binds to their OWN
 * connections (see `NodeExportSchema`). */
function stripNodeConnectionId(node: Node): NodeExport {
  const { connectionId, ...rest } = node;
  void connectionId;
  return { ...rest, connectionId: null };
}

function toPipelineVersionExport(version: PipelineVersion): PipelineVersionExport {
  return { ...version, nodes: version.nodes.map(stripNodeConnectionId) };
}

/**
 * Exports a pipeline + ALL of its immutable `PipelineVersion`s as a
 * version-stamped envelope. Owner-checked first (404, matching
 * `requireOwned`, if `id` doesn't exist or isn't owned by `ownerId`). Every
 * version's node `connectionId`s are nulled (see `stripNodeConnectionId`).
 * Runs/triggers bound to this pipeline are NOT included — per-entity export
 * only, no dependency-bundling.
 */
export function exportPipeline(db: Db, id: string, ownerId: string): ExportEnvelope {
  const pipeline = getPipeline(db, id);
  if (!pipeline || pipeline.ownerId !== ownerId) throw new NotFoundError('pipeline', id);

  const versions = listPipelineVersions(db, pipeline.id).map(toPipelineVersionExport);

  return ExportEnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    kind: 'pipeline',
    exportedAt: Date.now(),
    data: PipelineExportDataSchema.parse({ pipeline, versions }),
  });
}

/**
 * Exports a connection as a version-stamped envelope. `secretRef` is NEVER
 * exported (no plaintext, no ciphertext, not even the opaque ref) — replaced
 * with `requiresSecret` so the importing UI knows a secret must be
 * re-entered before this connection can call its provider.
 */
export function exportConnection(db: Db, id: string, ownerId: string): ExportEnvelope {
  const connection = getConnection(db, id);
  if (!connection || connection.ownerId !== ownerId) throw new NotFoundError('connection', id);

  const { secretRef, ...rest } = connection;
  const data: ConnectionExportData = ConnectionExportDataSchema.parse({
    ...rest,
    requiresSecret: secretRef !== null,
  });

  return ExportEnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    kind: 'connection',
    exportedAt: Date.now(),
    data,
  });
}

/**
 * Exports a trigger as a version-stamped envelope. `pipelineVersionId` is
 * nulled (cross-workspace binding is meaningless — re-bind on the receiving
 * side) and `webhook.secretRef` is stripped (via `WebhookPublicConfigSchema`,
 * same as `TriggerPublicSchema`).
 */
export function exportTrigger(db: Db, id: string, ownerId: string): ExportEnvelope {
  const trigger = getTrigger(db, id);
  if (!trigger || trigger.ownerId !== ownerId) throw new NotFoundError('trigger', id);

  const webhook = trigger.webhook ? WebhookPublicConfigSchema.parse(trigger.webhook) : null;
  const data: TriggerExportData = TriggerExportDataSchema.parse({
    ...trigger,
    pipelineVersionId: null,
    webhook,
  });

  return ExportEnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    kind: 'trigger',
    exportedAt: Date.now(),
    data,
  });
}
