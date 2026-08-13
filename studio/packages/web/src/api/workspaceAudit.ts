import {
  WorkspaceEventRowSchema,
  paginatedResponseSchema,
  type WorkspaceEventRow,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';
import { fetchAllPages, pageQuery } from './pagination';

const WorkspaceAuditPageSchema = paginatedResponseSchema(WorkspaceEventRowSchema);

/**
 * #1075 — the client half of the WORKSPACE-AUDIT log (`GET /api/workspace/audit`,
 * #3 G6a). The route, its owner scoping and its keyset pagination shipped with
 * G6a; nothing in the web app ever called it, so every `repo.connected`,
 * `pipeline.archived`, `pipeline.restored`, `import.applied` and
 * `pipeline.published` was written durably and read by no one.
 *
 * ORDER — the server orders ASCENDING (`pageOrder` = `asc(seq), asc(id)` in
 * `repo/pagination.ts`), i.e. oldest first, and there is no descending mode. So
 * this returns the log in APPEND order and the PAGE reverses it for display.
 * `seq` is monotonic per owner, so the reverse of the ascending walk is exactly
 * the descending order — not an approximation of it.
 *
 * THE COST OF THAT, stated rather than left implicit: rendering the newest
 * events requires walking every page of an append-only log with no retention
 * policy. That is the same full-list contract every sibling wrapper here
 * presents (`listSecrets`, `listConnections`, `listPipelines`), and at
 * `MAX_PAGE_SIZE` rows a page it is one request per 100 events — the log grows
 * at AUTHORING rate (a publish, an archive, an import), not run rate, so it is
 * a bounded cost today and a growing one over a workspace's life. #1076 is the
 * revisit: server-side descending order plus an incremental "load older", which
 * `api/pagination.ts`'s own docblock already anticipates as the point at which
 * a caller consumes `Paginated<T>` directly instead of walking. Revisit when a
 * real workspace's log makes the first paint slow, not before.
 *
 * PARSING IS ALL-OR-NOTHING, deliberately. `WorkspaceEventRowSchema` types
 * `payload` as the closed union, so one row of an unrecognised variant throws
 * and the page reports a load error rather than rendering. That adds no new
 * failure mode — the server parses the same rows through the same schema at
 * `repo/workspace-events.ts` and would fail first — and it is the right
 * polarity for an AUDIT surface specifically: silently dropping the row it
 * could not read would present a partial history as a complete one. Do not
 * "fix" this into a per-row soft fallback.
 */
export function listWorkspaceAudit(signal?: AbortSignal): Promise<WorkspaceEventRow[]> {
  return fetchAllPages((cursor) =>
    apiFetch(`/api/workspace/audit${pageQuery(cursor)}`, {
      schema: WorkspaceAuditPageSchema,
      signal,
    }),
  );
}
