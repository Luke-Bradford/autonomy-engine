import { PaginationQuerySchema } from '@autonomy-studio/shared';
import type { Principal } from '../auth/principal.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { decodeCursor, type PageArgs } from '../repo/pagination.js';

/**
 * Returns `row` if it exists AND belongs to `principal.ownerId`; otherwise
 * throws `NotFoundError` — deliberately the same outcome (and the same HTTP
 * response, via the global error handler) whether the row doesn't exist at
 * all or exists under a different owner. This is the per-request
 * authorization check every `get`/`update`/`delete`-by-id route must run in
 * addition to (never instead of) the auth seam attaching a principal —
 * knowing WHO is asking is not the same as proving THEY may see THIS row.
 */
export function requireOwned<T extends { ownerId: string | null }>(
  row: T | null,
  principal: Principal,
  resource: string,
  id: string,
): T {
  if (!row || row.ownerId !== principal.ownerId) {
    throw new NotFoundError(resource, id);
  }
  return row;
}

/**
 * Parses a list route's `request.query` into repo `PageArgs` (#534), mapping
 * both failure modes to a 400: an out-of-range/malformed `limit` throws a
 * `ZodError`, and an unrecognised `cursor` (bad base64/JSON or a stale
 * `CURSOR_VERSION`) decodes to `null` here and is rejected as a
 * `BadRequestError` — never silently treated as "first page" (which would hand
 * the caller a different result set than it asked to resume). This is the ONE
 * place the opaque cursor crosses from the HTTP boundary into the repo layer.
 */
export function pageArgsFromQuery(query: unknown): PageArgs {
  const { limit, cursor } = PaginationQuerySchema.parse(query);
  if (cursor === undefined) return { limit };
  const key = decodeCursor(cursor);
  if (!key) throw new BadRequestError('invalid cursor');
  return { limit, cursor: key };
}
