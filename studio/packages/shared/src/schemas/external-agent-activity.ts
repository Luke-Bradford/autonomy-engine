import { z } from 'zod';

/**
 * #988 — AI/agent activity REPORTED BY an agent studio did not launch.
 *
 * THE GAP THIS CLOSES. Every figure on `/monitor/ai` is derived from
 * `activity.metered` / `activity.agentTelemetry` rows in `run_events`, INNER
 * JOINed to `runs`. That join is not incidental — `run_events.run_id` is
 * `notNull` with a foreign key — so the surface can only ever describe AI use
 * that studio itself launched. The autonomy build loop's `claude -p` fires are
 * launched by `loop/drive.sh` outside studio, so the panel reported
 * `Runs executing 0 · Billed exchanges 0 · Tokens 0 in / 0 out` while the loop
 * was actively burning the operator's weekly subscription window. The zeros were
 * honest; the SCOPE was never stated.
 *
 * THE SHAPE IS INGEST, NOT SCRAPE. An external agent REPORTS IN through
 * `POST /api/monitor/external-activity`; studio does not reach out to inspect
 * processes it did not launch. That boundary is the reason this is a report
 * schema at all rather than a process reader: studio ships to other people, and
 * a product that enumerates the machine's processes is a different product.
 *
 * WHY THESE NUMBERS STAY OUT OF `totals`/`models`/`series`. `AgentCliActivity`
 * already documents the rule — folding non-token-metered CLI work into the token
 * table means "printing zeros for real work", the fail-open shape this codebase
 * refuses. Reported activity is a second instance of it and then some: a
 * subscription-billed fire's tokens are not spend billed to a studio connection,
 * so summing them into the money model would corrupt the one number the cost
 * surfaces exist to keep honest. Reported activity is rendered as its own
 * section, attributed to its reporter, and never added to studio's own figures.
 *
 * NO COST FIELD IS ACCEPTED, and that is a decision rather than an omission —
 * `loop/fire_stats.sh` parses a `total_cost_usd` out of every fire log, so the
 * figure is there for the taking. It is an API-EQUIVALENT estimate for work
 * billed to a subscription, i.e. money nobody was charged. Studio's cost
 * surfaces are fail-closed about what they can price; admitting a number that
 * corresponds to no invoice would make them confidently wrong instead. Reported
 * SPEND belongs to the quota panel next door, which reads the account.
 */

/**
 * How an invocation ENDED, using `activity.agentTelemetry`'s existing vocabulary
 * rather than a second one.
 *
 * `completed` carries that event's own meaning: the child exited on its own,
 * with ANY exit code — it is NOT "succeeded". `notCompleted` is the failure to
 * complete at all (killed, timed out, crashed). `unknown` is the third state a
 * REPORTER needs and an in-process telemetry event never did: the invocation is
 * still running, or the reporter cannot tell. Folding `unknown` into
 * `notCompleted` would report a fire that is running fine as one that failed.
 */
export const ExternalAgentOutcomeSchema = z.enum(['completed', 'notCompleted', 'unknown']);

export type ExternalAgentOutcome = z.infer<typeof ExternalAgentOutcomeSchema>;

/**
 * One side's token count, or `null` for "nobody counted".
 *
 * NULLABLE rather than defaulted to `0`, for the reason `TokenSeriesBucket`
 * spells out at length: a reporter that sends no usage and a reporter that
 * measured genuinely-zero usage must not arrive identically, or the UI draws a
 * confident zero over unmeasured work.
 */
const tokenCount = () => z.number().int().nonnegative().nullable();

/**
 * The `POST /api/monitor/external-activity` request body.
 *
 * IDEMPOTENT BY CONSTRUCTION on `(source, externalId)` — see the repo's upsert.
 * A reporter is expected to send an invocation when it STARTS (`endedAt: null`,
 * `outcome: 'unknown'`) and again when it finishes; both are the same row, so a
 * fire is never counted twice and an in-flight fire is visible while it runs.
 *
 * The `.default()`s here are not the manufactured-benign-value shape #473
 * forbids. That rule is about inventing a fact when READING stored data; these
 * default an absent request field to the "not known" value (`null` /
 * `'unknown'`), which is the honest reading of its absence, and the row records
 * exactly that.
 */
