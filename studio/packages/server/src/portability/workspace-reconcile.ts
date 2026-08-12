import {
  connectionContentForm,
  pipelineContentForm,
  pipelineRowContentForm,
  triggerContentForm,
  type WorkspaceGitArchiveProposal,
  type WorkspaceGitDisposition,
  type WorkspaceGitPreviewResource,
} from '@autonomy-studio/shared';
import type { OwnedVersionForm } from './workspace-serialize.js';
import { normalizedTriggerContentForm } from './trigger-content.js';
import {
  latestVersion,
  type ParsedConnection,
  type ParsedPipeline,
  type ParsedTrigger,
  type ParsedWorkspace,
} from './workspace-parse.js';

/**
 * #3 G5b — the workspace-git reconcile CLASSIFIER: diff the resources committed
 * on a branch against the DB working copy and label each with a reconcile
 * DISPOSITION (create / unchanged / update / rename / superseded), plus the
 * pipelines a pull would ARCHIVE. It is PURE: it takes two already-parsed
 * `ParsedWorkspace`s (the incoming branch snapshot, and the DB re-run through the
 * SAME serialize+parse path) and reads/writes nothing — the transactional APPLY
 * of these dispositions is the next slice (G5c).
 *
 * #983 — the one fact a `ParsedWorkspace` pair cannot carry is the version
 * HISTORY: the DB side is `serializeWorkspace`, which emits each pipeline's
 * LATEST version only, so a branch pinned to a version this workspace has since
 * authored past looks like an ordinary content edit. The caller therefore passes
 * `ownedVersions` — the stored form of the versions the branch names, read once
 * by the route. It stays an argument rather than a DB read so this file keeps
 * reading nothing, and it is OPTIONAL so a caller that wants only the archive
 * proposals (the apply) pays nothing for it.
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
 * #3 G8b-3 — the compare is ALSO folded on connection READINESS: the caller may
 * pass `readyVersionRids` (owned versions whose connections are all ready,
 * `readyVersionResourceIds`); a bound trigger over a version NOT in that set folds
 * `enabled`→false, matching the row the apply's forward gate force-disables — so
 * the preview does not show a phantom `update` for a trigger the apply lands
 * disabled. Omitting it (undefined) preserves the pre-G8b-3 binding-only compare.
 * KNOWN residual: a version co-created ON this very branch is not in the readiness
 * domain (it is unminted — its readiness is unknowable without simulating the
 * write), so an EXISTING trigger REBOUND to such a version may still preview a
 * phantom `update` (apply is authoritative + dispatch-gate-backstopped). A NEW
 * trigger is unaffected — it classifies `create`, which ignores the content form.
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

/**
 * The label for one resource's diff. `supersedes` (#983, pipelines only) means
 * the content difference is one a pull would NOT write — the branch names a
 * version this workspace already holds — so it is folded out before the label is
 * chosen, leaving any name difference to speak for itself.
 *
 * The precedence mirrors the apply's action ladder exactly (`updated` >
 * `renamed` > `superseded` > `unchanged`, `workspace-apply.ts`): a superseded
 * pipeline that ALSO renames is a `rename`, because the apply really does patch
 * the row's name — the version being a no-op does not make the whole import one.
 */
