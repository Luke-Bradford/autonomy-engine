import { and, eq } from 'drizzle-orm';
import {
  NewTriggerSchema,
  TriggerSchema,
  type NewTrigger,
  type Trigger,
} from '@autonomy-studio/shared';
import { triggers } from '../db/schema.js';
import { newId } from './ids.js';
import type { Db } from './types.js';

export function createTrigger(db: Db, input: NewTrigger): Trigger {
  const parsed = NewTriggerSchema.parse(input);
  const now = Date.now();
  const row: Trigger = {
    id: newId('trig'),
    ...parsed,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(triggers).values(row).run();
  return TriggerSchema.parse(row);
}

export function getTrigger(db: Db, id: string): Trigger | null {
  const row = db.select().from(triggers).where(eq(triggers.id, id)).get();
  return row ? TriggerSchema.parse(row) : null;
}

export interface ListTriggersFilter {
  pipelineVersionId?: string;
  /** Filters in SQL, like `listConnections`/`listPipelines` — never loaded
   * then filtered in the route. */
  ownerId?: string;
}

export function listTriggers(db: Db, filter: ListTriggersFilter = {}): Trigger[] {
  const conditions = [];
  if (filter.pipelineVersionId !== undefined) {
    conditions.push(eq(triggers.pipelineVersionId, filter.pipelineVersionId));
  }
  if (filter.ownerId !== undefined) {
    conditions.push(eq(triggers.ownerId, filter.ownerId));
  }

  const rows =
    conditions.length > 0
      ? db
          .select()
          .from(triggers)
          .where(and(...conditions))
          .all()
      : db.select().from(triggers).all();
  return rows.map((row) => TriggerSchema.parse(row));
}

/**
 * Like `listTriggers()` with no filter, but RESILIENT: a row that fails schema
 * validation is skipped (and reported via `onSkip`) instead of throwing out the
 * whole list. The scheduler uses this so ONE corrupt/legacy/hand-edited trigger
 * row can't dark-out ALL scheduling — matching the per-cron isolation the
 * scheduler already gives a bad cron string. (The normal `listTriggers` stays
 * strict: a route surfacing a poison row as a 500 is the right behaviour there.)
 */
export function listParsedTriggers(
  db: Db,
  onSkip?: (id: unknown, err: unknown) => void,
): Trigger[] {
  const rows = db.select().from(triggers).all();
  const parsed: Trigger[] = [];
  for (const row of rows) {
    const result = TriggerSchema.safeParse(row);
    if (result.success) parsed.push(result.data);
    else onSkip?.((row as { id?: unknown }).id, result.error);
  }
  return parsed;
}

export function updateTrigger(db: Db, id: string, patch: Partial<NewTrigger>): Trigger | null {
  const existing = getTrigger(db, id);
  if (!existing) return null;
  const updated = TriggerSchema.parse({ ...existing, ...patch, updatedAt: Date.now() });
  db.update(triggers).set(updated).where(eq(triggers.id, id)).run();
  return updated;
}

export function deleteTrigger(db: Db, id: string): boolean {
  const result = db.delete(triggers).where(eq(triggers.id, id)).run();
  return result.changes > 0;
}
