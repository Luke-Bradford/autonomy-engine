import { MAX_PAGE_SIZE, type Paginated } from '@autonomy-studio/shared';

/**
 * #534 — the list endpoints are now keyset-paginated (`{ items, nextCursor }`).
 * Most list PAGES render the full owner-scoped list, so those api wrappers
 * reconstruct it by walking every page: the SERVER response is bounded per
 * request, while the FE contract (`Promise<T[]>`) is unchanged, so no page
 * component has to change.
 *
 * #1076 landed the other half this docblock anticipated. The workspace audit
 * log is the first list with NO retention policy, so walking it to render the
 * newest entries is a cost that grows for the life of the workspace and never
 * falls. `api/workspaceAudit.ts` therefore consumes `Paginated<T>` DIRECTLY
 * against a server-side descending order, and `usePagedList` accumulates the
 * pages a reader actually asks for. `fetchAllPages` stays for the bounded
 * "browse my items" lists (secrets, connections, pipelines), which is what it
 * was always for — a new unbounded HISTORY surface should reach for the paged
 * shape instead.
 */

/** A generous safety bound so a server bug returning a non-advancing
 * `nextCursor` surfaces as a thrown error rather than an infinite fetch loop.
 * At `MAX_PAGE_SIZE` per page this covers far more rows than any owner realistically holds. */
const MAX_PAGES = 10_000;

/**
 * Follows `nextCursor` from the first page to the last, concatenating `items`,
 * and returns the full list. Guards against a non-advancing cursor (a repeated
 * or unbounded server cursor) by capping the page count and detecting a
 * repeated cursor — either is a server contract violation, surfaced as a throw.
 */
export async function fetchAllPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Paginated<T>>,
): Promise<T[]> {
  const all: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { items, nextCursor } = await fetchPage(cursor);
    all.push(...items);
    if (nextCursor === null) return all;
    if (seen.has(nextCursor)) {
      throw new Error('pagination cursor did not advance');
    }
    seen.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error(`pagination exceeded ${MAX_PAGES} pages`);
}

/**
 * Builds the `?limit=…[&cursor=…]` query for a list request, URL-encoding the
 * cursor (via `URLSearchParams`) so an opaque handle is always transmitted
 * safely.
 *
 * #1058 — `extra` carries a list route's own FILTER params (the archived
 * selector is the first). They go through the same `URLSearchParams` rather
 * than being concatenated onto the returned string at the call site, which is
 * what keeps this function the single owner of the leading `?` and of the
 * encoding. Pagination keys are written last so a caller cannot accidentally
 * override `limit`/`cursor` and break the page walk — including on the FIRST
 * page, where there is no cursor argument to overwrite an `extra.cursor` with,
 * so it is deleted outright.
 *
 * #1076 — `limit` defaults to `MAX_PAGE_SIZE`, which is right for a walk (it
 * minimises round-trips when reconstructing a full list) and wrong for a
 * surface that RENDERS one page: there the size is how much a reader sees
 * before asking for more, which is a UI decision and not the transport
 * maximum. A paged caller passes its own.
 */
export function pageQuery(
  cursor: string | undefined,
  extra: Record<string, string> = {},
  limit: number = MAX_PAGE_SIZE,
): string {
  const params = new URLSearchParams(extra);
  params.set('limit', String(limit));
  // `limit` is unconditionally written, so a caller's copy is always replaced.
  // `cursor` is written only on later pages, so on the first page an
  // `extra.cursor` would otherwise survive and start the walk mid-list.
  params.delete('cursor');
  if (cursor !== undefined) params.set('cursor', cursor);
  return `?${params.toString()}`;
}
