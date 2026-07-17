import { and, asc, eq, inArray, lt, lte, ne } from 'drizzle-orm';
import {
  ArmWakeupInputSchema,
  ScheduledWakeupSchema,
  buildDedupeKey,
  type ArmWakeupInput,
  type ScheduledWakeup,
  type WakeupStatus,
} from '@autonomy-studio/shared';
import { scheduledWakeups } from '../db/schema.js';
import { newId } from './ids.js';
import type { Db } from './types.js';

/**
 * #5 S1 — persistence for the durable-alarm OUTBOX. Dumb storage on purpose:
 * WHICH kinds are live, whether a due alarm is still CURRENT, and what firing
 * one actually does all belong to the alarm clock's handler registry
 * (`scheduler/alarms.ts`). This module only knows rows.
 *
 * The one invariant it does own: a settled row is FINAL. Arming is
 * upsert-if-absent and settling is a one-way door, so at-least-once delivery
 * (the same row picked up twice across a crash window) can never overwrite an
 * outcome or resurrect a spent alarm. FINAL is about the OUTCOME, not the row's
 * existence: `pruneSettledWakeups` (#464 retention) DELETES settled rows once
 * they are provably past every consumer's re-arm window — it never rewrites an
 * outcome or un-settles a row, so the invariant holds.
 */

/**
 * Arm a durable alarm. `dedupeKey` is DERIVED (never passed), so no caller can
 * hand-spell a key and skip the discriminator.
 *
 * Idempotent by `(kind, dedupeKey)`: re-arming returns the existing row rather
 * than a second alarm. "Armed" and "already armed" are deliberately the same
 * successful outcome — that indifference IS the replay idempotency.
 */
export function armWakeup(db: Db, input: ArmWakeupInput): ScheduledWakeup {
  const parsed = ArmWakeupInputSchema.parse(input);
  const dedupeKey = buildDedupeKey({
    kind: parsed.kind,
    ref: parsed.ref,
    discriminator: parsed.discriminator,
  });

  return db.transaction((tx) => {
    // Upsert-by-deterministic-key (spec #5: "commands re-emit on replay"). The
    // read-then-insert is safe under better-sqlite3's synchronous single-writer
    // model, and the UNIQUE (kind, dedupe_key) index is the real backstop — the
    // same pattern + rationale as `run-events.ts`'s `seq` assignment.
    //
    // Returning the EXISTING row whatever its status is the load-bearing half:
    // a replayed `scheduleRetry` for an attempt whose alarm already fired must
    // be a no-op, not a resurrection. It also makes an armed alarm IMMUTABLE —
    // there is deliberately no way to move a `dueAt`. Re-scheduling (a backoff
    // push-out, a lease heartbeat) is S7's `supersede`, which needs a durable
    // `supersededBy` slot and a consumer to pin its semantics; neither exists
    // yet. Until then a caller that wants a later alarm arms a NEW one under a
    // new discriminator.
    const existing = selectByKey(tx, parsed.kind, dedupeKey);
    if (existing !== null) return existing;

    const row: ScheduledWakeup = {
      id: newId('wku'),
      kind: parsed.kind,
      ref: parsed.ref,
      dueAt: parsed.dueAt,
      dedupeKey,
      status: 'pending',
      firedAt: null,
    };
    tx.insert(scheduledWakeups).values(row).run();
    return ScheduledWakeupSchema.parse(row);
  });
}

/**
 * The claim scan: pending rows due at or before `now`, for REGISTERED kinds
 * only, oldest first.
 *
 * `kinds` is not an optimisation — it is the fail-safe for a wakeup whose kind
 * has no handler (a downgrade, or a kind retired mid-rollout). Such a row is
 * simply never selected: it stays `pending` and visible, so nothing spins on it
 * and nothing drops it, and it fires normally if its kind is registered again.
 * Claiming-then-discarding would lose the alarm; claiming-then-erroring would
 * spin it every tick.
 *
 * Oldest-first so a late alarm is never starved by a fresher one. `id` breaks
 * `dueAt` ties: alarms armed in the same millisecond are common (a fan-out arms
 * a batch at once), and without a tie-breaker SQLite may order them differently
 * across ticks and restarts — so a replayed or restarted tick could claim the
 * same-due batch in a different order than the run that came before it.
 */
export function listDueWakeups(
  db: Db,
  opts: { kinds: readonly string[]; now: number },
): ScheduledWakeup[] {
  // `inArray` with an empty list is a SQL error in some dialects and an
  // always-false predicate in others; short-circuit so "an alarm clock with no
  // handlers is inert" is guaranteed here rather than by the caller.
  if (opts.kinds.length === 0) return [];
  const rows = db
    .select()
    .from(scheduledWakeups)
    .where(
      and(
        eq(scheduledWakeups.status, 'pending'),
        lte(scheduledWakeups.dueAt, opts.now),
        inArray(scheduledWakeups.kind, [...opts.kinds]),
      ),
    )
    .orderBy(asc(scheduledWakeups.dueAt), asc(scheduledWakeups.id))
    .all();
  return rows.map((row) => ScheduledWakeupSchema.parse(row));
}