export const ExternalAgentReportSchema = z
  .object({
    /**
     * WHO is reporting, e.g. `studio-build-loop`. Free text: studio does not own
     * the vocabulary of systems that may report to it, and a closed enum here
     * would mean a new reporter needs a studio release.
     */
    source: z.string().min(1).max(64),
    /**
     * The reporter's OWN handle for this invocation — for the build loop, the
     * fire id. The idempotency key's other half, and deliberately the
     * REPORTER's id rather than one studio issues: a reporter that crashes
     * between its start and end reports must be able to name the same
     * invocation again without having kept studio's answer.
     */
    externalId: z.string().min(1).max(128),
    /** Which CLI ran, e.g. `claude` / `codex`. */
    agent: z.string().min(1).max(64),
    /** The model it ran on, when the reporter knows it. */
    model: z.string().min(1).max(128).nullable().default(null),
    /** Epoch MILLISECONDS, on the REPORTER's clock. */
    startedAt: z.number().int(),
    /** Epoch MILLISECONDS; `null` while the invocation is STILL RUNNING. */
    endedAt: z.number().int().nullable().default(null),
    outcome: ExternalAgentOutcomeSchema.default('unknown'),
    inputTokens: tokenCount().default(null),
    outputTokens: tokenCount().default(null),
    cacheReadTokens: tokenCount().default(null),
    cacheCreationTokens: tokenCount().default(null),
  })
  .strict()
  /*
   * An invocation cannot end before it started. Checked here rather than trusted
   * because both stamps come from a CALLER's clock: a transposed pair would make
   * a negative duration, and the aggregate's "still running" reading depends on
   * `endedAt` meaning what it says.
   */
  .refine((r) => r.endedAt === null || r.endedAt >= r.startedAt, {
    message: 'endedAt must not be earlier than startedAt',
    path: ['endedAt'],
  })
  /*
   * A SETTLED outcome with no end stamp is a contradiction, and refusing it is
   * what lets `endedAt === null` be the single, trustworthy in-flight signal. A
   * reporter that knows HOW an invocation ended necessarily knows THAT it ended;
   * accepting the pair would put a finished fire in the "running right now"
   * count forever, which is the reading this whole surface exists to give.
   */
  .refine((r) => r.outcome === 'unknown' || r.endedAt !== null, {
    message: 'a settled outcome requires endedAt',
    path: ['outcome'],
  });

export type ExternalAgentReport = z.infer<typeof ExternalAgentReportSchema>;

/**
 * A group's token sums, plus how many of its invocations reported ANY figure.
 *
 * `measuredInvocations` is what keeps a sum honest: four `null`s and four zeroes
 * both sum to zero, and only this count distinguishes "nothing was measured"
 * from "the measured answer was zero". It is the same job
 * `inputReportedResponseCount` does on the metered side.
 */
export const ExternalAgentTokensSchema = z
  .object({
    inputTokens: tokenCount(),
    outputTokens: tokenCount(),
    cacheReadTokens: tokenCount(),
    cacheCreationTokens: tokenCount(),
    /** Invocations in this group that reported at least one token figure. */
    measuredInvocations: z.number().int().nonnegative(),
  })
  .strict();

export type ExternalAgentTokens = z.infer<typeof ExternalAgentTokensSchema>;

/**
 * The counts every level of this surface reports, shared by the per-reporter
 * rows and the window total so the two cannot drift apart.
 *
 * `completed + notCompleted + unknown === invocations` — a total partition, so
 * an invocation can never be silently dropped from the reading. `inFlight` is
 * NOT a fourth member of it: it counts rows with no end stamp, which are a
 * SUBSET of `unknown`. It is reported separately because it is the number the
 * ticket is actually about — "is my build loop firing right now" — and deriving
 * it from `unknown` would conflate "still running" with "the reporter could not
 * tell how it went".
 */
const activityCounts = {
  invocations: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  notCompleted: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  inFlight: z.number().int().nonnegative(),
  /** Epoch MILLISECONDS of the most recent invocation START; `null` when none. */
  lastAt: z.number().int().nullable(),
} as const;

/**
 * One (source, agent, model) group inside the window.
 *
 * That grain mirrors the metered table's (provider, model): it is the finest
 * split the reported row actually carries, and it answers the two questions the
 * operator has — WHOSE agent this is, and what it is running on.
 */
export const ExternalReporterActivitySchema = z
  .object({
    source: z.string(),
    agent: z.string(),
    /** `null` when the reporter did not say — rendered as such, never guessed. */
    model: z.string().nullable(),
    ...activityCounts,
    tokens: ExternalAgentTokensSchema,
  })
  .strict();

export type ExternalReporterActivity = z.infer<typeof ExternalReporterActivitySchema>;

/**
 * The window's reported activity: the same rows partitioned two ways, exactly as
 * `models` and `totals` are on the metered side.
 *
 * Unlike the metered side, the counts here are NOT summed from `reporters`:
 * that list is CAPPED (see `truncated`), so summing it would make the headline
 * quietly under-report the moment a 51st reporter appeared. They are read
 * ungrouped over the same rows in the same snapshot, which is what lets the
 * breakdown be truncated without the reading becoming false.
 */
export const ExternalAgentActivitySchema = z
  .object({
    ...activityCounts,
    tokens: ExternalAgentTokensSchema,
    /**
     * Whether `reporters` is a PREFIX rather than the whole breakdown.
     *
     * `source`/`agent`/`model` are free text from a caller studio does not
     * control, so the group count is bounded by what reporters invent — and this
     * body is polled every few seconds. The table is therefore capped while the
     * counts above it are computed ungrouped, so a truncated breakdown never
     * makes the HEADLINE under-report. Carried as data rather than inferred from
     * `reporters.length`, which would make the UI re-derive the server's cap.
     */
    truncated: z.boolean(),
    /** Busiest first, total order (invocations desc, then source/agent/model). */
    reporters: z.array(ExternalReporterActivitySchema),
  })
  .strict();

export type ExternalAgentActivity = z.infer<typeof ExternalAgentActivitySchema>;

/** The `POST /api/monitor/external-activity` response. */
export const ExternalAgentReportAcceptedSchema = z
  .object({
    id: z.string(),
    /**
     * `false` when this report UPDATED an invocation already known under the
     * same `(source, externalId)`. Returned rather than swallowed so a reporter
     * can tell an accepted duplicate from a first sighting.
     */
    created: z.boolean(),
  })
  .strict();

export type ExternalAgentReportAccepted = z.infer<typeof ExternalAgentReportAcceptedSchema>;
