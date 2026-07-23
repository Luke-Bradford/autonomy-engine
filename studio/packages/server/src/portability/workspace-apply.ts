import {
  connectionContentForm,
  interpolationMode,
  pipelineVersionContentForm,
  type Node,
  type NodeExport,
  type PipelineVersion,
  type PipelineVersionExport,
  type WorkspaceGitAppliedAction,
  type WorkspaceGitAppliedResource,
  type WorkspaceGitApplyResult,
  type WorkspaceGitArchivedResult,
  type WorkspaceGitDeferredResource,
} from '@autonomy-studio/shared';
import { archivePipeline } from '../repo/archive.js';
import {
  createConnection,
  getConnectionByResourceId,
  listConnections,
  updateConnection,
} from '../repo/connections.js';
import {
  createPipeline,
  getPipelineByResourceId,
  listPipelines,
  restorePipeline,
  updatePipeline,
} from '../repo/pipelines.js';
import {
  createPipelineVersion,
  getLatestPipelineVersion,
  listPipelineVersions,
} from '../repo/pipeline-versions.js';
import type { Db } from '../repo/types.js';
import { classifyWorkspace } from './workspace-reconcile.js';
import {
  parseWorkspaceFiles,
  type ParsedPipeline,
  type ParsedWorkspace,
} from './workspace-parse.js';
import { serializeWorkspace } from './workspace-serialize.js';

/**
 * #3 G5c-1 — the transactional reconcile APPLY write-path: the WRITE inverse of
 * `serializeWorkspace` (G3a) and the consumer of the G5b reconcile CLASSIFIER.
 * Takes the parsed branch snapshot (`parseWorkspaceFiles` over the committed
 * managed files) and reconciles it INTO the owner's DB working copy, atomically:
 * every write lands in ONE `db.transaction`, so a mid-way refusal (an invalid
 * doc, an unresolved ref, a cyclic call chain) leaves the DB exactly as it was.
 *
 * What this slice applies (spec #3 G5, table row G5):
 * - CONNECTIONS: create (preserving the file's `resourceId`) / update / rename.
 * - PIPELINES: create / RESTORE-onto-archived (spec note 1: a soft-archived
 *   pipeline whose file reappears classifies `create` because serialize omits
 *   archived — the apply un-archives the existing row rather than minting a
 *   duplicate under the same `resourceId`) / update (mint a NEW immutable
 *   version, preserving the file's version `resourceId`) / rename / concurrency.
 * - ARCHIVE: a DB pipeline whose file is ABSENT from the branch → `archivePipeline`
 *   (soft-delete + disable dependent triggers), reusing the G5a service.
 *
 * Deliberately DEFERRED to G5c-2 (#670): TRIGGER apply (binding remap,
 * mode-consistency, enabled/unbound). An incoming trigger is REPORTED in
 * `deferred` with its classifier disposition (honest round-trip — the preview
 * shows it, the apply names it as not-yet-applied), never silently applied.
 *
 * Inverse ref-remap (the precise inverse of `serializeWorkspace`'s `remapNode`):
 * a node's `connectionId` and `call.pipelineVersionId` are stable `resourceId`s
 * on the wire — resolved back to concrete DB ids via owner-scoped maps built
 * from the owner's own rows PLUS everything created in THIS apply. A `${}`
 * dynamic ref is preserved verbatim (it routes on run values; `interpolationMode`
 * is the SSOT, exactly as serialize decides it); a `null` connection ref stays
 * absent. A non-null LITERAL ref that resolves to nothing FAILS the whole apply
 * loudly (`WorkspaceApplyError`) — never a silent `null` (the #473 fail-open
 * shape; symmetric to serialize's `WorkspaceSerializeError`).
 *
 * Fail-closed on a corrupt branch: if the parse produced ANY diagnostic
 * (unparseable / duplicate-resourceId / unknown-dir), the whole import is
 * REFUSED (`refused: true`, nothing written) rather than partially applying a
 * known-broken tree — the merge-gate "a `gh` failure is never CI-green" posture.
 */