/**
 * Settle a PENDING row to a terminal status. Returns the settled row, or `null`
 * if it was already settled (or gone) — the guard, not an accident: delivery is
 * at-least-once, so the same row can be picked up twice around a crash, and the
 * second settle must not overwrite the first outcome. The caller reads `null`
 * as "someone else already handled this".
 *
 * The `WHERE status = 'pending'` is what makes it atomic: the check and the
 * write are ONE statement, so there is no read-then-write window.
 */
export function settleWakeup(
  db: Db,
  id: string,
  settle: { status: Exclude<WakeupStatus, 'pending'>; firedAt: number },
): ScheduledWakeup | null {
  const updated = db
    .update(scheduledWakeups)
    .set({ status: settle.status, firedAt: settle.firedAt })
    .where(and(eq(scheduledWakeups.id, id), eq(scheduledWakeups.status, 'pending')))
    .returning()
    .all();
  const row = updated[0];
  return row === undefined ? null : ScheduledWakeupSchema.parse(row);
}

/**
 * Disarm a pending alarm (a `wait` node cancelled, a trigger deleted). Returns
 * `null` if it was not pending — a fired alarm cannot be un-fired.
 *
 * `at` is required rather than defaulted to `Date.now()`: every other time value
 * in this module is a caller-supplied FACT, which is what makes "`dueAt` is
 * stored, never recomputed" true. A repo function that reads the clock itself
 * would be the one exception, and exceptions are how that invariant erodes.
 */
export function cancelWakeup(db: Db, id: string, at: number): ScheduledWakeup | null {
  return settleWakeup(db, id, { status: 'cancelled', firedAt: at });
}

/**
 * DELETE a pending alarm outright, freeing its `(kind, dedupeKey)`. Guarded by
 * `WHERE status = 'pending'` so a SETTLED row is never removed — a `fired` row is
 * a permanent outcome (the "settled = final" outbox invariant) and stays. Returns
 * the deleted row, or `null` if it was not pending (already settled, or gone).
 *
 * Why a caller wants this over `cancelWakeup`: `cancelWakeup` SETTLES the row to
 * `cancelled`, which KEEPS its `(kind, dedupeKey)` occupied. For a kind whose
 * discriminator is DETERMINISTIC and re-derivable — schedule ticks
 * (`tick-<occurrenceEpoch>`) — re-arming the SAME occurrence after a cancel then
 * hits `armWakeup`'s upsert-if-absent, finds the dead `cancelled` row, and
 * returns it WITHOUT inserting a live one → the alarm silently never arms
 * (disable→re-enable, or edit→revert, within one occurrence interval). Deleting
 * the dropped pending row frees the key so the re-seed inserts a real pending row.
 * (Retry's `attempt-<n>` discriminator never re-collides, so retry uses cancel.)
 */
export function deleteWakeup(db: Db, id: string): ScheduledWakeup | null {
  const deleted = db
    .delete(scheduledWakeups)
    .where(and(eq(scheduledWakeups.id, id), eq(scheduledWakeups.status, 'pending')))
    .returning()
    .all();
  const row = deleted[0];
  return row === undefined ? null : ScheduledWakeupSchema.parse(row);
}

/**
 * #464 — RETENTION. Delete SETTLED rows (`fired`/`suppressed`/`cancelled`) whose
 * `firedAt` is strictly before `before`, oldest-first, at most `limit` per call.
 * Returns the number deleted. `limit` omitted = unbounded (delete every eligible
 * row in one statement).
 *
 * Bounded + oldest-first ON PURPOSE: the caller DRAINS a backlog to a fixpoint
 * (loop until a batch returns `< limit`), so a self-hosted instance that has
 * piled up months of ticks is pruned in bounded batches rather than one
 * unbounded DELETE holding the single writer lock. The boundary is EXCLUSIVE
 * (`firedAt < before`, not `<=`): `before` is `now - retentionMs`, so a row
 * exactly at the floor is still inside the safe window and survives.
 *
 * SAFETY — why deleting a settled row can never cause a double-fire. Arming is
 * upsert-if-absent by `(kind, dedupeKey)`, and "re-arming a fired key is a
 * no-op" (see `armWakeup`) is what makes replay idempotent. Deleting a fired row
 * FREES its key, so a re-arm AFTER the delete would INSERT a fresh alarm and
 * re-fire — safe ONLY once the key can no longer be re-armed. For every CURRENT
 * kind that window is bounded by minutes–hours, far inside any sane
 * `retentionMs` floor (default 30 days):
 *   - `node_retry` (`{runId,nodeId,attemptId}`): a fired attempt's alarm is
 *     re-armed only if the run's log is replayed and re-emits `scheduleRetry`
 *     for that SAME attempt. The reducer never re-emits it for an attempt past
 *     `retry_pending` (the F2b/#443 drain-to-fixpoint property), and boot
 *     reconcile re-arms only PENDING holds lost in the HOLD→ARM window, never
 *     fired ones; a terminal run never replays at all.
 *   - `schedule_tick` (`{triggerId}`, `tick-<occurrenceEpoch>`): the reconciler
 *     seeds only FUTURE occurrences, so a fired past occurrence is never
 *     re-armed (catch-up is ≤1 late, minutes).
 * A future kind with a longer re-arm window (e.g. #4 `wait`) MUST re-check this
 * floor. Pending rows are never eligible here (only settled), so a far-future
 * `wait` alarm still `pending` is untouched regardless of its age.
 *
 * (When #465's `supersede` lands, pruning a settled row a `superseded_by` points
 * AT leaves a dangling reference — harmless: it is provenance only, no FK, never
 * joined for correctness. No special handling needed here.)
 */
