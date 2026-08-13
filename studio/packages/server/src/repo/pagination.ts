import { and, asc, desc, eq, gt, lt, or, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import type { Paginated } from '@autonomy-studio/shared';

/**
 * #534 — the server side of the keyset pagination convention (contract in
 * `@autonomy-studio/shared`'s `pagination.ts`). This module is PURE data: it
 * mints/parses the opaque cursor and builds the keyset SQL. It deliberately
 * does NOT import the HTTP error layer — a malformed cursor returns `null`
 * here and the route maps that to a 400 (`routes/util.ts` `pageArgsFromQuery`),
 * keeping the repo layer free of a `repo → errors → repo/index` import cycle.
 */

/** The position of one row in the `created_at ASC, id ASC` total order — what a
 * cursor encodes. Both columns are immutable on these tables, so a cursor never
 * points at a moved row. */
export interface CursorKey {
  createdAt: number;
  id: string;
}

/** A parsed page request: how many rows, and where to resume from. */
export interface PageArgs {
  limit: number;
  cursor?: CursorKey;
}

/** Bumped only if the cursor payload shape changes; a cursor minted by an older
 * shape then decodes to `null` (→ 400) rather than being misread. */
const CURSOR_VERSION = 1;

const CursorPayloadSchema = z.object({
  v: z.literal(CURSOR_VERSION),
  // `created_at` is a non-negative epoch-millis integer; a fractional or
  // negative `c` is a malformed cursor, rejected here (→ 400) rather than
  // round-tripped into the keyset predicate — the "closed, validated shape".
  c: z.number().int().nonnegative(),
  i: z.string().min(1),
});

/** Opaque, URL-safe (`base64url`) handle naming the last row of a page. The
 * client treats it as a blob — the encoding is an implementation detail. */
export function encodeCursor(key: CursorKey): string {
  const json = JSON.stringify({ v: CURSOR_VERSION, c: key.createdAt, i: key.id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Parses a cursor back to its `CursorKey`, or `null` if it is malformed, not
 * valid base64url/JSON, or carries a different `CURSOR_VERSION`. Never throws:
 * the caller decides the HTTP consequence (a 400). Fail-CLOSED — an
 * unrecognised cursor is rejected, never silently treated as "first page"
 * (which would hand the client a different result set than it asked to resume).
 */
export function decodeCursor(cursor: string): CursorKey | null {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = CursorPayloadSchema.safeParse(json);
  return parsed.success ? { createdAt: parsed.data.c, id: parsed.data.i } : null;
}

/**
 * The keyset predicate for `ORDER BY created_at ASC, id ASC`: rows strictly
 * AFTER the cursor position. The tuple form `(created_at > c) OR (created_at =
 * c AND id > i)` — never `id > i` alone — is load-bearing: across a
 * `created_at` tie it neither drops nor duplicates a row at the page boundary.
 * Returns `SQL | undefined` so it composes into `and(ownerEq, …)` (drizzle
 * drops an `undefined` conjunct) without a non-null assertion.
 */
export function afterCursor(
  createdAtCol: AnySQLiteColumn,
  idCol: AnySQLiteColumn,
  cursor: CursorKey,
): SQL | undefined {
  return or(
    gt(createdAtCol, cursor.createdAt),
    and(eq(createdAtCol, cursor.createdAt), gt(idCol, cursor.id)),
  );
}

/**
 * The `ORDER BY created_at ASC, id ASC` clause — the total order the
 * owner-scoped list endpoints (secrets/connections/pipelines) share, matched by
 * `afterCursor`'s `gt` predicate. These are "browse my items" lists, and
 * ascending is the right default for them. #1076 added the DESC sibling below
 * for the newest-first surfaces; as predicted here, only these two helpers
 * gained a direction — the cursor codec and `toPage` are direction-agnostic and
 * were not touched, so there is still ONE cursor format.
 */
export function pageOrder(createdAtCol: AnySQLiteColumn, idCol: AnySQLiteColumn): SQL[] {
  return [asc(createdAtCol), asc(idCol)];
}

/**
 * #1076 — the DESC mirror of `afterCursor`: rows strictly BEFORE the cursor
 * position under `ORDER BY <ordering scalar> DESC, id DESC`. Same tuple
 * discipline for the same reason — `(c < k) OR (c = k AND id < i)`, never
 * `id < i` alone — so a tie in the ordering scalar neither drops nor duplicates
 * a row at the page boundary.
 *
 * A CURSOR NAMES A POSITION, NOT A DIRECTION, and that is deliberate (it is
 * what keeps one cursor format rather than two). The consequence is worth
 * stating because it is the one way to misuse this: pairing a cursor minted
 * during an ascending walk with `order=desc` (or the reverse) returns a
 * coherent but DIFFERENT slice, and nothing errors. `decodeCursor` is
 * fail-closed about a cursor's SHAPE; it cannot be fail-closed about a
 * direction the payload does not carry. So the direction must come from the
 * same query that minted the cursor — a caller picks one and keeps it for the
 * whole walk, which is what the audit wrapper (`api/workspaceAudit.ts`) does by
 * sending `order` on every page including the first.
 */
export function beforeCursor(
  createdAtCol: AnySQLiteColumn,
  idCol: AnySQLiteColumn,
  cursor: CursorKey,
): SQL | undefined {
  return or(
    lt(createdAtCol, cursor.createdAt),
    and(eq(createdAtCol, cursor.createdAt), lt(idCol, cursor.id)),
  );
}

/**
 * #1076 — the `ORDER BY <ordering scalar> DESC, id DESC` clause, matched by
 * `beforeCursor`'s `lt` predicate. For a newest-first HISTORY surface (the
 * workspace audit log), where rendering the newest page must not mean walking
 * the whole log to reverse it client-side.
 */
export function pageOrderDesc(createdAtCol: AnySQLiteColumn, idCol: AnySQLiteColumn): SQL[] {
  return [desc(createdAtCol), desc(idCol)];
}

/**
 * Splits the fetched rows into a page. Callers fetch `limit + 1` rows: if the
 * extra row is present there IS a next page, so drop it and mint `nextCursor`
 * from the last KEPT row; otherwise this is the last page and `nextCursor` is
 * `null`. Fetch-one-extra means `nextCursor` is only ever set when a real next
 * row exists — never an empty trailing page, never a false `null`.
 */
export function toPage<T extends CursorKey>(rows: T[], limit: number): Paginated<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const boundary = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && boundary ? encodeCursor(boundary) : null,
  };
}
