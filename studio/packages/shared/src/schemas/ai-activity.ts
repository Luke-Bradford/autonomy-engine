import { z } from 'zod';
import { RunCostSchema } from '../pricing/run-cost.js';
import { RUN_SINCE_MS, RunSinceSchema, type RunSince } from './run.js';

/**
 * #917 — the CROSS-RUN view of what the operator's connected AIs have been
 * doing. Every other cost surface in the app is scoped to one run
 * (`GET /api/runs/:id/cost`) or one pipeline (`GET /api/pipelines/:id/cost`);
 * this is the first that answers "across EVERYTHING, what is my AI use right
 * now", which is the question the old prototype dashboard was still being kept
 * alive to answer.
 *
 * WHY THIS IS EVENT-SHAPED, NOT RUN-SHAPED. The obvious cheap implementation is
 * a list of unfinished runs, and it is wrong twice over. `LIVE_RUN_STATUSES`
 * includes `queued` (not started) and `waiting` (parked on an external wait,
 * having RELEASED its concurrency slot — it can sit there for days), so a
 * run-shaped panel reports "active" for runs where nothing whatsoever is
 * executing. And a run is not an AI: a pipeline of `fs`/`http` nodes drives no
 * model at all, so run liveness is not evidence of LLM use in either direction.
 * The `activity.metered` / `activity.agentTelemetry` log IS the record of AI
 * use, so that is what this reads.
 */

/**
 * One (provider, model) pair's billed exchanges inside the window.
 *
 * `provider` is the CONNECTION KIND (`anthropic_api`, `openai_api`, …) — see
 * `activity.metered`'s own field doc. That is what makes this grouping answer
 * the ticket's "across every connection": connection kind + model is the finest
 * granularity the metered event actually carries. It deliberately does NOT
 * carry a `connectionId`, so this cannot and does not claim to break spend down
 * per individual connection row.
 */
export const AiModelActivitySchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    /** `run_events.ts` of the most recent billed exchange in this group, epoch MILLISECONDS. */
    lastAt: z.number().int(),
    /**
     * Tokens + cost + the completeness flags for this group.
     *
     * `RunCost` is reused rather than a parallel shape being minted, even though
     * this group is not a run: the type is really "what a set of
     * `activity.metered` rows adds up to", and it is produced HERE by the same
     * `runCostFromAggregates` the per-run and per-pipeline aggregates use. A
     * second shape would be a second fail-closed cost derivation, which is the
     * one thing the money model refuses to have.
     */
    cost: RunCostSchema,
  })
  .strict();

export type AiModelActivity = z.infer<typeof AiModelActivitySchema>;

/**
 * Agent-CLI subprocess use in the window (`activity.agentTelemetry`).
 *
 * Counted SEPARATELY from `models` rather than folded in, because a CLI
 * subprocess is not token-metered: it emits no `inputTokens`/`outputTokens` and
 * no `costEstimate` (its spend lands on the account's subscription, which is
 * what the quota panel next to it reads). Adding it to the token table would
 * mean printing zeros for real work — the fail-open shape this codebase refuses.
 *
 * `completed` carries `activity.agentTelemetry`'s OWN meaning: the child exited
 * on its own, with ANY exit code. It is NOT "succeeded" — a non-zero exit is
 * data the pipeline branches on. `notCompleted` is the rest of the partition
 * (`timedOut`/`aborted`/`killed`/`signalled`/`spawnFailed`), i.e. failures to
 * complete at all.
 */
export const AgentCliActivitySchema = z
  .object({
    invocations: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    notCompleted: z.number().int().nonnegative(),
    /** Epoch MILLISECONDS of the most recent invocation; `null` when there were none. */
    lastAt: z.number().int().nullable(),
  })
  .strict();

export type AgentCliActivity = z.infer<typeof AgentCliActivitySchema>;

/**
 * How many runs are in each NON-TERMINAL status right now.
 *
 * Broken out per status rather than summed into one "live" number precisely
 * because they mean different things (see the header): `running` is the only one
 * where work is actually executing, and the UI must not present the other three
 * as if they were. This is a point-in-time count, NOT windowed — "right now" is
 * the question it answers.
 */
