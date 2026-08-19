import { and, eq } from 'drizzle-orm';
import {
  DatasetSchema,
  NewDatasetSchema,
  type Dataset,
  type NewDataset,
  type Paginated,
} from '@autonomy-studio/shared';
import { datasets } from '../db/schema.js';
import { newId } from './ids.js';
import { afterCursor, pageOrder, toPage, type PageArgs } from './pagination.js';
import type { CreateResourceOptions } from './pipelines.js';
import type { Db } from './types.js';

/**
 * #1114 (M2, data-movement spec §2) — the `datasets` repo, modelled on
 * `connections.ts`: a mutable resource row, read back through its Zod schema on
 * every access.
 *
 * Deliberately SHORTER than the connections repo, and the absences are settled
 * rather than pending (§2.4): no readiness derivation (a dataset holds no
 * credential — the store connection does), no `enabled` flag, no archive state,
 * no `active` pointer and no publish. Its whole job is to hold an ADDRESS.
 */

export function createDataset(db: Db, input: NewDataset, opts?: CreateResourceOptions): Dataset {
  const parsed = NewDatasetSchema.parse(input);
  const now = Date.now();
  const row: Dataset = {
    id: newId('ds'),
    // #3 G1 — stable identity, server-minted once; an import may PRESERVE the
    // file's `resourceId` (G5c), else one is minted fresh.
    resourceId: opts?.resourceId ?? newId('res'),
    ...parsed,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(datasets).values(row).run();
  return DatasetSchema.parse(row);
}

/**
 * Every read parses the DB row back through `DatasetSchema` — the boundary check
 * that catches a corrupt or pre-migration row instead of silently trusting
 * whatever Drizzle handed back. This is where a `columns` that somehow became
 * NULL fails LOUDLY rather than reading as "no columns".
 */
export function getDataset(db: Db, id: string): Dataset | null {
  const row = db.select().from(datasets).where(eq(datasets.id, id)).get();
  return row ? DatasetSchema.parse(row) : null;
}

/** #3 G5c — resolve a dataset by its stable `resourceId`, owner-scoped, for the
 * workspace-git reconcile apply (index-backed by `datasets_owner_resource_id_idx`).
 * Datasets have no archive state, so there is no filtered/unfiltered nuance. */
export function getDatasetByResourceId(
  db: Db,
  ownerId: string,
  resourceId: string,
): Dataset | null {
  const row = db
    .select()
    .from(datasets)
    .where(and(eq(datasets.ownerId, ownerId), eq(datasets.resourceId, resourceId)))
    .get();
  return row ? DatasetSchema.parse(row) : null;
}

export function listDatasets(db: Db, ownerId?: string): Dataset[] {
  const rows =
    ownerId === undefined
      ? db.select().from(datasets).all()
      : db.select().from(datasets).where(eq(datasets.ownerId, ownerId)).all();
  return rows.map((row) => DatasetSchema.parse(row));
}

/** The paginated, owner-scoped list surfaced by `GET /api/datasets` — keyset
 * over `created_at ASC, id ASC`, exactly as `listConnectionsPage` (see its note
 * on why this is a separate fn rather than a changed return type). */
export function listDatasetsPage(db: Db, ownerId: string, args: PageArgs): Paginated<Dataset> {
  const rows = db
    .select()
    .from(datasets)
    .where(
      and(
        eq(datasets.ownerId, ownerId),
        args.cursor ? afterCursor(datasets.createdAt, datasets.id, args.cursor) : undefined,
      ),
    )
    .orderBy(...pageOrder(datasets.createdAt, datasets.id))
    .limit(args.limit + 1)
    .all()
    .map((row) => DatasetSchema.parse(row));
  return toPage(rows, args.limit);
}

export function updateDataset(db: Db, id: string, patch: Partial<NewDataset>): Dataset | null {
  const existing = getDataset(db, id);
  if (!existing) return null;
  const updated = DatasetSchema.parse({
    ...existing,
    ...patch,
    // Identity and creation time are pinned to `existing` EXPLICITLY rather
    // than left to the spread, so the invariant is local: a future caller that
    // hands a raw object carrying them cannot silently persist it.
    id: existing.id,
    resourceId: existing.resourceId,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  });
  db.update(datasets).set(updated).where(eq(datasets.id, id)).run();
  return updated;
}

export function deleteDataset(db: Db, id: string): boolean {
  const result = db.delete(datasets).where(eq(datasets.id, id)).run();
  return result.changes > 0;
}