/**
 * A branch reference (a node's connection / call ref) that is a non-null LITERAL
 * `resourceId` resolving to no owned row and nothing created in this apply — a
 * broken/incomplete branch. Aborts the atomic apply; surfaced by the route as an
 * internal error (a corrupt commit, not the shape of user HTTP input). Also
 * thrown for a cyclic `call_pipeline` chain among co-created pipelines, which has
 * no valid mint order.
 */
export class WorkspaceApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceApplyError';
  }
}

/** The last (latest) version in a pipeline file. `serializeWorkspace` emits
 * exactly one (latest) version per pipeline (git history IS the version trail),
 * so this is that version; a hand-authored multi-version file applies its LAST
 * only — mirroring the serialize contract (the older versions live in git). */
function latestVersion(pipeline: ParsedPipeline): PipelineVersionExport | undefined {
  const versions = pipeline.data.versions;
  return versions.length > 0 ? versions[versions.length - 1] : undefined;
}

/** The literal (non-`${}`) `call.pipelineVersionId` resourceIds a version's
 * nodes reference — the edges that order the in-batch version mint. */
function literalCallRefs(version: PipelineVersionExport): string[] {
  const refs: string[] = [];
  for (const node of version.nodes) {
    const ref = node.call?.pipelineVersionId;
    if (ref !== undefined && interpolationMode(ref).mode === 'literal') refs.push(ref);
  }
  return refs;
}

/** Remap ONE node's `resourceId` refs to concrete DB ids (the inverse of
 * serialize's `remapNode`). `${}` dynamic refs are preserved; a `null`
 * connection ref becomes an absent key (the DB `NodeSchema.connectionId` is
 * `optional()`, never `null`); an unresolved literal ref throws. */
function remapNodeToDb(
  node: NodeExport,
  connById: Map<string, string>,
  versionById: Map<string, string>,
): Node {
  const { connectionId, call, ...rest } = node;
  const base = rest as Node;

  let dbNode: Node;
  if (connectionId === null) {
    dbNode = base;
  } else if (interpolationMode(connectionId).mode !== 'literal') {
    dbNode = { ...base, connectionId }; // dynamic — preserve verbatim
  } else {
    const resolved = connById.get(connectionId);
    if (resolved === undefined) {
      throw new WorkspaceApplyError(
        `node "${node.id}" references connection "${connectionId}", which is not on the branch or in the workspace`,
      );
    }
    dbNode = { ...base, connectionId: resolved };
  }

  if (call) {
    const ref = call.pipelineVersionId;
    let resolvedRef: string;
    if (interpolationMode(ref).mode !== 'literal') {
      resolvedRef = ref; // dynamic — preserve verbatim
    } else {
      const mapped = versionById.get(ref);
      if (mapped === undefined) {
        throw new WorkspaceApplyError(
          `node "${node.id}" call references pipeline version "${ref}", which is not on the branch or in the workspace`,
        );
      }
      resolvedRef = mapped;
    }
    dbNode = { ...dbNode, call: { ...call, pipelineVersionId: resolvedRef } };
  }

  return dbNode;
}

/** A pipeline whose apply will MINT a new immutable version, plus the in-batch
 * call edges that constrain the mint order. */
interface Minter {
  pipelineId: string;
  versionRid: string | null;
  version: PipelineVersionExport;
  callRefs: string[];
}

/**
 * Order the version mints so a pipeline whose call node references ANOTHER
 * co-created pipeline's brand-new version is minted AFTER it —
 * `createPipelineVersion`'s doc validator resolves a callee's nodes from the DB,
 * so the callee must be physically inserted first. Kahn over the in-batch edges
 * (a ref to an already-materialised version needs no edge — it resolves from the
 * seed). Deterministic (file order within each ready set). A cycle among
 * co-created `call_pipeline` chains has no valid order → `WorkspaceApplyError`.
 */
