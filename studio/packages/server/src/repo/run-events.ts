import { and, asc, count, eq, max, sql } from 'drizzle-orm';
import {
  NewRunEventSchema,
  RunEventSchema,
  type NewRunEvent,
  type PipelineCostAggregates,
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
 * #2 L6 / #599 — the per-pipeline cost rollup's BOUNDED aggregation: SUM/COUNT
 * `activity.metered` cost + tokens across ALL runs of a pipeline (all versions)
 * in a fixed number of scalar queries whose result set is O(1), rather than
 * loading every metered event (runs × LLM-calls, unbounded) into memory. The
 * caller feeds the returned aggregates to `rollupFromAggregates` — the single
 * fail-closed derivation site (shared with the in-memory array fold), so the SQL
 * path and the array path cannot drift.
 *
 * FAIL-CLOSED (the #473 / F13a lesson), preserved exactly in SQL:
 *   - `SUM(json_extract(payload,'$.costEstimate'))` skips NULLs, so an ABSENT
 *     costEstimate contributes NOTHING — `totalCostEstimate` is an honest LOWER
 *     BOUND, never a manufactured 0. `COALESCE(...,0)` only handles the
 *     empty-set case (SUM of no rows is NULL), never a per-row 0-pad.
 *   - `COUNT(json_extract(payload,'$.costEstimate'))` counts a present value —
 *     including a genuine `0` — but NOT an absent key, giving
 *     `pricedResponseCount`. `costEstimate` is `.optional()` (never JSON null),
 *     so absent ⟺ json_extract NULL ⟺ not priced.
 *   - #2 L14: `unpricedResponseCount` = metered rows with no costEstimate whose
 *     `meteringStatus` is `unpriced` (a subscription/CLI call — a KNOWN zero-marginal,
 *     not a gap). Carved out of the incompleteness signal below so the derived
 *     `costUnknownResponseCount = responseCount - priced - unpriced` counts only
 *     genuine gaps and `complete` stays true for a subscription-only run.
 *   - `incompleteRunCount` = runs with >=1 metered response that is neither priced
 *     nor `unpriced`, via
 *     `GROUP BY run_id HAVING count(*) > count(costEstimate) + <unpriced-in-group>`.
 *
 * SHARED PREDICATE SET + SNAPSHOT: (A) the metered sums/counts, (B) the
 * incomplete-run count, and (C) the run count all scan the IDENTICAL row set
 * (same join, same `activity.metered` filter, same owner scope) AND run inside
 * ONE read transaction (a single consistent SQLite snapshot). Both together are
 * what make the derived `complete` (from responseCount − priced) and
 * `incompleteRunCount` UNCONDITIONALLY consistent — the documented
 * `complete === (incompleteRunCount === 0)` invariant holds even under a
 * concurrent write, not merely because the reads happen to be issued with no
 * `await` between them. `runCount` (C) counts runs on the `runs` table, so it
 * INCLUDES zero-metered runs (each a complete $0, contributing to the count only).
 *
 * SOUNDNESS of trusting the stored `type` + payload JSON instead of re-parsing
 * each row through Zod: the SOLE production writer, `appendEngineEvent`
 * (`run/events.ts`), validates the payload through `EngineEventSchema` and stamps
 * the envelope `type` FROM the validated payload BEFORE insert. So a row with
 * `type='activity.metered'` always carries a well-formed metered payload — the
 * `json_extract` reads see exactly what the pure fold would. (Tests that append
 * raw rows must therefore build WELL-FORMED metered payloads; a hand-crafted
 * malformed one would diverge from the fold, which cannot occur in production.)
 *
 * Owner-scoped when `ownerId` is passed (authentication ≠ authorization): filters
 * the RUNS' own `owner_id`, defense in depth, never trusting that every run under
 * the pipeline shares its owner.
 */
export function aggregatePipelineCost(
  db: Db,
  pipelineId: string,
  ownerId?: string,
): PipelineCostAggregates {
  // The one shared metered predicate set — reused verbatim by (A) and (B).
  const meteredConditions = [
    eq(pipelineVersions.pipelineId, pipelineId),
    eq(runEvents.type, 'activity.metered'),
  ];
  if (ownerId !== undefined) {
    meteredConditions.push(eq(runs.ownerId, ownerId));
  }
  const costEstimate = sql`json_extract(${runEvents.payload}, '$.costEstimate')`;
  // #2 L14 — the per-group SUM of `unpriced` (subscription/CLI) responses: metered
  // rows with NO `costEstimate` whose `meteringStatus` is `unpriced`. The
  // `costEstimate is null` guard keeps this DISJOINT from `count(costEstimate)`
  // exactly as the pure fold's `else if` does (the executor never stamps a price on
  // an `unpriced` response, so the guard is belt-and-suspenders that pins fold-SQL
  // equivalence). `case ... then 1 else 0` never yields NULL, so the sum is a real
  // number over any non-empty group.
  const unpricedCount = sql`sum(case when ${costEstimate} is null and json_extract(${runEvents.payload}, '$.meteringStatus') = 'unpriced' then 1 else 0 end)`;
  const runConditions = [eq(pipelineVersions.pipelineId, pipelineId)];
  if (ownerId !== undefined) {
    runConditions.push(eq(runs.ownerId, ownerId));
  }

  // All THREE reads run in ONE transaction so they observe a single consistent
  // SQLite snapshot. Only then does "the derived `complete` (from A) and
  // `incompleteRunCount` (from B) cannot disagree" hold UNCONDITIONALLY — a
  // concurrent metered-event/run insert can no longer land between the reads and
  // skew A against B. It also stops the guarantee resting on the three `.get()`s
  // being issued with no `await` between them (true today — the fn is synchronous
  // — but a snapshot makes it robust to a future async refactor). Read-only, so
  // there is nothing to roll back; the transaction is purely for snapshot isolation.
  return db.transaction((tx): PipelineCostAggregates => {
    // (A) Pipeline-wide scalar sums/counts over metered events.
    const sums = tx
      .select({
        responseCount: count(),
        pricedResponseCount: count(costEstimate),
        // coalesce handles the empty-set case (sum of no rows is NULL); the inner
        // case-expression never per-row-pads a 0 where a status is absent.
        unpricedResponseCount: sql<number>`coalesce(${unpricedCount}, 0)`,
        totalCostEstimate: sql<number>`coalesce(sum(${costEstimate}), 0)`,
        inputTokens: sql<number>`coalesce(sum(json_extract(${runEvents.payload}, '$.inputTokens')), 0)`,
        outputTokens: sql<number>`coalesce(sum(json_extract(${runEvents.payload}, '$.outputTokens')), 0)`,
      })
      .from(runEvents)
      .innerJoin(runs, eq(runEvents.runId, runs.id))
      .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
      .where(and(...meteredConditions))
      .get();

    // (B) incompleteRunCount — runs with >=1 metered response that is a GENUINE
    // cost gap: neither priced (has a costEstimate) NOR `unpriced` (subscription).
    // #2 L14: subtracting the per-group unpriced count keeps a subscription-only run
    // from being flagged incomplete — its cost is known (none), not missing.
    const incompleteRuns = tx
      .select({ runId: runEvents.runId })
      .from(runEvents)
      .innerJoin(runs, eq(runEvents.runId, runs.id))
      .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
      .where(and(...meteredConditions))
      .groupBy(runEvents.runId)
      .having(sql`count(*) > count(${costEstimate}) + ${unpricedCount}`)
      .as('incomplete_runs');
    const incompleteRunCount = tx.select({ n: count() }).from(incompleteRuns).get()?.n ?? 0;

    // (C) runCount — ALL runs of the pipeline (incl. zero-metered), owner-scoped.
    const runCount =
      tx
        .select({ n: count() })
        .from(runs)
        .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
        .where(and(...runConditions))
        .get()?.n ?? 0;

    return {
      runCount,
      incompleteRunCount,
      responseCount: sums?.responseCount ?? 0,
      pricedResponseCount: sums?.pricedResponseCount ?? 0,
      unpricedResponseCount: sums?.unpricedResponseCount ?? 0,
      totalCostEstimate: sums?.totalCostEstimate ?? 0,
      inputTokens: sums?.inputTokens ?? 0,
      outputTokens: sums?.outputTokens ?? 0,
    };
  });
}

export function getRunEvent(db: Db, id: string): RunEvent | null {
  const row = db.select().from(runEvents).where(eq(runEvents.id, id)).get();
  return row ? RunEventSchema.parse(row) : null;
}
