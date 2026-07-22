import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import {
  NewRunSchema,
  RunLifecyclePatchSchema,
  RunSchema,
  type NewRun,
  type Run,
  type RunLifecyclePatch,
  type RunStatus,
} from '@autonomy-studio/shared';
import { pipelineVersions, runs } from '../db/schema.js';
import { newId } from './ids.js';
import type { Db } from './types.js';

export function createRun(db: Db, input: NewRun): Run {
  const parsed = NewRunSchema.parse(input);
  const row: Run = {
    id: newId('run'),
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
  /** Filters in SQL, like `listConnections`/`listPipelines` — never loaded
   * then filtered in the route. */
  ownerId?: string;
  /** The boot reconciler's "find all `running` rows" scan (backed by
   * `runs_status_idx`) — filtered in SQL, never loaded-then-filtered. */
  status?: RunStatus;
}

export function listRuns(db: Db, filter: ListRunsFilter = {}): Run[] {
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
  if (filter.ownerId !== undefined) {
    conditions.push(eq(runs.ownerId, filter.ownerId));
  }
  if (filter.status !== undefined) {
    conditions.push(eq(runs.status, filter.status));
  }

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
): Run | null {
  const base = and(eq(runs.triggerId, triggerId), eq(runs.status, 'queued'));
  const row =
    pipelineId === undefined
      ? db
          .select()
          .from(runs)
          .where(base)
          .orderBy(asc(runs.queuedAt), asc(sql`rowid`))
          .limit(1)
          .get()
      : db
          .select({ runs })
          .from(runs)
          .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
          .where(and(base, eq(pipelineVersions.pipelineId, pipelineId)))
          // Same rowid tie-break as the unscoped branch — qualified, since the
          // join makes a bare `rowid` ambiguous.
          .orderBy(asc(runs.queuedAt), asc(sql`${runs}.rowid`))
          .limit(1)
          .get()?.runs;
  return row ? RunSchema.parse(row) : null;
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
