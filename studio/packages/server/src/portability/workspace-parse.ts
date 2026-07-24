import {
  kindForDir,
  parseAndUpgradeEnvelope,
  type ConnectionExportData,
  type ExportEnvelope,
  type PipelineExportData,
  type ResourceKind,
  type TriggerExportData,
  type WorkspaceParseDiagnostic,
} from '@autonomy-studio/shared';
import type { WorkspaceFile } from './workspace-serialize.js';

/**
 * #3 G4 — the workspace-git import PARSER: the READ inverse of
 * `serializeWorkspace` (G3a). Turns a set of committed managed files into
 * validated, upgraded in-memory resources. It is PURE (no filesystem, no git,
 * no DB) and does NO writes — the git reader (`git/workspace-read.ts`) supplies
 * the files and G5's transactional reconcile consumes the result.
 *
 * Scope boundary (deliberately NOT here — those are later slices):
 * - No DB compare / create/update/rename/delete CLASSIFICATION (G5).
 * - No cross-resource ref RESOLUTION. A trigger or `call_pipeline` node can pin
 *   a version `resourceId` whose file is NOT committed (G3a serializes only the
 *   latest version per pipeline, but a binding to an OLD version is faithful) —
 *   so an unresolved version ref is EXPECTED, not a parse error; the
 *   "absent → disabled" reconcile is G7's charter. A missing connection ref is
 *   likewise a G5/G8 readiness concern.
 *
 * Validation performed here is STRUCTURAL and per-file, plus one workspace-level
 * check (duplicate identity):
 * - each file parses + upgrades + validates through `parseAndUpgradeEnvelope`;
 * - its envelope `kind` matches the directory it sits in (`kindForDir`);
 * - no two files of a kind claim the same NON-null `resourceId` (a `null`
 *   resourceId is legacy-no-identity — G1 — and is never a duplicate).
 *
 * Every failure is COLLECTED as a `WorkspaceParseDiagnostic` (never thrown, so a
 * preview shows the whole picture; #473: a bad file is visible, not dropped).
 * Only fully-valid files land in the `pipelines`/`connections`/`triggers`
 * arrays.
 *
 * `unreadablePaths` are managed files the git reader could not read at all
 * (#664 — a blob over the provider's collected-output cap, or a per-blob git
 * failure): they never reach `files`, so they are surfaced here as `unreadable`
 * diagnostics rather than silently vanishing (the same visible-not-dropped
 * contract). A caller that read files directly (the DB snapshot) passes none.
 */

/** A parsed pipeline: keyed on the pipeline ROW's `resourceId` (what G5's
 * rename/create classification and this parser's dedup use); the committed
 * version resourceId(s) are surfaced so G7's binding reconcile need not
 * re-parse. `null` resourceId = a pre-G1 file → G5 treats as create-new. */
export interface ParsedPipeline {
  path: string;
  /** #3 G6b — the git blob SHA of this pipeline's file at the read ref, or `null`
   * when it did not come from git (the DB-snapshot baseline). A minted version
   * stamps it as `source_blob_sha` provenance. Only pipelines carry it —
   * connections/triggers are not versioned. */
  blobSha: string | null;
  resourceId: string | null;
  versionResourceIds: (string | null)[];
  data: PipelineExportData;
}

export interface ParsedConnection {
  path: string;
  resourceId: string | null;
  data: ConnectionExportData;
}

export interface ParsedTrigger {
  path: string;
  resourceId: string | null;
  data: TriggerExportData;
}

export interface ParsedWorkspace {
  pipelines: ParsedPipeline[];
  connections: ParsedConnection[];
  triggers: ParsedTrigger[];
  diagnostics: WorkspaceParseDiagnostic[];
}

/** Fixed, categorical diagnostic text — NEVER the raw JSON/Zod error, which
 * could echo arbitrary committed file content into an API response. The `code`
 * carries the machine-readable category; the `path` identifies the file. */
