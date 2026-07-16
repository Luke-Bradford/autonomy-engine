import { asc, eq, max } from 'drizzle-orm';
import {
  NewPipelineVersionSchema,
  PipelineVersionSchema,
  validatePipelineDoc,
  type NewPipelineVersion,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { pipelineVersions } from '../db/schema.js';
import { ISSUE_LIST_CAP } from '../limits.js';
import { newId } from './ids.js';
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
  const issues = validatePipelineDoc(parsed);
  if (issues.length > 0) throw new InvalidPipelineDocError(issues);

  return db.transaction((tx) => {
    const maxRow = tx
      .select({ maxVersion: max(pipelineVersions.version) })
      .from(pipelineVersions)
      .where(eq(pipelineVersions.pipelineId, parsed.pipelineId))
      .get();
    const nextVersion = (maxRow?.maxVersion ?? 0) + 1;

    const row: PipelineVersion = {
      id: newId('pv'),
      ...parsed,
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
