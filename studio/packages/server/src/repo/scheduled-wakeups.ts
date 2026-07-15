import { and, asc, eq, inArray, lte } from 'drizzle-orm';
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
 * outcome or resurrect a spent alarm.
 */

/** `armWakeup` returns the durable row; `dedupeKey` is derived, never passed. */
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
    // be a no-op, not a resurrection. It also makes an armed alarm immutable —
    // `dueAt` moves only via `supersedeWakeup`, which mints a new key.
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
      supersededBy: null,
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
 * Oldest-first so a late alarm is never starved by a fresher one.
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
    .orderBy(asc(scheduledWakeups.dueAt))
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
  settle: { status: Exclude<WakeupStatus, 'pending'>; firedAt: number; supersededBy?: string },
): ScheduledWakeup | null {
  const updated = db
    .update(scheduledWakeups)
    .set({
      status: settle.status,
      firedAt: settle.firedAt,
      supersededBy: settle.supersededBy ?? null,
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
 */
export function cancelWakeup(db: Db, id: string, opts?: { at?: number }): ScheduledWakeup | null {
  return settleWakeup(db, id, { status: 'cancelled', firedAt: opts?.at ?? Date.now() });
}

export class WakeupSupersedeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WakeupSupersedeError';
  }
}

/**
 * Replace a pending alarm with a new one, atomically: cancel the old row (with
 * `supersededBy` naming its replacement) and arm the new one, in ONE
 * transaction. The `dueAt` mover — a heartbeat pushing a lease alarm out, a
 * backoff re-schedule (spec #5: "heartbeats supersede old alarms").
 *
 * The replacement MUST carry a new `discriminator`, and this refuses loudly if
 * it does not. Reason: arming is upsert-if-absent keyed by (kind, dedupeKey) —
 * that is exactly what gives replay its idempotency — so a same-key supersede
 * would find the just-cancelled row and return IT. The new alarm would never
 * arm, and nothing would say so: the silent-no-arm failure the spike documents.
 * Refusing turns a caller bug into an exception instead of a lost alarm.
 *
 * Atomic in the direction that matters: a refused replacement rolls the cancel
 * back, so a bad supersede leaves the old alarm ARMED rather than losing both.
 */
export function supersedeWakeup(
  db: Db,
  opts: { kind: string; oldDedupeKey: string; next: ArmWakeupInput; at?: number },
): ScheduledWakeup {
  const at = opts.at ?? Date.now();
  return db.transaction((tx) => {
    const old = selectByKey(tx, opts.kind, opts.oldDedupeKey);
    if (old === null) {
      throw new WakeupSupersedeError(
        `cannot supersede: no '${opts.kind}' wakeup with dedupeKey '${opts.oldDedupeKey}'`,
      );
    }
    if (old.status !== 'pending') {
      throw new WakeupSupersedeError(
        `cannot supersede '${old.id}': it is not pending (status '${old.status}')`,
      );
    }

    const nextKey = buildDedupeKey({
      kind: opts.next.kind,
      ref: opts.next.ref,
      discriminator: opts.next.discriminator,
    });
    if (opts.next.kind === opts.kind && nextKey === opts.oldDedupeKey) {
      throw new WakeupSupersedeError(
        `cannot supersede '${old.id}' with the same dedupeKey ('${nextKey}'): arming is ` +
          `upsert-by-key, so the replacement would silently resolve to the superseded row and ` +
          `never arm. Give the replacement a new discriminator.`,
      );
    }

    const replacement = armWakeup(tx, opts.next);
    settleWakeup(tx, old.id, { status: 'cancelled', firedAt: at, supersededBy: replacement.id });
    return replacement;
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
    .orderBy(asc(scheduledWakeups.dueAt))
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
