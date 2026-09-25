import { PaginationQuerySchema } from '@autonomy-studio/shared';
import type { FastifyReply } from 'fastify';
import type { Principal } from '../auth/principal.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { getConnection } from '../repo/connections.js';
import { decodeCursor, type PageArgs } from '../repo/pagination.js';
import type { Db } from '../repo/types.js';

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

/**
 * #1143 — lifted here from `routes/datasets.ts` once a second route
 * (`POST /api/import?connectionId=`) needed the identical check.
 *
 * A dataset's `connectionId` names the store it lives in, and it arrives as raw
 * HTTP input — so being logged in is not evidence the caller may bind to it.
 * Authentication is not authorisation, and the check is HERE (the untrusted
 * boundary) rather than in the repo, which the workspace-git apply also calls
 * with an id it has already resolved owner-scoped through `connById`.
 *
 * This is deliberately an OWNERSHIP + existence check at write time, not a
 * standing guarantee — the connection can still be deleted afterwards, which is
 * the dangling case the serializer discloses and a dispatch will refuse (§3.1's
 * "refs to mutable rows are checked at dispatch" holds unchanged). What it stops
 * is a caller pointing a dataset at a store belonging to someone else in the
 * first place.
 *
 * A 400, not a 404: the dataset in the URL (on PATCH) is real and owned, so 404
 * would be a lie about the wrong resource. The message deliberately does not
 * distinguish "no such connection" from "not yours" — that difference is exactly
 * the existence oracle an unauthorised caller would be probing for.
 *
 * #1143 — also the check `POST /api/import?connectionId=` runs on the store an
 * importer chooses for a dataset file: the same untrusted id, the same answer.
 */
export function requireOwnedConnection(
  db: Db,
  principal: Principal,
  connectionId: string,
): NonNullable<ReturnType<typeof getConnection>> {
  const connection = getConnection(db, connectionId);
  if (!connection || connection.ownerId !== principal.ownerId) {
    throw new BadRequestError(`no such connection "${connectionId}"`);
  }
  // Returns the ROW (#1218) rather than only asserting: the sheet-listing route
  // needs the very config this has just proved the caller owns, and re-fetching
  // it would be a second lookup that could disagree with the one that authorised.
  return connection;
}
