import { z } from 'zod';
import { RunCostSchema } from '../pricing/run-cost.js';
import { TriggerContextSchema } from './trigger-context.js';

export const RunStatusSchema = z.enum([
  'pending',
  // #5 S6a — a fire held in the durable admission QUEUE: a run row exists (so the
  // queue survives a restart, unlike the old in-memory launcher FIFO) but no
  // event log and no drive yet. Like `pending`, it is a PRE-`run.started` ROW
  // status — never event-projected (absent from the engine's
  // `RunLifecycleStatusSchema`) — and, like `pending` counting a slot, it must
  // stay OUT of `ACTIVE_RUN_STATUSES`: pre-admission ≠ occupying a slot. On
  // admission the launcher re-stamps `startedAt`, flips it to `pending`, and
  // drives it. (`run.queued`/`run.admitted` as durable EVENTS belong to the
  // trigger/observability read-model — #overview 11 — which does not exist yet;
  // deferred there, not dropped, exactly as S5a deferred `trigger.fireSuppressed`.)
  'queued',
  'running',
  'success',
  'failure',
  'skipped',
  'waiting',
  'interrupted',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * The ROW statuses at which a run has stopped advancing — the `RunStatus` twin of
 * the engine's `TERMINAL_RUN_STATUS`, which answers the same question about the
 * narrower `RunLifecycleStatus`.
 *
 * It exists (#930) because the two enums are NOT the same set and the difference
 * is silent: `RunStatus` carries `queued` and `skipped`, which
 * `RunLifecycleStatusSchema` deliberately does not. A surface holding a row status
 * and asking `TERMINAL_RUN_STATUS.has(...)` therefore needs a cast, and the cast
 * hides the answer rather than giving one — `skipped` is terminal (the run never
 * ran and never will) and `queued` is not (it has not started yet), and a cast
 * silently classifies both as terminal by dint of not being in the non-terminal
 * three.
 *
 * Built the same way as its twin: by NAMING the non-terminal statuses and taking
 * the rest, so adding a status to `RunStatusSchema` forces a deliberate decision
 * here instead of defaulting to terminal by omission.
 */
export const TERMINAL_RUN_ROW_STATUS: ReadonlySet<RunStatus> = new Set<RunStatus>(
  RunStatusSchema.options.filter(
    (status) =>
      status !== 'pending' && status !== 'queued' && status !== 'running' && status !== 'waiting',
  ),
);

/**
 * One execution of a specific, immutable `PipelineVersion`. `leaseUntil` is the
 * execution LEASE: #5 S4 has a `running` run HOLD it (`now + LEASE_TTL_MS`,
 * projected from status by `syncRunLifecycle`) and a parked/terminal run RELEASE
 * it (`null`), splitting "held by a live drive" from the lifecycle status.
 * #5 S7's lease service (`server/scheduler/lease.ts`) is the live consumer:
 * its heartbeat sweep RENEWS `leaseUntil` + stamps `heartbeatAt` (live-drive
 * evidence — written nowhere else) while a drive is live, and its `run_lease`
 * alarm reclaims a run whose lease expired unrenewed. The boot reconciler
 * still scans by `status`, not lease. Both are epoch-ms, nullable.
 */
export const RunSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1).nullable(),
  pipelineVersionId: z.string().min(1),
  triggerId: z.string().min(1).nullable(),
  parentRunId: z.string().min(1).nullable(),
  params: z.record(z.string(), z.unknown()),
  status: RunStatusSchema,
  leaseUntil: z.number().int().nullable(),
  heartbeatAt: z.number().int().nullable(),
  /**
   * #5 S6a — when this fire entered the durable admission QUEUE (epoch-ms), the
   * FIFO ordering key the launcher drains oldest-first. `null` for every run that
   * was never queued (an immediate start, or a legacy row). Set once at enqueue
   * and never rewritten — admission re-stamps `startedAt`, not this — so it stays
   * a faithful record of when the fire was admitted-to-the-queue for observability.
   */
  queuedAt: z.number().int().nullable(),
  /**
   * #5 S6a — the fire-time trigger context (#5 S12) a durably `queued` run must
   * carry so a delayed admission still seeds `${trigger.scheduledTime}` with the
   * occurrence that fired it, not whenever the slot happened to free. `null` for
   * an immediately-started run (its context is folded straight into the event log
   * by `startRun`) and for a run with no trigger. Immutable, like `params`: set
   * at enqueue, read once at admission, never patched.
   */
  triggerContext: TriggerContextSchema.nullable(),
  /**
   * RS6 — the durable ROW projection of `run.started.rerunOf`: the SOURCE run's
   * id when THIS run is a rerun-from-failed of it, `null` for an original run.
   * The reseed producer sets it in the SAME transaction that appends
   * `run.started{rerunOf}` + `run.reseeded` (RS2), so the row lineage and the
   * event-log lineage can never disagree. Immutable like `parentRunId`/`params`
   * (absent from `RunLifecyclePatchSchema` — cannot be patched), so provenance
   * is not rewritable. DISTINCT from `parentRunId` (call_pipeline child→parent);
   * this is source-run→rerun. Backs the rerun-history grouping query
   * (`ListRunsFilter.rerunOf`) so "reruns of R1" is answered by an indexed
   * column, not by folding every run's log. The Original/Rerun/
   * Rerun-from-failed run-type label is a later (UI) slice that consumes this
   * column; only the projection lands here.
   *
   * The Monitor's copied-vs-executed RENDER shipped with #918 and does NOT read
   * this column, deliberately: it is folded from the `run.reseeded` event, which
   * names its own `sourceRunId` and is present whenever the log renders — while
   * this column arrives on a separate REST read that can be absent exactly when
   * the doc-free fold is the only thing left standing. The two are written in
   * one transaction, so they cannot disagree where both are present.
   *
   * NOTE the deliberate optional→nullable translation: the EVENT field is
   * `.optional()` (absent = a normal run), this PROJECTION is `.nullable()`
   * (`null` = a normal run) — the same RS1 convention as the reducer fold.
   */
  rerunOf: z.string().min(1).nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
});
export type Run = z.infer<typeof RunSchema>;

