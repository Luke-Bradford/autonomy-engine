import type { FastifyPluginAsync } from 'fastify';
import { listWorkspaceEventsPage } from '../repo/index.js';
import { pageArgsFromQuery } from './util.js';

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
 */
export const workspaceAuditRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.get('/api/workspace/audit', async (request) => {
    const page = listWorkspaceEventsPage(
      db,
      request.principal.ownerId,
      pageArgsFromQuery(request.query),
    );
    return { items: page.items, nextCursor: page.nextCursor };
  });
};
