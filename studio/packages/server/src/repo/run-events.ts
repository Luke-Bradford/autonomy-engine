import { and, asc, count, eq, inArray, max, sql } from 'drizzle-orm';
import {
  NewRunEventSchema,
  RunEventSchema,
  runCostFromAggregates,
  type NewRunEvent,
  type PipelineCostAggregates,
  type RunCost,
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
 * The ONE SQL statement of the fail-closed three-way categorisation, so the
 * per-PIPELINE aggregate (#599) and the per-RUN aggregate (#931) cannot say
 * different things about the same money — the SQL-layer twin of
 * `runCostFromAggregates` being the one derivation site.
 *
 * `costEstimate` is the presence test the whole model turns on: `json_extract`
 * yields NULL for an absent key, and `costEstimate` is `.optional()` (never JSON
 * null), so absent ⟺ NULL ⟺ not priced.
 */
export const meteredCostEstimate = sql`json_extract(${runEvents.payload}, '$.costEstimate')`;

/**
 * #2 L14 — the per-group SUM of `unpriced` (subscription/CLI) responses: metered
 * rows with NO `costEstimate` whose `meteringStatus` is `unpriced`. The
 * `costEstimate is null` guard keeps this DISJOINT from `count(costEstimate)`
 * exactly as the pure fold's `else if` does (the executor never stamps a price on
 * an `unpriced` response, so the guard is belt-and-suspenders that pins fold-SQL
 * equivalence). `case ... then 1 else 0` never yields NULL, so the sum is a real
 * number over any non-empty group.
 */
export const meteredUnpricedCount = sql`sum(case when ${meteredCostEstimate} is null and json_extract(${runEvents.payload}, '$.meteringStatus') = 'unpriced' then 1 else 0 end)`;

/**
 * The `MeteredAggregates` selection, valid both UNGROUPED (one row for the whole
 * filtered set) and GROUPED (one row per `run_id`).
 *
 * The `coalesce(sum(...), 0)` wrappers exist ONLY for the empty-set case — SQL's
 * `sum` of no rows is NULL — and NEVER per-row-pad a 0 where a value is absent
 * (that is the fail-closed rule this whole module is built on). GROUPED, they are
 * therefore dead weight: a group exists only because it has at least one row. The
 * empty case does not disappear though, it MOVES — a run with no metered events
 * produces no group at all, so its zeroed cost comes from the caller's lookup
 * miss rather than from a coalesced NULL. `aggregateRunCosts` says where.
 */
export function meteredAggregateColumns() {
  return {
    responseCount: count(),
    pricedResponseCount: count(meteredCostEstimate),
    unpricedResponseCount: sql<number>`coalesce(${meteredUnpricedCount}, 0)`,
    totalCostEstimate: sql<number>`coalesce(sum(${meteredCostEstimate}), 0)`,
    inputTokens: sql<number>`coalesce(sum(json_extract(${runEvents.payload}, '$.inputTokens')), 0)`,
    outputTokens: sql<number>`coalesce(sum(json_extract(${runEvents.payload}, '$.outputTokens')), 0)`,
  };
}

/**
 * How many run ids `aggregateRunCosts` binds per statement.
 *
 * MEASURED against this repo's `better-sqlite3` (SQLite 3.53.2): the parameter
 * ceiling is `SQLITE_MAX_VARIABLE_NUMBER = 32766`, and 32767 binds raise
 * "too many SQL variables". This sits well below it deliberately — that limit is
 * a COMPILE-TIME option (it defaulted to 999 before SQLite 3.32), so a differently
 * built binary could be far lower, and the failure mode of guessing high is the
 * whole runs page 500ing rather than one slow query.
 */
const RUN_ID_BIND_CHUNK = 500;

/**
 * #931 — the per-RUN cost aggregation behind the run list's cost column: the same
 * bounded SUM/COUNT as {@link aggregatePipelineCost}, `GROUP BY run_id`, for a
 * KNOWN set of run ids.
 *
 * WHY BY ID rather than by re-applying the list's own filter conditions. Both
 * would work, but the id set makes set-equality with the rendered rows true BY
 * CONSTRUCTION rather than by an argument about two predicate lists staying in
 * step — and `listRunSummaries`' predicates are demonstrably NOT one list (the
 * `pipelineId` axis is pushed on outside the shared builder because it reads a
 * joined column). It is also the cheaper query: `run_events_run_id_idx` serves an
 * `IN` directly, where a re-filtered form would scan on `type`, which is indexed
 * nowhere. The in-file precedent is `queuedTriggerCandidatesForPipeline`
 * (`repo/runs.ts`), which collects ids then re-queries by `inArray` for the same
 * reason.
 *
 * A run with NO metered events is ABSENT from the returned map — deliberately, and
 * it is the one thing a caller must handle. Ungrouped, `aggregatePipelineCost` gets
 * "no metered events at all" as a single all-zero row; grouped, that case has no
 * row to be, so the zero has to come from the caller. `listRunSummaries` answers it
 * with `computeRunCost([])`, i.e. the fold's own empty value rather than a
 * hand-written zero object that could be missed when `RunCost` grows a field.
 *
 * Owner-scoped when `ownerId` is passed (authentication ≠ authorization). Defense
 * in depth: the ids handed in have normally ALREADY cleared an owner filter, and
 * the join can never drop a row of its own (`run_events.run_id` is a cascading FK),
 * so this is a second lock on the same door rather than the only one.
 */
export function aggregateRunCosts(
  db: Db,
  runIds: readonly string[],
  ownerId?: string,
): Map<string, RunCost> {
  const costs = new Map<string, RunCost>();
  for (let i = 0; i < runIds.length; i += RUN_ID_BIND_CHUNK) {
    const chunk = runIds.slice(i, i + RUN_ID_BIND_CHUNK);
    const conditions = [inArray(runEvents.runId, chunk), eq(runEvents.type, 'activity.metered')];
    if (ownerId !== undefined) conditions.push(eq(runs.ownerId, ownerId));
    const rows = db
      .select({ runId: runEvents.runId, ...meteredAggregateColumns() })
      .from(runEvents)
      .innerJoin(runs, eq(runEvents.runId, runs.id))
      .where(and(...conditions))
      .groupBy(runEvents.runId)
      .all();
    for (const row of rows) {
      const { runId, ...aggregates } = row;
      costs.set(runId, runCostFromAggregates(aggregates));
    }
  }
  return costs;
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
      .select(meteredAggregateColumns())
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
      .having(sql`count(*) > count(${meteredCostEstimate}) + ${meteredUnpricedCount}`)
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
