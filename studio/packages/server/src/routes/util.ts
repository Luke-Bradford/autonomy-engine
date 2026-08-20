import { PaginationQuerySchema } from '@autonomy-studio/shared';
import type { FastifyReply } from 'fastify';
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

/**
 * #925 — mark a response whose BODY IS A CREDENTIAL as uncacheable.
 *
 * Two routes hand a live secret back in a 200 body: `GET /api/runs/:id/
 * external-waits` (each `callbackPath` embeds a re-derived external-wait
 * capability token — holding it IS the authorization to settle that wait) and
 * `POST /api/triggers/:id/webhook-secret` (the plaintext signing secret,
 * returned exactly once). With no cache directive at all, a browser or any
 * interposed intermediary is free to apply HEURISTIC caching to those responses
 * and land a bearer credential on disk, or in a shared cache.
 *
 * `no-store` (RFC 9111 §5.2.2.5) is the directive that forbids STORING it
 * anywhere, which is the actual requirement — `no-cache` would still permit the
 * store and only force revalidation.
 *
 * DELIBERATELY a per-route call and NOT a blanket `onSend` hook. A blanket
 * `no-store` would also stop the SPA bundle and every read-model list route being
 * cached — a performance regression nobody asked for, to protect responses that
 * carry nothing. The rule is "one rule, installed at every site that needs it"
 * (the shape #913 used for the log channel), so a THIRD credential-revealing
 * route must call this too. The enumeration of which routes those are is kept in
 * `util/log-redaction.ts`'s `SECRET_URL_ROUTE_BASES` docblock — the same list,
 * one place, because the two protections answer the same question about the same
 * routes ("where does a credential travel?") in two different channels.
 */
export function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
}