function mintOrder(minters: Minter[]): number[] {
  const ridToIndex = new Map<string, number>();
  minters.forEach((m, i) => {
    if (m.versionRid !== null) ridToIndex.set(m.versionRid, i);
  });
  const deps = minters.map((m, i) => {
    const set = new Set<number>();
    for (const ref of m.callRefs) {
      const j = ridToIndex.get(ref);
      if (j !== undefined && j !== i) set.add(j);
    }
    return set;
  });

  const order: number[] = [];
  const done = new Set<number>();
  while (order.length < minters.length) {
    let progressed = false;
    for (let i = 0; i < minters.length; i++) {
      if (done.has(i)) continue;
      let ready = true;
      for (const d of deps[i]!) {
        if (!done.has(d)) {
          ready = false;
          break;
        }
      }
      if (ready) {
        order.push(i);
        done.add(i);
        progressed = true;
      }
    }
    if (!progressed) {
      throw new WorkspaceApplyError(
        'workspace-git import has a cyclic call_pipeline dependency among co-created pipelines; the version mint cannot be ordered',
      );
    }
  }
  return order;
}

export function applyWorkspace(
  db: Db,
  ownerId: string,
  incoming: ParsedWorkspace,
  head: string | null,
): WorkspaceGitApplyResult {
  // Fail-closed on a corrupt branch: refuse the whole import (nothing written).
  if (incoming.diagnostics.length > 0) {
    return {
      head,
      refused: true,
      applied: [],
      deferred: [],
      archived: [],
      diagnostics: incoming.diagnostics,
    };
  }

  return db.transaction(() => {
    // The DB working copy run through the IDENTICAL serialize+parse path the
    // branch files took, so both sides of every content diff get the same
    // volatile treatment (and archived pipelines are omitted, #666) — this is
    // the classifier's baseline too.
    const dbSnapshot = parseWorkspaceFiles(serializeWorkspace(db, ownerId));
    const dbConnFormByRid = new Map<string, string>();
    for (const c of dbSnapshot.connections) {
      if (c.resourceId !== null) dbConnFormByRid.set(c.resourceId, connectionContentForm(c.data));
    }
    const plan = classifyWorkspace(dbSnapshot, incoming);

    const applied: WorkspaceGitAppliedResource[] = [];

    // --- Connections (leaf: they reference nothing) ---
    // `connById` (resourceId → DB id) resolves node connection refs on the way
    // IN; `connRidByDbId` (the inverse) is used to compute a stored version's
    // content form in resourceId-space for the change decision below.
    const connById = new Map<string, string>();
    const connRidByDbId = new Map<string, string>();
    for (const c of listConnections(db, ownerId)) {
      connById.set(c.resourceId, c.id);
      connRidByDbId.set(c.id, c.resourceId);
    }

    for (const inc of incoming.connections) {
      const data = inc.data;
      const existing =
        inc.resourceId === null ? null : getConnectionByResourceId(db, ownerId, inc.resourceId);
      const patch = {
        name: data.name,
        kind: data.kind,
        config: data.config,
        parameters: data.parameters,
      };
      if (existing === null) {
        // secretRef is NEVER imported (secrets never in git) — a fresh
        // connection starts with none; `requiresSecret` is G8's readiness gate.
        const created = createConnection(
          db,
          { ...patch, ownerId, secretRef: null },
          inc.resourceId !== null ? { resourceId: inc.resourceId } : undefined,
        );
        connById.set(created.resourceId, created.id);
        applied.push({
          path: inc.path,
          kind: 'connection',
          resourceId: created.resourceId,
          action: 'created',
        });
        continue;
      }

      const dbForm = inc.resourceId !== null ? dbConnFormByRid.get(inc.resourceId) : undefined;
      const contentChanged = dbForm === undefined || connectionContentForm(data) !== dbForm;
      const nameChanged = data.name !== existing.name;
      let action: WorkspaceGitAppliedAction = 'unchanged';
      if (contentChanged) {
        updateConnection(db, existing.id, patch);
        action = 'updated';
      } else if (nameChanged) {
        updateConnection(db, existing.id, { name: data.name });
        action = 'renamed';
      }
      connById.set(existing.resourceId, existing.id);
      applied.push({ path: inc.path, kind: 'connection', resourceId: existing.resourceId, action });
    }

    // --- Pipelines ---
    // Seed the version map with EVERY owned version (incl. archived pipelines'
    // versions — a call ref to an archived pipeline's still-present version must
    // resolve). `existingVersionRids` is the skip-mint guard: an incoming version
    // already materialised (a restore that preserved it, or a DB-ahead re-pull)
    // is a no-op, never a UNIQUE-index collision.
    const versionById = new Map<string, string>();
    const versionRidByDbId = new Map<string, string>();
    const existingVersionRids = new Set<string>();
    for (const pipeline of listPipelines(db, ownerId)) {
      for (const v of listPipelineVersions(db, pipeline.id)) {
        versionById.set(v.resourceId, v.id);
        versionRidByDbId.set(v.id, v.resourceId);
        existingVersionRids.add(v.resourceId);
      }
    }

    const minters: Minter[] = [];

    for (const inc of incoming.pipelines) {
      const row = inc.data.pipeline;
      const version = latestVersion(inc);
      const versionRid = version?.resourceId ?? null;
      // The version doc already materialised under this owner (a restore that
      // preserved it, or a re-pull of what we already have) — an immutable
      // version is never re-minted (skip guard) and never collides on the
      // `(pipeline_id, resource_id)` UNIQUE index.
      const alreadyMaterialised = versionRid !== null && existingVersionRids.has(versionRid);
      const existing =
        inc.resourceId === null ? null : getPipelineByResourceId(db, ownerId, inc.resourceId);

      let pipelineId: string;
      let resourceId: string;
      let action: WorkspaceGitAppliedAction;
      // Whether THIS pipeline queues a version mint — derived ONCE here (every
      // branch below sets it) so the reported `action` can never disagree with
      // what is actually written.
      let willMint: boolean;

      if (existing === null) {
        // A brand-new pipeline claiming a version `resourceId` that already
        // exists (under ANY of the owner's pipelines) is a contradiction —
        // version ids are globally unique by construction, so this is a corrupt
        // / hand-crafted branch. Fail closed, symmetric to the existing-pipeline
        // path below (#473): never create a version-less shell + report
        // `created` while silently dropping the version.
        if (version !== undefined && alreadyMaterialised) {
          throw new WorkspaceApplyError(
            `new pipeline "${inc.resourceId ?? '(pre-G1)'}" branch version "${versionRid}" reuses an existing immutable version id — version ids are unique per resource`,
          );
        }
        const created = createPipeline(
          db,
          { ownerId, name: row.name, concurrency: row.concurrency },
          inc.resourceId !== null ? { resourceId: inc.resourceId } : undefined,
        );
        pipelineId = created.id;
        resourceId = created.resourceId;
        action = 'created';
        willMint = version !== undefined;
      } else {
        pipelineId = existing.id;
        resourceId = existing.resourceId;
        const rowPatch: { name?: string; concurrency?: number | null } = {};
        if (row.name !== existing.name) rowPatch.name = row.name;
        if (row.concurrency !== existing.concurrency) rowPatch.concurrency = row.concurrency;
        if (Object.keys(rowPatch).length > 0) updatePipeline(db, existing.id, rowPatch);

        // The version write is decided UNIFORMLY for a live OR an archived
        // (restore) pipeline: compare the branch's latest version doc against the
        // pipeline's ACTUAL latest DB version — which survives archive — in
        // resourceId-space via the reverse maps. A branch whose latest doc
        // DIFFERS but reuses an EXISTING immutable version `resourceId` is a
        // contradiction (immutable rows can't be edited in place — a hand-edit
        // that kept the id, or a git-revert to a superseded version): fail closed
        // (#473, never silently skip a real edit), for archived and live alike.
        // A benign no-op (identical doc) does NOT trip this — `versionChanged` is
        // false. This is the ONE place `willMint` is decided, so the reported
        // `action` can never disagree with what is written.
        const dbLatest = getLatestPipelineVersion(db, existing.id);
        const dbLatestForm = dbLatest
          ? dbVersionForm(dbLatest, connRidByDbId, versionRidByDbId)
          : undefined;
        const versionChanged =
          version !== undefined &&
          (dbLatestForm === undefined || pipelineVersionContentForm(version) !== dbLatestForm);
        if (versionChanged && alreadyMaterialised) {
          throw new WorkspaceApplyError(
            `pipeline "${existing.resourceId}" branch version "${versionRid}" reuses an existing immutable version id with different content — author a new version instead of editing one in place`,
          );
        }
        willMint = versionChanged; // alreadyMaterialised + changed already threw

        if (existing.archived) {
          restorePipeline(db, existing.id);
          action = 'restored';
        } else if (willMint || rowPatch.concurrency !== undefined) {
          action = 'updated';
        } else if (rowPatch.name !== undefined) {
          action = 'renamed';
        } else {
          action = 'unchanged';
        }
      }

      applied.push({ path: inc.path, kind: 'pipeline', resourceId, action });
      if (willMint && version !== undefined) {
        minters.push({ pipelineId, versionRid, version, callRefs: literalCallRefs(version) });
      }
    }

    // Mint versions in call-dependency order so a co-created callee exists before
    // its caller's doc is validated.
    for (const idx of mintOrder(minters)) {
      const m = minters[idx]!;
      const created = createPipelineVersion(
        db,
        {
          ...m.version,
          pipelineId: m.pipelineId,
          nodes: m.version.nodes.map((n) => remapNodeToDb(n, connById, versionById)),
        },
        m.versionRid !== null ? { resourceId: m.versionRid } : undefined,
      );
      if (m.versionRid !== null) versionById.set(m.versionRid, created.id);
    }

    // --- Triggers: deferred to G5c-2 (#670) — report, do not apply ---
    const deferred: WorkspaceGitDeferredResource[] = plan.resources
      .filter((r) => r.kind === 'trigger')
      .map((r) => ({
        path: r.path,
        kind: 'trigger' as const,
        resourceId: r.resourceId,
        disposition: r.disposition,
      }));

    // --- Archive: a DB pipeline whose file is absent from the branch ---
    const archived: WorkspaceGitArchivedResult[] = [];
    for (const proposal of plan.archive) {
      const target = getPipelineByResourceId(db, ownerId, proposal.resourceId);
      if (target === null) continue; // vanished under us — never manufacture one
      const result = archivePipeline(db, target.id);
      if (result === null) continue;
      archived.push({
        resourceId: proposal.resourceId,
        name: result.pipeline.name,
        disabledTriggerIds: result.disabledTriggerIds,
      });
    }

    return { head, refused: false, applied, deferred, archived, diagnostics: [] };
  });
}

