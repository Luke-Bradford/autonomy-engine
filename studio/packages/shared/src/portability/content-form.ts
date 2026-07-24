import { canonicalStringify } from './canonical.js';
import type { ConnectionExportData, PipelineExportData, TriggerExportData } from './envelope.js';

/**
 * #3 G5b — the CANONICAL CONTENT FORM of an exported resource: a stable string
 * over ONLY the authoring content of a resource's export `data`, with the
 * identity / local-runtime / volatile fields removed. Two resources compare
 * EQUAL by content iff their content forms are string-equal. This is the
 * primitive the workspace-git reconcile classifier (`workspace-reconcile.ts`)
 * uses to decide "unchanged vs a real edit that mints a new immutable version",
 * and the same primitive the later drift gate (#3 G3 working-copy model) reuses
 * to decide "uncommitted".
 *
 * The comparison is STRING EQUALITY of the canonical form ("parsed-object
 * compare", per the Codex-hardened block). SHA-256 over the form is an explicit
 * FUTURE optimization for large workspaces (equal hash ⇒ compare forms to rule
 * out a collision) — deliberately NOT built here, no consumer needs it yet.
 *
 * The exclusion set is STRUCTURE-AWARE (enumerated per resource LEVEL), never a
 * blanket key-removal — this distinction is load-bearing:
 * - `id`/`resourceId`/`createdAt`/`updatedAt`/`ownerId` at the RESOURCE-envelope
 *   level are machine-specific (each workspace mints its own) → excluded.
 * - `id` on a `node`/`edge`/`container` and `name` on a `param`/`output` are
 *   AUTHOR-assigned graph content, stable across machines → KEPT. A blanket
 *   "strip every `id`" would collapse two genuinely-different graphs to equal
 *   and mint no version for a real edit (silent data loss — the inverse of the
 *   #473 fail-open shape).
 * - `name` (the resource display name) is excluded from the CONTENT form because
 *   the classifier tracks a rename as a distinct signal (`nameChanged`) from a
 *   content edit; folding it in would make a pure rename read as a content edit.
 * - `version`/`pipelineId`/`catalogVersion` on a version, and `requiresSecret`
 *   on a connection, are local/derived state (row numbering, the catalog the doc
 *   was authored under, whether a local secret happens to be present — G8's
 *   readiness charter) → excluded, so they never manufacture spurious churn.
 * - `node.position` is canvas geometry, never behaviour → excluded (else a
 *   node-drag would mint a version + a Publish candidate — the v2 hardened note).
 *
 * A binding IS content and stays IN the form: a `trigger.pipelineVersionId` /
 * `node.call.pipelineVersionId` / `node.connectionId` is a `resourceId` in an
 * export (remapped by `serializeWorkspace`), which is stable across machines, so
 * a rebind is a real change the classifier must see. Envelope-level fields
 * (`schemaVersion`, `catalogVersion`, `exportedAt`) never enter — the form is
 * computed over `data`, not the whole envelope.
 *
 * `enabled` STAYS content here (#3 G7, #668 RESOLVED): a trigger's `enabled` is
 * authored intent on the export wire, so a committed enable/disable on a BOUND
 * trigger propagates on pull and reads as an `update`. The G7/G8 readiness gate
 * can LOCALLY force `enabled:false` for an absent binding, which would otherwise
 * churn a force-disabled unbound trigger as a perpetual `update` — but that is
 * NOT fixed by excluding `enabled` (the churn's real driver is the dangling
 * BINDING field, not `enabled`). It is fixed one layer up, in the SERVER reconcile
 * (`server/src/portability/trigger-content.ts` `normalizedTriggerContentForm`):
 * an incoming trigger whose binding does not resolve is normalized to
 * (null, disabled) — resolved space — BEFORE this raw form is computed, so it
 * matches what the apply persists. This raw form stays a pure branch-vs-branch
 * comparator; the resolution domain is a server concept, so it lives server-side.
 *
 * A webhook trigger's secret-PRESENCE (#3 G8b, #674 RESOLVED) is LOCAL readiness
 * state, never authoring content — the `requiresSecret` shape one level down. An
 * exported webhook config always has `secretRef` stripped
 * (`WebhookPublicConfigSchema`), so a trigger WITH a local secret serializes
 * `webhook: {}` while a fresh cross-workspace CREATE (which cannot reconstruct the
 * secret — `NewTriggerSchema.webhook` requires `secretRef`) forces `webhook:
 * null`. `{}` ≠ `null` would churn a `update` on every import forever. So
 * `triggerContentForm` collapses an EMPTY webhook object to `null`: the two
 * secret-presence states compare equal, exactly as `connectionContentForm`
 * excludes `requiresSecret`. A NON-empty webhook config (a future non-secret
 * catchall field — the schema is `.catchall(z.unknown())`) is real authoring
 * content and is KEPT, so this stays structure-aware, never the #473 fail-open
 * shape of blanket-dropping the whole `webhook` key.
 */

