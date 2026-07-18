import {
  CATALOG_VERSION,
  ConnectionExportDataSchema,
  ExportEnvelopeSchema,
  PipelineExportDataSchema,
  SCHEMA_VERSION,
  TriggerExportDataSchema,
  WebhookPublicConfigSchema,
  interpolationMode,
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

/** A LITERAL `connectionId` is nulled on export — a concrete connection id from
 * another workspace is meaningless; the importer re-binds to their OWN
 * connections (see `NodeExportSchema`). Any node whose ORIGINAL literal
 * `connectionId` was non-null (i.e. actually stripped, not just absent) has
 * its id added to `strippedIds` so the envelope's `strippedConnectionRefs`
 * can later tell the importer exactly which nodes need a connection
 * rebind — as opposed to every node, which would false-positive-flood nodes
 * that never referenced a connection.
 *
 * #2 L13a — a `${}` `connectionId` (dynamic routing) is PORTABLE: it references
 * run params/outputs, not a concrete env-specific connection row, so it is
 * PRESERVED across the export boundary rather than nulled — nulling it would
 * silently destroy the authored routing (import would restore no connection),
 * exactly the fail-open "manufacture an absent fact" this codebase refuses. A
 * preserved dynamic id needs no rebind, so it is NOT added to `strippedIds`.
 * `interpolationMode` is the SSOT literal-vs-dynamic classifier (`$$`-escaped
 * text is `literal`) — the same one `literalCallTargets` uses for call targets. */
function stripNodeConnectionId(node: Node, strippedIds: Set<string>): NodeExport {
  const { connectionId, ...rest } = node;
  if (connectionId != null && interpolationMode(connectionId).mode !== 'literal') {
    // Dynamic (`${}`) — portable, keep it, no rebind needed.
    return { ...rest, connectionId };
  }
  if (connectionId != null) strippedIds.add(node.id);
  return { ...rest, connectionId: null };
}

function toPipelineVersionExport(
  version: PipelineVersion,
  strippedIds: Set<string>,
): PipelineVersionExport {
  return {
    ...version,
    nodes: version.nodes.map((node) => stripNodeConnectionId(node, strippedIds)),
  };
}

/**
 * Exports a pipeline + ALL of its immutable `PipelineVersion`s as a
 * version-stamped envelope. Owner-checked first (404, matching
 * `requireOwned`, if `id` doesn't exist or isn't owned by `ownerId`). Every
 * version's node `connectionId`s are nulled (see `stripNodeConnectionId`),
 * and the ids of the nodes that actually HAD one are carried in
 * `data.strippedConnectionRefs` so the importer can report an
 * `unresolvedConnectionRef` attention item only for those nodes, not every
 * node. Runs/triggers bound to this pipeline are NOT included — per-entity
 * export only, no dependency-bundling.
 */
export function exportPipeline(db: Db, id: string, ownerId: string): ExportEnvelope {
  const pipeline = getPipeline(db, id);
  if (!pipeline || pipeline.ownerId !== ownerId) throw new NotFoundError('pipeline', id);

  const strippedConnectionRefs = new Set<string>();
  const versions = listPipelineVersions(db, pipeline.id).map((version) =>
    toPipelineVersionExport(version, strippedConnectionRefs),
  );

  return ExportEnvelopeSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    kind: 'pipeline',
    exportedAt: Date.now(),
    data: PipelineExportDataSchema.parse({
      pipeline,
      versions,
      strippedConnectionRefs: Array.from(strippedConnectionRefs),
    }),
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
