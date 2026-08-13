import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { listWorkspaceEventsPage } from '../repo/index.js';
import { pageArgsFromQuery } from './util.js';

/**
 * #1076 — the direction of the walk. Parsed HERE, beside `pageArgsFromQuery`
 * rather than folded into the shared `PaginationQuerySchema`: this is the only
 * list route that has two directions, and adding `order` to the shared schema
 * would have every other list endpoint advertise a parameter it silently
 * ignores. The same route-local-filter-schema idiom as
 * `ListPipelinesQuerystringSchema`. An unrecognised value is a ZodError → 400
 * at the boundary (loud), never a silent fallback to a direction the caller did
 * not ask for.
 *
 * DEFAULT `asc`, i.e. the contract this route shipped with is unchanged and the
 * descending mode is purely additive. The one consumer that wants newest-first
 * says so on every request. A flipped default would have re-sliced the log
 * under every existing reader — the import-provenance and publish-history
 * readers all mean APPEND order — to save one query parameter at a single
 * caller.
 */
const AuditQuerySchema = z.object({
  order: z.enum(['asc', 'desc']).default('asc'),
});

/**
 * #3 G6a — the read side of the WORKSPACE-AUDIT log (`GET /api/workspace/audit`).
 *
 * Deliberately mounted OUTSIDE `/api/workspace/git`: the log records
 * `pipeline.archived` too, which happens on a DB-only workspace with no git
 * connection, so the audit surface is not git-gated. Unlike the git routes it
 * therefore NEVER 404s on a missing `workspace_git` row — an owner with no
 * connection and no archives simply gets an empty page.
 *
 * Keyset-paginated (#534) and owner-scoped: authentication ≠ authorization, so
 * the query filters `request.principal.ownerId` and never returns another
 * owner's history.
 *
 * BIDIRECTIONAL since #1076 (`?order=asc|desc`). A reader that wants the NEWEST
 * entries must pass `order=desc` rather than walking to the end of an
 * append-only log and reversing: this is the one list here with no retention
 * policy, so the cost of that walk grows for the life of the workspace and
 * never falls. A `cursor` names a POSITION and not a direction, so a caller
 * sends the same `order` on every page of one walk, first page included —
 * `repo/pagination.ts`'s `beforeCursor` docblock has the full argument.
 */
export const workspaceAuditRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.get('/api/workspace/audit', async (request) => {
    const { order } = AuditQuerySchema.parse(request.query);
    const page = listWorkspaceEventsPage(
      db,
      request.principal.ownerId,
      pageArgsFromQuery(request.query),
      order,
    );
    return { items: page.items, nextCursor: page.nextCursor };
  });
};
