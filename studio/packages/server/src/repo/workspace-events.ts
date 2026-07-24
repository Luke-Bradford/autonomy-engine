import { and, eq, max } from 'drizzle-orm';
import {
  WorkspaceEventRowSchema,
  WorkspaceEventSchema,
  type Paginated,
  type WorkspaceEvent,
  type WorkspaceEventRow,
} from '@autonomy-studio/shared';
import { workspaceEvents } from '../db/schema.js';
import { newId } from './ids.js';
import { afterCursor, encodeCursor, pageOrder, type PageArgs } from './pagination.js';
import type { Db } from './types.js';

/**
 * #3 G6a — the WORKSPACE-AUDIT log writer/reader. Append-only (the ticket's
 * headline invariant): there is deliberately NO update/delete export in this
 * module, and the SQL triggers (0027) back that up. `seq` is monotonic per
 * `ownerId`, starting at 0, computed inside a transaction alongside the insert
 * (the `run-events.ts` / `pipeline-versions.ts` read-max-then-insert pattern,
 * same rationale).
 *
 * NOTE: the `max()+1` numbering relies on better-sqlite3's synchronous,
 * single-writer connection model (no other connection interleaves a write
 * between the read and the insert). The `workspace_events_owner_id_seq_idx`
 * UNIQUE index is the real backstop against any cross-connection race, not this
 * transaction.
 *
 * SINGLE VALIDATING WRITER: the `payload` is parsed through the closed
 * `WorkspaceEventSchema` union here, and the envelope `type` column is stamped
 * FROM the parsed payload — so the indexed `type` can never disagree with the
 * payload it labels (the `appendEngineEvent` idiom). Called inside a caller's
 * transaction, its own `db.transaction` composes as a SAVEPOINT, so the audit
 * fact commits or rolls back ATOMICALLY with the mutation it records (the
 * fail-safe direction: never a committed change with a lost audit fact).
 */
export function appendWorkspaceEvent(
  db: Db,
  ownerId: string,
  payload: WorkspaceEvent,
): WorkspaceEventRow {
  const parsed = WorkspaceEventSchema.parse(payload);

  return db.transaction((tx) => {
    const maxRow = tx
      .select({ maxSeq: max(workspaceEvents.seq) })
      .from(workspaceEvents)
      .where(eq(workspaceEvents.ownerId, ownerId))
      .get();
    const nextSeq = maxRow?.maxSeq === null || maxRow?.maxSeq === undefined ? 0 : maxRow.maxSeq + 1;

    const row: WorkspaceEventRow = {
      id: newId('wev'),
      ownerId,
      seq: nextSeq,
      type: parsed.type,
      payload: parsed,
      createdAt: Date.now(),
    };
    tx.insert(workspaceEvents).values(row).run();
    return WorkspaceEventRowSchema.parse(row);
  });
}

/**
 * One owner's audit log, oldest-first, keyset-paginated. Ordered by `seq` — the
 * authoritative per-owner APPEND order — NOT by the wall-clock `createdAt`:
 * two events minted in the same millisecond would otherwise read back in
 * random-`id` order, wrong for an audit history. It still reuses the shared
 * opaque-cursor codec (`afterCursor`/`pageOrder`/`encodeCursor`): that codec is
 * generic over "an ordering scalar + an id tie-break", so the `CursorKey`'s
 * numeric slot carries `seq` here (seq is already unique per owner, so the id
 * tie-break is redundant but harmless). Only `toPage` is not reused — it mints
 * the cursor from a row's `.createdAt`, but our ordering scalar is `.seq`; the
 * one-extra-row split is inlined instead. Owner-scoped: authentication ≠
 * authorization — every query filters `owner_id`.
 */
export function listWorkspaceEventsPage(
  db: Db,
  ownerId: string,
  args: PageArgs,
): Paginated<WorkspaceEventRow> {
  const rows = db
    .select()
    .from(workspaceEvents)
    .where(
      and(
        eq(workspaceEvents.ownerId, ownerId),
        args.cursor ? afterCursor(workspaceEvents.seq, workspaceEvents.id, args.cursor) : undefined,
      ),
    )
    .orderBy(...pageOrder(workspaceEvents.seq, workspaceEvents.id))
    .limit(args.limit + 1)
    .all()
    .map((row) => WorkspaceEventRowSchema.parse(row));

  const hasMore = rows.length > args.limit;
  const items = hasMore ? rows.slice(0, args.limit) : rows;
  const boundary = items[items.length - 1];
  return {
    items,
    // The cursor's numeric slot carries `seq` (the ordering scalar), matching
    // the `afterCursor(seq, id, …)` resume predicate above.
    nextCursor:
      hasMore && boundary ? encodeCursor({ createdAt: boundary.seq, id: boundary.id }) : null,
  };
}
