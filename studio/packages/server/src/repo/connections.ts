import { and, eq } from 'drizzle-orm';
import {
  ConnectionSchema,
  NewConnectionSchema,
  connectionNotReadyReason,
  deriveSecretStatus,
  type Connection,
  type ConnectionKind,
  type NewConnection,
  type Paginated,
  type SecretStatus,
} from '@autonomy-studio/shared';
import { connections } from '../db/schema.js';
import { newId } from './ids.js';
import { afterCursor, pageOrder, toPage, type PageArgs } from './pagination.js';
import type { CreateResourceOptions } from './pipelines.js';
import type { Db } from './types.js';

/**
 * #1211 — `deriveSecretStatus` and `connectionNotReadyReason` used to live HERE,
 * and now live in `@autonomy-studio/shared` (`schemas/connection.ts`) with their
 * full rationale. They moved because the Connections page has to answer "would
 * saving this kind change disable my dependent triggers?" BEFORE the write, and
 * the only honest way to answer it is to run the server's own predicate rather
 * than re-spell its rule in the client — where the two would drift silently, the
 * form falling quiet about a disable the server still performs.
 *
 * Both are pure functions of a `Connection` row and of `connectionKindRequiresSecret`,
 * which was already shared, so the move cost nothing and changed no verdict.
 * Re-exported here so every existing server call site keeps its import, and so
 * this file remains the place a reader looks for the readiness rules.
 */
export { connectionNotReadyReason, deriveSecretStatus };

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
    // #3 G8a — readiness is server-derived, never client input: a new
    // connection is `enabled` and its `secretStatus` derives from kind +
    // whether a secret was supplied at create.
    secretStatus: deriveSecretStatus(parsed.kind, parsed.secretRef),
    enabled: true,
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
  const merged = { ...existing, ...patch };
  const updated = ConnectionSchema.parse({
    ...merged,
    // #3 G8a — RE-derive readiness after the patch: a patch may change `kind`
    // or `secretRef` (supplying or removing a credential), so a preserved stale
    // `secretStatus` would leave the dispatch gate lying about readiness.
    // `patch` is `Partial<NewConnection>`, which omits `secretStatus`/`enabled`,
    // so neither is client-writable here. `enabled` is pinned to `existing`
    // EXPLICITLY (not merely left to the `...merged` spread) so the invariant is
    // local — a future caller that hands a raw object carrying `enabled` cannot
    // silently persist it. A toggle flow is G8b.
    secretStatus: deriveSecretStatus(merged.kind, merged.secretRef),
    enabled: existing.enabled,
    updatedAt: Date.now(),
  });
  db.update(connections).set(updated).where(eq(connections.id, id)).run();
  return updated;
}

export function deleteConnection(db: Db, id: string): boolean {
  const result = db.delete(connections).where(eq(connections.id, id)).run();
  return result.changes > 0;
}
