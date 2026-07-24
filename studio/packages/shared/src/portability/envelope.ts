import { z } from 'zod';
import { CATALOG_VERSION, SCHEMA_VERSION } from '../schemas/version.js';
import { ConnectionPublicSchema } from '../schemas/connection.js';
import { NodeSchema, PipelineSchema, PipelineVersionSchema } from '../schemas/pipeline.js';
import { TriggerPublicSchema } from '../schemas/trigger.js';

/**
 * A pipeline node as it appears in an EXPORT: `connectionId` is always
 * present but nulled (a connection id from another workspace is meaningless
 * — the importer re-binds to their OWN connections). Distinct from
 * `NodeSchema` (whose `connectionId` is `optional()`, never `null`, on the
 * live DB row) because the export/import DTOs are their own contract, not
 * the same shape as the stored entity.
 */
export const NodeExportSchema = NodeSchema.omit({ connectionId: true }).extend({
  connectionId: z.string().min(1).nullable(),
});
export type NodeExport = z.infer<typeof NodeExportSchema>;

/**
 * #3 G1 — `resourceId` as it appears in an EXPORT: required-nullable, unlike
 * the stored schemas where it is required non-null. `null` means "exported
 * before G1 existed" (the v3→v4 upgrader backfills it — an upgrader must be
 * DETERMINISTIC, so it cannot mint a random id; `null` is the honest
 * "never had one"). PORTABLE import ignores this field entirely (it mints new
 * ids by design — that IS portable semantics); only the workspace-git import
 * (#3 G4/G5) will read it, treating `null` as legacy-no-identity → create-new.
 */
const exportResourceId = z.string().min(1).nullable();

/** A `PipelineVersion` as it appears in an export: identical to the stored
 * row except every node's `connectionId` is nulled (see `NodeExportSchema`)
 * and `resourceId` is nullable (see `exportResourceId`). */
export const PipelineVersionExportSchema = PipelineVersionSchema.omit({
  nodes: true,
  resourceId: true,
  // #3 G6b — git provenance is LOCAL derived state (which commit/blob/branch/path
  // a version was imported FROM on THIS machine), never authoring content.
  // Serializing it would (1) leak one machine's checkout details cross-machine and
  // (2) make a file's committed bytes depend on its own git blob sha — a
  // self-referential churn loop. `z.object` strips it on export and ignores it on
  // any future import — no SCHEMA_VERSION bump (same posture as `archived`).
  sourceCommit: true,
  sourceBranch: true,
  sourceFilePath: true,
  sourceBlobSha: true,
}).extend({
  nodes: z.array(NodeExportSchema),
  resourceId: exportResourceId,
});
export type PipelineVersionExport = z.infer<typeof PipelineVersionExportSchema>;

/** The pipeline row as it appears in an export: `resourceId` nullable (see
 * `exportResourceId`). */
export const PipelineExportSchema = PipelineSchema.omit({
  resourceId: true,
  // #3 G5a — `archived` is a LOCAL runtime state, never authoring content: git
  // represents an archived pipeline as file ABSENCE (the G5b reconcile
  // delete-classification), so it never enters the wire. `z.object` strips it
  // on export and ignores it on any future import — no SCHEMA_VERSION bump.
  archived: true,
}).extend({
  resourceId: exportResourceId,
});
export type PipelineExport = z.infer<typeof PipelineExportSchema>;

/**
 * `data` for a `kind: 'pipeline'` envelope: the pipeline row plus EVERY one
 * of its immutable `PipelineVersion`s (see `exportPipeline` in
 * `@autonomy-studio/server`'s `portability/export.ts`). Runs/triggers bound
 * to this pipeline are NOT included — out of scope for P1c (per-entity
 * export, no dependency-bundling).
 *
 * `strippedConnectionRefs` is the set of node ids (across all `versions`)
 * whose ORIGINAL `connectionId` was non-null before export nulled it (see
 * `stripNodeConnectionId` in `export.ts`) — i.e. nodes that actually need a
 * connection rebind on import. Nodes that never had a `connectionId` are NOT
 * in this list. `exportPipeline` always populates it; `.default([])` only
 * exists so an OLDER envelope (predating this field) still parses rather
 * than refusing outright — those envelopes simply report zero
 * `unresolvedConnectionRef` attention items on import.
 */
