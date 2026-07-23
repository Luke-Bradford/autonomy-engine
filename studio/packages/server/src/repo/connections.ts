import { and, eq } from 'drizzle-orm';
import {
  ConnectionSchema,
  NewConnectionSchema,
  type Connection,
  type NewConnection,
  type Paginated,
} from '@autonomy-studio/shared';
import { connections } from '../db/schema.js';
import { newId } from './ids.js';
import { afterCursor, pageOrder, toPage, type PageArgs } from './pagination.js';
import type { CreateResourceOptions } from './pipelines.js';
import type { Db } from './types.js';

export function createConnection(
  db: Db,
  input: NewConnection,
  opts?: CreateResourceOptions,
): Connection {
  const parsed = NewConnectionSchema.parse(input);
  const now = Date.now();
  const row: Connection = {
    id: newId('conn'),
    // #3 G1 — stable identity, server-minted once (see `createPipeline`).
    // #3 G5c — an import may preserve the file's `resourceId`; else mint fresh.
    resourceId: opts?.resourceId ?? newId('res'),
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

/**
 * #3 G5c — resolve a connection by its stable `resourceId`, owner-scoped, for
 * the workspace-git reconcile apply (index-backed by the G1 UNIQUE
 * `connections_owner_resource_id_idx`). Connections have no archive state, so —
 * unlike `getPipelineByResourceId` — there is no filtered/unfiltered nuance.
 */
export function getConnectionByResourceId(
  db: Db,
  ownerId: string,
  resourceId: string,
): Connection | null {
  const row = db
    .select()
    .from(connections)
    .where(and(eq(connections.ownerId, ownerId), eq(connections.resourceId, resourceId)))
    .get();
  return row ? ConnectionSchema.parse(row) : null;
}

export function listConnections(db: Db, ownerId?: string): Connection[] {
  const rows =
    ownerId === undefined
      ? db.select().from(connections).all()
      : db.select().from(connections).where(eq(connections.ownerId, ownerId)).all();
  return rows.map((row) => ConnectionSchema.parse(row));
}

/**
 * The paginated, owner-scoped list surfaced by `GET /api/connections` (#534).
 * Keyset over `created_at ASC, id ASC` (see `pagination.ts`); fetches one extra
 * row to decide `nextCursor`. A SEPARATE fn from `listConnections` rather than a
 * changed return type: pagination is its OWN bounded query (it cannot compose
 * over a fn that already loaded every row), and `listConnections` stays the
 * unscoped primitive (`ownerId?` → all owners) the repo tests exercise. The
 * envelope thus lives only at the HTTP boundary.
 */
export function listConnectionsPage(
  db: Db,
  ownerId: string,
  args: PageArgs,
): Paginated<Connection> {
  const rows = db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.ownerId, ownerId),
        args.cursor ? afterCursor(connections.createdAt, connections.id, args.cursor) : undefined,
      ),
    )
    .orderBy(...pageOrder(connections.createdAt, connections.id))
    .limit(args.limit + 1)
    .all()
    .map((row) => ConnectionSchema.parse(row));
  return toPage(rows, args.limit);
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
