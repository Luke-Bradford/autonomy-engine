import { asc, desc, sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';
import {
  RUN_SORT_DEFAULT_KEY,
  RUN_SORT_NATURAL_DIR,
  RUN_STATUS_SORT_RANK,
  RUN_TRIGGERED_BY_SORT_RANK,
  RunSortDirSchema,
  RunSortKeySchema,
  type RunSort,
  type RunSortDir,
  type RunSortKey,
} from '@autonomy-studio/shared';
import { pipelines, runs } from '../db/schema.js';
import {
  afterKeyset,
  decodeCursorPayload,
  encodeCursorPayload,
  type KeysetTerm,
} from './pagination.js';
import { RUN_TRIGGERED_BY_SQL } from './run-triggered-by.js';

/**
 * #1484 OR35 M1 — how the runs grid is sorted, server side, so the order holds
 * across every page of a keyset walk rather than only the page on screen.
 *
 * Every sort is a list of TERMS ending in `runs.id`, the unique tie-break a
 * keyset needs. A column that ties (a status, a pipeline name) is followed by
 * `started_at DESC`, so the runs inside one status still read newest first
 * whichever way the column itself is sorted.
 *
 * `RunSort` itself is shared (`@autonomy-studio/shared`), so the page's URL
 * state and the server's resolved request are one type.
 */
export type { RunSort };

export const RUN_SORT_DEFAULT: RunSort = {
  key: RUN_SORT_DEFAULT_KEY,
  dir: RUN_SORT_NATURAL_DIR[RUN_SORT_DEFAULT_KEY],
};

/** An absent `?dir=` means the column's natural direction — the same map the
 * browser reads, so a URL it wrote without `dir` is answered as it displays. */
export function resolveRunSort(key: RunSortKey | undefined, dir: RunSortDir | undefined): RunSort {
  const k = key ?? RUN_SORT_DEFAULT_KEY;
  return { key: k, dir: dir ?? RUN_SORT_NATURAL_DIR[k] };
}

type TermType = 'int' | 'text';
interface SortTerm {
  expr: SQL | AnySQLiteColumn;
  dir: RunSortDir;
  type: TermType;
}

/** A `CASE` mapping each value to its rank, every value a bound parameter. A
 * value outside the map (none can reach it: both columns are closed
 * vocabularies) ranks last rather than NULL, because a NULL term would drop the
 * row from every page after the first (`afterKeyset`). */
function rankOf(expr: SQL | AnySQLiteColumn, ranks: Record<string, number>): SQL<number> {
  const arms = Object.entries(ranks).map(([value, rank]) => sql`when ${value} then ${rank}`);
  return sql<number>`(case ${expr} ${sql.join(arms, sql` `)} else ${Object.keys(ranks).length} end)`;
}

const NEWEST_FIRST: SortTerm = { expr: runs.startedAt, dir: 'desc', type: 'int' };

/**
 * The terms for one sort, before the `id` tie-break.
 *
 * - **Duration** puts UNFINISHED runs last in both directions (`finished_at IS
 *   NULL` ascending, as its own leading term). The grid shows them as "so far",
 *   a figure that grows, so ranking them by it would reshuffle on every refresh,
 *   and ranking them as zero would open "shortest first" on every running run.
 * - **Pipeline** compares `lower(name)`: SQLite's `lower` folds ASCII only, so a
 *   non-ASCII initial sorts by its code point. Stated, not worked around.
 * - **Status** and **Triggered by** sort by the shared ranks, not by their slugs.
 */
function sortTerms(sort: RunSort): SortTerm[] {
  switch (sort.key) {
    case 'started':
      return [{ expr: runs.startedAt, dir: sort.dir, type: 'int' }];
    case 'duration':
      return [
        { expr: sql`(${runs.finishedAt} is null)`, dir: 'asc', type: 'int' },
        {
          expr: sql`coalesce(${runs.finishedAt} - ${runs.startedAt}, 0)`,
          dir: sort.dir,
          type: 'int',
        },
        NEWEST_FIRST,
      ];
    case 'pipeline':
      return [{ expr: sql`lower(${pipelines.name})`, dir: sort.dir, type: 'text' }, NEWEST_FIRST];
    case 'status':
      return [
        { expr: rankOf(runs.status, RUN_STATUS_SORT_RANK), dir: sort.dir, type: 'int' },
        NEWEST_FIRST,
      ];
    case 'triggeredBy':
      return [
        {
          expr: rankOf(RUN_TRIGGERED_BY_SQL, RUN_TRIGGERED_BY_SORT_RANK),
          dir: sort.dir,
          type: 'int',
        },
        NEWEST_FIRST,
      ];
  }
}

/** The `id` tie-break runs in the LAST term's direction, which keeps
 * `started_at DESC, id DESC` exactly the order this list had before it could be
 * sorted. */
function idDir(terms: readonly SortTerm[]): RunSortDir {
  return terms[terms.length - 1]?.dir ?? 'desc';
}

/** The `ORDER BY` for a sort: its terms, then `id`. */
export function runSortOrderBy(sort: RunSort): SQL[] {
  const terms = sortTerms(sort);
  const by = (expr: SQL | AnySQLiteColumn, dir: RunSortDir) =>
    dir === 'asc' ? asc(expr) : desc(expr);
  return [...terms.map((t) => by(t.expr, t.dir)), by(runs.id, idDir(terms))];
}

/** The term values to SELECT alongside each row, as one JSON array, so the
 * page's last row becomes a cursor holding exactly the values its terms compared
 * (SQL computed them; nothing re-derives a rank or a duration in TypeScript). */
export function runSortValuesJson(sort: RunSort): SQL<string> {
  return sql<string>`json_array(${sql.join(
    sortTerms(sort).map((t) => sql`${t.expr}`),
    sql`, `,
  )})`;
}

/** A decoded runs-list cursor: which sort minted it, and its row's term values. */
export interface RunCursor {
  sort: RunSort;
  values: (string | number)[];
  id: string;
}

/** The keyset predicate resuming after `cursor` under its own sort. */
export function afterRunCursor(cursor: RunCursor): SQL | undefined {
  const terms = sortTerms(cursor.sort);
  const keyset: KeysetTerm[] = terms.map((t, i) => ({
    expr: t.expr,
    dir: t.dir,
    value: cursor.values[i] as string | number,
  }));
  keyset.push({ expr: runs.id, dir: idDir(terms), value: cursor.id });
  return afterKeyset(keyset);
}

/**
 * Version 2 of the runs cursor. Version 1 carried only `(started_at, id)` and no
 * direction — "a cursor names a position, not a direction" (`pagination.ts`) —
 * so replaying it under another order returned a coherent but different slice
 * and nothing errored. This one names the sort that minted it, and
 * `decodeRunCursor` refuses it under any other: a 400, never a wrong page. A v1
 * cursor is refused too; only a page open across the upgrade holds one.
 */
const RUN_CURSOR_VERSION = 2;

const RunCursorPayloadSchema = z.object({
  v: z.literal(RUN_CURSOR_VERSION),
  s: RunSortKeySchema,
  d: RunSortDirSchema,
  k: z.array(z.union([z.number().int(), z.string()])),
  i: z.string().min(1),
});

export function encodeRunCursor(cursor: RunCursor): string {
  return encodeCursorPayload({
    v: RUN_CURSOR_VERSION,
    s: cursor.sort.key,
    d: cursor.sort.dir,
    k: cursor.values,
    i: cursor.id,
  });
}

/**
 * The cursor back to its values, or `null` if it is unreadable, from another
 * sort or direction than `sort`, or carries values that do not fit that sort's
 * terms (wrong count or type). Never throws; the route maps `null` to a 400.
 */
export function decodeRunCursor(raw: string, sort: RunSort): RunCursor | null {
  const parsed = RunCursorPayloadSchema.safeParse(decodeCursorPayload(raw));
  if (!parsed.success) return null;
  const { s, d, k, i } = parsed.data;
  if (s !== sort.key || d !== sort.dir) return null;
  const terms = sortTerms(sort);
  if (k.length !== terms.length) return null;
  const fits = terms.every((t, idx) =>
    t.type === 'int' ? typeof k[idx] === 'number' : typeof k[idx] === 'string',
  );
  return fits ? { sort, values: k, id: i } : null;
}
