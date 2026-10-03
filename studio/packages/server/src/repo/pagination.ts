import { and, asc, desc, eq, gt, lt, or, sql, type SQL } from 'drizzle-orm';
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
 * cursor encodes.
 *
 * THE ORDERING SCALAR IS IMMUTABLE ON EVERY TABLE BUT ONE, so a cursor points at
 * a row that has not moved. #1083 added the exception and it is named here
 * rather than only at the call site, because this is where a future caller reads
 * the rule: `runs` orders by `started_at`, which `admitQueuedRun` RE-STAMPS when
 * a queued run is admitted. That walk is still sound, and `listRunSummariesPage`
 * carries the argument — admission only moves the stamp FORWARD, so under a DESC
 * walk a row moves toward the head and can be missed, never duplicated. The rule
 * for anyone adding the next list: a mutable ordering scalar needs that argument
 * made explicitly for its own direction of travel, not assumed from this one.
 * #1484's runs sorts (`run-sort.ts`, its own cursor) order by keys that are ALL
 * mutable, and `listRunSummariesPage` states what that costs.
 * The `id` half of the key is a primary key everywhere, so it never moves. */
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
  return encodeCursorPayload({ v: CURSOR_VERSION, c: key.createdAt, i: key.id });
}

/**
 * Parses a cursor back to its `CursorKey`, or `null` if it is malformed, not
 * valid base64url/JSON, or carries a different `CURSOR_VERSION`. Never throws:
 * the caller decides the HTTP consequence (a 400). Fail-CLOSED — an
 * unrecognised cursor is rejected, never silently treated as "first page"
 * (which would hand the client a different result set than it asked to resume).
 */
export function decodeCursor(cursor: string): CursorKey | null {
  const parsed = CursorPayloadSchema.safeParse(decodeCursorPayload(cursor));
  return parsed.success ? { createdAt: parsed.data.c, id: parsed.data.i } : null;
}

/** The wire half of every cursor codec: a payload as `base64url` JSON. */
export function encodeCursorPayload(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** `encodeCursorPayload` reversed, or `undefined` when the text is not
 * `base64url` JSON. The caller's schema judges the shape; this never throws. */
export function decodeCursorPayload(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
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

/** One term of a keyset order: the expression, its direction, and the value
 * the cursor's row holds for it. */
export interface KeysetTerm {
  expr: SQL | AnySQLiteColumn;
  dir: 'asc' | 'desc';
  value: string | number;
}

/**
 * #1484 — the keyset predicate for an order of ANY length whose terms may run in
 * DIFFERENT directions: rows strictly after the cursor's row. It generalises
 * `afterCursor`/`beforeCursor` (two terms, one direction) to
 * `(t1 > v1) OR (t1 = v1 AND t2 > v2) OR …`, each `>` flipped to `<` for a
 * descending term. SQLite's row-value comparison would be one expression, but it
 * compares every term in ONE direction, and the runs grid's secondary order
 * (newest first) has to hold whichever way its primary column is sorted.
 *
 * The last term must be unique (a primary key), or two rows equal on every term
 * would straddle a page boundary and one would be dropped. No term may be NULL:
 * `=` and `<` against NULL are never true, so a NULL-valued row would vanish from
 * every page after the first. Callers wrap a nullable expression in `coalesce`.
 */
export function afterKeyset(terms: readonly KeysetTerm[]): SQL | undefined {
  // Each term as a plain `SQL` fragment, so a column and a computed expression
  // compare the same way: against a bound parameter holding the cursor's value.
  const exprs = terms.map((term) => sql`${term.expr}`);
  return or(
    ...terms.map((term, i) =>
      and(
        ...terms.slice(0, i).map((prior, j) => eq(exprs[j] as SQL, prior.value)),
        term.dir === 'asc' ? gt(exprs[i] as SQL, term.value) : lt(exprs[i] as SQL, term.value),
      ),
    ),
  );
}