export const LiveRunCountsSchema = z
  .object({
    pending: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
  })
  .strict();

export type LiveRunCounts = z.infer<typeof LiveRunCountsSchema>;

/**
 * #967 — how wide one bucket of the token-flow series is, per window.
 *
 * Exhaustive `Record<RunSince, number>` for the reason `RUN_SINCE_MS` itself is
 * one: a new member of `RUN_SINCE_WINDOWS` fails typecheck HERE rather than
 * resolving to `undefined` and dividing by it. It lives beside the window
 * vocabulary in `shared` — not server-side — because the web needs the same
 * number to label the axis, and two spellings of it could disagree.
 *
 * The sizes are chosen so every window yields a similar, small number of bars
 * (12/24/28/30 whole buckets). That is a RENDERING bound as much as a query
 * one: past ~30 bars a bucket is thinner than the 2px gap between them.
 */
export const AI_ACTIVITY_BUCKET_MS: Record<RunSince, number> = {
  '1h': 5 * 60_000,
  '24h': 60 * 60_000,
  '7d': 6 * 60 * 60_000,
  '30d': 24 * 60 * 60_000,
};

/**
 * The most buckets a window can produce — `windowMs / bucketMs`, PLUS ONE.
 *
 * The `+ 1` is not slack. Buckets are aligned to absolute epoch multiples (see
 * `TokenSeriesBucketSchema`), and a window's two ends are arbitrary instants, so
 * the range almost always straddles one extra boundary: a `24h` window opened at
 * 09:30 covers part of the 09:00 bucket and part of the 09:00-next-day one, i.e.
 * 25 buckets, not 24. Derived rather than written out per window so it cannot
 * drift from `AI_ACTIVITY_BUCKET_MS`.
 */
export function maxBucketCount(since: RunSince): number {
  return RUN_SINCE_MS[since] / AI_ACTIVITY_BUCKET_MS[since] + 1;
}

/**
 * One time bucket of the token-flow series.
 *
 * ALIGNED TO ABSOLUTE EPOCH MULTIPLES of `bucketMs`, not to the window's start.
 * Window-relative buckets would slide by the poll interval on every refresh, so
 * two polls of identical data would render differently — the same reshuffling
 * the model table's total ordering exists to prevent. The cost is that the
 * boundaries are UTC, which is why nothing here or in the UI may label a bucket
 * as a calendar day or clock hour: `RUN_SINCE_MS`'s own docblock already settles
 * that the axis means "how far back", not "which day".
 *
 * WHY TOKEN PRESENCE IS COUNTED SEPARATELY FROM THE TOKENS. `RunCost` makes the
 * COST side honest (`costUnknownResponseCount`, `complete`) but says nothing
 * about the token side, because `inputTokens`/`outputTokens` are `.optional()`
 * on `activity.metered` — a provider may omit `usage` entirely, and
 * `cliSpendFact()` mints a metered event with no token fields at all. The SQL
 * sums them with `coalesce(sum(...), 0)`, so "nobody counted" and "genuinely
 * zero" arrive identically as `0`. On a table that is survivable; on a chart it
 * is the plotted-zero failure the ticket names — a bucket of real, unmeasured
 * agent-CLI work would draw as a confident zero-height bar. These two counters
 * are what let the UI draw "unmeasured" instead, and they are the SQL twin of
 * the counters `accumulateMetered` already keeps on the event-walk path.
 *
 * They are deliberately NOT added to `meteredAggregateColumns()`, which would
 * give the per-run and per-pipeline cost surfaces the same honesty: that widens
 * `RunCost`'s wire shape and every surface reading it, which is a bigger change
 * than #967. Filed as a follow-up instead.
 */
