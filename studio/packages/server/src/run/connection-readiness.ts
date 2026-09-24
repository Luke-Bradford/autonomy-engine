import {
  catalog,
  interpolationMode,
  type ActivityCatalogEntry,
  type ConnectionDependentsResponse,
  type ConnectionKind,
  type Node,
} from '@autonomy-studio/shared';
import { candidateVersions } from '../repo/candidate-versions.js';
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
 * - M1 (#1104): which BINDING is checked is likewise the CATALOG's answer, not
 *   the node's. An activity the catalog declares `sinkConnectionKinds` for is
 *   PAIRED, and both ends of `Node.connectionIds` are checked; every other
 *   activity is checked on `Node.connectionId` alone and its `connectionIds` is
 *   inert — a stray pair must not block enable, exactly as a stray singular
 *   ref does not. No entry declares a sink at M1, so this widening reports
 *   nothing new in this build;
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

/**
 * The catalog these gates decide "does this node bind a connection, and is it
 * PAIRED" against. Defaults to the shipped one; overridable EXACTLY as the
 * executor's `ExecutorDeps.catalog` is (`run/executor.ts`), and for the same
 * reason — this module's decisions are catalog-driven, so a test cannot exercise
 * a shape no shipped entry declares. M1's paired branch is the first such shape:
 * no entry declares `sinkConnectionKinds` in this build, so without the seam the
 * pair handling below would be unreachable and therefore untested.
 *
 * Threaded through all three exported gates, not just the scanner, so "the
 * reverse gate and the import-preview readiness domain inherit the pair for
 * free" is an ASSERTED claim rather than a stated one.
 */
export type CatalogOverride = typeof catalog;

/**
 * The connection refs one node contributes to the readiness scan, in the shape
 * the catalog says the node's ACTIVITY binds. ONE place decides singular-vs-pair
 * so the scanner, and any future caller, cannot disagree:
 *  - the activity binds no connection ⇒ nothing (a stray ref on it is never
 *    dispatched, so it must not block enable);
 *  - the activity is PAIRED (`sinkConnectionKinds` declared) ⇒ both ends of
 *    `Node.connectionIds`, and NOT `connectionId` (`validateDoc` refuses the
 *    two together, and dispatch reads only the pair);
 *  - otherwise ⇒ `Node.connectionId` alone, `connectionIds` inert.
 */
function connectionRefsOfNode(node: Node, entry: ActivityCatalogEntry | undefined): string[] {
  return connectionEndsOfNode(node, entry).map((end) => end.ref);
}

/**
 * #1252 — the same ends `connectionRefsOfNode` yields, each with the kinds
 * dispatch will accept AT THAT END: `connectionKinds` for a single binding or a
 * pair's source, `sinkConnectionKinds` for a pair's sink — exactly the two lists
 * `executor.ts` hands `resolveConnection` before it refuses
 * `CONNECTION_KIND_INVALID`. One function, so the ref rule and the kind rule
 * cannot drift apart.
 */
function connectionEndsOfNode(
  node: Node,
  entry: ActivityCatalogEntry | undefined,
): { ref: string; kinds: readonly ConnectionKind[] }[] {
  if (entry === undefined || entry.connectionKinds.length === 0) return [];
  if (entry.sinkConnectionKinds !== undefined) {
    const pair = node.connectionIds;
    return pair === undefined
      ? []
      : [
          { ref: pair.source, kinds: entry.connectionKinds },
          { ref: pair.sink, kinds: entry.sinkConnectionKinds },
        ];
  }
  return node.connectionId === undefined
    ? []
    : [{ ref: node.connectionId, kinds: entry.connectionKinds }];
}

/**
 * #1211 — every connection reference a VERSION makes, split by whether it can be
 * resolved statically. Extracted from `unreadyConnectionsForVersion` so the
 * readiness scan and the dependency PREVIEW (`connectionDependents`) enumerate
 * refs through ONE walk and cannot disagree about what a version references.
 *
 * `literal` is deduped and in node order; `dynamic` records the NODE rather than
 * the (unresolvable) ref, because a node is what a surface can point at — and is
 * therefore deduped BY NODE, since a PAIRED node may have two dynamic ends and
 * still be one node to point at. (Counting it twice would have the advisory say
 * "2 enabled triggers (router, router)".) A vanished version yields both empty,
 * exactly as the scan did before — a trigger bound to a deleted version must
 * read the same to the preview as to the gate.
 */
interface VersionConnectionRefs {
  literal: string[];
  dynamic: { nodeId: string }[];
}

function connectionRefsForVersion(
  db: Db,
  versionId: string,
  activityCatalog: CatalogOverride,
): VersionConnectionRefs {
  const version = getPipelineVersion(db, versionId);
  if (version === null) return { literal: [], dynamic: [] };

  const literal: string[] = [];
  const dynamic: { nodeId: string }[] = [];
  const seen = new Set<string>();
  const seenDynamicNodes = new Set<string>();
  for (const node of version.nodes) {
    // Every ref this node contributes — one, or a pair's two. The per-ref skips
    // below apply per END: a paired node may legitimately have a literal source
    // and a `${}`-dynamic sink, and reporting the dynamic one as `missing`
    // (`getConnection` on a raw template returns null) would refuse to enable a
    // trigger that dispatches perfectly well.
    for (const connectionId of connectionRefsOfNode(node, activityCatalog.get(node.type))) {
      if (interpolationMode(connectionId).mode !== 'literal') {
        // Dispatch's domain — but REPORTED rather than swallowed, see below.
        if (!seenDynamicNodes.has(node.id)) {
          seenDynamicNodes.add(node.id);
          dynamic.push({ nodeId: node.id });
        }
        continue;
      }
      if (seen.has(connectionId)) continue;
      seen.add(connectionId);
      literal.push(connectionId);
    }
  }
  return { literal, dynamic };
}

export function unreadyConnectionsForVersion(
  db: Db,
  ownerId: string | null,
  versionId: string,
  activityCatalog: CatalogOverride = catalog,
): UnreadyConnection[] {
  const unready: UnreadyConnection[] = [];
  for (const connectionId of connectionRefsForVersion(db, versionId, activityCatalog).literal) {
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
export function readyVersionResourceIds(
  db: Db,
  ownerId: string,
  activityCatalog: CatalogOverride = catalog,
): Set<string> {
  const ready = new Set<string>();
  for (const pipeline of listPipelines(db, ownerId)) {
    for (const version of listPipelineVersions(db, pipeline.id)) {
      if (unreadyConnectionsForVersion(db, ownerId, version.id, activityCatalog).length === 0) {
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
export function regateTriggersForConnection(
  db: Db,
  connectionId: string,
  activityCatalog: CatalogOverride = catalog,
): string[] {
  return db.transaction((tx) => {
    const disabled: string[] = [];
    for (const trigger of listTriggers(tx)) {
      if (!trigger.enabled) continue;
      if (trigger.pipelineVersionId === null) continue;
      const unready = unreadyConnectionsForVersion(
        tx,
        trigger.ownerId,
        trigger.pipelineVersionId,
        activityCatalog,
      );
      if (unready.some((u) => u.connectionId === connectionId)) {
        updateTrigger(tx, trigger.id, { enabled: false });
        disabled.push(trigger.id);
      }
    }
    return disabled;
  });
}

/**
 * #1211 — the PREVIEW of the reverse gate above: which of THIS OWNER's enabled
 * triggers would be switched off if `connectionId` stopped being ready, read
 * BEFORE the write that would do it.
 *
 * WHY IT EXISTS. `routes/connections.ts` runs `regateTriggersForConnection` on
 * two paths — a `kind` PATCH that leaves the connection `needs_secret`, and a
 * DELETE (dependents fold to `missing`) — and both disable every dependent
 * enabled trigger silently. Correct behaviour, and the operator is told nothing
 * before or after, so an operator can change a connection's kind and stop a
 * nightly schedule without ever seeing a word about it (#1211). This read is
 * what lets the Connections page say it at the point the operator can still
 * reconsider.
 *
 * IT REFUSES NOTHING. Like M9's `datasetReferences`, it is called from no gate;
 * the enable gate (G8b-1), the dispatch gate (G8a) and the reverse gate (G8b-2)
 * are untouched and remain the only refusals. Advisory is also the polarity
 * #1145/#1158/#1174 set deliberately for this page: the server accepts these
 * writes, and a form must not refuse what the server accepts.
 *
 * PARITY WITH THE WRITE IT DESCRIBES is the load-bearing property, and it is
 * asserted rather than asserted-about: the tests run this preview, perform the
 * transition, then run `regateTriggersForConnection` and compare id sets. It
 * holds because the two share `connectionRefsForVersion` and apply the same
 * enabled/bound filters — the ONLY difference is that the gate additionally
 * tests present readiness (which is false at preview time by construction, that
 * being the whole point) and this assumes the transition.
 *
 * Both transitions land on the same set: `needs_secret` makes every literal
 * reference unready via `connectionNotReadyReason`, and a DELETE makes every one
 * of them `missing` via the owner-scoped lookup. So one preview answers both,
 * and the two surfaces differ only in wording.
 *
 * ONE PARSE PER VERSION however many triggers pin it — `getPipelineVersion`
 * parses a whole doc, and N triggers on one version is the common shape (the
 * same cost `candidateVersions` in `repo/candidate-versions.ts` was written
 * to avoid).
 *
 * THE TRIGGER BUCKETS ONLY. The node buckets (#1252) DO walk
 * `candidateVersions` — see `dependentNodes` for why the two halves answer
 * over different sets.
 *
 * NOT `candidateVersions`, deliberately, though it also builds a
 * triggers-by-version map: its candidate set is "latest-of-each-pipeline ∪
 * active-published ∪ trigger-pinned" and is unfiltered by `enabled`, which
 * answers a different question and is wrong here in both directions — it admits
 * versions no enabled trigger is bound to, and its `listPipelines(db, ownerId)`
 * root drops a trigger pinning a SHARED pipeline's version. This mirrors the
 * gate's own walk instead, which is the only walk parity can be claimed against.
 *
 * Owner-scoped, and therefore a LOWER BOUND — see
 * `ConnectionDependentsResponseSchema` for why that is the safe direction here
 * and what it costs.
 *
 * `ownerId` is NON-NULL, unlike the `string | null` its neighbours above take,
 * and the difference is load-bearing rather than incidental. Those functions
 * NARROW on a null owner (a null-owner scan matches only shared connections).
 * `listTriggers` does the opposite: its filter is applied only when `ownerId`
 * is defined, so a `null ?? undefined` here would drop the WHERE clause and
 * return every owner's triggers — inverting the exact scoping this function's
 * response schema documents as a guarantee, and turning a deliberate
 * under-report into a leak of other owners' trigger names. Non-null is what the
 * only caller has (`Principal.ownerId` is a `string`), so the unsafe value is
 * refused by the type rather than handled by a branch nothing exercises.
 */
export function connectionDependents(
  db: Db,
  ownerId: string,
  connectionId: string,
  activityCatalog: CatalogOverride = catalog,
): ConnectionDependentsResponse {
  const refsByVersion = new Map<string, VersionConnectionRefs>();
  const triggers: ConnectionDependentsResponse['triggers'] = [];
  const dynamic: ConnectionDependentsResponse['dynamic'] = [];

  for (const trigger of listTriggers(db, { ownerId })) {
    if (!trigger.enabled) continue;
    if (trigger.pipelineVersionId === null) continue;

    let refs = refsByVersion.get(trigger.pipelineVersionId);
    if (refs === undefined) {
      refs = connectionRefsForVersion(db, trigger.pipelineVersionId, activityCatalog);
      refsByVersion.set(trigger.pipelineVersionId, refs);
    }

    // THE TWO BUCKETS ARE DISJOINT, and the literal one wins. A trigger whose
    // version names this connection outright WILL be disabled — that is settled,
    // whatever else its version does. A `${}` node elsewhere in the same version
    // adds no uncertainty to a trigger whose fate is already known, and reporting
    // it in both would have the advisory name one trigger twice as though they
    // were two: "switches off 1 enabled trigger (nightly) … 1 other enabled
    // trigger (nightly)". `dynamic` means "could not be settled", so a settled
    // trigger is not a member of it.
    if (refs.literal.includes(connectionId)) {
      triggers.push({ id: trigger.id, name: trigger.name });
      continue;
    }
    // Reported rather than swallowed: a `${}`-dynamic ref MAY address this
    // connection, and a surface that inherited the gate's silent skip would
    // render an earned-looking "nothing would be disabled" over it.
    //
    // ONE entry for this trigger however many of its nodes are dynamic — the
    // advisory names TRIGGERS, so a row per node would list one trigger twice
    // ("2 enabled triggers (router, router)"). `connectionRefsForVersion`
    // already dedupes a single PAIRED node's two ends; this is the same rule at
    // the level above it, and the response shape makes both structural.
    if (refs.dynamic.length > 0) {
      dynamic.push({
        id: trigger.id,
        name: trigger.name,
        nodeIds: refs.dynamic.map((node) => node.nodeId),
      });
    }
  }
  return { triggers, dynamic, ...dependentNodes(db, ownerId, connectionId, activityCatalog) };
}

/**
 * #1252 — the NODE buckets of `connectionDependents`: which nodes a kind change
 * could break, over `candidateVersions` (the set M9 settled for "what uses
 * this?") rather than the trigger buckets' enabled-trigger walk. That walk
 * exists for parity with `regateTriggersForConnection`; a kind change that keeps
 * the connection ready performs no write, so there is nothing here to be at
 * parity with, and a pipeline's latest version breaks whether or not a trigger
 * is bound to it yet.
 *
 * ARCHIVED pipelines are skipped: the launcher refuses to dispatch them at all
 * (#3 G5a), so no kind is what breaks them, and naming them would be a claim
 * the product does not make.
 */
function dependentNodes(
  db: Db,
  ownerId: string,
  connectionId: string,
  activityCatalog: CatalogOverride,
): Pick<ConnectionDependentsResponse, 'nodes' | 'dynamicNodes'> {
  const nodes: ConnectionDependentsResponse['nodes'] = [];
  const dynamicNodes: ConnectionDependentsResponse['dynamicNodes'] = [];
  for (const { pipeline, version } of candidateVersions(db, ownerId)) {
    if (pipeline.archived) continue;
    for (const node of version.nodes) {
      const where = {
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        versionId: version.id,
        version: version.version,
        nodeId: node.id,
        nodeType: node.type,
      };
      let accepted: readonly ConnectionKind[] | null = null;
      let dynamicEnd = false;
      for (const end of connectionEndsOfNode(node, activityCatalog.get(node.type))) {
        if (interpolationMode(end.ref).mode !== 'literal') {
          dynamicEnd = true;
          continue;
        }
        if (end.ref !== connectionId) continue;
        // A pair naming this connection at BOTH ends dispatches only if both
        // ends accept the kind — the intersection, not either list.
        accepted = accepted === null ? end.kinds : accepted.filter((k) => end.kinds.includes(k));
      }
      // Literal wins, as in the trigger buckets: a node whose use of this
      // connection is settled is not also "unsettled" because its other end
      // is an expression.
      if (accepted !== null) nodes.push({ ...where, acceptedKinds: [...accepted] });
      else if (dynamicEnd) dynamicNodes.push(where);
    }
  }
  return { nodes, dynamicNodes };
}