/**
 * Remap a STORED DB node's concrete ids back to stable `resourceId`s (the
 * forward direction serialize uses), so a stored version can be compared to a
 * branch version in the SAME resourceId-space. `${}` dynamic refs stay verbatim;
 * an absent `connectionId` becomes `null` (the export shape). An id absent from
 * the owner-scoped reverse map is kept as-is (defensive — an owned row's refs
 * always map; a mismatch just makes the content forms differ, never a false
 * "unchanged"). Reads no DB — pure over the passed maps.
 */
function forwardRemapNode(
  node: Node,
  connRidByDbId: Map<string, string>,
  versionRidByDbId: Map<string, string>,
): NodeExport {
  const { connectionId, call, ...rest } = node;
  let connExport: string | null;
  if (connectionId === undefined) connExport = null;
  else if (interpolationMode(connectionId).mode !== 'literal') connExport = connectionId;
  else connExport = connRidByDbId.get(connectionId) ?? connectionId;

  const exported: NodeExport = { ...rest, connectionId: connExport };
  if (call) {
    const ref = call.pipelineVersionId;
    const refExport =
      interpolationMode(ref).mode !== 'literal' ? ref : (versionRidByDbId.get(ref) ?? ref);
    exported.call = { ...call, pipelineVersionId: refExport };
  }
  return exported;
}

/** The content form of a STORED DB version, in resourceId-space — the baseline
 * the branch's incoming version is compared against to decide "mint a new
 * version vs no-op vs a divergent-content contradiction". Uses the reverse maps
 * so archived pipelines' versions (omitted from the serialize snapshot) are
 * comparable too. */
function dbVersionForm(
  version: PipelineVersion,
  connRidByDbId: Map<string, string>,
  versionRidByDbId: Map<string, string>,
): string {
  const exportForm = {
    ...version,
    nodes: version.nodes.map((n) => forwardRemapNode(n, connRidByDbId, versionRidByDbId)),
  } as PipelineVersionExport;
  return pipelineVersionContentForm(exportForm);
}
