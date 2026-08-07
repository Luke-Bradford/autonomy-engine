import { z } from 'zod';
import { RunCostSchema } from '../pricing/run-cost.js';
import { RunSinceSchema } from './run.js';

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
