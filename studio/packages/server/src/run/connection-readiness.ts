import { catalog, interpolationMode } from '@autonomy-studio/shared';
import { connectionNotReadyReason, getConnection } from '../repo/connections.js';
import { getPipelineVersion } from '../repo/pipeline-versions.js';
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
  ownerId: string,
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