export const TokenSeriesBucketSchema = z
  .object({
    /** Inclusive lower bound, epoch MILLISECONDS. A multiple of `bucketMs`. */
    bucketStart: z.number().int(),
    /**
     * Exclusive upper bound, epoch MILLISECONDS, CLAMPED to the window.
     *
     * So the first and last buckets report the span they actually cover rather
     * than a full `bucketMs` the data was never collected over. A renderer that
     * sized bars by `bucketMs` would draw the in-progress final bucket at full
     * width and make every poll look like a cliff.
     */
    bucketEnd: z.number().int(),
    /**
     * Whether this bucket covers less than its full `bucketMs`.
     *
     * True for the leading bucket (clipped by the window's start) and the
     * trailing one (still in progress). Carried as DATA rather than re-derived
     * in the UI, so the "this period is not over" reading is the server's single
     * answer — the same reason an open attempt span contributes its start and
     * not an assumed end rather than being guessed at render time.
     */
    partial: z.boolean(),
    /**
     * The bucket's totals, derived by the SAME `runCostFromAggregates` every
     * other cost surface uses. A second shape here would be a second fail-closed
     * cost derivation, which is the one thing the money model refuses to have.
     */
    cost: RunCostSchema,
    /** Billed exchanges in this bucket that actually REPORTED an input count. */
    inputReportedResponseCount: z.number().int().nonnegative(),
    /** Billed exchanges in this bucket that actually REPORTED an output count. */
    outputReportedResponseCount: z.number().int().nonnegative(),
  })
  .strict();

export type TokenSeriesBucket = z.infer<typeof TokenSeriesBucketSchema>;

/**
 * The token-flow-over-time series (#967) — the half of the Tokens panel that
 * answers "how did it move", where the model table answers "where did it go".
 */
export const TokenSeriesSchema = z
  .object({
    /** Bucket width for the requested window, from `AI_ACTIVITY_BUCKET_MS`. */
    bucketMs: z.number().int().positive(),
    /**
     * Oldest first, CONTIGUOUS and zero-filled — a bucket in which nothing was
     * billed is present with zeroes rather than absent.
     *
     * That is honest here in a way a zero COST would not be: the query counts
     * events, and "no billed exchange occurred in these five minutes" is a
     * measured fact, not an unmeasured one. Absent buckets would instead make a
     * renderer infer the gap's width from its neighbours.
     */
    buckets: z.array(TokenSeriesBucketSchema),
  })
  .strict();

export type TokenSeries = z.infer<typeof TokenSeriesSchema>;

/**
 * The `GET /api/monitor/ai-activity` response body.
 *
 * IN-FLIGHT RUNS ARE INCLUDED, and that falls out of the design rather than
 * needing special handling: `activity.metered` is appended to the durable log
 * when an exchange is billed, so a run still executing has already contributed
 * every exchange it has paid for. The figures are therefore "so far" for live
 * runs in exactly the sense the run list's cost column already declares.
 */
export const AiActivitySnapshotSchema = z
  .object({
    /** When the SERVER built this response, epoch MILLISECONDS. */
    generatedAt: z.number().int(),
    /** The relative window requested, resolved server-side (`RUN_SINCE_MS`). */
    since: RunSinceSchema,
    /** The resolved lower bound of the window, epoch MILLISECONDS. */
    windowStart: z.number().int(),
    runs: LiveRunCountsSchema,
    /** Newest-spend-first, total order (cost desc, then provider, then model). */
    models: z.array(AiModelActivitySchema),
    /**
     * #967 — the same billed exchanges as `models`, partitioned by TIME instead
     * of by (provider, model). Both partition the identical row set, so
     * `sum(series.buckets[].cost.inputTokens) === totals.inputTokens` holds by
     * construction, and a repo test pins it.
     *
     * REQUIRED, not optional: an optional series would let the panel render
     * nothing at all and look like a window with no activity.
     */
    series: TokenSeriesSchema,
    agentCli: AgentCliActivitySchema,
    /**
     * The window's totals across every group in `models`.
     *
     * Derived by SUMMING the same per-group aggregates rather than by a second
     * SQL pass, so the table and its total literally cannot disagree — and the
     * `complete` flag stays honest: one unpriced-and-unknown exchange anywhere
     * makes the total a lower bound, exactly as it does per run.
     */
    totals: RunCostSchema,
  })
  .strict();

export type AiActivitySnapshot = z.infer<typeof AiActivitySnapshotSchema>;