/** Deep clone via a JSON round-trip. Export `data` is always JSON-safe (it was
 * Zod-parsed from a JSON envelope), so this is lossless here and needs no
 * `structuredClone` global (absent from the shared `ES2023` lib set). */
function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Delete a fixed set of keys from a plain object in place. Typed as `unknown`
 * so it can drop fields the static type marks as required (they are excluded
 * from the content form on purpose). */
function omitKeys(value: unknown, keys: readonly string[]): void {
  const record = value as Record<string, unknown>;
  for (const key of keys) delete record[key];
}

/** Resource-envelope-level identity/volatile fields (a pipeline row, a
 * connection, a trigger). NOT applied to nested nodes/edges/containers. */
const RESOURCE_VOLATILE = [
  'id',
  'resourceId',
  'ownerId',
  'name',
  'createdAt',
  'updatedAt',
] as const;

/** Per-version identity/derived fields inside a pipeline's `versions[]`. */
const VERSION_VOLATILE = [
  'id',
  'resourceId',
  'pipelineId',
  'version',
  'catalogVersion',
  'createdAt',
  // #3 G6b — git provenance (source commit/branch/path/blob) is machine-local
  // derived state, not authoring content. The branch (export) side never carries
  // it (`PipelineVersionExportSchema` strips it), but the DB side (`dbVersionForm`
  // spreads a stored `PipelineVersion`) DOES, so it must be scrubbed here too —
  // otherwise every existing version's DB content form would differ from its
  // branch form and every re-pull would misfire a spurious duplicate-version mint.
  'sourceCommit',
  'sourceBranch',
  'sourceFilePath',
  'sourceBlobSha',
] as const;

/**
 * #3 G5c — the content form of a SINGLE pipeline version's authoring doc (nodes,
 * edges, containers, params, outputs), with the version-level identity/derived
 * fields and per-node canvas geometry removed. Separated from
 * `pipelineContentForm` because the reconcile APPLY must decide "mint a new
 * immutable version" from the VERSION doc alone, independently of the pipeline
 * ROW fields (`name`/`concurrency`) — a `concurrency`-only change must patch the
 * row WITHOUT minting a spurious immutable version. Operates on a value already
 * in the export/`resourceId` space (bindings are `resourceId`s), so both sides
 * of the apply's diff run through the SAME serialize+parse path and compare
 * apples-to-apples.
 */
/** Strip a version's identity/derived fields + per-node canvas geometry, IN
 * PLACE — the single definition of "a version's authoring content", shared by
 * `pipelineVersionContentForm` and `pipelineContentForm` so the two can never
 * drift on what a version's content is. */
function scrubVersion(version: { nodes: unknown[] }): void {
  omitKeys(version, VERSION_VOLATILE);
  for (const node of version.nodes) omitKeys(node, ['position']);
}

export function pipelineVersionContentForm(
  version: PipelineExportData['versions'][number],
): string {
  const clone = jsonClone(version);
  scrubVersion(clone);
  return canonicalStringify(clone);
}

export function pipelineContentForm(data: PipelineExportData): string {
  const clone = jsonClone(data);
  omitKeys(clone.pipeline, RESOURCE_VOLATILE);
  for (const version of clone.versions) scrubVersion(version);
  return canonicalStringify(clone);
}

export function connectionContentForm(data: ConnectionExportData): string {
  const clone = jsonClone(data);
  // `requiresSecret` is derived from whether a LOCAL secret happens to be
  // present (G8's readiness concern), not authoring content — exclude it so a
  // machine that has not re-entered the secret does not churn every connection.
  omitKeys(clone, [...RESOURCE_VOLATILE, 'requiresSecret']);
  return canonicalStringify(clone);
}

export function triggerContentForm(data: TriggerExportData): string {
  const clone = jsonClone(data);
  omitKeys(clone, RESOURCE_VOLATILE);
  // #3 G8b (#674) — collapse an EMPTY webhook config to null: `{}` (secret
  // present locally, stripped on export) and `null` (no secret) are the same
  // secret-presence readiness signal, not authoring content. A non-empty config
  // (a non-secret catchall field) is real content and stays untouched.
  if (
    clone.webhook !== null &&
    typeof clone.webhook === 'object' &&
    Object.keys(clone.webhook).length === 0
  ) {
    clone.webhook = null;
  }
  return canonicalStringify(clone);
}
