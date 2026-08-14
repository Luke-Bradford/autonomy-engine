import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  runCostFromAggregates,
  type AgentCliActivity,
  type AiModelActivity,
  type ExternalAgentActivity,
  type LiveRunCounts,
  type MeteredAggregates,
  type RunCost,
  type TokenSeries,
} from '@autonomy-studio/shared';
import { runEvents, runs } from '../db/schema.js';
import { meteredAggregateColumns } from './run-events.js';
import { aggregateExternalAgentActivity } from './external-agent-activity.js';
import { LIVE_RUN_STATUSES } from './runs.js';
import type { Db } from './types.js';

/**
 * #917 — the CROSS-RUN AI-activity aggregate behind `GET /api/monitor/ai-activity`.
 *
 * BOUNDED, in the same sense `aggregatePipelineCost` (#599) is: four queries
 * whose result sets are O(distinct provider/model pairs) + O(1) + O(4) +
 * O(buckets in the window), never a load of every metered event into memory. The
 * window makes it cheaper still. The bucket query's ROW COUNT — not merely the
 * series built from it — is bounded by `maxBucketCount` REGARDLESS of the data,
 * because `bucketStartExpr` clamps inside the GROUP BY. Bounding it afterwards
 * in JS would leave the fetch itself unbounded, which is the half that costs
 * memory; see that function for why a clamp and not a filter.
 *
 * WHY NOT A LIST OF UNFINISHED RUNS — the shape this deliberately is not. Run
 * liveness is not evidence of AI use in either direction: `LIVE_RUN_STATUSES`
 * counts `queued` (not started) and `waiting` (parked, slot released, possibly
 * for days) as live, while a run of `fs`/`http` nodes drives no model at all.
 * The `activity.metered` / `activity.agentTelemetry` log IS the record of what
 * the connected AIs did, so that is what is read here — and it includes runs
 * still in flight for free, because an exchange is logged when it is billed.
 *
 * FAIL-CLOSED, inherited rather than restated: the metered columns come from
 * `meteredAggregateColumns()` — the same SQL twin the per-run and per-pipeline
 * aggregates use — and every group is turned into a `RunCost` by the same
 * `runCostFromAggregates`. An absent `costEstimate` contributes nothing and
 * flips `complete`, so a total is an honest LOWER BOUND, never a manufactured 0.
 */
export interface AiActivityFilter {
  /** Window lower bound, epoch MILLISECONDS, compared against `run_events.ts`. */
  sinceMs: number;
  /** Owner scope. Authentication ≠ authorization — the route always passes it. */
  ownerId?: string;
  /**
   * Window UPPER bound — the response's `generatedAt` (#967).
   *
   * Passed in rather than read from the clock here so the series and the
   * `generatedAt` the client is told about are the same instant. Taking `now()`
   * inside would let the trailing bucket end a few milliseconds after the
   * timestamp stamped on the response.
   */
  nowMs: number;
  /** Bucket width for the series, from `AI_ACTIVITY_BUCKET_MS`. */
  bucketMs: number;
}

export interface AiActivityAggregate {
  models: AiModelActivity[];
  agentCli: AgentCliActivity;
  /** #988 — AI use REPORTED BY agents studio did not launch. Read in the SAME
   * snapshot as everything else here, and deliberately summed into nothing. */
  external: ExternalAgentActivity;
  totals: RunCost;
  runs: LiveRunCounts;
  series: TokenSeries;
}

/** `provider`/`model` are read out of the metered payload, so the GROUP BY and
 * the SELECT must be the identical expression — bound once here rather than
 * written twice and trusted to match. */
const meteredProvider = sql<string>`json_extract(${runEvents.payload}, '$.provider')`;
const meteredModel = sql<string>`json_extract(${runEvents.payload}, '$.model')`;

