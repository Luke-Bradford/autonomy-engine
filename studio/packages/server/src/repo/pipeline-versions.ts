import { asc, eq, max } from 'drizzle-orm';
import {
  NewPipelineVersionSchema,
  PipelineVersionSchema,
  type NewPipelineVersion,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { pipelineVersions } from '../db/schema.js';
import { newId } from './ids.js';
import type { Db } from './types.js';

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
