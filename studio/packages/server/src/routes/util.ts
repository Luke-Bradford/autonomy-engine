import type { Principal } from '../auth/principal.js';
import { NotFoundError } from '../errors.js';

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
