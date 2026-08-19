import {
  connectionContentForm,
  datasetContentForm,
  pipelineContentForm,
  RESOURCE_KINDS,
  triggerContentForm,
  type ResourceKind,
  type WorkspaceGitDriftResource,
} from '@autonomy-studio/shared';
import type {
  ParsedConnection,
  ParsedDataset,
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

/** Diff one kind's DB-side items against its committed-side items by
 * `resourceId`, returning the drifted resources (clean ones are omitted). A
 * `null` resourceId never matches (only pre-G1 committed files carry it, and the
 * DB side always mints real ids): a null-id DB item is therefore `added`, a
 * null-id committed item `removed`. */
function driftForKind(
  // #1112 — `WorkspaceGitDriftResource['kind']` IS `ResourceKind` (the drift
  // schema's kind field is `ExportKindSchema`, now derived from
  // `RESOURCE_KINDS`), so this names the SSOT directly rather than keeping a
  // same-shaped second name for it that could quietly stop agreeing.
  kind: ResourceKind,
  dbItems: DriftItem[],
  committedItems: DriftItem[],
): WorkspaceGitDriftResource[] {
  const committedByRid = new Map<string, DriftItem>();
  for (const item of committedItems) {
    // First-wins: a well-formed committed snapshot carries each `resourceId`
    // once (the server writes one file per resource). If a corrupted/hand-edited
    // managed dir ever carries two under one id, only one can match the single
    // DB row; the rest are NOT dropped — they fall through to the `removed` loop
    // below (matched is tracked by object identity, not by id), surfacing the
    // drift rather than silently under-reporting it (#473 fail-safe shape).
    if (item.resourceId !== null && !committedByRid.has(item.resourceId)) {
      committedByRid.set(item.resourceId, item);
    }
  }
  const matched = new Set<DriftItem>();
  const out: WorkspaceGitDriftResource[] = [];

  for (const db of dbItems) {
    const committed = db.resourceId === null ? undefined : committedByRid.get(db.resourceId);
    if (committed === undefined) {
      out.push({ path: db.path, kind, resourceId: db.resourceId, name: db.name, change: 'added' });
      continue;
    }
    matched.add(committed);
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
    if (matched.has(committed)) continue;
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

function datasetItem(d: ParsedDataset): DriftItem {
  return {
    path: d.path,
    resourceId: d.resourceId,
    name: d.data.name,
    contentForm: datasetContentForm(d.data),
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
/**
 * #1112 (M2, data-movement spec §2.3) — the per-kind projections, as an
 * EXHAUSTIVE `Record<ResourceKind, …>` rather than three spelled-out
 * `driftForKind` calls.
 *
 * This site is one of the five the spec measured as failing SILENTLY: a kind
 * missing from a spelled-out list compiles clean and then reports **permanently
 * clean** — the working copy could diverge from the branch forever and this
 * differ would say there was nothing to commit. A `Record` keyed by
 * `ResourceKind` makes the omission a compile error instead, the same idiom
 * `CONNECTION_CONFIG_SCHEMAS` (`shared/src/catalog/connection-config.ts`) uses
 * for connection kinds.
 */
const DRIFT_PROJECTIONS: Record<ResourceKind, (workspace: ParsedWorkspace) => DriftItem[]> = {
  pipeline: (workspace) => workspace.pipelines.map(pipelineItem),
  connection: (workspace) => workspace.connections.map(connectionItem),
  trigger: (workspace) => workspace.triggers.map(triggerItem),
  dataset: (workspace) => workspace.datasets.map(datasetItem),
};

export function computeDrift(
  db: ParsedWorkspace,
  committed: ParsedWorkspace,
): WorkspaceGitDriftResource[] {
  return RESOURCE_KINDS.flatMap((kind) => {
    const project = DRIFT_PROJECTIONS[kind];
    return driftForKind(kind, project(db), project(committed));
  });
}
