import {
  connectionContentForm,
  pipelineContentForm,
  triggerContentForm,
  type WorkspaceGitArchiveProposal,
  type WorkspaceGitDisposition,
  type WorkspaceGitPreviewResource,
} from '@autonomy-studio/shared';
import { normalizedTriggerContentForm } from './trigger-content.js';
import type {
  ParsedConnection,
  ParsedPipeline,
  ParsedTrigger,
  ParsedWorkspace,
} from './workspace-parse.js';

/**
 * #3 G5b — the workspace-git reconcile CLASSIFIER: diff the resources committed
 * on a branch against the DB working copy and label each with a reconcile
 * DISPOSITION (create / unchanged / update / rename), plus the pipelines a pull
 * would ARCHIVE. It is PURE: it takes two already-parsed `ParsedWorkspace`s (the
 * incoming branch snapshot, and the DB re-run through the SAME serialize+parse
 * path) and reads/writes nothing — the transactional APPLY of these dispositions
 * is the next slice (G5c).
 *
 * Matching is by stable `resourceId` (identity; the file PATH is cosmetic, G1),
 * so a resource that moved paths (a rename) is still recognised as the same
 * resource. Content equality is the canonical CONTENT FORM (`content-form.ts`),
 * which excludes identity/volatile/local-runtime fields — so cross-machine ids,
 * timestamps, row-version numbers, canvas positions, and the local
 * `requiresSecret` flag never manufacture a spurious `update`.
 *
 * Because the DB side is produced by `serializeWorkspace` (which already OMITS
 * archived pipelines and version-less shells, #666), the classifier's DB
 * baseline is exactly the committable working copy — an archived pipeline never
 * appears as an `update`/`archive` against itself.
 *
 * #3 G7 — an incoming trigger's binding is diffed in RESOLVED space via
 * `ownedVersionRids` (the caller passes `listVersionResourceIds` — ALL owned
 * versions incl. archived, NOT derivable from the latest-only DB snapshot),
 * unioned with the branch's own to-be-minted version ids. A binding that does
 * not resolve normalizes to (null, disabled) — matching what the apply persists —
 * so a force-disabled unbound trigger stops previewing a phantom `update` forever
 * (the same resolved-space compare the apply does at `workspace-apply.ts`).
 *
 * Scope boundary (DELIBERATELY not here): only PIPELINES surface an archive
 * proposal (they are the only kind with an archive state, G5a). A connection or
 * trigger present in the DB but ABSENT from the branch is NOT surfaced — its
 * delete/orphan semantics are undecided in the spec ("never DB-delete on
 * import") and are deferred to the G5c apply. A pre-G1 file (`resourceId: null`)
 * has no identity to match, so it always classifies `create`.
 *
 * Archive inference is SOUND only over a complete snapshot: if `incoming` carries
 * any parse diagnostic (a file that failed to read/parse never reached
 * `incoming.pipelines`), NO archives are proposed — an absent id could be a real
 * deletion or just an unread file, indistinguishable here (#664).
 */

export interface WorkspaceReconcilePlan {
  resources: WorkspaceGitPreviewResource[];
  archive: WorkspaceGitArchiveProposal[];
}

/** The DB-side facts needed to diff one incoming resource: its display name and
 * canonical content form, keyed by `resourceId`. */
interface DbEntry {
  name: string;
  contentForm: string;
}

function disposition(nameChanged: boolean, contentChanged: boolean): WorkspaceGitDisposition {
  if (contentChanged) return 'update';
  if (nameChanged) return 'rename';
  return 'unchanged';
}

/**
 * Classify one incoming resource against the DB-side map for its kind. A `null`
 * resourceId, or an id with no DB counterpart, is a `create` (no diff — both
 * change flags `false`); otherwise the disposition is derived from the
 * independent name/content change signals, both carried through so a
 * rename-that-also-edits loses neither.
 */
function classifyResource(
  kind: WorkspaceGitPreviewResource['kind'],
  path: string,
  resourceId: string | null,
  name: string,
  contentForm: string,
  dbByResourceId: Map<string, DbEntry>,
): WorkspaceGitPreviewResource {
  const db = resourceId === null ? undefined : dbByResourceId.get(resourceId);
  if (db === undefined) {
    return {
      path,
      kind,
      resourceId,
      name,
      disposition: 'create',
      nameChanged: false,
      contentChanged: false,
    };
  }
  const nameChanged = name !== db.name;
  const contentChanged = contentForm !== db.contentForm;
  return {
    path,
    kind,
    resourceId,
    name,
    disposition: disposition(nameChanged, contentChanged),
    nameChanged,
    contentChanged,
  };
}

/** Build the DB-side lookup for a kind, keyed by `resourceId`. The DB side comes
 * from `serializeWorkspace`, which always mints real (non-null) resourceIds, so
 * a `null` here would be a bug — such rows are skipped rather than trusted. */
