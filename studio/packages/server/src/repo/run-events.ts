import { asc, eq, max } from 'drizzle-orm';
import {
  NewRunEventSchema,
  RunEventSchema,
  type NewRunEvent,
  type RunEvent,
} from '@autonomy-studio/shared';
import { runEvents } from '../db/schema.js';
import { newId } from './ids.js';
import type { Db } from './types.js';

/**
 * Append-only (the ticket's other headline invariant): there is deliberately
 * no update/delete export in this module. `seq` is monotonic per `runId`,
 * starting at 0, computed inside a transaction alongside the insert (same
 * read-max-then-insert pattern as `pipeline-versions.ts`, same rationale).
 */
export function appendRunEvent(db: Db, input: NewRunEvent): RunEvent {
  const parsed = NewRunEventSchema.parse(input);

  return db.transaction((tx) => {
    const maxRow = tx
      .select({ maxSeq: max(runEvents.seq) })
      .from(runEvents)
      .where(eq(runEvents.runId, parsed.runId))
      .get();
    const nextSeq = maxRow?.maxSeq === null || maxRow?.maxSeq === undefined ? 0 : maxRow.maxSeq + 1;

    const row: RunEvent = {
      id: newId('evt'),
      ...parsed,
      seq: nextSeq,
      ts: Date.now(),
    };
    tx.insert(runEvents).values(row).run();
    return RunEventSchema.parse(row);
  });
}

/** All events for one run, in append order (`seq` ascending). */
export function listRunEvents(db: Db, runId: string): RunEvent[] {
  const rows = db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.seq))
    .all();
  return rows.map((row) => RunEventSchema.parse(row));
}

export function getRunEvent(db: Db, id: string): RunEvent | null {
  const row = db.select().from(runEvents).where(eq(runEvents.id, id)).get();
  return row ? RunEventSchema.parse(row) : null;
}
