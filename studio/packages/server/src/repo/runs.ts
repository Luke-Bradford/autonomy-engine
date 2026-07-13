import { and, eq } from 'drizzle-orm';
import {
  NewRunSchema,
  RunLifecyclePatchSchema,
  RunSchema,
  type NewRun,
  type Run,
  type RunLifecyclePatch,
} from '@autonomy-studio/shared';
import { runs } from '../db/schema.js';
import { newId } from './ids.js';
import type { Db } from './types.js';

export function createRun(db: Db, input: NewRun): Run {
  const parsed = NewRunSchema.parse(input);
  const row: Run = {
    id: newId('run'),
    ...parsed,
    leaseUntil: null,
    heartbeatAt: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  db.insert(runs).values(row).run();
  return RunSchema.parse(row);
}

export function getRun(db: Db, id: string): Run | null {
  const row = db.select().from(runs).where(eq(runs.id, id)).get();
  return row ? RunSchema.parse(row) : null;
}

export interface ListRunsFilter {
  pipelineVersionId?: string;
  triggerId?: string;
  parentRunId?: string;
}

export function listRuns(db: Db, filter: ListRunsFilter = {}): Run[] {
  const conditions = [];
  if (filter.pipelineVersionId !== undefined) {
    conditions.push(eq(runs.pipelineVersionId, filter.pipelineVersionId));
  }
  if (filter.triggerId !== undefined) {
    conditions.push(eq(runs.triggerId, filter.triggerId));
  }
  if (filter.parentRunId !== undefined) {
    conditions.push(eq(runs.parentRunId, filter.parentRunId));
  }

  const rows =
    conditions.length > 0
      ? db
          .select()
          .from(runs)
          .where(and(...conditions))
          .all()
      : db.select().from(runs).all();
  return rows.map((row) => RunSchema.parse(row));
}

/**
 * Mutates ONLY run-lifecycle fields (`status`, `leaseUntil`, `heartbeatAt`,
 * `finishedAt`) — the fields the executor/boot-reconciler update as a run
 * progresses. The immutable-binding + provenance fields (`params`,
 * `pipelineVersionId`, `triggerId`, `parentRunId`, `startedAt`) are not part
 * of `RunLifecyclePatch`'s type, so a caller touching one is a compile-time
 * error; `RunLifecyclePatchSchema.parse` (`.strict()`) is the matching
 * runtime guard for a caller that bypasses the type (`as any`/`as never`).
 */
export function updateRun(db: Db, id: string, patch: RunLifecyclePatch): Run | null {
  const parsedPatch = RunLifecyclePatchSchema.parse(patch);
  const existing = getRun(db, id);
  if (!existing) return null;
  const updated = RunSchema.parse({ ...existing, ...parsedPatch, id: existing.id });
  db.update(runs).set(updated).where(eq(runs.id, id)).run();
  return updated;
}

export function deleteRun(db: Db, id: string): boolean {
  const result = db.delete(runs).where(eq(runs.id, id)).run();
  return result.changes > 0;
}
