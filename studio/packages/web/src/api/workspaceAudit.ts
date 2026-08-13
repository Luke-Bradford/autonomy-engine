import {
  WorkspaceEventRowSchema,
  paginatedResponseSchema,
  type Paginated,
  type WorkspaceEventRow,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';
import { pageQuery } from './pagination';

const WorkspaceAuditPageSchema = paginatedResponseSchema(WorkspaceEventRowSchema);

/**
 * How many entries one audit page holds. Deliberately NOT `DEFAULT_PAGE_SIZE`
 * (50) or `MAX_PAGE_SIZE` (100): those size a TRANSPORT chunk for a caller
 * reconstructing a whole list, where a bigger page is strictly better. This
 * number is different in kind — it is how much history a reader is shown before
 * they ask for more, so it wants to be about a screenful. Exported so the tests
 * and the e2e spec assert against the real value rather than re-literalling it.
 */
export const AUDIT_PAGE_SIZE = 25;

/**
 * #1075 — the client half of the WORKSPACE-AUDIT log (`GET /api/workspace/audit`,
 * #3 G6a). The route, its owner scoping and its keyset pagination shipped with
 * G6a; nothing in the web app ever called it, so every `repo.connected`,
 * `pipeline.archived`, `pipeline.restored`, `import.applied` and
 * `pipeline.published` was written durably and read by no one.
 *
 * ORDER — #1076. This asks the SERVER for descending order (`?order=desc`,
 * `repo/pagination.ts`'s `pageOrderDesc`/`beforeCursor`) and returns ONE page,
 * rather than walking an append-only log to its end and reversing it. The
 * ordering scalar is `seq`, the per-owner append order, so "descending" here is
 * exact rather than a wall-clock approximation: two events minted in the same
 * millisecond still read back in the order they happened.
 *
 * WHY THAT MATTERS HERE and not on the sibling wrappers (`listSecrets`,
 * `listConnections`, `listPipelines`), which do still walk: this is the first
 * list with NO retention policy at all. It grows at AUTHORING rate — a publish,
 * an archive, an import — so it is small today, but the walk's cost rises for
 * the life of a workspace and never falls, and it is paid to render twenty rows.
 *
 * `order` GOES ON EVERY REQUEST, first page included. A cursor names a POSITION
 * and carries no direction, so pairing one with the other order returns a
 * coherent but different slice and nothing errors — `beforeCursor`'s docblock
 * has the full argument. One walk, one direction, stated every time.
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
export function fetchWorkspaceAuditPage(
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<Paginated<WorkspaceEventRow>> {
  return apiFetch(
    `/api/workspace/audit${pageQuery(cursor, { order: 'desc' }, AUDIT_PAGE_SIZE)}`,
    { schema: WorkspaceAuditPageSchema, signal },
  );
}
