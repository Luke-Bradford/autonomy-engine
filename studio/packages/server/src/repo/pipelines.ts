import { eq } from 'drizzle-orm';
import {
  NewPipelineSchema,
  PipelineSchema,
  type NewPipeline,
  type Pipeline,
} from '@autonomy-studio/shared';
import { pipelines } from '../db/schema.js';
import { newId } from './ids.js';
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

export function deletePipeline(db: Db, id: string): boolean {
  const result = db.delete(pipelines).where(eq(pipelines.id, id)).run();
  return result.changes > 0;
}
