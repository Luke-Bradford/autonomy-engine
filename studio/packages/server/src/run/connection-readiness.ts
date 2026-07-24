import { catalog, interpolationMode } from '@autonomy-studio/shared';
import { connectionNotReadyReason, getConnection } from '../repo/connections.js';
import { getPipelineVersion, listPipelineVersions } from '../repo/pipeline-versions.js';
import { listPipelines } from '../repo/pipelines.js';
import { listTriggers, updateTrigger } from '../repo/triggers.js';
import type { Db } from '../repo/types.js';

/**
 * #3 G8b — the enable-side twin of the executor's DISPATCH readiness gate
 * (`resolveConnection`, G8a): scan a pipeline VERSION's nodes and report every
 * connection reference that is not ready to dispatch. Used by the trigger routes
 * to REFUSE enabling a trigger bound to a version whose connections cannot run
 * (git-publish spec 120-123: "a trigger referencing unresolved connections
 * cannot be enabled until validation passes"). Readiness is checked at ENABLE
 * and at DISPATCH, never at version SAVE — a version is immutable but connections
 * are mutable, so a save-time check would go stale (`NodeSchema.connectionId`
 * settled this: the existence/allowlist check lives at dispatch, not save).
 *
 * Deliberately MIRRORS `resolveConnection` so the enable gate and the dispatch
 * gate can never disagree about what "ready" means:
 * - only nodes whose ACTIVITY binds a connection (`connectionKinds.length > 0`)
 *   are checked — a stray `connectionId` on a connection-less activity is never
 *   dispatched, so it must not block enable;
 * - a `${}`-DYNAMIC `connectionId` is skipped — it is unresolvable statically
 *   (it routes on run values); the dispatch gate checks it at fire time;
 * - owner-scope EXACTLY as the dispatch gate: a null or cross-owner connection
 *   folds to `missing`, never a distinct "forbidden", so the refusal message can
 *   never confirm the existence of another owner's connection;
 * - the ready/not-ready decision for an OWNED row is the shared
 *   `connectionNotReadyReason` predicate.
 *
 * A required-connection node carrying NO `connectionId` is out of scope here: it
 * is the structural/unbound domain (dispatch `CONNECTION_MISSING`), not the
 * secret-readiness domain — there is no connection id to report as unready.
 *
 * Scope is secret-READINESS: a literal ref to a ready-but-WRONG-KIND connection
 * is NOT reported (it fails dispatch as `CONNECTION_KIND_INVALID`, checked before
 * the readiness gate). Kind-validity stays dispatch-only for the same reason
 * readiness is not checked at version save — a version is immutable, a
 * connection's kind is mutable.
 */
export type UnreadyConnectionReason = 'missing' | 'disabled' | 'needs_secret';

export interface UnreadyConnection {
  connectionId: string;
  reason: UnreadyConnectionReason;
}

export function unreadyConnectionsForVersion(
  db: Db,
  ownerId: string | null,
  versionId: string,
): UnreadyConnection[] {
  const version = getPipelineVersion(db, versionId);
  if (version === null) return [];

  const unready: UnreadyConnection[] = [];
  const seen = new Set<string>();
  for (const node of version.nodes) {
    const connectionId = node.connectionId;
    if (connectionId === undefined) continue; // structural/unbound — dispatch's domain
    const entry = catalog.get(node.type);
    if (entry === undefined || entry.connectionKinds.length === 0) continue;
    if (interpolationMode(connectionId).mode !== 'literal') continue; // dynamic — dispatch's domain
    if (seen.has(connectionId)) continue;
    seen.add(connectionId);

    const connection = getConnection(db, connectionId);
    // Owner authorization, mirroring `resolveConnection`: a null or cross-owner
    // (or null-owner-run vs owned-connection) hit folds into `missing`.
    if (connection === null || (connection.ownerId !== null && connection.ownerId !== ownerId)) {
      unready.push({ connectionId, reason: 'missing' });
      continue;
    }
    const reason = connectionNotReadyReason(connection);
    if (reason !== null) unready.push({ connectionId, reason });
  }
  return unready;
}