const DIAGNOSTIC_MESSAGE: Record<WorkspaceParseDiagnostic['code'], string> = {
  unparseable: 'file is not a valid resource envelope',
  kind_mismatch: 'envelope kind does not match its directory',
  duplicate_resource_id: 'resourceId is claimed by more than one file of this kind',
  unknown_dir: 'file is not under a managed resource directory',
  unreadable: 'file could not be read from the repository',
};

function diagnostic(
  path: string,
  code: WorkspaceParseDiagnostic['code'],
): WorkspaceParseDiagnostic {
  return { path, code, message: DIAGNOSTIC_MESSAGE[code] };
}

/** The stable identity of a resource envelope: for a pipeline it is the
 * pipeline ROW's resourceId (NOT a version's); for a connection/trigger it is
 * the resource's own resourceId. */
function envelopeResourceId(envelope: ExportEnvelope): string | null {
  return envelope.kind === 'pipeline'
    ? envelope.data.pipeline.resourceId
    : envelope.data.resourceId;
}

export function parseWorkspaceFiles(
  files: readonly WorkspaceFile[],
  unreadablePaths: readonly string[] = [],
): ParsedWorkspace {
  const pipelines: ParsedPipeline[] = [];
  const connections: ParsedConnection[] = [];
  const triggers: ParsedTrigger[] = [];
  // Unreadable files never made it into `files` — surface each as a diagnostic
  // up front so a preview shows the whole picture and an apply fails closed.
  const diagnostics: WorkspaceParseDiagnostic[] = unreadablePaths.map((path) =>
    diagnostic(path, 'unreadable'),
  );

  const seenResourceId: Record<ResourceKind, Set<string>> = {
    pipeline: new Set(),
    connection: new Set(),
    trigger: new Set(),
  };

  for (const file of files) {
    // The TOP-LEVEL segment decides the expected kind. studio only ever writes
    // `<dir>/<slug>.json` (flat), so a human-committed NESTED file
    // (`pipelines/sub/x.json`, which `ls-tree -r` would surface) is read as a
    // top-level `pipelines` file here — harmless for a read-only preview; the
    // path→identity classification that would care is G5's reconcile.
    const dir = file.path.split('/')[0] ?? '';
    const expectedKind = kindForDir(dir);
    if (expectedKind === null) {
      diagnostics.push(diagnostic(file.path, 'unknown_dir'));
      continue;
    }

    let envelope: ExportEnvelope;
    try {
      envelope = parseAndUpgradeEnvelope(file.contents);
    } catch {
      // parseAndUpgradeEnvelope throws ImportError for bad JSON / failed upgrade
      // / final validation — categorical message only, no raw-content leak.
      diagnostics.push(diagnostic(file.path, 'unparseable'));
      continue;
    }

    if (envelope.kind !== expectedKind) {
      diagnostics.push(diagnostic(file.path, 'kind_mismatch'));
      continue;
    }

    const resourceId = envelopeResourceId(envelope);
    if (resourceId !== null) {
      if (seenResourceId[expectedKind].has(resourceId)) {
        diagnostics.push(diagnostic(file.path, 'duplicate_resource_id'));
        continue;
      }
      seenResourceId[expectedKind].add(resourceId);
    }

    switch (envelope.kind) {
      case 'pipeline':
        pipelines.push({
          path: file.path,
          // #3 G6b — `undefined` (DB-snapshot, never git) collapses to `null`.
          blobSha: file.blobSha ?? null,
          resourceId,
          versionResourceIds: envelope.data.versions.map((version) => version.resourceId),
          data: envelope.data,
        });
        break;
      case 'connection':
        connections.push({ path: file.path, resourceId, data: envelope.data });
        break;
      case 'trigger':
        triggers.push({ path: file.path, resourceId, data: envelope.data });
        break;
    }
  }

  return { pipelines, connections, triggers, diagnostics };
}