export const PipelineExportDataSchema = z.object({
  pipeline: PipelineExportSchema,
  versions: z.array(PipelineVersionExportSchema),
  strippedConnectionRefs: z.array(z.string().min(1)).default([]),
});
export type PipelineExportData = z.infer<typeof PipelineExportDataSchema>;

/**
 * `data` for a `kind: 'connection'` envelope: the connection minus
 * `secretRef` (never exported — see `ConnectionPublicSchema`), plus
 * `requiresSecret` so the importing UI knows a secret must be re-entered
 * before this connection can call its provider.
 */
export const ConnectionExportDataSchema = ConnectionPublicSchema.omit({
  resourceId: true,
}).extend({
  requiresSecret: z.boolean(),
  resourceId: exportResourceId,
});
export type ConnectionExportData = z.infer<typeof ConnectionExportDataSchema>;

/**
 * The ALREADY-public webhook config shape an export's `data.webhook` field
 * carries — i.e. `WebhookPublicConfigSchema`'s output type, but as a plain
 * (non-transforming) schema. This is deliberately NOT `WebhookPublicConfigSchema`
 * itself: that schema is `WebhookConfigSchema.transform(...)`, so Zod
 * validates its INPUT against `WebhookConfigSchema` first (which REQUIRES
 * `secretRef`) before stripping it — fine the first time (stripping a live
 * `Trigger.webhook`), but it can never be re-applied to its own
 * already-stripped output, which is exactly what re-parsing an export
 * envelope (whose `secretRef` is already gone) needs to do.
 */
export const WebhookExportConfigSchema = z.record(z.string(), z.unknown());
export type WebhookExportConfig = z.infer<typeof WebhookExportConfigSchema>;

/**
 * `data` for a `kind: 'trigger'` envelope: the trigger with
 * `pipelineVersionId` nulled (a cross-workspace pipeline-version id is
 * meaningless — the importer re-binds on the receiving side) and
 * `webhook.secretRef` stripped (`webhook` here is the already-public shape,
 * see `WebhookExportConfigSchema`).
 */
export const TriggerExportDataSchema = TriggerPublicSchema.omit({
  pipelineVersionId: true,
  webhook: true,
  resourceId: true,
}).extend({
  pipelineVersionId: z.string().min(1).nullable(),
  webhook: WebhookExportConfigSchema.nullable(),
  resourceId: exportResourceId,
});
export type TriggerExportData = z.infer<typeof TriggerExportDataSchema>;

export const ExportKindSchema = z.enum(['pipeline', 'connection', 'trigger']);
export type ExportKind = z.infer<typeof ExportKindSchema>;

const EnvelopeBaseShape = {
  schemaVersion: z.number().int(),
  catalogVersion: z.number().int(),
  exportedAt: z.number().int(),
};

/**
 * The one export/import wire format for every config object (per the target
 * architecture: "Every config object exports as version-stamped JSON").
 * Discriminated on `kind` so `data` is exactly the right shape for what was
 * exported. `schemaVersion`/`catalogVersion` gate what
 * `parseAndUpgradeEnvelope` (below) will accept on import.
 */
export const ExportEnvelopeSchema = z.discriminatedUnion('kind', [
  z.object({ ...EnvelopeBaseShape, kind: z.literal('pipeline'), data: PipelineExportDataSchema }),
  z.object({
    ...EnvelopeBaseShape,
    kind: z.literal('connection'),
    data: ConnectionExportDataSchema,
  }),
  z.object({ ...EnvelopeBaseShape, kind: z.literal('trigger'), data: TriggerExportDataSchema }),
]);
export type ExportEnvelope = z.infer<typeof ExportEnvelopeSchema>;

/**
 * Thrown by `parseAndUpgradeEnvelope` for anything it refuses to import: a
 * `schemaVersion`/`catalogVersion` newer than this build supports, a missing
 * upgrader for an older `schemaVersion`, malformed JSON/shape, or a final Zod
 * validation failure. Callers (`POST /api/import`) map this to a structured
 * 400 — never a raw stack trace or a leaked internal error shape.
 */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

/**
 * A single schema-version migration step: takes the raw (already
 * JSON-parsed, NOT yet Zod-validated) envelope object at `fromSchemaVersion`
 * and returns the envelope object at `fromSchemaVersion + 1` (with its own
 * `schemaVersion` field bumped to match). Deliberately `unknown` in/out — an
 * upgrader's whole job is reshaping a payload that does NOT yet conform to
 * the current Zod schemas.
 */
