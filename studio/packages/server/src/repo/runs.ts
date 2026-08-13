import { and, asc, count, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { ZodError } from 'zod';
import {
  computeRunCost,
  NewRunSchema,
  RunLifecyclePatchSchema,
  RunSchema,
  RunSummarySchema,
  type NewRun,
  type Run,
  type RunSummary,
  type RunLifecyclePatch,
  type RunStatus,
} from '@autonomy-studio/shared';
import { pipelines, pipelineVersions, runs, triggers } from '../db/schema.js';
import { newId } from './ids.js';
import { aggregateRunCosts } from './run-events.js';
import type { Db } from './types.js';

/**
 * #796 (P3b) — `id` is a SEPARATE argument rather than a field on `NewRun`, and
 * deliberately so. A `call_pipeline` child's row id must be the reducer's
 * DETERMINISTIC `childRunId` (a pure hash of parent run + call node + attempt),
 * because that identity is the whole idempotency story: a crash-replay re-emits
 * the same `startChild`, and `getRun(childRunId)` is then the crash-safe
 * "already spawned?" test — no new column, no new index, no lookup key that
 * could disagree with the one the reducer checks on `call.returned`.
 *
 * Keeping it OFF `NewRunSchema` keeps the wire shape closed: that schema is a
 * parsed input type, so an optional `id` on it would make a caller-chosen run id
 * structurally acceptable the day anything parses a request body into a
 * `NewRun`. Only in-process callers holding a derived id can pass one here.
 */
export function createRun(db: Db, input: NewRun, id?: string): Run {
  const parsed = NewRunSchema.parse(input);
  const row: Run = {
    id: id ?? newId('run'),
    ...parsed,
    leaseUntil: null,
    heartbeatAt: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  db.insert(runs).values(row).run();
  return RunSchema.parse(row);
}

export function getRun(db: Db, id: string): Run | null {
  const row = db.select().from(runs).where(eq(runs.id, id)).get();
  return row ? RunSchema.parse(row) : null;
}

export interface ListRunsFilter {
  pipelineVersionId?: string;
  triggerId?: string;
  parentRunId?: string;
  /** RS6 — the rerun-history grouping scan: "reruns of R1" (backed by
   * `runs_rerun_of_idx`). Filtered in SQL, never loaded-then-filtered. */
  rerunOf?: string;
  /** Filters in SQL, like `listConnections`/`listPipelines` — never loaded
   * then filtered in the route. */
  ownerId?: string;
  /** The boot reconciler's "find all `running` rows" scan (backed by
   * `runs_status_idx`) — filtered in SQL, never loaded-then-filtered. */
  status?: RunStatus;
  /**
   * U26 — the Monitor filter pane's time axis, as an INCLUSIVE epoch-ms lower
   * bound on `started_at` (backed by `runs_started_at_idx`). Inclusive so a
   * window computed as `now - 1h` still contains a run stamped exactly an hour
   * ago, rather than dropping the boundary run on a millisecond.
   *
   * The epoch is the primitive; the WINDOW (`?since=24h`) is the wire/UI
   * vocabulary that resolves to one, and it resolves server-side
   * (`RUN_SINCE_MS`). There is deliberately no upper bound to pair with it —
   * nothing consumes one (the presets are all "the last N"), and a filter field
   * no caller sets is a field nobody maintains.
   *
   * STATED, not discovered later: `admitQueuedRun` RE-STAMPS `started_at` when a
   * durably-queued fire is admitted, so a `queued` run enters this window when
   * it is admitted rather than when it was enqueued. That is the same fact
   * `formatRunDuration` already refuses to measure a queued row against;
   * `queued_at` is the column that records the enqueue, and it is not this axis.
   */
  startedAfter?: number;
}

/**
 * `listRunSummaries` only. The PIPELINE axis needs the `runs ⋈ pipeline_versions`
 * hop that the summary read-model already makes — a run row carries only its
 * immutable `pipelineVersionId`, and pipeline identity lives on the version row.
 *
 * It is a SEPARATE interface rather than a field on `ListRunsFilter` for a
 * fail-closed reason: `listRuns` and `listParsedRuns` share `listRunsConditions`
 * and have no join, so a `pipelineId` there would be a narrowing they ACCEPT and
 * silently do not apply. A filter that ignores a constraint is the same shape as
 * a gate that fails open. The type system refuses it instead.
 */
export interface ListRunSummariesFilter extends ListRunsFilter {
  /** Every run of every version of this pipeline (`countActiveRunsForPipeline`'s
   * join, reused). */
  pipelineId?: string;
}

function listRunsConditions(filter: ListRunsFilter) {
  const conditions = [];
  if (filter.pipelineVersionId !== undefined) {
    conditions.push(eq(runs.pipelineVersionId, filter.pipelineVersionId));
  }
  if (filter.triggerId !== undefined) {
    conditions.push(eq(runs.triggerId, filter.triggerId));
  }
  if (filter.parentRunId !== undefined) {
    conditions.push(eq(runs.parentRunId, filter.parentRunId));
  }
  if (filter.rerunOf !== undefined) {
    conditions.push(eq(runs.rerunOf, filter.rerunOf));
  }
  if (filter.ownerId !== undefined) {
    conditions.push(eq(runs.ownerId, filter.ownerId));
  }
  if (filter.status !== undefined) {
    conditions.push(eq(runs.status, filter.status));
  }
  if (filter.startedAfter !== undefined) {
    conditions.push(gte(runs.startedAt, filter.startedAfter));
  }
  return conditions;
}

/**
 * The strict, UN-joined list primitive. Since R2 moved `GET /api/runs` onto
 * `listRunSummaries`, this has no production caller left — it is kept
 * deliberately, not stranded: it is the plain-`Run` read the repo's own tests
 * assert against throughout, and the base any future caller that wants rows
 * without the name join should use. The lenient boot/sweep scans use
 * `listParsedRuns` instead, for the reason its own docblock gives.
 */
export function listRuns(db: Db, filter: ListRunsFilter = {}): Run[] {
  const conditions = listRunsConditions(filter);
  const rows =
    conditions.length > 0
      ? db
          .select()
          .from(runs)
          .where(and(...conditions))
          .all()
      : db.select().from(runs).all();
  return rows.map((row) => RunSchema.parse(row));
}

/**
 * R2 — `listRuns` as the Monitor's list read-model: every run PLUS the human
 * names U10's columns need, in ONE query instead of an N+1 walk from the client.
 *
 * `runs ⋈ pipeline_versions` is the join `countActiveRunsForPipeline` and
 * `queuedTriggerCandidatesForPipeline` already use — a run row carries only its
 * immutable `pipelineVersionId`, and the pipeline identity lives on the version
 * row. This EXTENDS it with a second hop to `pipelines` for the name. Both hops
 * are INNER: the FKs are `restrict`/`cascade`, so a surviving run necessarily
 * pins both rows.
 *
 * The trigger hop is a LEFT JOIN, and that asymmetry is load-bearing. Two REAL
 * cases have no trigger: a rerun (`run/reseed.ts` sets `triggerId = null`
 * deliberately) and any run whose trigger was later deleted (`onDelete:
 * 'set null'`). An INNER join would drop both from the operator's own list —
 * silently, and indistinguishably from "you have no reruns". A child run will
 * join them once P3b lands the spawn seam (#796); nothing creates one yet.
 *
 * ORDER is a total, deterministic newest-first (`started_at DESC, rowid DESC`).
 * The tie-break is `rowid`, not `id`: run ids are random nanoids, so ordering a
 * millisecond tie by id would be stable but ARBITRARY — "newest-first" would
 * quietly stop being true exactly at the tie. `rowid` is SQLite's insertion
 * order, so it breaks the tie chronologically, which is what the column claims.
 * Same tie-breaker `nextQueuedRunForTrigger` uses for two fires enqueued in the
 * same millisecond, and QUALIFIED for the same reason: the join makes a bare
 * `rowid` ambiguous.
 * MEASURED, not assumed: on the production path (the route always passes
 * `ownerId`) SQLite picks `runs_owner_id_idx` and sorts through a
 * `USE TEMP B-TREE FOR ORDER BY`; `runs_started_at_idx` is used only for an
 * UNFILTERED list, and even then the tie-break needs a temp b-tree for the
 * last term. That cost is accepted at U10's "client-side small-data v1" scale —
 * this is a correctness claim about the ORDER, not a performance claim about the
 * index. RE-MEASURED when U26 added the `status`/`pipelineId`/`startedAfter`
 * axes, rather than left to silently cover a query it was never taken against:
 * the plan is UNCHANGED for owner-only, owner+status, owner+startedAfter,
 * owner+pipeline and all four together — SQLite still drives on
 * `runs_owner_id_idx` with a `USE TEMP B-TREE FOR ORDER BY` (the pipeline filter
 * only re-orders the join so `pipelines` leads). `listRuns` issues no
 * `ORDER BY` at all, yet the page consuming it
 * claimed rows arrived "newest-first as the server returns them" — SQLite's row
 * order is an implementation detail, so that was never a promise anything kept.
 * The `id` tie-break makes two runs stamped in the same millisecond stably
 * ordered rather than arbitrarily.
 *
 * SECURITY — the ownership proof is the RUN's, exactly as `GET /api/runs/:id/detail`
 * documents. `ownerId` filters the RUNS table; the joined version and pipeline
 * are reachable only from a run that filter already cleared, and a run's binding
 * is established at trigger-create time under `requireOwnedPipelineVersion` and
 * is immutable thereafter, or is copied from an owned run's binding
 * (`run/reseed.ts`) — the same two creation paths the `/detail` docblock names.
 * No owner filter is applied to `pipelines` — a version row carries no `ownerId`
 * (owner scoping rides the pipeline FK), and filtering there could only ever
 * DROP one of the caller's own runs from their list.
 */
export function listRunSummaries(db: Db, filter: ListRunSummariesFilter = {}): RunSummary[] {
  const conditions = listRunsConditions(filter);
  // U26 — the one axis that cannot live in `listRunsConditions`: it reads a
  // JOINED column. Expressed over the join this query already makes, exactly as
  // `countActiveRunsForPipeline` does, rather than as a subquery.
  if (filter.pipelineId !== undefined) {
    conditions.push(eq(pipelineVersions.pipelineId, filter.pipelineId));
  }
  /* #931 — the rows and their costs are read inside ONE transaction, so both come
     from a single consistent SQLite snapshot and a metered event appended between
     the two reads cannot land in a cost whose row predates it. (A nested call would
     drop to a SAVEPOINT and read the OUTER snapshot instead — still self-consistent,
     which is all this claims. There is no such caller today: `listRunSummaries` is
     reached only from `GET /api/runs`.) Read-only, so there is nothing to roll back;
     the transaction is purely for snapshot isolation, exactly as
     `aggregatePipelineCost`'s is. */
  return db.transaction((tx) => {
    const query = tx
      .select({
        run: runs,
        pipelineId: pipelines.id,
        pipelineName: pipelines.name,
        pipelineVersion: pipelineVersions.version,
        triggerName: triggers.name,
      })
      .from(runs)
      .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
      .innerJoin(pipelines, eq(pipelineVersions.pipelineId, pipelines.id))
      .leftJoin(triggers, eq(runs.triggerId, triggers.id));
    const rows = (conditions.length > 0 ? query.where(and(...conditions)) : query)
      .orderBy(desc(runs.startedAt), desc(sql`${runs}.rowid`))
      .all();
    const costs = aggregateRunCosts(
      tx,
      rows.map((row) => row.run.id),
      filter.ownerId,
    );
    return rows.map((row) =>
      RunSummarySchema.parse({
        ...row.run,
        pipelineId: row.pipelineId,
        pipelineName: row.pipelineName,
        pipelineVersion: row.pipelineVersion,
        triggerName: row.triggerName,
        /* A run with no metered events has no aggregate GROUP, and its cost is a
           genuine zero — nothing was billed. `computeRunCost([])` rather than a
           hand-written zero object, so the empty value stays the FOLD's own and
           cannot fall out of step when `RunCost` grows a field. */
        cost: costs.get(row.run.id) ?? computeRunCost([]),
      }),
    );
  });
}

/**
 * #646 — `listRuns`, but RESILIENT per row (the `listParsedTriggers`
 * discipline): a corrupt/legacy/hand-edited row is skipped (and reported via
 * `onSkip`) instead of throwing out the whole list. The boot reconciler, the
 * queued-run recovery and the S7 lease sweep use this because their scans sit
 * ABOVE any per-run fault boundary — one poison `running`/`queued` row
 * otherwise aborts SERVER BOOT (`reconcileOnBoot`/`recoverQueued` are awaited
 * unguarded in `index.ts`) or silences the lease heartbeat for every live run.
 * (`listRuns` stays strict: a route surfacing a poison row as a 500 is right
 * there.)
 *
 * Two phases for the same empirically-verified reason as
 * `listParsedDueWakeups`: drizzle's `{mode:'json'}` codec (`params`,
 * `trigger_context`) throws out of `.all()` itself on one invalid-JSON cell, so
 * per-row leniency needs a codec-free id-only projection first, then a strict
 * per-id read whose failure is scoped to its own row. Only DETERMINISTIC
 * corruption (`ZodError`/`SyntaxError` — the #515 classification) is skipped;
 * any other throw is a genuine DB fault and propagates. A row deleted between
 * the phases is silently skipped.
 */
export function listParsedRuns(
  db: Db,
  filter: ListRunsFilter = {},
  onSkip?: (id: string, err: unknown) => void,
): Run[] {
  const conditions = listRunsConditions(filter);
  const ids = (
    conditions.length > 0
      ? db
          .select({ id: runs.id })
          .from(runs)
          .where(and(...conditions))
          .all()
      : db.select({ id: runs.id }).from(runs).all()
  ).map((row) => row.id);

  const parsed: Run[] = [];
  for (const id of ids) {
    try {
      const row = getRun(db, id);
      if (row !== null) parsed.push(row);
    } catch (err) {
      if (isDeterministicRowCorruption(err)) onSkip?.(id, err);
      else throw err;
    }
  }
  return parsed;
}

/**
 * The #515 classification, named once: a row that will not parse is
 * PERMANENTLY corrupt (`ZodError`/`SyntaxError` — it fails identically on every
 * read), and ANY other throw is a live DB fault (a locked database, a closed
 * connection, a disk error) which the next attempt may well clear.
 *
 * The distinction is load-bearing, not cosmetic: callers file the first under a
 * permanent bucket that asks an operator to repair the row, and must let the
 * second propagate to a transient one. Conflating them either re-reports a
 * healthy row as corrupt forever, or retries a repair-needing row forever.
 */
export function isDeterministicRowCorruption(err: unknown): boolean {
  return err instanceof ZodError || err instanceof SyntaxError;
}

/**
 * `getRun`, but with `listParsedRuns`'s per-row leniency — the SINGLE-ROW twin,
 * for a reader that knows the one id it wants and so has no list to scan.
 *
 * Same contract as the scan, deliberately: a row whose stored state is
 * deterministically corrupt is reported via `onSkip` and returns `null`; a
 * genuine DB fault PROPAGATES. Callers that read a row outside a lenient scan
 * (the boot reconciler's orphan sweep reads a `pending` child's PARENT, which no
 * scan parsed) would otherwise hand-roll this classification, and a policy
 * hand-rolled per call site is a policy that drifts.
 *
 * `null` covers both "absent" and "corrupt" because every caller so far treats
 * them the same way — there is no row to act on. `onSkip` is what distinguishes
 * them, for a caller that must report the corruption rather than just skip it.
 */
export function getParsedRun(
  db: Db,
  id: string,
  onSkip?: (id: string, err: unknown) => void,
): Run | null {
  try {
    return getRun(db, id);
  } catch (err) {
    if (!isDeterministicRowCorruption(err)) throw err;
    onSkip?.(id, err);
    return null;
  }
}

/**
 * Mutates ONLY run-lifecycle fields (`status`, `leaseUntil`, `heartbeatAt`,
 * `finishedAt`) — the fields the executor/boot-reconciler update as a run
 * progresses. The immutable-binding + provenance fields (`params`,
 * `pipelineVersionId`, `triggerId`, `parentRunId`, `startedAt`) are not part
 * of `RunLifecyclePatch`'s type, so a caller touching one is a compile-time
 * error; `RunLifecyclePatchSchema.parse` (`.strict()`) is the matching
 * runtime guard for a caller that bypasses the type (`as any`/`as never`).
 */
export function updateRun(db: Db, id: string, patch: RunLifecyclePatch): Run | null {
  const parsedPatch = RunLifecyclePatchSchema.parse(patch);
  const existing = getRun(db, id);
  if (!existing) return null;
  const updated = RunSchema.parse({ ...existing, ...parsedPatch, id: existing.id });
  db.update(runs).set(updated).where(eq(runs.id, id)).run();
  return updated;
}

/**
 * Statuses that OCCUPY a concurrency slot for their trigger — the admission
 * count. Terminal = `success`/`failure`/`skipped`/`interrupted`. (`skipped` is
 * terminal; the concurrency gate never CREATES a skipped run row, but a
 * node-driven skip that terminalizes a whole run must still free the slot.)
 *
 * #5 S4 — a `waiting` (parked) run RELEASES its slot: per the Codex-hardened spec
 * (line 132-134) a run parked on a timer/webhook/dependency for hours "must not
 * occupy a worker or a slot", and "resumption is event-driven". So `waiting` is
 * NOT here — parking frees the trigger's slot, and a resuming run rejoins
 * `running` directly. This is the split #5 S3 deferred: the execution LEASE
 * (`syncRunLifecycle` projects `leaseUntil` from status — held while `running`,
 * released on park) is now distinct from the lifecycle status.
 *
 * CONSEQUENCE (intended, spec-sanctioned): a parked run no longer blocks a new
 * fire, so a `skip_if_running` trigger with a long-parked run WILL fire again,
 * and a resumed run can transiently exceed `parallel`'s `max`. Bounding this with
 * a `waiting_concurrency` re-admission gate on resume is a LATER #5 S6 slice, not
 * S6a's — the "by default" in the spec is exactly that opt-in. (S6a made the
 * QUEUE durable; the resume-readmission gate rides the same substrate next.)
 *
 * `queued` (#5 S6a — a fire held in the durable admission queue, a real `runs`
 * row now) stays OUT of this set: pre-admission ≠ occupying a slot, so a queued
 * row must not count against its trigger's admission gate. `countQueuedRunsForTrigger`
 * is the SEPARATE queue-depth count.
 */
const ACTIVE_RUN_STATUSES = ['pending', 'running'] as const satisfies readonly RunStatus[];

/**
 * #896 — every run status that has NOT finished. Deliberately WIDER than
 * `ACTIVE_RUN_STATUSES` above, and the difference is the whole point of it
 * existing separately rather than reusing the neighbour:
 *
 * - `waiting` — a PARKED run does not occupy a trigger's concurrency slot (that
 *   is exactly why `ACTIVE_RUN_STATUSES` excludes it), but it has not finished
 *   and its remaining nodes have not been billed yet. For a duplicate-work guard
 *   it is unambiguously live.
 * - `queued` — pre-admission, so it likewise must not count against a trigger's
 *   slot. It is unreachable for a rerun today (a rerun drives immediately and
 *   never passes through the launcher's admission queue), and is listed for
 *   completeness of the partition rather than because it is expected.
 *
 * `pending` is defensive in the same way and for a different reason: the reseed
 * producer syncs R2's row to its folded status INSIDE the creating transaction,
 * precisely so a durable `pending` row with a log cannot exist. Both are listed
 * because this set's contract is "has not finished", not "is expected here".
 *
 * Written out rather than derived from `TERMINAL_RUN_STATUS`, because that
 * derivation is subtly wrong: `TERMINAL_RUN_STATUS` is a set of
 * `RunLifecycleStatus`, which contains neither `queued` nor `skipped`, so
 * `!TERMINAL_RUN_STATUS.has(s)` answers `false` for the terminal `skipped` and
 * would quietly admit it here. The partition test in `__tests__/runs.test.ts`
 * is what actually catches a newly-added `RunStatus`.
 */
export const LIVE_RUN_STATUSES = [
  'pending',
  'queued',
  'running',
  'waiting',
] as const satisfies readonly RunStatus[];

/**
 * #896 — the rerun of `sourceRunId` that has not finished, if there is one.
 *
 * The double-spend guard behind `POST /api/runs/:id/rerun-from-failed`. A rerun
 * re-executes every node from the failure onward, so a second one of the same
 * source run is a second bill for work already in progress. The client's own
 * in-flight flag cannot carry this: it is component state on a page keyed by run
 * id, so a navigate-away-and-back mid-flight resets it (and a second tab, or a
 * bare `curl`, never had it at all).
 *
 * Returns the id AND status so the refusal can say which run and what it is
 * doing — with no cancel control in the UI, that is the operator's only handle on
 * it. Backed by `runs_rerun_of_idx`; ordered oldest-first so the answer (and any
 * test asserting it) is stable when a pre-guard database holds several. The
 * tie-break is `rowid`, not `id`, for the reason the neighbouring readers give:
 * `startedAt` is a millisecond stamp that several rows can share, and `id` is a
 * random nanoid, so an id tie-break is stable but ARBITRARY — it would pick a
 * different one of two same-millisecond reruns on a different insert order.
 */
export function findLiveRerunOf(
  db: Db,
  sourceRunId: string,
): { id: string; status: RunStatus } | null {
  const row = db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(and(eq(runs.rerunOf, sourceRunId), inArray(runs.status, [...LIVE_RUN_STATUSES])))
    .orderBy(asc(runs.startedAt), asc(sql`rowid`))
    .get();
  return row ?? null;
}

/**
 * Count a trigger's currently-active (non-terminal) runs — the P4 concurrency
 * gate's authoritative, restart-safe source of truth. A run row is durable
 * from creation and survives a process restart (to be resumed by the boot
 * reconciler), whereas an in-memory counter does not; basing admission on the
 * DB keeps the gate correct across a crash mid-run. Filtered in SQL, backed by
 * `runs_status_idx` + the trigger filter.
 */
export function countActiveRunsForTrigger(db: Db, triggerId: string): number {
  const row = db
    .select({ n: count() })
    .from(runs)
    .where(and(eq(runs.triggerId, triggerId), inArray(runs.status, [...ACTIVE_RUN_STATUSES])))
    .get();
  return row?.n ?? 0;
}

/**
 * #5 S6a — the DURABLE admission queue. A `queue`-policy fire that overflows the
 * trigger's single slot becomes a `runs` row with `status = 'queued'` and a
 * `queued_at` FIFO key, replacing the launcher's old in-memory FIFO (which a
 * crash silently dropped). `count`/`next` back the launcher's enqueue-bound and
 * drain; `admit` promotes the drained row.
 */

/** How many fires are currently held in the durable queue for `triggerId` (the
 * launcher's `maxQueueDepth` bound is checked against this — restart-safe, unlike
 * the old in-memory array length). `queued` is deliberately NOT in
 * `ACTIVE_RUN_STATUSES` (pre-admission ≠ a slot), so this is a SEPARATE count. */
export function countQueuedRunsForTrigger(db: Db, triggerId: string): number {
  const row = db
    .select({ n: count() })
    .from(runs)
    .where(and(eq(runs.triggerId, triggerId), eq(runs.status, 'queued')))
    .get();
  return row?.n ?? 0;
}

/**
 * The oldest queued fire for `triggerId` — the next to admit — or `null` if the
 * queue is empty. STRICT arrival FIFO: `queued_at` (ms) then `rowid` as the
 * tie-breaker for two fires enqueued in the SAME millisecond. `rowid` is SQLite's
 * monotonic-with-INSERT key, so it reproduces the exact enqueue order the old
 * in-memory array gave — `id` (a random nanoid) could NOT, it would order a
 * same-ms burst arbitrarily. Deterministic and stable across replays/restarts.
 * The queue is bounded (`maxQueueDepth`) and per-trigger, so the unindexed
 * `ORDER BY` scans a small set — no dedicated index in this slice.
 *
 * #5 S6b — `pipelineId` (optional) PIPELINE-scopes the pick: a queued row
 * freezes the version it enqueued under while the trigger's binding is
 * mutable, so one trigger can hold queued rows on TWO pipelines (rebound
 * mid-queue). A pipeline drain must admit only rows belonging to the drained
 * pipeline — the trigger-global oldest could be a FOREIGN-pipeline row that
 * never passed that pipeline's gate.
 */
export function nextQueuedRunForTrigger(
  db: Db,
  triggerId: string,
  pipelineId?: string,
  /** #646 — invoked for each corrupt row SKIPPED on the way to the head. */
  onSkip?: (id: string, err: unknown) => void,
): Run | null {
  const base = and(eq(runs.triggerId, triggerId), eq(runs.status, 'queued'));
  // #646 — LENIENT per row, like `listParsedRuns` and for the same empirically-
  // verified reason: the old strict `.get()` mapped the FIFO head through the
  // json codec, so a corrupt head row threw `SyntaxError` out of every drain —
  // including `recoverQueued`'s unguarded boot drain, re-opening the exact
  // boot-abort this sweep closes, one hop deeper. Phase 1 is a codec-free
  // id-only pick in queue order (no `limit(1)`: the head might be the corrupt
  // row being skipped); phase 2 walks the ids to the first HEALTHY row. A
  // corrupt row is skipped (reported via `onSkip`), NOT admitted and NOT
  // permitted to block the queue behind it: it can never be admitted anyway (no
  // reader can construct it), so blocking on it would starve the trigger's
  // healthy fires behind an unserviceable head, forever.
  const ids = (
    pipelineId === undefined
      ? db
          .select({ id: runs.id })
          .from(runs)
          .where(base)
          .orderBy(asc(runs.queuedAt), asc(sql`rowid`))
          .all()
      : db
          .select({ id: runs.id })
          .from(runs)
          .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
          .where(and(base, eq(pipelineVersions.pipelineId, pipelineId)))
          // Same rowid tie-break as the unscoped branch — qualified, since the
          // join makes a bare `rowid` ambiguous.
          .orderBy(asc(runs.queuedAt), asc(sql`${runs}.rowid`))
          .all()
  ).map((row) => row.id);

  for (const id of ids) {
    try {
      const row = getRun(db, id);
      // Deleted or admitted between the phases: no longer a queued candidate.
      if (row === null || row.status !== 'queued') continue;
      return row;
    } catch (err) {
      if (isDeterministicRowCorruption(err)) onSkip?.(id, err);
      else throw err;
    }
  }
  return null;
}

/**
 * Admit a queued run: flip `queued → pending` and RE-STAMP `started_at` to now
 * (admission time — `run.started.startedAt` reads the row, so `${run.startedAt}`
 * must reflect when the run was admitted, not when it was enqueued; driver.ts's
 * `startRun` comment anticipates exactly this). `queued_at` and `trigger_context`
 * are preserved (the queued-at record + the frozen fire-time context the drive
 * still needs). Returns the admitted run, or `null` if the row is missing or was
 * already admitted by a concurrent drain — the `status = 'queued'` guard in the
 * UPDATE makes the promotion idempotent (a second drain flips nothing).
 *
 * This is a PURPOSE-BUILT write, deliberately NOT `updateRun`: re-stamping
 * `started_at` is a provenance rewrite that `RunLifecyclePatchSchema` (`.strict()`,
 * no `startedAt`) forbids by design. Admission is the one sanctioned exception,
 * so it gets its own function rather than a hole in the lifecycle-patch guard.
 */
export function admitQueuedRun(db: Db, id: string): Run | null {
  const startedAt = Date.now();
  const result = db
    .update(runs)
    .set({ status: 'pending', startedAt })
    .where(and(eq(runs.id, id), eq(runs.status, 'queued')))
    .run();
  if (result.changes === 0) return null;
  return getRun(db, id);
}

/**
 * #5 S6b — count the PIPELINE's currently-active runs across ALL its versions
 * and triggers (including a trigger-less `call_pipeline` child bound to one of
 * its versions): the per-pipeline half of both-must-pass admission. Same
 * `ACTIVE_RUN_STATUSES` definition as the per-trigger gate — `queued` is
 * pre-admission and `waiting` released its slot, so neither occupies pipeline
 * capacity. SQL-filtered via the runs ⋈ pipeline_versions join (a run row
 * carries only its immutable `pipelineVersionId`; the version row carries the
 * pipeline identity).
 */
export function countActiveRunsForPipeline(db: Db, pipelineId: string): number {
  const row = db
    .select({ n: count() })
    .from(runs)
    .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
    .where(
      and(
        eq(pipelineVersions.pipelineId, pipelineId),
        inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/** One trigger's standing in the pipeline's admission queue (#5 S6b). */
export interface QueuedTriggerCandidate {
  triggerId: string;
  /** The trigger's oldest waiting fire (its next-to-admit, FIFO within the trigger). */
  oldestQueuedAt: number;
  /** When the trigger was last SERVED — MAX(started_at) over its non-queued
   * runs (`admitQueuedRun`/`createRun` stamp admission time). `null` = never. */
  lastAdmittedAt: number | null;
}

/**
 * #5 S6b — the pipeline's queued triggers in FAIR service order:
 * least-recently-ADMITTED first (never-served first), then oldest `queuedAt`,
 * then `triggerId` (a total, deterministic order). This is the durable
 * round-robin the spec's "per-trigger round-robin (no monopoly)" requires,
 * derived entirely from persisted run rows — `started_at` is (re-)stamped at
 * every admission, so MAX(started_at) over a trigger's non-queued runs IS its
 * durable service record; no in-memory rotation pointer, restart-safe. A
 * trigger that bursts 100 old fires cannot monopolize a single-slot pipeline:
 * once served, it becomes the MOST-recently-admitted and rotates behind the
 * others. (Caveat, accepted: deleting run history — `deleteRun`, a future
 * retention sweep — erases the service record, resetting a trigger to
 * "never served"; fairness degrades gracefully, never deadlocks.)
 *
 * Within a trigger the queue order stays strict durable-`queuedAt` FIFO
 * (`nextQueuedRunForTrigger`).
 */
export function queuedTriggerCandidatesForPipeline(
  db: Db,
  pipelineId: string,
): QueuedTriggerCandidate[] {
  // Grouped queued rows for this pipeline (runs ⋈ versions), per trigger.
  const queuedGroups = db
    .select({
      triggerId: runs.triggerId,
      oldestQueuedAt: sql<number>`min(${runs.queuedAt})`,
    })
    .from(runs)
    .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
    .where(and(eq(pipelineVersions.pipelineId, pipelineId), eq(runs.status, 'queued')))
    .groupBy(runs.triggerId)
    .all();

  const triggerIds = queuedGroups.map((g) => g.triggerId).filter((id): id is string => id !== null);
  if (triggerIds.length === 0) return [];

  // Service record per trigger: MAX(started_at) over its NON-queued rows (a
  // queued row's started_at is an enqueue-time placeholder, not a service).
  // PIPELINE-scoped like everything else here: a trigger rebound from another
  // pipeline must rank by its service within THIS pipeline, not drag its old
  // pipeline's history into the fairness order.
  const served = db
    .select({
      triggerId: runs.triggerId,
      lastAdmittedAt: sql<number>`max(${runs.startedAt})`,
    })
    .from(runs)
    .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
    .where(
      and(
        eq(pipelineVersions.pipelineId, pipelineId),
        inArray(runs.triggerId, triggerIds),
        sql`${runs.status} != 'queued'`,
      ),
    )
    .groupBy(runs.triggerId)
    .all();
  const lastAdmitted = new Map(served.map((s) => [s.triggerId, s.lastAdmittedAt]));

  return queuedGroups
    .filter((g): g is typeof g & { triggerId: string } => g.triggerId !== null)
    .map((g) => ({
      triggerId: g.triggerId,
      oldestQueuedAt: g.oldestQueuedAt,
      lastAdmittedAt: lastAdmitted.get(g.triggerId) ?? null,
    }))
    .sort((a, b) => {
      const aServed = a.lastAdmittedAt ?? -Infinity;
      const bServed = b.lastAdmittedAt ?? -Infinity;
      if (aServed !== bServed) return aServed - bServed;
      if (a.oldestQueuedAt !== b.oldestQueuedAt) return a.oldestQueuedAt - b.oldestQueuedAt;
      return a.triggerId < b.triggerId ? -1 : a.triggerId > b.triggerId ? 1 : 0;
    });
}

export function deleteRun(db: Db, id: string): boolean {
  const result = db.delete(runs).where(eq(runs.id, id)).run();
  return result.changes > 0;
}