function disposition(
  nameChanged: boolean,
  contentChanged: boolean,
  supersedes: boolean,
): WorkspaceGitDisposition {
  if (contentChanged && !supersedes) return 'update';
  if (nameChanged) return 'rename';
  if (contentChanged) return 'superseded';
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
  supersedes = false,
  contentUnverified = false,
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
      // A `create` has no DB counterpart, so there was no comparison to leave
      // undecided (#1018).
      contentUnverified: false,
    };
  }
  const nameChanged = name !== db.name;
  const contentChanged = contentForm !== db.contentForm;
  return {
    path,
    kind,
    resourceId,
    name,
    // `contentChanged` stays TRUE for a superseded pipeline: the branch's form
    // really does differ from the head. Only the LABEL summarises write-intent —
    // the two signals answer different questions and neither is derived from the
    // other (see `WorkspaceGitPreviewResourceSchema`).
    disposition: disposition(nameChanged, contentChanged, supersedes),
    nameChanged,
    contentChanged,
    contentUnverified,
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
  readyVersionRids?: ReadonlySet<string>,
  ownedVersions?: ReadonlyMap<string, OwnedVersionForm>,
): WorkspaceReconcilePlan {
  // #3 G7 — the resolution domain for an incoming trigger binding: every owned
  // version (`ownedVersionRids`) PLUS the version this very branch would mint,
  // so a trigger co-created with its pipeline resolves without a mint having run.
  // EXACT parity with the apply's `versionById`: the apply materialises only the
  // LATEST version per pipeline file, so a hand-crafted multi-version file's
  // non-latest version is NOT resolvable (the apply would force-disable a trigger
  // bound to it). Reuse the SHARED `latestVersion` the apply mints from — not an
  // inline copy — so the two selections can never drift.
  const incomingVersionRids = new Set<string>();
  for (const pipeline of incoming.pipelines) {
    const rid = latestVersion(pipeline)?.resourceId;
    if (rid != null) incomingVersionRids.add(rid);
  }
  const bindingResolves = (rid: string): boolean =>
    ownedVersionRids.has(rid) || incomingVersionRids.has(rid);
  // #3 G8b-3 — readiness fold: without a readiness domain (undefined), a bound
  // trigger is treated ready (pre-G8b-3 binding-only compare). A co-created
  // version is never in `readyVersionRids` (unminted) → its readiness is unknown
  // here; that only affects an existing trigger rebound onto it (documented
  // residual), never a fresh `create`-disposition trigger.
  const connectionsReady =
    readyVersionRids === undefined
      ? undefined
      : (rid: string): boolean => readyVersionRids.has(rid);

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

  // #983 — the DB side's pipeline ROW form (versions excluded; `name` is already
  // excluded as volatile), so `supersedes` can ask "is the version trail the ONLY
  // thing that differs". Its own map rather than a field on `DbEntry` because only
  // pipelines have a version trail for a difference to be attributable to.
  const dbPipelineRowForms = new Map<string, string>();
  for (const p of db.pipelines) {
    if (p.resourceId === null) continue;
    dbPipelineRowForms.set(p.resourceId, pipelineRowContentForm(p.data));
  }

  /**
   * #983 — would a pull write NOTHING for this pipeline's content difference?
   * True only when the branch's latest version is one this workspace ALREADY
   * HOLDS, byte-identical, under the pipeline that owns it — the "commit, keep
   * authoring, then pull" loop, where the DB moved on and the branch did not.
   *
   * Every other reason the forms could differ answers FALSE, deliberately. A
   * version id owned by ANOTHER pipeline, and an owned id whose content was
   * hand-edited, are the two cases the apply REFUSES outright
   * (`WorkspaceApplyError`); a row field such as `concurrency` differing is a
   * real patch the apply performs. Falling back to `update` overstates what
   * happens in the two refusal cases — but the alternative is a preview that says
   * "nothing to do" ahead of an import that either writes or refuses, and of the
   * two errors, promising a write that never comes is the one an operator can see
   * and correct. (A preview-visible REFUSAL is a larger question than #983 and is
   * filed separately.)
   *
   * Without `ownedVersions` — the apply's own call, which reads only
   * `plan.archive` — this is always false, preserving the pre-#983 labels exactly.
   *
   * #1018 — the byte-identity test goes through `OwnedVersionForm.compare`, the
   * SAME masked comparison the apply refuses on, so a stored row referencing a
   * DELETED connection is superseded in BOTH readings or neither. Comparing raw
   * forms here would put the preview back on the wrong side of the very
   * divergence #983 lifted this lookup to prevent: `update` (a promised write)
   * ahead of an apply that writes nothing. `contentUnverified` rides out with it,
   * because a preview that hides which fields could not be judged is describing a
   * comparison it did not make.
   */
  const supersession = (p: ParsedPipeline): { supersedes: boolean; contentUnverified: boolean } => {
    const no = { supersedes: false, contentUnverified: false };
    if (ownedVersions === undefined || p.resourceId === null) return no;
    const version = latestVersion(p);
    const versionRid = version?.resourceId;
    if (version === undefined || versionRid == null) return no;
    const owned = ownedVersions.get(versionRid);
    if (owned === undefined) return no;
    if (owned.pipelineResourceId !== p.resourceId) return no;
    const comparison = owned.compare(version);
    if (!comparison.identical) return no;
    const dbRowForm = dbPipelineRowForms.get(p.resourceId);
    return {
      supersedes: dbRowForm !== undefined && dbRowForm === pipelineRowContentForm(p.data),
      contentUnverified: comparison.undecidableRefs > 0,
    };
  };

  const resources: WorkspaceGitPreviewResource[] = [
    ...incoming.pipelines.map((p) => {
      const { supersedes, contentUnverified } = supersession(p);
      return classifyResource(
        'pipeline',
        p.path,
        p.resourceId,
        pipelineName(p),
        pipelineContentForm(p.data),
        dbPipelines,
        supersedes,
        contentUnverified,
      );
    }),
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
        // via `serializeTrigger`, is already resolved). #3 G8b-3 — plus the
        // readiness fold (a bound-but-unready trigger folds `enabled`→false).
        normalizedTriggerContentForm(t.data, bindingResolves, connectionsReady),
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