export type Upgrader = (env: unknown) => unknown;

export type UpgraderRegistry = ReadonlyMap<number, Upgrader>;

/**
 * v1→v2 (#5 S8): backfill the two required-nullable trigger fields added since
 * schemaVersion 1 — `recurrence` (#5 S5b; its missing bump left every pre-S5b
 * trigger export un-importable, healed here) and `event` (#5 S8) — as `null`
 * (the honest "never had one" value; contrast #473's manufactured `.default`).
 * Only a `kind:'trigger'` envelope's `data` is touched; an already-present key
 * (a post-S5b v1 export DOES carry `recurrence`) is never clobbered. Pipeline/
 * connection envelopes pass through with only the version stamp advanced.
 */
function upgradeV1ToV2(env: unknown): unknown {
  if (!isPlainObject(env)) return env; // parseAndUpgradeEnvelope rejects it next
  const upgraded: Record<string, unknown> = { ...env, schemaVersion: 2 };
  if (env.kind === 'trigger' && isPlainObject(env.data)) {
    upgraded.data = { recurrence: null, event: null, ...env.data };
  }
  return upgraded;
}

/**
 * The live upgrader registry, keyed by the `schemaVersion` an upgrader
 * migrates FROM. A future schema bump adds exactly ONE entry here;
 * `parseAndUpgradeEnvelope`'s chaining loop already handles a multi-step chain
 * (v1→v2→v3, ...) with no further change required. Tests inject their OWN
 * registry (see `parseAndUpgradeEnvelope`'s `upgraders` param) rather than
 * mutating this shared instance, so a fake upgrader registered in a test never
 * leaks into another test file or into production parsing.
 */
/**
 * v2→v3 (#5 S9): backfill the required-nullable trigger field added since
 * schemaVersion 2 — `window` (the tumbling-window geometry) — as `null` (the
 * honest "never had one" value). Only a `kind:'trigger'` envelope's `data` is
 * touched; an already-present key is never clobbered. Pipeline/connection
 * envelopes pass through with only the version stamp advanced.
 */
function upgradeV2ToV3(env: unknown): unknown {
  if (!isPlainObject(env)) return env; // parseAndUpgradeEnvelope rejects it next
  const upgraded: Record<string, unknown> = { ...env, schemaVersion: 3 };
  if (env.kind === 'trigger' && isPlainObject(env.data)) {
    upgraded.data = { window: null, ...env.data };
  }
  return upgraded;
}

/**
 * v3→v4 (#3 G1): backfill the required-nullable `resourceId` added to EVERY
 * exported resource — unlike v1→v2/v2→v3 (trigger-only), this touches ALL
 * THREE kinds, including the NESTED `data.pipeline` and every entry of
 * `data.versions[]` for a pipeline envelope. `null` is the honest "exported
 * before stable identity existed" value (an upgrader must be deterministic,
 * so it can never MINT an id — see `exportResourceId`); an already-present
 * key is never clobbered.
 */
function upgradeV3ToV4(env: unknown): unknown {
  if (!isPlainObject(env)) return env; // parseAndUpgradeEnvelope rejects it next
  const upgraded: Record<string, unknown> = { ...env, schemaVersion: 4 };
  if (!isPlainObject(env.data)) return upgraded; // final validation rejects it
  if (env.kind === 'pipeline') {
    const data: Record<string, unknown> = { ...env.data };
    if (isPlainObject(data.pipeline)) {
      data.pipeline = { resourceId: null, ...data.pipeline };
    }
    if (Array.isArray(data.versions)) {
      data.versions = data.versions.map((version) =>
        isPlainObject(version) ? { resourceId: null, ...version } : version,
      );
    }
    upgraded.data = data;
  } else if (env.kind === 'connection' || env.kind === 'trigger') {
    upgraded.data = { resourceId: null, ...env.data };
  }
  return upgraded;
}

