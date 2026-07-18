import { and, asc, eq, max } from 'drizzle-orm';
import {
  NewRunEventSchema,
  RunEventSchema,
  type NewRunEvent,
  type RunEvent,
} from '@autonomy-studio/shared';
import { pipelineVersions, runEvents, runs } from '../db/schema.js';
import { newId } from './ids.js';
import type { Db } from './types.js';

/**
 * Append-only (the ticket's other headline invariant): there is deliberately
 * no update/delete export in this module. `seq` is monotonic per `runId`,
 * starting at 0, computed inside a transaction alongside the insert (same
 * read-max-then-insert pattern as `pipeline-versions.ts`, same rationale).
 *
 * NOTE: this `max()+1` numbering relies on better-sqlite3's synchronous,
 * single-writer connection model (no other connection can interleave a write
 * between the read and the insert). The `run_events_run_id_seq_idx` UNIQUE
 * index is the real backstop against any cross-connection race, not this
 * transaction.
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

/**
 * The highest `seq` in a run's log, or `null` for an empty one.
 *
 * #497's `resume` sites need the log POSITION they are deriving at, and they
 * hold `EngineEvent[]` (`loadEngineEvents`), which carries no `seq` — it is the
 * parsed payload, not the envelope. Inferring it as `events.length - 1` would be
 * sound today (seq is contiguous from 0: `max()+1` numbering, and this module
 * exports no delete) but it is an INFERENCE across two modules, and a cheap
 * authoritative read on a once-per-drive path is worth more than saving it.
 */
export function maxRunEventSeq(db: Db, runId: string): number | null {
  const row = db
    .select({ maxSeq: max(runEvents.seq) })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .get();
  return row?.maxSeq ?? null;
}

/**
 * #2 L6 — every `activity.metered` event across ALL runs of a pipeline, in ONE
 * indexed join (`run_events → runs → pipeline_versions`), so the per-pipeline
 * cost rollup is 2 queries total (this + `listRunsForPipeline`), not 1+N. The
 * `type = 'activity.metered'` filter is exact on the stored envelope `type`
 * column (`appendRunEvent` stamps it from the payload's `type`), so it is a
 * cheap pre-filter — the projection still re-parses each payload and folds only
 * true metered events, so a mislabelled row can never inflate the cost.
 *
 * Owner-scoped when `ownerId` is passed, matching `listRunsForPipeline` exactly
 * so the two queries agree on the run set (defense in depth: filters the RUNS'
 * own `owner_id`, not just the pipeline's). Ordered by `(runId, seq)` for a
 * deterministic result; the fold itself is order-independent.
 */
export function listMeteredEventsForPipeline(
  db: Db,
  pipelineId: string,
  ownerId?: string,
): RunEvent[] {
  const conditions = [
    eq(pipelineVersions.pipelineId, pipelineId),
    eq(runEvents.type, 'activity.metered'),
  ];
  if (ownerId !== undefined) {
    conditions.push(eq(runs.ownerId, ownerId));
  }
  const rows = db
    .select()
    .from(runEvents)
    .innerJoin(runs, eq(runEvents.runId, runs.id))
    .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
    .where(and(...conditions))
    .orderBy(asc(runEvents.runId), asc(runEvents.seq))
    .all();
  return rows.map((row) => RunEventSchema.parse(row.run_events));
}

export function getRunEvent(db: Db, id: string): RunEvent | null {
  const row = db.select().from(runEvents).where(eq(runEvents.id, id)).get();
  return row ? RunEventSchema.parse(row) : null;
}
