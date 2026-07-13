import { eq } from 'drizzle-orm';
import {
  ConnectionSchema,
  NewConnectionSchema,
  type Connection,
  type NewConnection,
} from '@autonomy-studio/shared';
import { connections } from '../db/schema.js';
import { newId } from './ids.js';
import type { Db } from './types.js';

export function createConnection(db: Db, input: NewConnection): Connection {
  const parsed = NewConnectionSchema.parse(input);
  const now = Date.now();
  const row: Connection = {
    id: newId('conn'),
    ...parsed,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(connections).values(row).run();
  return ConnectionSchema.parse(row);
}

/**
 * Every read parses the DB row back through `ConnectionSchema` — the
 * boundary check that catches a corrupt or pre-migration/legacy row instead
 * of silently trusting whatever Drizzle handed back.
 */
export function getConnection(db: Db, id: string): Connection | null {
  const row = db.select().from(connections).where(eq(connections.id, id)).get();
  return row ? ConnectionSchema.parse(row) : null;
}

export function listConnections(db: Db, ownerId?: string): Connection[] {
  const rows =
    ownerId === undefined
      ? db.select().from(connections).all()
      : db.select().from(connections).where(eq(connections.ownerId, ownerId)).all();
  return rows.map((row) => ConnectionSchema.parse(row));
}

export function updateConnection(
  db: Db,
  id: string,
  patch: Partial<NewConnection>,
): Connection | null {
  const existing = getConnection(db, id);
  if (!existing) return null;
  const updated = ConnectionSchema.parse({ ...existing, ...patch, updatedAt: Date.now() });
  db.update(connections).set(updated).where(eq(connections.id, id)).run();
  return updated;
}

export function deleteConnection(db: Db, id: string): boolean {
  const result = db.delete(connections).where(eq(connections.id, id)).run();
  return result.changes > 0;
}