export function aggregateAiActivity(db: Db, filter: AiActivityFilter): AiActivityAggregate {
  const eventConditions = (type: string) => {
    const conditions = [eq(runEvents.type, type), gte(runEvents.ts, filter.sinceMs)];
    if (filter.ownerId !== undefined) conditions.push(eq(runs.ownerId, filter.ownerId));
    return conditions;
  };

  /*
   * ONE read transaction, for the same reason `aggregatePipelineCost` uses one:
   * the three reads then observe a single consistent SQLite snapshot, so a
   * metered event appended between them cannot make the model table, the
   * agent-CLI counts and the run counts describe different instants. Read-only,
   * so there is nothing to roll back — the transaction is purely for snapshot
   * isolation.
   */
  return db.transaction((tx): AiActivityAggregate => {
    // (A) Billed exchanges, grouped by connection kind + model.
    const modelRows = tx
      .select({
        provider: meteredProvider,
        model: meteredModel,
        lastAt: sql<number>`max(${runEvents.ts})`,
        ...meteredAggregateColumns(),
      })
      .from(runEvents)
      .innerJoin(runs, eq(runEvents.runId, runs.id))
      .where(and(...eventConditions('activity.metered')))
      .groupBy(meteredProvider, meteredModel)
      .all();

    const models: AiModelActivity[] = modelRows.map((row) => {
      const { provider, model, lastAt, ...aggregates } = row;
      return { provider, model, lastAt, cost: runCostFromAggregates(aggregates) };
    });

    /*
     * A TOTAL order, so the table does not reshuffle between two polls of
     * identical data: spend descending, then provider, then model. The
     * (provider, model) tail is unique per group, which is what makes it total —
     * ordering on cost alone would leave ties arbitrary. Sorted HERE rather than
     * in SQL because the sort key is the DERIVED `RunCost`, not a selected
     * column; sorting on the raw sum would order by a different number than the
     * one rendered.
     */
    models.sort(
      (a, b) =>
        b.cost.totalCostEstimate - a.cost.totalCostEstimate ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );

    /*
     * Totals are SUMMED FROM THE GROUPS rather than read by a second ungrouped
     * query. The groups partition the same row set, so the arithmetic is exact —
     * and it makes "the total equals the table" true by construction rather than
     * by two queries being trusted to share a predicate. It also keeps the
     * derivation single: the summed aggregates go through the same
     * `runCostFromAggregates`, so `complete` stays honest (one genuine gap
     * anywhere makes the whole window a lower bound).
     */
    const summed = modelRows.reduce<MeteredAggregates>(
      (acc, row) => ({
        responseCount: acc.responseCount + row.responseCount,
        pricedResponseCount: acc.pricedResponseCount + row.pricedResponseCount,
        unpricedResponseCount: acc.unpricedResponseCount + row.unpricedResponseCount,
        totalCostEstimate: acc.totalCostEstimate + row.totalCostEstimate,
        inputTokens: acc.inputTokens + row.inputTokens,
        outputTokens: acc.outputTokens + row.outputTokens,
        inputReportedResponseCount: acc.inputReportedResponseCount + row.inputReportedResponseCount,
        outputReportedResponseCount:
          acc.outputReportedResponseCount + row.outputReportedResponseCount,
      }),
      { ...EMPTY_METERED_AGGREGATES },
    );

    // (B) Agent-CLI subprocesses — the untokened half of "connected AI" use.
    // `completed` is the event's own meaning (the child exited on its own, ANY
    // code), NOT success; the rest of the partition is a failure to complete.
    const agentRow = tx
      .select({
        invocations: count(),
        completed: sql<number>`coalesce(sum(case when json_extract(${runEvents.payload}, '$.summary') = 'completed' then 1 else 0 end), 0)`,
        // `max()` of no rows is NULL, which is exactly the "there were none"
        // signal — surfaced as `null` rather than coalesced to 0, because epoch
        // zero is a real instant and would read as "last used in 1970".
        lastAt: sql<number | null>`max(${runEvents.ts})`,
      })
      .from(runEvents)
      .innerJoin(runs, eq(runEvents.runId, runs.id))
      .where(and(...eventConditions('activity.agentTelemetry')))
      .get();

    const invocations = agentRow?.invocations ?? 0;
    const completed = agentRow?.completed ?? 0;
    const agentCli: AgentCliActivity = {
      invocations,
      completed,
      notCompleted: invocations - completed,
      lastAt: agentRow?.lastAt ?? null,
    };

    // (C) How many runs are in each non-terminal status RIGHT NOW. Not windowed:
    // "is anything executing" is a question about the present, not the window.
    const runConditions = [inArray(runs.status, [...LIVE_RUN_STATUSES])];
    if (filter.ownerId !== undefined) runConditions.push(eq(runs.ownerId, filter.ownerId));
    const statusRows = tx
      .select({ status: runs.status, n: count() })
      .from(runs)
      .where(and(...runConditions))
      .groupBy(runs.status)
      .all();

    // Every live status is reported, including the ones with no rows: a real 0
    // is a fact ("none are queued"), where an absent key would make the UI infer
    // one. Seeded from `LIVE_RUN_STATUSES` so a newly-added status cannot be
    // silently dropped from the surface.
    const runCounts = Object.fromEntries(
      LIVE_RUN_STATUSES.map((status) => [status, 0]),
    ) as LiveRunCounts;
    for (const row of statusRows) {
      if (row.status in runCounts) runCounts[row.status as keyof LiveRunCounts] = row.n;
    }

    // (D) #967 — the SAME billed exchanges as (A), partitioned by TIME.
    const bucketRows = tx
      .select({
        bucketStart: bucketStartExpr(filter.bucketMs, lastBucketStart(filter)),
        ...meteredAggregateColumns(),
      })
      .from(runEvents)
      .innerJoin(runs, eq(runEvents.runId, runs.id))
      .where(and(...eventConditions('activity.metered')))
      .groupBy(bucketStartExpr(filter.bucketMs, lastBucketStart(filter)))
      .all();

    // (E) #988 — activity REPORTED BY agents studio did not launch. Read from
    // the SAME transaction as (A)-(D) so the reported section and studio's own
    // figures describe one instant, and summed into NONE of them: see
    // `ExternalAgentActivitySchema` for why reported tokens are not studio spend.
    const external = aggregateExternalAgentActivity(tx, {
      sinceMs: filter.sinceMs,
      nowMs: filter.nowMs,
      ownerId: filter.ownerId,
    });

    return {
      models,
      agentCli,
      external,
      totals: runCostFromAggregates(summed),
      runs: runCounts,
      series: buildSeries(bucketRows, filter),
    };
  });
}

