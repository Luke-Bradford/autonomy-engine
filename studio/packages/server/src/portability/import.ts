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

/**
 * ATOMIC (#459): a pipeline import is many writes — one `pipelines` row plus a
 * version row per exported version — and any version can be REFUSED, either by
 * `NewPipelineVersionSchema` or (as of #444) by the doc gate. Without a
 * transaction the refusal lands mid-way, leaving an orphan pipeline and the
 * versions that happened to precede it: an import that "failed" but still
 * changed the database. #444 is what makes that likely rather than exotic, so
 * the two ship together.
 *
 * `createPipelineVersion` opens its OWN `db.transaction`; better-sqlite3 drops
 * a nested one to a `SAVEPOINT` and commits it with the outer scope, so passing
 * the same `db` handle down composes and needs no tx threading. (Note this is
 * NOT `scheduler/alarms.ts`'s idiom, which threads the `tx` handle into its
 * callee; here the callee takes `db` and relies on better-sqlite3's native
 * nesting instead. Both are safe — the rollback is verified by the test below.)
 */
function importPipelineEnvelope(
  db: Db,
  ownerId: string,
  envelope: Extract<ExportEnvelope, { kind: 'pipeline' }>,
): ImportResult {
  return db.transaction(() => importPipelineEnvelopeInTx(db, ownerId, envelope));
}

function importPipelineEnvelopeInTx(
  db: Db,
  ownerId: string,
  envelope: Extract<ExportEnvelope, { kind: 'pipeline' }>,
): ImportResult {
  const {
    pipeline: exportedPipeline,
    versions: exportedVersions,
    strippedConnectionRefs,
  } = envelope.data;
  // #5 S6b — `concurrency` rides the round-trip (the #473 lesson: a field the
  // import silently drops is destroyed data). `createPipeline`'s WRITE schema
  // is strict, so an envelope carrying a corrupted cap (the read schema is
  // lenient) is REFUSED here rather than laundered into a fresh row.
  const pipeline = createPipeline(db, {
    ownerId,
    name: exportedPipeline.name,
    concurrency: exportedPipeline.concurrency,
  });

  // Only nodes actually recorded here HAD a connection stripped on export —
  // every node's `connectionId` is nulled by export regardless (see
  // `stripNodeConnectionId`), so checking `connectionId === null` here would
  // false-positive-flood nodes that never referenced a connection at all.
  const attention: ImportAttentionItem[] = strippedConnectionRefs.map((nodeId) => ({
    type: 'unresolvedConnectionRef',
    nodeId,
  }));
  const versions = exportedVersions.map((exportedVersion) => {
    // SPREAD, not a field-by-field rebuild (#473). Listing the fields by hand
    // is what silently dropped `containers` on import: every field of
    // `NewPipelineVersion` that has a `.default()` is OPTIONAL in `z.input`, so
    // forgetting one type-checks cleanly and loses data at run time. Spreading
    // keeps this in step with `PipelineVersionExportSchema` (which derives from
    // `PipelineVersionSchema`) by construction, so a field added to the domain
    // model imports without a change here. `id`/`version`/`createdAt` ride along
    // harmlessly — `NewPipelineVersionSchema` omits them and Zod strips unknown
    // keys, so the server still assigns all three (`createPipelineVersion`);
    // the import tests pin that, since it is what keeps the module's
    // "never reuses an exported id" invariant true under a spread.
    const input: NewPipelineVersion = {
      ...exportedVersion,
      pipelineId: pipeline.id,
      nodes: exportedVersion.nodes.map(toDbNode),
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
    // #5 S8 — an event subscription only makes sense on an `event` trigger
    // (`assertEventConsistent`, the route guard this path bypasses): force it
    // null on any other mode, or a hand-crafted envelope could create a row
    // whose every subsequent PATCH 400s on the cross-field rule. An event-mode
    // trigger keeps its subscription verbatim (no secret in it).
    event: rest.mode === 'event' ? (rest.event ?? null) : null,
    // #5 S9 — a window geometry only makes sense on a `tumbling` trigger
    // (`assertWindowConsistent`, the route guard this path bypasses): force it
    // null on any other mode, exactly as `event` above. A tumbling trigger
    // keeps its geometry verbatim (no secret in it).
    window: rest.mode === 'tumbling' ? (rest.window ?? null) : null,
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
