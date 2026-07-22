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
import { drainByBatches } from './retention.js';
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
  return armWakeupInternal(db, input).row;
}

/**
 * The arm with its honesty bit: `created` says whether this call actually
 * INSERTED. `armWakeup` returns the existing row whatever its status (the
 * load-bearing replay idempotency), which means the RETURN VALUE cannot tell a
 * fresh arm from a spent collision — exactly the gap that let the S1-era
 * `supersedeWakeup` ship a silent-lost-alarm (#465 trap 1: "the guard must
 * check what the arm RESOLVED TO — not the key"). `supersedeWakeup` refuses on
 * `created === false`; plain callers keep the indifferent `armWakeup`.
 */
function armWakeupInternal(
  db: Db,
  input: ArmWakeupInput,
): { row: ScheduledWakeup; created: boolean } {
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
    // there is deliberately no way to move a `dueAt` by re-arming.
    // Re-scheduling (a backoff push-out, a lease heartbeat) is S7's
    // `supersedeWakeup` below: an explicit cancel-old + arm-new in one
    // transaction, never a mutation of a live row.
    const existing = selectByKey(tx, parsed.kind, dedupeKey);
    if (existing !== null) return { row: existing, created: false };

    const row: ScheduledWakeup = {
      id: newId('wku'),
      kind: parsed.kind,
      ref: parsed.ref,
      dueAt: parsed.dueAt,
      dedupeKey,
      status: 'pending',
      firedAt: null,
      supersededBy: null,
    };
    tx.insert(scheduledWakeups).values(row).run();
    return { row: ScheduledWakeupSchema.parse(row), created: true };
  });
}

/**
 * #5 S7 (#465) — a supersede whose replacement failed to ARM. Thrown INSIDE the
 * supersede transaction so the whole thing rolls back and the old alarm stays
 * pending (#465 trap 2: "refusing must roll back, so a rejected supersede
 * leaves the old alarm ARMED rather than losing both"). Named so a caller's
 * per-item catch can tell this expected refusal from a real fault — the
 * `StaleWakeupError` pattern.
 */
export class SupersedeRefusedError extends Error {
  constructor(dedupeKey: string) {
    super(
      `supersede refused: the replacement key '${dedupeKey}' already names an existing row — ` +
        `arming it would return that row (whatever its status) instead of inserting a live alarm`,
    );
    this.name = 'SupersedeRefusedError';
  }
}

/**
 * #5 S7 (#465) — replace one alarm with another: cancel `old` + arm `next` in
 * ONE transaction. The ONLY sanctioned way to "move" a `dueAt` (arming is
 * immutable-by-design — see `armWakeup`). First consumer: the lease heartbeat
 * ("heartbeats supersede old alarms", spec #5's codex-hardened line).
 *
 * Semantics, decided per #465:
 *  - `next` must actually INSERT. If its key collides with ANY pre-existing row
 *    (even a spent one — a fired heartbeat generation, say), the supersede
 *    REFUSES by throwing `SupersedeRefusedError`, rolling back the cancel, so
 *    the old alarm stays armed. The guard checks what the arm RESOLVED TO
 *    (`created`), never the key: `armWakeup` returns the existing row whatever
 *    its status, so key comparison is exactly the check that shipped the
 *    S1-era silent-lost-alarm.
 *  - `old` is cancelled ONLY if still pending, stamped `supersededBy = next.id`
 *    (provenance). An `old` that is MISSING or already SETTLED cancels nothing
 *    and the replacement still arms — the heartbeat's post-boot case, where the
 *    previous generation's alarm fired/suppressed while the process was down
 *    and renewal must still arm the next generation. A settled outcome is
 *    never rewritten (the outbox's "settled is FINAL" invariant).
 *
 * `at` is the caller-supplied cancel timestamp (`firedAt` on the cancelled
 * row), required for the same reason `cancelWakeup`'s is.
 */
export function supersedeWakeup(
  db: Db,
  input: { old: ArmWakeupInput; next: ArmWakeupInput; at: number },
): ScheduledWakeup {
  return db.transaction((tx) => {
    const { row: next, created } = armWakeupInternal(tx, input.next);
    if (!created) throw new SupersedeRefusedError(next.dedupeKey);

    const oldParsed = ArmWakeupInputSchema.parse(input.old);
    const oldKey = buildDedupeKey({
      kind: oldParsed.kind,
      ref: oldParsed.ref,
      discriminator: oldParsed.discriminator,
    });
    const old = selectByKey(tx, oldParsed.kind, oldKey);
    if (old !== null && old.status === 'pending') {
      // `settleWakeup`'s atomic `WHERE status = 'pending'` guard still applies;
      // under this transaction the read above cannot go stale.
      settleWakeup(tx, old.id, { status: 'cancelled', firedAt: input.at, supersededBy: next.id });
    }
    return next;
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
  settle: {
    status: Exclude<WakeupStatus, 'pending'>;
    firedAt: number;
    /** #5 S7 — the replacement row's id; only `supersedeWakeup` passes it. */
    supersededBy?: string;
  },
): ScheduledWakeup | null {
  const updated = db
    .update(scheduledWakeups)
    .set({
      status: settle.status,
      firedAt: settle.firedAt,
      ...(settle.supersededBy !== undefined ? { supersededBy: settle.supersededBy } : {}),
    })
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
 *   - `window_due` (#5 S9, `window-<startEpochMs>`): seed and re-arm both go
 *     through `firstWindowEndingAfter(now)` — only windows ENDING in the
 *     future are ever armed — so a fired past window's key is never re-armed
 *     (and even if it were, the handler's projection-existence suppression +
 *     the partial UNIQUE `window.created` index refuse a second fire). #5 S10
 *     backfill will arm PAST windows and MUST re-verify this argument when it
 *     lands (its cursor machinery, not key-reuse, has to carry the guarantee).
 * A future kind with a longer re-arm window (e.g. #4 `wait`) MUST re-check this
 * floor. Pending rows are never eligible here (only settled), so a far-future
 * `wait` alarm still `pending` is untouched regardless of its age.
 *
 * (#465's `supersede` is live (S7): pruning a settled row a `superseded_by`
 * points AT leaves a dangling reference — harmless, decided deliberately: it is
 * provenance only, no FK, never joined for correctness. No special handling.)
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

/**
 * #464 — drain settled rows older than `before` in bounded batches until a batch
 * comes back short (the fixpoint) OR `maxBatches` is reached. Returns the total
 * deleted. Pure over the clock — the caller passes `before = now - retentionMs`.
 *
 * Signature mirrors `pruneSettledWakeups`' options object; the batching loop is
 * the shared `drainByBatches` (see `./retention.ts` — the identical discipline
 * the `webhook_deliveries` sweep uses).
 */
export function drainSettledWakeups(
  db: Db,
  opts: { before: number; batch?: number; maxBatches?: number },
): number {
  return drainByBatches((limit) => pruneSettledWakeups(db, { before: opts.before, limit }), {
    batch: opts.batch,
    maxBatches: opts.maxBatches,
  });
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