/**
 * The bucket a `run_events.ts` falls in, as an epoch-millisecond multiple of
 * `bucketMs`, CLAMPED to `lastBucketStart`.
 *
 * THE CLAMP IS WHAT MAKES THE QUERY BOUNDED, and it has to live HERE rather than
 * in `buildSeries` for a reason the fold cannot cover. `run_events.ts` has no
 * upper bound — clock skew or a fixture can date an event after `nowMs` — and
 * grouping by the raw bucket therefore yields one row per distinct future
 * bucket: a single row dated a year out returns ~105,000 rows on the `1h`
 * window, every one of them materialised by `.all()` before any JS runs. Folding
 * them afterwards bounds the SERIES but not the FETCH, which is the half that
 * costs memory. Clamping inside the GROUP BY makes SQLite do the fold, so the
 * result set is `maxBucketCount` rows REGARDLESS of the data.
 *
 * It is a clamp and not a `ts <= nowMs` filter because the row must still be
 * COUNTED: query (A) has no upper bound either, so dropping future-dated rows
 * here would break `sum(series.buckets[].cost) === totals` and the bars would
 * visibly fail to add up to the "Tokens" figure beside them. Clamping keeps both
 * properties — the row lands in the latest bucket we can defend, and the series
 * still cannot exceed its bound.
 *
 * THE `cast(… as integer)` IS LOAD-BEARING, and its absence is silent. SQLite's
 * `/` is integer division only when BOTH operands are INTEGERs — but `bucketMs`
 * arrives as a bound parameter, and better-sqlite3 binds every JS number as
 * REAL. So the natural-looking `ts / bucketMs` divides in floating point and
 * yields a distinct value per event: the GROUP BY then produces one group per
 * ROW, quietly turning this bounded query into an O(events) load and the series
 * into noise. The cast forces the truncation the grouping depends on.
 *
 * `floor()` would read better and is deliberately not used: SQLite's math
 * functions are a compile-time option (`SQLITE_ENABLE_MATH_FUNCTIONS`), and this
 * repo does not bet on those.
 *
 * Built by a FUNCTION called at both use sites rather than stored in a const,
 * for the same reason `meteredProvider`/`meteredModel` are bound once: the
 * SELECT and the GROUP BY must be the identical expression, and the only way to
 * guarantee that is to have one definition of it.
 */
function bucketStartExpr(bucketMs: number, lastBucketStart: number) {
  // `min(X, Y)` with TWO arguments is SQLite's scalar min, not the aggregate —
  // the aggregate is the one-argument form, and using it here would collapse the
  // whole result to a single row.
  return sql<number>`min((cast(${runEvents.ts} / ${bucketMs} as integer)) * ${bucketMs}, ${lastBucketStart})`;
}

