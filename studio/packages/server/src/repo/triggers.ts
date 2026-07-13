import { eq } from 'drizzle-orm';
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

export function listTriggers(db: Db, pipelineVersionId?: string): Trigger[] {
  const rows =
    pipelineVersionId === undefined
      ? db.select().from(triggers).all()
      : db.select().from(triggers).where(eq(triggers.pipelineVersionId, pipelineVersionId)).all();
  return rows.map((row) => TriggerSchema.parse(row));
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