/**
 * #3 G8b-3 — the set of the owner's version RESOURCE IDs whose connections are
 * all READY, for the git-import PREVIEW's resolved-space trigger compare
 * (`classifyWorkspace`). The classifier is PURE (takes no `db`), so the route
 * precomputes this readiness domain exactly as it precomputes `ownedVersionRids`
 * (`listVersionResourceIds`), and the classifier folds a bound trigger's
 * `enabled`→false when its version is NOT in this set — matching what the apply's
 * FORWARD gate persists (`applyWorkspace`), so preview and apply agree on the row
 * an import would land (the G7 preview↔apply parity, extended to readiness).
 *
 * Readiness is per-VERSION (all of a version's connection refs ready), reusing the
 * SAME `unreadyConnectionsForVersion` the enable / import / dispatch gates use, so
 * the four can never disagree. Every owned version is included (a trigger may pin
 * an older or an archived pipeline's version), keyed by stable `resourceId`.
 */
export function readyVersionResourceIds(db: Db, ownerId: string): Set<string> {
  const ready = new Set<string>();
  for (const pipeline of listPipelines(db, ownerId)) {
    for (const version of listPipelineVersions(db, pipeline.id)) {
      if (unreadyConnectionsForVersion(db, ownerId, version.id).length === 0) {
        ready.add(version.resourceId);
      }
    }
  }
  return ready;
}

/**
 * #3 G8b-2 — the connection→dependent-triggers REVERSE-gate (git-publish spec
 * ~742-745: "Add the connection→dependent-triggers reverse index for post-hoc
 * secret changes"). The forward gates (G8b-1 ENABLE, G8a DISPATCH) stop an
 * unready connection from being enabled or from firing a secretless run; this is
 * the reverse: when a connection transitions ready→unready AFTER its dependent
 * triggers were enabled — a `kind` change to a secret-requiring kind without a
 * secret (`not_required`→`needs_secret`), or a DELETE (dependents fold to
 * `missing`) — the dependents' `enabled` flag would otherwise stay a stale
 * `true`, so the operator sees an "enabled" trigger that silently never fires
 * (the dispatch gate refuses each fire). Disabling them keeps the flag honest.
 *
 * MIRRORS `archivePipeline` (repo/archive.ts), the pipeline→trigger analogue:
 * atomic (one transaction), ENABLED-ONLY (an already-disabled dependent is left
 * exactly as-is — no `updatedAt` churn, never re-enabled), idempotent (a second
 * call after the connection is ready-again / already gone disables nothing new),
 * and it returns the ids it flipped enabled→disabled. As with archive, the
 * scheduler resync is the CALLER's job AFTER the tx commits (the route calls
 * `fastify.scheduler.sync()` to drop the now-disabled triggers' pending wakeups
 * — the alarm clock owns its own db, a caller tx cannot thread through it).
 *
 * The dependency link lives INSIDE the bound version's JSON (`node.connectionId`),
 * not a column, so — unlike `listTriggersByPipeline`'s SQL join on the
 * `pipeline_version_id` column — there is no cheap reverse-join: every enabled
 * trigger's bound version is scanned. Reuse is deliberate: readiness is decided
 * by the SAME `unreadyConnectionsForVersion` the ENABLE gate uses (and which
 * mirrors the DISPATCH gate), so the reverse gate can never disagree with either
 * about what "unready" means, and inherits its skips for free — a `${}`-dynamic
 * or connection-less-node reference is dispatch's domain, not disabled here.
 *
 * Owner-scope: each trigger's readiness is scanned in that trigger's OWN owner
 * scope (`unreadyConnectionsForVersion(tx, trigger.ownerId, …)`, nullable owner
 * mirroring `resolveConnection`). So an OWNED connection reaches its owner's
 * dependents, plus any (import-smuggled) foreign trigger whose version references
 * the id — that folds to `missing`, which is an unready reason and so still
 * matches, and disabling it is correct (that owner genuinely cannot resolve the
 * private connection; the G8b-1 enable gate would refuse to enable it in the
 * first place, so this only bites a trigger enabled by a path that bypassed it).
 * A SHARED (null-owner) connection reaches every owner's dependents — matching
 * who each connection is actually resolvable for. A `null`-version (unbound)
 * trigger never fires, so it is never a dependent.
 */
export function regateTriggersForConnection(db: Db, connectionId: string): string[] {
  return db.transaction((tx) => {
    const disabled: string[] = [];
    for (const trigger of listTriggers(tx)) {
      if (!trigger.enabled) continue;
      if (trigger.pipelineVersionId === null) continue;
      const unready = unreadyConnectionsForVersion(tx, trigger.ownerId, trigger.pipelineVersionId);
      if (unready.some((u) => u.connectionId === connectionId)) {
        updateTrigger(tx, trigger.id, { enabled: false });
        disabled.push(trigger.id);
      }
    }
    return disabled;
  });
}