function dbMap<T>(
  parsed: readonly T[],
  resourceIdOf: (r: T) => string | null,
  nameOf: (r: T) => string,
  contentFormOf: (r: T) => string,
): Map<string, DbEntry> {
  const map = new Map<string, DbEntry>();
  for (const resource of parsed) {
    const resourceId = resourceIdOf(resource);
    if (resourceId === null) continue;
    map.set(resourceId, { name: nameOf(resource), contentForm: contentFormOf(resource) });
  }
  return map;
}

const pipelineName = (p: ParsedPipeline): string => p.data.pipeline.name;
const connectionName = (c: ParsedConnection): string => c.data.name;
const triggerName = (t: ParsedTrigger): string => t.data.name;

/**
 * Classify a whole incoming workspace against the DB working copy. `incoming`
 * is the branch snapshot (`parseWorkspaceFiles` over the committed files);
 * `db` is `parseWorkspaceFiles(serializeWorkspace(...))` — the DB run through
 * the identical serialize+parse path, so both sides get identical volatile
 * treatment for free. Resource order follows `incoming` (pipelines, then
 * connections, then triggers) for a stable preview.
 */
export function classifyWorkspace(
  db: ParsedWorkspace,
  incoming: ParsedWorkspace,
  ownedVersionRids: ReadonlySet<string>,
): WorkspaceReconcilePlan {
  // #3 G7 — the resolution domain for an incoming trigger binding: every owned
  // version (`ownedVersionRids`) PLUS the version this very branch would mint,
  // so a trigger co-created with its pipeline resolves without a mint having run.
  // EXACT parity with the apply's `versionById`: the apply materialises only the
  // LATEST version per pipeline file (`latestVersion`), so a hand-crafted
  // multi-version file's non-latest version is NOT resolvable (the apply would
  // force-disable a trigger bound to it) — take only the last version's id, not
  // every version, else the preview would be too lenient for that non-canonical
  // input.
  const incomingVersionRids = new Set<string>();
  for (const pipeline of incoming.pipelines) {
    const versions = pipeline.data.versions;
    const latest = versions.length > 0 ? versions[versions.length - 1] : undefined;
    if (latest !== undefined && latest.resourceId !== null) {
      incomingVersionRids.add(latest.resourceId);
    }
  }
  const bindingResolves = (rid: string): boolean =>
    ownedVersionRids.has(rid) || incomingVersionRids.has(rid);

  const dbPipelines = dbMap(
    db.pipelines,
    (p) => p.resourceId,
    pipelineName,
    (p) => pipelineContentForm(p.data),
  );
  const dbConnections = dbMap(
    db.connections,
    (c) => c.resourceId,
    connectionName,
    (c) => connectionContentForm(c.data),
  );
  const dbTriggers = dbMap(
    db.triggers,
    (t) => t.resourceId,
    triggerName,
    (t) => triggerContentForm(t.data),
  );

  const resources: WorkspaceGitPreviewResource[] = [
    ...incoming.pipelines.map((p) =>
      classifyResource(
        'pipeline',
        p.path,
        p.resourceId,
        pipelineName(p),
        pipelineContentForm(p.data),
        dbPipelines,
      ),
    ),
    ...incoming.connections.map((c) =>
      classifyResource(
        'connection',
        c.path,
        c.resourceId,
        connectionName(c),
        connectionContentForm(c.data),
        dbConnections,
      ),
    ),
    ...incoming.triggers.map((t) =>
      classifyResource(
        'trigger',
        t.path,
        t.resourceId,
        triggerName(t),
        // #3 G7 — the incoming side is normalized to resolved space (the DB side,
        // via `serializeTrigger`, is already resolved).
        normalizedTriggerContentForm(t.data, bindingResolves),
        dbTriggers,
      ),
    ),
  ];

  // A DB pipeline whose resourceId is absent from the branch would be archived
  // by a pull (git-delete → archive, G5a). Only non-null incoming ids can match
  // (a `null`-id incoming pipeline is a fresh create, never a match).
  //
  // But "absent from the branch" is only sound when the branch snapshot is
  // COMPLETE. A parse diagnostic (#664 unreadable, or unparseable / kind_mismatch
  // / unknown_dir) means a committed file did NOT reach `incoming.pipelines`, so
  // an absent id could be a real deletion OR just an unread file — indistinguishable
  // here. Inferring archive from an incomplete snapshot would advertise a spurious
  // "will archive P" for the very pipeline whose file failed to read. So propose
  // NO archives while any diagnostic stands (the operator fixes the branch first);
  // the apply already REFUSES wholesale on any diagnostic, so this only makes the
  // read-only preview agree with that fail-closed posture.
  const incomingPipelineIds = new Set(
    incoming.pipelines.map((p) => p.resourceId).filter((id): id is string => id !== null),
  );
  const archive: WorkspaceGitArchiveProposal[] =
    incoming.diagnostics.length > 0
      ? []
      : db.pipelines
          .filter((p) => p.resourceId !== null && !incomingPipelineIds.has(p.resourceId))
          .map((p) => ({
            path: p.path,
            kind: 'pipeline' as const,
            resourceId: p.resourceId!,
            name: pipelineName(p),
          }));

  return { resources, archive };
}
