import { and, eq } from 'drizzle-orm';
import {
  GlobalParamSchema,
  NewGlobalParamSchema,
  type GlobalParam,
  type GlobalParamPatchBody,
  type NewGlobalParam,
  type Paginated,
} from '@autonomy-studio/shared';
import { globalParams } from '../db/schema.js';
import { newId } from './ids.js';
import { afterCursor, pageOrder, toPage, type PageArgs } from './pagination.js';
import type { Db } from './types.js';

/**
 * #844 GL1 — the global-params store (spec `2026-09-27-foundation-global-params.md`
 * GL-D1). The write RULES (name, value-vs-type, byte bound) are the route's
 * boundary schemas; this module persists and decodes, and decodes SHAPE only so
 * a row written under older rules still lists and deletes.
 *
 * `value` crosses the column as JSON text serialized here, never via drizzle's
 * json mode (which would store a JSON `null` value as SQL NULL).
 */
type GlobalParamRow = typeof globalParams.$inferSelect;

function decode(row: GlobalParamRow): GlobalParam {
  return GlobalParamSchema.parse({ ...row, value: JSON.parse(row.value) as unknown });
}

function encode(param: GlobalParam): GlobalParamRow {
  return { ...param, value: JSON.stringify(param.value) };
}

export function createGlobalParam(db: Db, input: NewGlobalParam): GlobalParam {
  const parsed = NewGlobalParamSchema.parse(input);
  const now = Date.now();
  const param = GlobalParamSchema.parse({
    id: newId('gp'),
    ...parsed,
    createdAt: now,
    updatedAt: now,
  });
  db.insert(globalParams).values(encode(param)).run();
  return param;
}

export function getGlobalParam(db: Db, id: string): GlobalParam | null {
  const row = db.select().from(globalParams).where(eq(globalParams.id, id)).get();
  return row ? decode(row) : null;
}

/** `GET /api/global-params` (#534 envelope): one owner's globals, keyset over
 * `created_at ASC, id ASC`, as `listNamedSecretsPage`. */
export function listGlobalParamsPage(
  db: Db,
  ownerId: string,
  args: PageArgs,
): Paginated<GlobalParam> {
  const rows = db
    .select()
    .from(globalParams)
    .where(
      and(
        eq(globalParams.ownerId, ownerId),
        args.cursor ? afterCursor(globalParams.createdAt, globalParams.id, args.cursor) : undefined,
      ),
    )
    .orderBy(...pageOrder(globalParams.createdAt, globalParams.id))
    .limit(args.limit + 1)
    .all()
    .map(decode);
  return toPage(rows, args.limit);
}

/**
 * Replaces `value` and/or `description` in place. `name` and `type` are not
 * in the patch type at all: they are immutable after creation (GL-D1). Returns
 * `null` if the row vanished (a concurrent DELETE), so the route reports a 404
 * rather than a write that did not land.
 */
export function updateGlobalParam(
  db: Db,
  id: string,
  patch: GlobalParamPatchBody,
): GlobalParam | null {
  const existing = getGlobalParam(db, id);
  if (!existing) return null;
  // An empty patch changes nothing, so it does not move `updatedAt` either.
  if (patch.value === undefined && patch.description === undefined) return existing;
  const updated = GlobalParamSchema.parse({
    ...existing,
    ...(patch.value !== undefined ? { value: patch.value } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    updatedAt: Date.now(),
  });
  const result = db.update(globalParams).set(encode(updated)).where(eq(globalParams.id, id)).run();
  return result.changes > 0 ? updated : null;
}

export function deleteGlobalParam(db: Db, id: string): boolean {
  const result = db.delete(globalParams).where(eq(globalParams.id, id)).run();
  return result.changes > 0;
}
