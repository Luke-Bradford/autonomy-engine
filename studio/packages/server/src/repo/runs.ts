import { and, count, eq, inArray } from 'drizzle-orm';
import {
  NewRunSchema,
  RunLifecyclePatchSchema,
  RunSchema,
  type NewRun,
  type Run,
  type RunLifecyclePatch,
  type RunStatus,
} from '@autonomy-studio/shared';
import { runs } from '../db/schema.js';
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
 * a fair-queue / `waiting_concurrency` re-admission gate on resume is #5 **S6**'s
 * scope, not S4's — the "by default" in the spec is exactly that S6 opt-in.
 *
 * `queued` is NOT a run status (a queued fire is held in the launcher's in-memory
 * queue with no run row, so it never counted here); when #5 S6 persists a
 * `queued` status it must likewise stay OUT of this set (pre-admission ≠ a slot).
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

export function deleteRun(db: Db, id: string): boolean {
  const result = db.delete(runs).where(eq(runs.id, id)).run();
  return result.changes > 0;
}
