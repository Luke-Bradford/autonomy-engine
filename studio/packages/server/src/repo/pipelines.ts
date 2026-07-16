import { and, eq } from 'drizzle-orm';
import {
  NewPipelineSchema,
  PipelineSchema,
  type NewPipeline,
  type Pipeline,
  type Paginated,
} from '@autonomy-studio/shared';
import { pipelines } from '../db/schema.js';
import { newId } from './ids.js';
import { afterCursor, pageOrder, toPage, type PageArgs } from './pagination.js';
import type { Db } from './types.js';

export function createPipeline(db: Db, input: NewPipeline): Pipeline {
  const parsed = NewPipelineSchema.parse(input);
  const now = Date.now();
  const row: Pipeline = {
    id: newId('pipe'),
    ...parsed,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(pipelines).values(row).run();
  return PipelineSchema.parse(row);
}

export function getPipeline(db: Db, id: string): Pipeline | null {
  const row = db.select().from(pipelines).where(eq(pipelines.id, id)).get();
  return row ? PipelineSchema.parse(row) : null;
}

export function listPipelines(db: Db, ownerId?: string): Pipeline[] {
  const rows =
    ownerId === undefined
      ? db.select().from(pipelines).all()
      : db.select().from(pipelines).where(eq(pipelines.ownerId, ownerId)).all();
  return rows.map((row) => PipelineSchema.parse(row));
}

/**
 * The paginated, owner-scoped list surfaced by `GET /api/pipelines` (#534).
 * Keyset over `created_at ASC, id ASC` (see `pagination.ts`). A SEPARATE fn
 * from `listPipelines` (not a changed return type): pagination is its own
 * bounded query, and `listPipelines` stays the unscoped primitive (`ownerId?` →
 * all owners) the repo/portability tests exercise.
 */
export function listPipelinesPage(db: Db, ownerId: string, args: PageArgs): Paginated<Pipeline> {
  const rows = db
    .select()
    .from(pipelines)
    .where(
      and(
        eq(pipelines.ownerId, ownerId),
        args.cursor ? afterCursor(pipelines.createdAt, pipelines.id, args.cursor) : undefined,
      ),
    )
    .orderBy(...pageOrder(pipelines.createdAt, pipelines.id))
    .limit(args.limit + 1)
    .all()
    .map((row) => PipelineSchema.parse(row));
  return toPage(rows, args.limit);
}

/** Only `name` (and `ownerId`, unused by MVP callers) are mutable here — the
 * graph itself is never edited in place; every graph change is a new
 * `PipelineVersion` row (see `pipeline-versions.ts`). */
export function updatePipeline(
  db: Db,
  id: string,
  patch: Partial<Pick<NewPipeline, 'name' | 'ownerId'>>,
): Pipeline | null {
  const existing = getPipeline(db, id);
  if (!existing) return null;
  const updated = PipelineSchema.parse({ ...existing, ...patch, updatedAt: Date.now() });
  db.update(pipelines).set(updated).where(eq(pipelines.id, id)).run();
  return updated;
}

/**
 * Thrown by `deletePipeline` when the pipeline has run history. `pipelines`
 * -> `pipeline_versions` is `ON DELETE CASCADE`, but `pipeline_versions` ->
 * `runs` is (deliberately) `ON DELETE RESTRICT` — runs are immutable audit
 * history, never silently swept away by deleting their pipeline. That makes
 * the RESTRICT-on-history case an INTENTIONAL outcome, not a bug: this error
 * surfaces it clearly instead of leaking an opaque `SqliteError` (or, worse,
 * a `false` return that reads identically to "no such pipeline").
 */
export class PipelineHasRunsError extends Error {
  constructor(public readonly pipelineId: string) {
    super(
      `Cannot delete pipeline "${pipelineId}": it has run history. ` +
        'pipeline_versions -> runs is ON DELETE RESTRICT by design (runs are ' +
        'immutable audit history) — delete/archive the runs first, or keep the pipeline.',
    );
    this.name = 'PipelineHasRunsError';
  }
}

/** Narrow, non-message-only check that a thrown error is the SQLite foreign
 * key constraint failure (vs. some unrelated error we should let propagate
 * unchanged) — both `code` (better-sqlite3's SQLite extended result code)
 * and the standard SQLite message text are checked so an unrelated
 * `SQLITE_CONSTRAINT_*` failure isn't misreported as "has runs". */
function isForeignKeyRestrictError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return (
    typeof code === 'string' &&
    code.startsWith('SQLITE_CONSTRAINT') &&
    err.message.includes('FOREIGN KEY constraint failed')
  );
}

/**
 * Deletes a pipeline, cascading its `pipeline_versions` (and, transitively,
 * any `triggers` bound to those versions). Throws `PipelineHasRunsError`
 * instead of letting an opaque FK error escape when the pipeline has run
 * history (see `PipelineHasRunsError`). Returns `false` only for "no such
 * pipeline" (never conflated with the has-runs case).
 */
export function deletePipeline(db: Db, id: string): boolean {
  try {
    const result = db.delete(pipelines).where(eq(pipelines.id, id)).run();
    return result.changes > 0;
  } catch (err) {
    if (isForeignKeyRestrictError(err)) {
      throw new PipelineHasRunsError(id);
    }
    throw err;
  }
}
