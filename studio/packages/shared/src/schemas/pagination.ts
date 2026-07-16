import { z } from 'zod';

/**
 * #534 — the ONE pagination convention for studio list endpoints. Every
 * unbounded owner-scoped list GET (`/api/secrets`, `/api/connections`,
 * `/api/pipelines`, …) shares this shape so a client learns it once and the
 * server never emits an unbounded response.
 *
 * KEYSET (cursor), not offset: studio ids are random (`nanoid`), so a page is
 * a stable slice of the total order `created_at ASC, id ASC` (id is the
 * deterministic tie-breaker — `created_at` is a millisecond int and can
 * collide). The `cursor` is an OPAQUE server-minted handle (a client never
 * builds or parses one); it names the last item of the prior page, and the
 * server returns rows strictly after it. Keyset compares VALUES, so it is
 * immune to rows inserted/deleted between pages — an offset scheme would
 * drift.
 */

/** Default page size when a client omits `?limit`. SSOT — imported, never
 * re-literalled. */
export const DEFAULT_PAGE_SIZE = 50;

/** Hard ceiling on `?limit`. A larger request is a 400 at the boundary
 * (loud), never silently clamped — an accepted request must mean what it
 * says. SSOT. */
export const MAX_PAGE_SIZE = 100;

/**
 * The list-endpoint query contract. `limit` is coerced from the query string
 * (`?limit=25`) and bounded `[1, MAX_PAGE_SIZE]` — out of range is a 400, not
 * a clamp. `cursor` is the opaque handle from a prior page's `nextCursor`;
 * absent means "first page". Unknown query keys are ignored (a GET query may
 * legitimately carry unrelated params), so this is intentionally NOT `.strict()`.
 */
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/**
 * The response envelope. `nextCursor` is the handle to fetch the NEXT page, or
 * `null` when this page is the last — the server sets it to `null` precisely
 * (via a fetch-one-extra probe), so an absent-`null` never manufactures a
 * false "more pages" nor hides a real one (the F13a/#473 fail-open rule).
 */
export function paginatedResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

/** The decoded shape of `paginatedResponseSchema(item)` — the FE/BE-shared
 * page type. */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