/**
 * R2 — a run PLUS the human names the Monitor's list needs, resolved server-side
 * in one query so U10 needn't N+1.
 *
 * A `Run` row carries only opaque foreign keys: `pipelineVersionId` identifies
 * the immutable version, and the pipeline's NAME lives two joins away
 * (`runs ⋈ pipeline_versions ⋈ pipelines`). The runs list rendered that raw
 * `pv_…` id as its only identity column, so an operator with more than one
 * pipeline could not tell their runs apart without opening each one.
 *
 * Strictly ADDITIVE over `RunSchema`, which is what makes the
 * `GET /api/runs` response-shape change safe: every existing reader parsing a
 * summary through `RunSchema` still succeeds (zod strips the extra keys).
 *
 * `triggerName` is NULLABLE and the join behind it must be a LEFT join. Two
 * REAL, reachable cases have no trigger: a rerun deliberately sets
 * `triggerId = null` (`run/reseed.ts` — "a rerun is an explicit operator
 * action"), and `runs.trigger_id` is `onDelete: 'set null'`, so deleting a
 * trigger leaves its runs behind with no name to resolve. An INNER join here
 * would silently drop exactly those runs from the operator's own list. (A child
 * run will be a third such case once P3b lands the spawn seam — see #796 — but
 * nothing creates one today, so it is not offered as a reason.)
 *
 * DURATION is deliberately NOT a field. The spec lists it among what the list
 * shows, but `startedAt`/`finishedAt` already determine it, and a server-stamped
 * elapsed for a still-running run would be stale the instant it was serialized —
 * a second, immediately-wrong authority for a value the row already fixes. The
 * client derives it (`pages/runs/format.ts::formatRunDuration`).
 *
 * COST *is* a field (#931), and the rule above is why that needed answering
 * rather than assuming. It clears BOTH halves of the duration objection:
 *
 *  - Not a SECOND authority. Duration is derivable from `startedAt`/`finishedAt`,
 *    which this row already carries, so a `duration` field would be a second
 *    statement of a fact the row already fixes. Cost is not derivable from
 *    anything here — it lives in `run_events`, two reads away — so this is the
 *    row's FIRST statement of it, resolved server-side for the same reason R2
 *    resolves `pipelineName`/`triggerName`: "so U10 needn't N+1". Not by the same
 *    MEANS, though, and the difference is worth being exact about — those two are
 *    columns of the row SELECT's own join, whereas cost is a SECOND statement
 *    (`aggregateRunCosts`, its own `GROUP BY run_id`) joined to the rows in
 *    memory. What makes the pair coherent is that both run inside ONE
 *    `db.transaction`, so they read one SQLite snapshot — a transaction, not a
 *    query (`repo/runs.ts::listRunSummaries`).
 *  - Not IMMEDIATELY-WRONG. A live run's spend genuinely does move after
 *    serialization, exactly as an elapsed clock does. The difference is that a
 *    moving cost is still a TRUE statement of spend-so-far, where a frozen
 *    elapsed is simply wrong the next millisecond; and the list says which it is
 *    looking at — the cell marks a non-terminal run's figure as so-far
 *    (`TERMINAL_RUN_ROW_STATUS`, `pages/runs/costColumn.ts`). Without that
 *    marker this field WOULD be the thing the paragraph above forbids.
 *
 * A consequence worth stating: the list's cost and the run-detail page's cost are
 * read at different instants and by different means (this is a bounded SQL
 * aggregate; the detail page folds the live event tail). For a settled run they
 * agree by construction — one derivation site, pinned by an SQL-vs-fold
 * equivalence test. For a LIVE one they may differ by whatever was billed in
 * between, which is the same "so far" the marker already declares.
 */