/** The bucket containing `nowMs` — the last one the series can legitimately hold. */
function lastBucketStart(filter: AiActivityFilter): number {
  return Math.floor(filter.nowMs / filter.bucketMs) * filter.bucketMs;
}

type BucketRow = MeteredAggregates & { bucketStart: number };

/**
 * Zero-fills the sparse `GROUP BY` result into a contiguous, oldest-first series.
 *
 * THE FILL RANGE IS WHAT KEEPS THE CHART AND THE TILE ABOVE IT HONEST. It starts
 * at the aligned bucket CONTAINING `sinceMs` — not at the first aligned bucket
 * at-or-after it. Those differ by up to one whole bucket (a day, on the `30d`
 * window), and taking the later one would drop every event in that gap from the
 * chart while query (A) still counted it in `totals`, so the bars would visibly
 * fail to add up to the "Tokens" figure beside them. Including it costs nothing
 * and misrepresents nothing, because the query's own `ts >= sinceMs` predicate
 * means the bucket holds only in-window events — which is exactly what `partial`
 * then declares.
 *
 * IT ENDS AT THE BUCKET CONTAINING `nowMs`, WHICH IS ALSO THE LAST BUCKET THE
 * QUERY CAN RETURN. `run_events.ts` is not bounded above by anything — clock
 * skew or a fixture can date an event after `nowMs` — and an earlier draft
 * simply widened the range to cover whatever came back, to keep
 * `sum(buckets) === totals` true unconditionally. That bought the invariant at
 * the price of the bound: ONE row dated a year out turns a 13-bucket `1h`
 * window into ~105,000 buckets, every one of which the chart then renders as a
 * list item. `bucketStartExpr`'s clamp keeps BOTH properties — the row is still
 * counted, so the bars still add up to the tile above them, and neither the
 * series nor the fetch behind it can exceed `maxBucketCount`. This function
 * therefore only has to fill the range; it does no clamping of its own.
 *
 * Folding is also the more honest of the two readings: the series is a picture
 * of the window the caller asked for, and an event stamped in the future did not
 * happen in a future the operator can be shown. Attributing it to the most
 * recent bucket says "this is in your window, at the latest instant we can
 * defend", where a bucket drawn beyond `nowMs` would assert a period that has
 * not happened yet.
 */
function buildSeries(rows: BucketRow[], filter: AiActivityFilter): TokenSeries {
  const { bucketMs, sinceMs, nowMs } = filter;
  const alignDown = (ms: number) => Math.floor(ms / bucketMs) * bucketMs;

  const first = alignDown(sinceMs);
  const last = alignDown(nowMs);

  /*
   * A plain index, because the rows arrive ALREADY clamped and already merged:
   * `bucketStartExpr` does the clamping inside the GROUP BY, so SQLite folds a
   * future-dated row into `last` before the row set is materialised. Re-clamping
   * here would be a second authority for the same rule, and — worse — it would
   * make the bound look enforced while the unbounded fetch it exists to prevent
   * had already happened.
   */
  const byStart = new Map<number, BucketRow>(rows.map((row) => [row.bucketStart, row]));

  const buckets = [];
  for (let start = first; start <= last; start += bucketMs) {
    const row = byStart.get(start);
    const fullEnd = start + bucketMs;
    // Clamped at BOTH ends, so a bucket reports the span it was actually
    // collected over. The trailing bucket is the one that matters visually — an
    // in-progress period drawn at full width reads as a collapse in AI use
    // rather than as a period that has only just begun.
    const bucketEnd = Math.min(fullEnd, nowMs);
    buckets.push({
      bucketStart: start,
      bucketEnd,
      partial: start < sinceMs || fullEnd > nowMs,
      cost: runCostFromAggregates(row ?? EMPTY_METERED_AGGREGATES),
    });
  }

  return { bucketMs, buckets };
}

/*
 * `mergeRows` used to live here, adding two bucket rows together after the JS
 * fold clamped them onto the same bucket. It is gone because SQLite now does the
 * clamping inside the GROUP BY, so the rows arrive already summed by the same
 * `sum()`/`count()` expressions that build every other bucket — one aggregation
 * path instead of two that had to agree.
 */

const EMPTY_METERED_AGGREGATES: MeteredAggregates = {
  responseCount: 0,
  pricedResponseCount: 0,
  unpricedResponseCount: 0,
  totalCostEstimate: 0,
  inputTokens: 0,
  outputTokens: 0,
  inputReportedResponseCount: 0,
  outputReportedResponseCount: 0,
};
