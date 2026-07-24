import {
  connectionContentForm,
  pipelineContentForm,
  triggerContentForm,
  type WorkspaceGitDriftResource,
} from '@autonomy-studio/shared';
import type {
  ParsedConnection,
  ParsedPipeline,
  ParsedTrigger,
  ParsedWorkspace,
} from './workspace-parse.js';

/**
 * #3 G10 — the COMMIT-direction DRIFT between the DB working copy and the studio
 * working branch: the pure dual of the pull-direction reconcile classifier
 * (`workspace-reconcile.ts`). Given both sides already parsed
 * (`parseWorkspaceFiles`), it reports which resources a Commit would add /
 * remove / modify / rename, matched by stable `resourceId` (identity; the file
 * PATH is cosmetic, G1).
 *
 * Equality is the canonical CONTENT FORM (`content-form.ts`) — the SAME
 * primitive the reconcile classifier uses — NOT byte/blob equality. This is
 * load-bearing (settled #662, and the `content-form.ts` docstring names this
 * drift gate as its reuse): a re-mint that only bumps volatile fields (a new
 * immutable version id/number, a `node.position` drag) leaves the content form
 * unchanged, so it is NOT drift. Byte equality would over-report every such
 * re-mint (and every import round-trip, which mints fresh version ids) as
 * "uncommitted" — the exact churn #662 excludes.
 *
 * `renamed` vs `modified`: the content form excludes the display `name` (the
 * reconcile tracks a rename as a SEPARATE signal), so this differ compares names
 * explicitly. A resource whose content form differs is `modified` even if the
 * name also changed (content supersedes, mirroring the reconcile's
 * `disposition()` precedence); a name-only change is `renamed`.
 *
 * Read-only and pure: no DB, no git, no I/O. The route feeds it the DB snapshot
 * (`serializeWorkspace` → `parseWorkspaceFiles`) and the committed snapshot
 * (`readWorkspaceFilesAtRef` → `parseWorkspaceFiles`); a committed file that
 * would not parse never reaches here (it stays a `diagnostic` on the route
 * result), so it is never manufactured as a spurious match (#473 shape).
 */

/** The per-kind projection this differ needs: identity, path, display name, and
 * the canonical content form. Both the DB and committed sides are `ParsedX`
 * lists, so the accessors are shared. */
interface DriftItem {
  path: string;
  resourceId: string | null;
  name: string;
  contentForm: string;
}

type ExportKind = WorkspaceGitDriftResource['kind'];

/** Diff one kind's DB-side items against its committed-side items by
 * `resourceId`, returning the drifted resources (clean ones are omitted). A
 * `null` resourceId never matches (only pre-G1 committed files carry it, and the
 * DB side always mints real ids): a null-id DB item is therefore `added`, a
 * null-id committed item `removed`. */
function driftForKind(
  kind: ExportKind,
  dbItems: DriftItem[],
  committedItems: DriftItem[],
): WorkspaceGitDriftResource[] {
  const committedByRid = new Map<string, DriftItem>();
  for (const item of committedItems) {
    if (item.resourceId !== null) committedByRid.set(item.resourceId, item);
  }
  const matchedRids = new Set<string>();
  const out: WorkspaceGitDriftResource[] = [];

  for (const db of dbItems) {
    const committed = db.resourceId === null ? undefined : committedByRid.get(db.resourceId);
    if (committed === undefined) {
      out.push({ path: db.path, kind, resourceId: db.resourceId, name: db.name, change: 'added' });
      continue;
    }
    matchedRids.add(db.resourceId!);
    if (db.contentForm !== committed.contentForm) {
      out.push({
        path: db.path,
        kind,
        resourceId: db.resourceId,
        name: db.name,
        change: 'modified',
      });
    } else if (db.name !== committed.name) {
      out.push({
        path: db.path,
        kind,
        resourceId: db.resourceId,
        name: db.name,
        change: 'renamed',
      });
    }
    // else: content form AND name identical → clean → omitted.
  }

  for (const committed of committedItems) {
    if (committed.resourceId !== null && matchedRids.has(committed.resourceId)) continue;
    out.push({
      path: committed.path,
      kind,
      resourceId: committed.resourceId,
      name: committed.name,
      change: 'removed',
    });
  }
  return out;
}

function pipelineItem(p: ParsedPipeline): DriftItem {
  return {
    path: p.path,
    resourceId: p.resourceId,
    name: p.data.pipeline.name,
    contentForm: pipelineContentForm(p.data),
  };
}

function connectionItem(c: ParsedConnection): DriftItem {
  return {
    path: c.path,
    resourceId: c.resourceId,
    name: c.data.name,
    contentForm: connectionContentForm(c.data),
  };
}

function triggerItem(t: ParsedTrigger): DriftItem {
  return {
    path: t.path,
    resourceId: t.resourceId,
    name: t.data.name,
    contentForm: triggerContentForm(t.data),
  };
}

/**
 * The drifted resources between the DB working copy (`db`) and the committed
 * snapshot (`committed`), both already parsed — a `clean` resource is omitted, so
 * a non-empty result means there are content/rename/add/remove changes. This
 * pure differ sees only the successfully-parsed resources; a committed file that
 * would NOT parse is the route's concern (a `diagnostic`, which the route ALSO
 * folds into `hasUncommittedChanges` — an uncomparable committed file is a
 * pending change the next Commit would drop, never a silent `clean`).
 */
export function computeDrift(
  db: ParsedWorkspace,
  committed: ParsedWorkspace,
): WorkspaceGitDriftResource[] {
  return [
    ...driftForKind(
      'pipeline',
      db.pipelines.map(pipelineItem),
      committed.pipelines.map(pipelineItem),
    ),
    ...driftForKind(
      'connection',
      db.connections.map(connectionItem),
      committed.connections.map(connectionItem),
    ),
    ...driftForKind('trigger', db.triggers.map(triggerItem), committed.triggers.map(triggerItem)),
  ];
}