export const RunSummarySchema = RunSchema.extend({
  /**
   * U29 (#1015) — the pipeline's IDENTITY, resolved server-side by the same join
   * that already resolves its name.
   *
   * `pipelineName` cannot stand in for it. `pipelines` is unique on
   * `(owner_id, resource_id)` and NOT on `(owner_id, name)`, so two distinct
   * pipelines may legitimately share a name; anything that groups or filters runs
   * by pipeline therefore has to key on this, or it silently merges them. Nor can
   * `pipelineVersionId` stand in — that splits ONE pipeline across its versions,
   * which is the opposite error.
   */
  pipelineId: z.string().min(1),
  pipelineName: z.string(),
  /** The version NUMBER (`pipeline_versions.version`), not its id — what an
   * operator reads as "v3". */
  pipelineVersion: z.number().int(),
  /** `null` for a rerun, or for a run whose trigger has been deleted. */
  triggerName: z.string().nullable(),
  /**
   * #931 — what this run has been billed, as a bounded per-run SQL aggregate
   * (`repo/run-events.ts::aggregateRunCosts`).
   *
   * NEVER nullable, and a run with no metered events carries a ZEROED cost rather
   * than an absent one: zero metered rows genuinely IS zero billed exchanges,
   * which `readCost` classifies `'none'` → "No billed exchange". A `null` would
   * assert "cost unknown", a different and false claim — and manufacturing the
   * wrong one of those two is the whole failure mode this money model is built
   * around.
   */
  cost: RunCostSchema,
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

/**
 * Insert shape: server sets `id` + `startedAt`; `leaseUntil`/`heartbeatAt`/
 * `finishedAt` start `null` (the executor sets them as the run progresses,
 * not at creation); `status` defaults to `'pending'`.
 */
export const NewRunSchema = RunSchema.omit({
  id: true,
  status: true,
  leaseUntil: true,
  heartbeatAt: true,
  queuedAt: true,
  triggerContext: true,
  rerunOf: true,
  startedAt: true,
  finishedAt: true,
}).extend({
  status: RunStatusSchema.default('pending'),
  // #5 S6a — both default `null`, so every existing `createRun` caller (an
  // immediate start) keeps compiling and passing nothing; only the launcher's
  // durable-queue path sets them (`status: 'queued'` + `queuedAt` + the frozen
  // fire-time `triggerContext`).
  queuedAt: z.number().int().nullable().default(null),
  triggerContext: TriggerContextSchema.nullable().default(null),
  // RS6 — defaults `null`, so every existing `createRun` caller keeps compiling
  // and passing nothing; only the rerun-from-failed producer sets it (RS2).
  rerunOf: z.string().min(1).nullable().default(null),
});
// z.input, not z.infer/z.output — see the note on NewConnection in
// connection.ts for why every insert type in this package uses it (here it
// matters concretely: `status` has `.default('pending')`, so z.input is what
// keeps it optional for callers of `createRun`).
export type NewRun = z.input<typeof NewRunSchema>;

/**
 * The ONLY shape `updateRun` accepts: the run-lifecycle fields the
 * executor/boot-reconciler mutate as a run progresses. Every immutable
 * binding field (`pipelineVersionId`, `triggerId`, `parentRunId`, `params`,
 * `startedAt`) is deliberately absent — `.strict()` means a patch carrying
 * any of them (or any other unrecognized key) is rejected by `.parse()`
 * rather than silently stripped, so `updateRun` cannot be used to rewrite a
 * run's immutable bindings/provenance even by an `as any`/`as never` cast
 * around the TS type.
 */
export const RunLifecyclePatchSchema = RunSchema.pick({
  status: true,
  leaseUntil: true,
  heartbeatAt: true,
  finishedAt: true,
})
  .partial()
  .strict();
export type RunLifecyclePatch = z.infer<typeof RunLifecyclePatchSchema>;

/**
 * Append-only event log entry — the source of truth for run/node state (the
 * monitoring feed is a live tail of this table; late-joiners replay from it).
 * `seq` is monotonic per `runId`, assigned by the repository layer, never by
 * the caller. `payload` is intentionally `unknown`-shaped here: the event
 * envelope is generic across every `type` the engine/executor emit
 * (`node.started`, `node.output`, `run.finished`, …), each with its own
 * payload shape defined where that event is produced, not in this shared
 * envelope schema.
 */
export const RunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  type: z.string().min(1),
  payload: z.unknown(),
  ts: z.number().int(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

/** Insert shape: server sets `id`, `seq` (monotonic per run), and `ts`. */
export const NewRunEventSchema = RunEventSchema.omit({
  id: true,
  seq: true,
  ts: true,
});
export type NewRunEvent = z.input<typeof NewRunEventSchema>;

/**
 * #497 — WHERE THE PURE REDUCER'S `diagnostics` LAND.
 *
 * `reduce(state, event) → { state, commands, diagnostics }`. The first two are
 * durable (`run_events` + the `runs` row); the third had no production consumer
 * at all, so the "and say so" half of #480/#487/#488/#491 was written to nowhere.
 * This is that sink.
 *
 * NOT an engine event, and that is the load-bearing decision. `run_events` is a
 * log of FACTS; a diagnostic is a DERIVATION of (immutable doc + log). Storing a
 * derivation as a fact would put it in `EngineEventSchema` — re-folding every
 * already-bound log (the #443 authority question) — and make replay double-count
 * it (the fold re-derives the diagnostic AND meets the stored one). So it gets
 * its own table, off the event log, read by nothing the engine gates on.
 *
 * `phase` DISCRIMINATES THE DERIVATION, and is not decoration: `resume()` folds
 * NO event, so it is keyed at the log position it was derived AT — which is the
 * same `seq` as the fold that preceded it. Without `phase` in the key those two
 * distinct derivations collide, and the insert's `OR IGNORE` splices them into
 * one mis-attributed list.
 * - `fold`   — derived by folding the event at `seq`.
 * - `resume` — derived by `resume()` over the projection as of `seq`.
 * - `cap`    — the truncation marker (see `RUN_DIAGNOSTIC_CAP`), at `seq: -1`.
 */
export const RUN_DIAGNOSTIC_PHASES = ['fold', 'resume', 'cap'] as const;
export const RunDiagnosticPhaseSchema = z.enum(RUN_DIAGNOSTIC_PHASES);
export type RunDiagnosticPhase = z.infer<typeof RunDiagnosticPhaseSchema>;

/**
 * The per-RUN ceiling on recorded diagnostics.
 *
 * Per-RUN rather than per-fold, which is the whole point: a per-fold cap bounds
 * nothing, because `MAX_DRIVER_STEPS` is 1_000_000 and the attacker-shaped
 * diagnostics repeat PER FOLD — e.g. `container capped at maxRounds` once per
 * container per round — on a doc that (being pre-#444) was never validated. A
 * per-fold cap of 50 would therefore
 * bound a single run at ~5e7 rows, which is not a bound in any sense an operator
 * would recognise.
 *
 * 500 is a judgement, not a derivation: comfortably above what any well-formed
 * run emits (a healthy run emits none at all — a diagnostic means something was
 * neutralized), while small enough that a malicious doc cannot fill a disk.
 *
 * The cap is enforced by a `count()` per diagnostic-bearing fold rather than by
 * cross-fold state on the recorder, which is deliberate: the recorder is
 * stateless (each call stands alone, so a re-boot re-deriving mid-run needs no
 * carried counter to stay correct), and the count is only ever paid on the
 * already-pathological path — a well-formed run emits no diagnostics and returns
 * before the query. A doomed run past the cap keeps paying one count + one no-op
 * marker insert per fold, which is bounded by `MAX_DRIVER_STEPS` and acceptable
 * for a run that is going to fail regardless.
 */
export const RUN_DIAGNOSTIC_CAP = 500;

/**
 * #1069 — the exact sentence `writeCapMarker` stores when a run hits
 * `RUN_DIAGNOSTIC_CAP`, in SHARED rather than server-local.
 *
 * It lives here, beside `RunDiagnosticSchema`, because BOTH sides need the
 * literal: the server writes it, and the web tests assert on it to pin how the
 * marker is rendered. It used to be a module-local const in the server package,
 * which the web package cannot import, so the web side kept a hand-copied
 * duplicate — and that copy drifted twice at once (a curly apostrophe for a
 * straight one, and the whole closing clause dropped).
 *
 * The closing clause is not decoration. "(see the diagnostics below)" is a CLAIM
 * ABOUT LAYOUT — it is true only while the marker is rendered ABOVE the list it
 * qualifies. A paraphrased copy silently deletes the one sentence that constrains
 * that, letting the test keep passing while the property it guards is gone. One
 * export, imported by both, is what makes that impossible rather than merely
 * discouraged.
 */
export const capMarkerMessage = (cap: number): string =>
  `diagnostics for this run reached the cap of ${cap} and later ones were NOT recorded. ` +
  `The run's decisions are unaffected and remain fully durable in its event log — what is ` +
  `capped here is the EXPLANATION of them. A run emitting this many diagnostics almost ` +
  `always means a malformed doc reached the reducer (see the diagnostics below).`;

export const RunDiagnosticSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  /**
   * The log position this was derived at. `-1` is the `cap` marker's sentinel —
   * deliberately BELOW every real `seq` (which start at 0), so the standard
   * `ORDER BY seq, ordinal` read surfaces "this list is incomplete" FIRST,
   * before the diagnostics it is a caveat on.
   */
  seq: z.number().int().gte(-1),
  phase: RunDiagnosticPhaseSchema,
  /** Index within the one `diagnostics[]` this row came from — ties the order. */
  ordinal: z.number().int().nonnegative(),
  message: z.string().min(1),
  ts: z.number().int(),
});
export type RunDiagnostic = z.infer<typeof RunDiagnosticSchema>;

/**
 * U26 — the Monitor filter pane's time axis, as a closed vocabulary of RELATIVE
 * windows rather than a pair of absolute epochs.
 *
 * Relative because the filter is URL-addressable: `?since=24h` still means "the
 * last day" when the link is opened tomorrow, where a baked-in `startedAfter`
 * epoch would quietly become "the day before yesterday". The epochs stay the
 * REPO layer's primitive (`ListRunsFilter.startedAfter`) — this is the wire and
 * UI vocabulary that resolves to one, and it resolves SERVER-side, so the window
 * is measured against the same clock that stamped `runs.started_at`. A client
 * computing its own lower bound would silently widen or narrow the window by
 * whatever its clock skew happens to be.
 *
 * Shared rather than declared twice: the route parses `?since=` through this
 * enum and the picker renders its options from the same array, so a member can
 * never exist on one side only.
 */
export const RUN_SINCE_WINDOWS = ['1h', '24h', '7d', '30d'] as const;
export const RunSinceSchema = z.enum(RUN_SINCE_WINDOWS);
export type RunSince = z.infer<typeof RunSinceSchema>;

/**
 * How far back each window reaches, in ms. Exhaustive by construction — a new
 * member of `RUN_SINCE_WINDOWS` fails typecheck here rather than resolving to
 * `undefined` and producing `NaN` as a lower bound (which SQLite would compare
 * as NULL and drop every row from, silently).
 *
 * `30d` is a fixed 30×24h, not a calendar month: the axis is "how far back",
 * and a window whose length depends on which month you ask in is not that.
 */
export const RUN_SINCE_MS: Record<RunSince, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};