export function pruneSettledWakeups(db: Db, opts: { before: number; limit?: number }): number {
  // Oldest-first, `id` breaking `firedAt` ties — the same total order
  // `listDueWakeups`/`listPendingWakeups` use, so batch boundaries are stable
  // across sweeps. Deleting via a subquery of ids (not `DELETE … LIMIT`, which
  // throws unless better-sqlite3 is compiled with SQLITE_ENABLE_UPDATE_DELETE_LIMIT).
  const doomed = db
    .select({ id: scheduledWakeups.id })
    .from(scheduledWakeups)
    .where(and(ne(scheduledWakeups.status, 'pending'), lt(scheduledWakeups.firedAt, opts.before)))
    .orderBy(asc(scheduledWakeups.firedAt), asc(scheduledWakeups.id));
  const bounded = opts.limit === undefined ? doomed : doomed.limit(opts.limit);
  const deleted = db
    .delete(scheduledWakeups)
    .where(inArray(scheduledWakeups.id, bounded))
    .returning({ id: scheduledWakeups.id })
    .all();
  return deleted.length;
}

/** Default per-batch bound for `drainSettledWakeups` — big enough that a normal
 * sweep is one batch, small enough that a months-deep backlog is pruned in
 * bounded DELETEs rather than one statement holding the single writer lock. */
export const RETENTION_BATCH = 1_000;

/**
 * #464 — drain every settled row older than `before` in bounded batches until a
 * batch comes back short (the fixpoint), so a high-volume instance's backlog is
 * fully pruned across one sweep without an unbounded DELETE. Returns the total
 * deleted. Pure over the clock — the caller passes `before = now - retentionMs`.
 *
 * Signature mirrors `pruneSettledWakeups`' options object. `batch` defaults to
 * `RETENTION_BATCH`; the guard clamps it to ≥ 1 so a mistaken `batch <= 0` (which
 * would prune 0 rows forever, since `0 < 0` never breaks the loop) can never
 * spin — a footgun, not a reachable call today.
 */
export function drainSettledWakeups(db: Db, opts: { before: number; batch?: number }): number {
  const batch = Math.max(1, opts.batch ?? RETENTION_BATCH);
  let total = 0;
  for (;;) {
    const n = pruneSettledWakeups(db, { before: opts.before, limit: batch });
    total += n;
    if (n < batch) break;
  }
  return total;
}

export function getWakeupByKey(db: Db, kind: string, dedupeKey: string): ScheduledWakeup | null {
  return selectByKey(db, kind, dedupeKey);
}

export function getWakeup(db: Db, id: string): ScheduledWakeup | null {
  const row = db.select().from(scheduledWakeups).where(eq(scheduledWakeups.id, id)).get();
  return row ? ScheduledWakeupSchema.parse(row) : null;
}

/** Every armed (unsettled) alarm — introspection, tests, and a future boot report. */
export function listPendingWakeups(db: Db): ScheduledWakeup[] {
  const rows = db
    .select()
    .from(scheduledWakeups)
    .where(eq(scheduledWakeups.status, 'pending'))
    .orderBy(asc(scheduledWakeups.dueAt), asc(scheduledWakeups.id))
    .all();
  return rows.map((row) => ScheduledWakeupSchema.parse(row));
}

function selectByKey(db: Db, kind: string, dedupeKey: string): ScheduledWakeup | null {
  const row = db
    .select()
    .from(scheduledWakeups)
    .where(and(eq(scheduledWakeups.kind, kind), eq(scheduledWakeups.dedupeKey, dedupeKey)))
    .get();
  return row ? ScheduledWakeupSchema.parse(row) : null;
}
