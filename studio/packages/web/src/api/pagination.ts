import { MAX_PAGE_SIZE, type Paginated } from '@autonomy-studio/shared';

/**
 * #534 — the list endpoints are now keyset-paginated (`{ items, nextCursor }`).
 * Today's list PAGES render the full owner-scoped list, so these api wrappers
 * reconstruct it by walking every page: the SERVER response is bounded per
 * request, while the FE contract (`Promise<T[]>`) is unchanged, so no page
 * component has to change. Incremental "load more" UI is a later, browser-gated
 * ticket; when it lands it consumes `Paginated<T>` directly rather than this
 * walk.
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
 * Builds the `?limit=…[&cursor=…]` query for a list request. Requests the max
 * page size to minimise round-trips when reconstructing the full list, and
 * URL-encodes the cursor (via `URLSearchParams`) so an opaque handle is always
 * transmitted safely.
 */
export function pageQuery(cursor: string | undefined): string {
  const params = new URLSearchParams({ limit: String(MAX_PAGE_SIZE) });
  if (cursor !== undefined) params.set('cursor', cursor);
  return `?${params.toString()}`;
}
