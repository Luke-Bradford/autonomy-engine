import { and, eq, inArray } from 'drizzle-orm';
import {
  GlobalParamSchema,
  globalParamNameDefect,
  type GlobalParamType,
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

/**
 * #844 GL3 — the names and types of one owner's globals, for the save gate
 * (spec GL-D2). Values are never read here: the gate types a reference, it does
 * not resolve one, and a value may be 64 KiB. A null owner has none. A row
 * whose name breaks today's rule (a `__proto__` stored before GL3 reserved it)
 * is left out, so no version can come to read it.
 */
export function listOwnerGlobalTypes(db: Db, ownerId: string | null): Map<string, GlobalParamType> {
  const out = new Map<string, GlobalParamType>();
  if (ownerId === null) return out;
  const rows = db
    .select({ name: globalParams.name, type: globalParams.type })
    .from(globalParams)
    .where(eq(globalParams.ownerId, ownerId))
    .all();
  for (const r of rows) {
    if (globalParamNameDefect(r.name) === null) out.set(r.name, r.type);
  }
  return out;
}

/**
 * #844 GL3 — one owner's globals whose name is one of `names`, for a run's
 * start check (GL-D3). A null owner has none. The `name` column compares
 * BINARY, so this matches exactly, as a reference does.
 */
export function listOwnerGlobalParamsNamed(
  db: Db,
  ownerId: string | null,
  names: readonly string[],
): GlobalParam[] {
  if (ownerId === null || names.length === 0) return [];
  return db
    .select()
    .from(globalParams)
    .where(and(eq(globalParams.ownerId, ownerId), inArray(globalParams.name, [...names])))
    .all()
    .map(decode);
}