export const UPGRADERS: Map<number, Upgrader> = new Map([
  [1, upgradeV1ToV2],
  [2, upgradeV2ToV3],
  [3, upgradeV3ToV4],
]);

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ImportError('Malformed import: invalid JSON');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The one import entry point every envelope must pass through: JSON-parses
 * `raw` if it's a string, chains any registered `Upgrader`s from the
 * envelope's own `schemaVersion` up to the current `SCHEMA_VERSION`, then
 * validates the result against `ExportEnvelopeSchema`. Refuses (via
 * `ImportError`) a `schemaVersion`/`catalogVersion` newer than this build
 * supports, a chain missing an upgrader, an upgrader that doesn't advance
 * `schemaVersion`, or a final shape that still doesn't validate.
 */
export function parseAndUpgradeEnvelope(
  raw: unknown,
  upgraders: UpgraderRegistry = UPGRADERS,
): ExportEnvelope {
  const parsed = typeof raw === 'string' ? parseJson(raw) : raw;
  if (!isPlainObject(parsed)) {
    throw new ImportError('Malformed import: expected a JSON object');
  }

  let current: Record<string, unknown> = parsed;

  const catalogVersion = current.catalogVersion;
  if (typeof catalogVersion !== 'number' || !Number.isInteger(catalogVersion)) {
    throw new ImportError('Malformed import: missing or invalid catalogVersion');
  }
  if (catalogVersion > CATALOG_VERSION) {
    throw new ImportError(
      `Cannot import: catalogVersion ${catalogVersion} is newer than this build supports (${CATALOG_VERSION})`,
    );
  }

  const rawSchemaVersion = current.schemaVersion;
  if (typeof rawSchemaVersion !== 'number' || !Number.isInteger(rawSchemaVersion)) {
    throw new ImportError('Malformed import: missing or invalid schemaVersion');
  }
  // Explicitly typed `number` (not inferred from the `unknown` property
  // access above): a `let` reassigned inside the loop below loses its
  // narrowed-from-`unknown` type across loop iterations under TS's control
  // flow analysis, which would otherwise make every use below type as
  // `unknown` again.
  let schemaVersion: number = rawSchemaVersion;
  if (schemaVersion > SCHEMA_VERSION) {
    throw new ImportError(
      `Cannot import: schemaVersion ${schemaVersion} is newer than this build supports (${SCHEMA_VERSION})`,
    );
  }

  while (schemaVersion < SCHEMA_VERSION) {
    const upgrader = upgraders.get(schemaVersion);
    if (!upgrader) {
      throw new ImportError(
        `Cannot import: no upgrader registered from schemaVersion ${schemaVersion} to ${schemaVersion + 1}`,
      );
    }
    const upgraded = upgrader(current);
    if (!isPlainObject(upgraded)) {
      throw new ImportError(
        `Upgrader from schemaVersion ${schemaVersion} returned a malformed envelope`,
      );
    }
    const nextVersion = upgraded.schemaVersion;
    // Each registered upgrader must advance EXACTLY one version — a gap
    // (nextVersion <= schemaVersion, already impossible for a well-behaved
    // upgrader chain since the missing-upgrader check above would have
    // caught it) or an OVERSHOOT (nextVersion > schemaVersion + 1) would
    // otherwise let a single upgrader silently skip past an intermediate
    // version's own upgrader (or past SCHEMA_VERSION itself). Requiring
    // exactly `schemaVersion + 1` makes the chain walk one step at a time,
    // no matter how many hops separate the envelope's version from
    // `SCHEMA_VERSION`.
    if (
      typeof nextVersion !== 'number' ||
      !Number.isInteger(nextVersion) ||
      nextVersion !== schemaVersion + 1
    ) {
      throw new ImportError(
        `Upgrader from schemaVersion ${schemaVersion} must produce schemaVersion ${schemaVersion + 1} exactly (got ${String(nextVersion)})`,
      );
    }
    current = upgraded;
    schemaVersion = nextVersion;
  }

  // Defense-in-depth: the loop invariant above should already guarantee
  // this, but assert it explicitly before validating against the current
  // schema — a future refactor of the loop must not be able to silently
  // hand an under/over-shot envelope to `ExportEnvelopeSchema`.
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new ImportError(
      `Cannot import: upgrade chain ended at schemaVersion ${schemaVersion}, expected ${SCHEMA_VERSION}`,
    );
  }

  const result = ExportEnvelopeSchema.safeParse(current);
  if (!result.success) {
    throw new ImportError(`Envelope failed validation: ${result.error.message}`);
  }
  return result.data;
}
