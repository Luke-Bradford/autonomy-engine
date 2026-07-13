import { and, eq } from 'drizzle-orm';
import { NewRunSchema, RunSchema, type NewRun, type Run } from '@autonomy-studio/shared';
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

/** Mutates run-lifecycle fields (`status`, `leaseUntil`, `heartbeatAt`,
 * `finishedAt`) — the fields the executor/boot-reconciler update as a run
 * progresses. `params`/`pipelineVersionId`/`triggerId`/`parentRunId` are set
 * once at creation and not expected to change, but are not hard-blocked here
 * (no invariant in the ticket forbids it) — callers should treat them as
 * effectively immutable. */
export function updateRun(db: Db, id: string, patch: Partial<Run>): Run | null {
  const existing = getRun(db, id);
  if (!existing) return null;
  const updated = RunSchema.parse({ ...existing, ...patch, id: existing.id });
  db.update(runs).set(updated).where(eq(runs.id, id)).run();
  return updated;
}

export function deleteRun(db: Db, id: string): boolean {
  const result = db.delete(runs).where(eq(runs.id, id)).run();
  return result.changes > 0;
}
