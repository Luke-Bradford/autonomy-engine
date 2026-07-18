import { asc, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import {
  lowerAgentTaskStructuredOutputs,
  lowerLlmStructuredOutputs,
  lowerNodeOutputs,
  NewPipelineVersionSchema,
  PipelineVersionSchema,
  StrictNodeSchema,
  validatePipelineDoc,
  type NewPipelineVersion,
  type PipelineResolver,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { pipelineVersions } from '../db/schema.js';
import { ISSUE_LIST_CAP } from '../limits.js';
import { newId } from './ids.js';
import { getPipeline } from './pipelines.js';
import type { Db } from './types.js';

/**
 * Thrown by `createPipelineVersion` for a doc that is schema-valid but fails
 * the engine's STRUCTURAL/`${}` rules (#444). `issues` is the complete list
 * (never just the first) so an author fixes the whole doc in one round-trip.
 *
 * Mapped to `400 invalid_pipeline_doc` by `errors.ts`. Defined here, in the
 * repo layer, mirroring `PipelineHasRunsError`: the repo owns the rule, and
 * `errors.ts` (which imports FROM repo) owns the HTTP mapping — importing the
 * server-layer `BadRequestError` here would invert that dependency.
 */
export class InvalidPipelineDocError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Pipeline doc is invalid (${issues.length} issue${issues.length === 1 ? '' : 's'}): ` +
        summarizeIssues(issues),
    );
    this.name = 'InvalidPipelineDocError';
  }
}

/**
 * Bounds the human `message` (the client renders THIS, not `issues[]`, for this
 * error — see `errors.ts` / `web/src/api/client.ts`): it names the first
 * `ISSUE_LIST_CAP` issues, then states the remainder ("…and N more") instead of
 * joining an O(doc) tail. `this.issues` always carries the COMPLETE list — only
 * the summary string is bounded. Same `ISSUE_LIST_CAP` the response `issues[]`
 * array uses (`limits.ts`): both are representations of the SAME list and
 * neither may re-emit it whole. Truncation is STATED, never a silent tail drop
 * (the F13a/#473 rule; #496); mirrors the "…and N more" idiom in
 * `shared/src/engine/reduce.ts`'s stall diagnostic.
 */
function summarizeIssues(issues: string[]): string {
  const named = issues.slice(0, ISSUE_LIST_CAP).join('; ');
  const rest = issues.length - ISSUE_LIST_CAP;
  return rest > 0 ? `${named}; …and ${rest} more` : named;
}

/**
 * PipelineVersion is IMMUTABLE once written (the ticket's headline
 * invariant): there is deliberately no `updatePipelineVersion` export in
 * this module. `version` auto-increments per `pipelineId` — computed inside
 * a transaction so the read-max-then-insert isn't racy against a concurrent
 * writer on the same `pipelineId` (better-sqlite3 is a single connection,
 * but `db.transaction` still gives us the atomic read+insert for free and
 * documents the intent).
 *
 * NOTE: this `max()+1` numbering relies on better-sqlite3's synchronous,
 * single-writer connection model (no other connection can interleave a write
 * between the read and the insert). The `pipeline_versions_pipeline_id_version_idx`
 * UNIQUE index is the real backstop against any cross-connection race, not
 * this transaction.
 */
export function createPipelineVersion(db: Db, input: NewPipelineVersion): PipelineVersion {
  const parsed = NewPipelineVersionSchema.parse(input);

  // #456 (F13b) — LOWER the catalog's canonical `outputs` into each known-type
  // node whose `config.outputs` is absent, so a version stored via ANY client
  // (API/import/CLI/test) carries the same contract the web palette seeds
  // client-side (`lowerNodeOutputs`). Without this a non-web-created node
  // persisted `absent`: the reducer stored the whole payload unchecked and
  // `validateRefs` name-checked nothing — one activity type, two runtime
  // contracts, decided by which client made the node.
  //
  // Runs AFTER the strict parse (before it, `input` is an unvalidated `z.input`)
  // and BEFORE `validatePipelineDoc` below, so `validateRefs` name-checks every
  // `${nodes.X.output.NAME}` ref against the SEEDED contract — that binding is
  // the whole point. The lowered nodes are RE-PARSED through `StrictNodeSchema`
  // to keep F13a's "strict on WRITE" invariant: this writes node configs the
  // strict path never saw, and the closing `PipelineVersionSchema.parse` is
  // read-tolerant, so without the re-parse a seeded contract would bypass the
  // write-path validation the field is supposed to have.
  //
  // #2 L4a — `lowerLlmStructuredOutputs` runs FIRST: a `structured` `llm_call`'s
  // `config.outputs` is DERIVED from its `outputSchema` (overwriting any stale
  // catalog-default seed), so it must set the contract before `lowerNodeOutputs`,
  // which then sees a present value and skips it (text-mode `llm_call`s still get
  // the `[text, stopReason]` default). An INVALID `outputSchema` is left
  // un-lowered here and reported by `validateLlmCallOutput` in
  // `validatePipelineDoc` below → 400, so no garbage contract persists.
  //
  // #2 L11b — `lowerAgentTaskStructuredOutputs` is the `agent_task` counterpart,
  // composed in the SAME derive-before-seed slot: a structured `agent_task`'s
  // `config.outputs` is derived from its `outputSchema` (opt-in by presence), so it
  // too must run before `lowerNodeOutputs` seeds the `[output, exitCode]` default.
  // An invalid schema is left un-lowered and reported by `validateAgentTaskOutput`.
  const lowered = {
    ...parsed,
    nodes: z
      .array(StrictNodeSchema)
      .parse(
        lowerNodeOutputs(lowerAgentTaskStructuredOutputs(lowerLlmStructuredOutputs(parsed.nodes))),
      ),
  };

  // Mint the id BEFORE validation so the call-graph analysis (#495) has a
  // `selfId` — `validateCallGraph` short-circuits without one. The same id is
  // reused for the insert below (id generation is a pure, order-free `nanoid`;
  // minting it here instead of inside the txn changes nothing on the write).
  // A brand-new version's id is unknowable to the author, so a literal self-call
  // by id can never be authored; `selfId` here serves only to SEED the DFS root.
  const id = newId('pv');

  // OWNER-SCOPED `call_pipeline` resolver (#495). This closes the fail-open seam
  // #444's write gate left: without a resolver, `validateCallGraph` cannot see
  // past the caller's own doc, so a call chain that CYCLES or exceeds
  // `maxCallDepth` reached the reducer unrefused. The resolver is SYNCHRONOUS
  // (better-sqlite3 is synchronous), so `validatePipelineDoc` stays a pure core
  // with the DB read injected here, in the impure server layer.
  //
  // SECURITY — the resolver is the boundary that keeps #444's echo-safety intact
  // across the transitive call graph. `validateCallGraph` interpolates callee
  // version ids into its error strings; #444's argument that an error only ever
  // names the caller's OWN doc holds only if the walk never enters a version the
  // caller does not own. So the resolver returns a callee's `nodes` ONLY when the
  // callee's pipeline shares this caller's `ownerId`, and `undefined` otherwise —
  // a cross-owner (or missing, or dynamic `${}`) callee is SKIPPED before its id
  // can be echoed. Every id a 400 can carry is therefore either `selfId` or a
  // successfully-resolved OWNED version.
  //
  // `null` owner (a legacy/unowned pipeline) is treated as one shared bucket:
  // a null-owner caller resolves other null-owner versions. MVP uses a single
  // fixed `'local'` principal, so this never triggers today; it is the honest
  // reading of "owner = the `ownerId` value" for a future multi-tenant swap.
  // Memoize `pipelineId -> ownerId` so a DFS that reaches the same pipeline by
  // several call paths pays for the owner lookup once. The DFS is bounded by
  // `maxCallDepth`, so this is a small redundancy — but the cache is one Map and
  // costs nothing, and reads are safe to memoize: a pipeline's `ownerId` cannot
  // change under a single synchronous validation pass.
  const ownerIdByPipeline = new Map<string, string | null>();
  // `?? null` maps BOTH "pipeline record missing" and "exists but legitimately
  // unowned" to `null`, so both land in the shared null-owner bucket described
  // below. That conflation is safe today only because the MVP's fixed `'local'`
  // principal never leaves `callerOwnerId` null, so the null bucket is never
  // actually entered. A multi-tenant swap that introduces real null-owner callers
  // MUST split these (a missing pipeline is a broken FK, not an unowned peer, and
  // should resolve to `undefined`/skip, not join the caller's bucket).
  const ownerIdOf = (pipelineId: string): string | null => {
    const cached = ownerIdByPipeline.get(pipelineId);
    if (cached !== undefined) return cached;
    const ownerId = getPipeline(db, pipelineId)?.ownerId ?? null;
    ownerIdByPipeline.set(pipelineId, ownerId);
    return ownerId;
  };
  const callerOwnerId = ownerIdOf(lowered.pipelineId);
  const resolvePipeline: PipelineResolver = (calleeVersionId) => {
    const callee = getPipelineVersion(db, calleeVersionId);
    if (callee === null) return undefined; // gone/never-existed — not analyzable
    const calleeOwnerId = ownerIdOf(callee.pipelineId);
    if (calleeOwnerId !== callerOwnerId) return undefined; // cross-owner — never traverse/echo
    return { nodes: callee.nodes };
  };
  // Reads run BEFORE the transaction below; that is safe because a
  // pipeline_versions row is IMMUTABLE once written (no update path), so a
  // callee's `nodes` cannot change under us. A callee DELETED between this read
  // and the insert is the only race, and a call to a now-gone version is caught
  // at run time by #491's `stalled` backstop, not silently run.

  // THE write gate (#444). Every path that stores a pipeline_versions row —
  // the `POST /api/pipelines/:id/versions` route and the git-import path —
  // funnels through this ONE function, so guarding here binds both BY
  // CONSTRUCTION rather than asking each caller to remember. That matters
  // more than usual here: a version is IMMUTABLE once written (DB triggers
  // RAISE(ABORT) on update), so an invalid doc that gets in can never be
  // repaired, only re-authored — and it reaches the pure reducer, where it
  // stalled the run until #491's backstop, or threw/spun until #487/#488/#493
  // neutralized it.
  //
  // WRITE-PATH ONLY, deliberately: reads never validate. Rows written before
  // this gate existed are still unvalidated, so the reducer's own defences
  // stay load-bearing (defence in depth) — this closes the door, it does not
  // clean the house. #491's `stalled` backstop LANDED and is the complementary
  // answer for those rows: they no longer wedge a run forever, they terminalize
  // as `failure{reason:'stalled'}`. That is containment, NOT a substitute for
  // this gate — a stalled run is still a run the author never wanted.
  const issues = validatePipelineDoc(lowered, { selfId: id, resolvePipeline });
  if (issues.length > 0) throw new InvalidPipelineDocError(issues);

  return db.transaction((tx) => {
    const maxRow = tx
      .select({ maxVersion: max(pipelineVersions.version) })
      .from(pipelineVersions)
      .where(eq(pipelineVersions.pipelineId, lowered.pipelineId))
      .get();
    const nextVersion = (maxRow?.maxVersion ?? 0) + 1;

    // Persist the LOWERED doc (#456 G1): validating `lowered` but storing
    // `parsed` would certify a seeded contract that is never written — the
    // worst outcome (validation passes against a contract the runtime lacks).
    const row: PipelineVersion = {
      id, // minted above (before validation) so the call graph had a `selfId`
      ...lowered,
      version: nextVersion,
      createdAt: Date.now(),
    };
    tx.insert(pipelineVersions).values(row).run();
    return PipelineVersionSchema.parse(row);
  });
}

export function getPipelineVersion(db: Db, id: string): PipelineVersion | null {
  const row = db.select().from(pipelineVersions).where(eq(pipelineVersions.id, id)).get();
  return row ? PipelineVersionSchema.parse(row) : null;
}

/** All versions of one pipeline, oldest first. */
export function listPipelineVersions(db: Db, pipelineId: string): PipelineVersion[] {
  const rows = db
    .select()
    .from(pipelineVersions)
    .where(eq(pipelineVersions.pipelineId, pipelineId))
    .orderBy(asc(pipelineVersions.version))
    .all();
  return rows.map((row) => PipelineVersionSchema.parse(row));
}

/**
 * The newest version of a pipeline. NOTE: runs/triggers must still bind the
 * specific version id they were created against — this is a convenience
 * lookup for "what would a brand-new trigger bind today", never a "latest"
 * indirection stored anywhere.
 */
export function getLatestPipelineVersion(db: Db, pipelineId: string): PipelineVersion | null {
  const rows = listPipelineVersions(db, pipelineId);
  return rows.length > 0 ? rows[rows.length - 1]! : null;
}

// No delete either: pipeline_versions rows are referenced by triggers
// (CASCADE) and runs (RESTRICT) — an ad hoc single-version delete would
// either silently take triggers with it or be blocked by historical runs.
// Cleanup, if ever needed, goes through deleting the parent `pipelines` row
// (which cascades) rather than a standalone version-delete API.
