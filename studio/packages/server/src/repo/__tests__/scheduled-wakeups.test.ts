import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDedupeKey } from '@autonomy-studio/shared';
import { openDb } from '../../db/client.js';
import {
  armWakeup,
  cancelWakeup,
  deleteWakeup,
  getWakeup,
  getWakeupByKey,
  drainSettledWakeups,
  listDueWakeups,
  listPendingWakeups,
  pruneSettledWakeups,
  settleWakeup,
} from '../scheduled-wakeups.js';
import type { Db } from '../types.js';
import { freshDb } from './helpers.js';

/**
 * #5 S1 — the durable-alarm outbox's persistence layer. Real migrations, real
 * better-sqlite3, real UNIQUE index — no mocks (the DB constraint IS the
 * behaviour under test in several of these).
 */

const RETRY_REF = { runId: 'run_1', nodeId: 'a' };

function armRetry(db: Db, discriminator: string, dueAt = 1_000) {
  return armWakeup(db, { kind: 'retry', ref: RETRY_REF, dueAt, discriminator });
}

describe('#5 S1 — armWakeup', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb().db;
  });

  it('arms a pending row with a derived dedupeKey', () => {
    const row = armRetry(db, 'attempt-1');
    expect(row.status).toBe('pending');
    expect(row.firedAt).toBeNull();
    expect(row.dedupeKey).toBe(
      buildDedupeKey({ kind: 'retry', ref: RETRY_REF, discriminator: 'attempt-1' }),
    );
  });

  it('is IDEMPOTENT: re-arming the same key returns the existing row, not a second alarm', () => {
    // Spec #5: "scheduleRetry/scheduleWait commands upsert by deterministic key
    // (commands re-emit on replay)". A replay must not arm a duplicate.
    const first = armRetry(db, 'attempt-1');
    const second = armRetry(db, 'attempt-1');
    expect(second.id).toBe(first.id);
    expect(listPendingWakeups(db)).toHaveLength(1);
  });

  it('does NOT move dueAt on re-arm — an armed alarm is IMMUTABLE', () => {
    // There is deliberately no way to move a `dueAt`: re-scheduling (a backoff
    // push-out, a lease heartbeat) is S7's `supersede`, which needs a durable
    // `supersededBy` slot and a consumer to pin its semantics. Until then, a
    // later alarm is a NEW alarm under a new discriminator.
    const first = armRetry(db, 'attempt-1', 1_000);
    const second = armRetry(db, 'attempt-1', 9_999);
    expect(second.dueAt).toBe(1_000);
    expect(second.id).toBe(first.id);
  });

  it('re-arming an already-FIRED key is a no-op and does NOT resurrect it', () => {
    // The replay case: the reducer re-emits `scheduleRetry` for attempt-1 after
    // that alarm already fired. Resurrecting it would re-fire a retry that
    // already happened.
    const armed = armRetry(db, 'attempt-1');
    settleWakeup(db, armed.id, { status: 'fired', firedAt: 5_000 });

    const again = armRetry(db, 'attempt-1');
    expect(again.status).toBe('fired');
    expect(again.id).toBe(armed.id);
    expect(listPendingWakeups(db)).toHaveLength(0);
  });

  it('THE SPIKE REGRESSION: attempt-2 arms even though attempt-1 already fired', () => {
    // The spike's headline failure mode, proven against the REAL unique index:
    // with a discriminator-less key, attempt-2 would collide with attempt-1's
    // `fired` row and — because arming is upsert-if-absent — would silently
    // never arm. No error, no retry, no trace. This is the test that fails if
    // anyone drops the discriminator from `buildDedupeKey`.
    const first = armRetry(db, 'attempt-1');
    settleWakeup(db, first.id, { status: 'fired', firedAt: 5_000 });

    const second = armRetry(db, 'attempt-2');

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');
    expect(listPendingWakeups(db)).toHaveLength(1);
  });

  it('the same ref+discriminator under a different kind is a DIFFERENT alarm', () => {
    armRetry(db, 'attempt-1');
    const timer = armWakeup(db, {
      kind: 'timer',
      ref: RETRY_REF,
      dueAt: 1_000,
      discriminator: 'attempt-1',
    });
    expect(timer.status).toBe('pending');
    expect(listPendingWakeups(db)).toHaveLength(2);
  });

  it('rejects a malformed input at the boundary', () => {
    expect(() =>
      armWakeup(db, { kind: 'retry', ref: RETRY_REF, dueAt: 1, discriminator: '' }),
    ).toThrow();
  });
});

describe('#5 S1 — listDueWakeups (the claim scan)', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb().db;
  });

  it('returns pending rows due at or before now, oldest first', () => {
    armWakeup(db, { kind: 'retry', ref: RETRY_REF, dueAt: 300, discriminator: 'c' });
    armWakeup(db, { kind: 'retry', ref: RETRY_REF, dueAt: 100, discriminator: 'a' });
    armWakeup(db, { kind: 'retry', ref: RETRY_REF, dueAt: 200, discriminator: 'b' });

    const due = listDueWakeups(db, { kinds: ['retry'], now: 250 });

    // Oldest first: a late alarm must not be starved by a fresher one.
    expect(due.map((r) => r.dueAt)).toEqual([100, 200]);
  });

  it('breaks dueAt ties on id, so the claim order is stable across ticks', () => {
    // Alarms armed in the SAME millisecond are common (a fan-out arms a batch at
    // once). Without a tie-breaker SQLite may return equal-`dueAt` rows in a
    // different order across ticks and restarts, so a restarted or replayed tick
    // could claim the same-due batch in a different order than the run before it.
    const armed = [armRetry(db, 'z', 100), armRetry(db, 'a', 100), armRetry(db, 'm', 100)];
    const expected = [...armed].map((r) => r.id).sort();

    // Same query, repeatedly: the order must be identical AND id-ascending.
    for (let i = 0; i < 5; i++) {
      const due = listDueWakeups(db, { kinds: ['retry'], now: 250 });
      expect(due.map((r) => r.id)).toEqual(expected);
    }
    expect(listPendingWakeups(db).map((r) => r.id)).toEqual(expected);
  });

  it('excludes rows not yet due', () => {
    armRetry(db, 'attempt-1', 5_000);
    expect(listDueWakeups(db, { kinds: ['retry'], now: 4_999 })).toHaveLength(0);
    expect(listDueWakeups(db, { kinds: ['retry'], now: 5_000 })).toHaveLength(1);
  });

  it('excludes rows that are already settled', () => {
    const a = armRetry(db, 'attempt-1', 100);
    settleWakeup(db, a.id, { status: 'fired', firedAt: 150 });
    const b = armRetry(db, 'attempt-2', 100);
    settleWakeup(db, b.id, { status: 'suppressed', firedAt: 150 });
    const c = armRetry(db, 'attempt-3', 100);
    cancelWakeup(db, c.id, 150);

    expect(listDueWakeups(db, { kinds: ['retry'], now: 9_999 })).toHaveLength(0);
  });

  it('NEVER claims an unregistered kind — the row stays pending and recoverable', () => {
    // A kind with no handler (a downgrade, or a kind retired mid-rollout) must
    // not be claimed-and-dropped. Filtering the scan by registered kinds leaves
    // the row visible and pending: no spin, no loss, and it fires normally once
    // the kind is registered again.
    armWakeup(db, { kind: 'from_the_future', ref: RETRY_REF, dueAt: 100, discriminator: 'x' });

    expect(listDueWakeups(db, { kinds: ['retry'], now: 9_999 })).toHaveLength(0);
    expect(listPendingWakeups(db)).toHaveLength(1);
    expect(listDueWakeups(db, { kinds: ['retry', 'from_the_future'], now: 9_999 })).toHaveLength(1);
  });

  it('an empty kind list claims nothing (an alarm clock with no handlers is inert)', () => {
    armRetry(db, 'attempt-1', 100);
    expect(listDueWakeups(db, { kinds: [], now: 9_999 })).toHaveLength(0);
  });

  it('pending rows SURVIVE a real process restart — the headline S1 win', () => {
    // The whole point of the table, so this test is deliberately NOT run
    // against `:memory:` (which cannot outlive its connection and would make
    // the assertion vacuous): a real file, genuinely CLOSED, genuinely
    // re-opened. A `setTimeout` dies with the process; a ROW does not. This is
    // what "survives restart, re-armed at boot" means, and it is proven rather
    // than asserted.
    const dir = mkdtempSync(join(tmpdir(), 'studio-s1-'));
    const file = join(dir, 'wakeups.db');
    try {
      const first = openDb(file);
      armWakeup(first.db, { kind: 'retry', ref: RETRY_REF, dueAt: 100, discriminator: 'a' });
      first.sqlite.close(); // the "crash"

      const rebooted = openDb(file); // the boot
      try {
        const due = listDueWakeups(rebooted.db, { kinds: ['retry'], now: 9_999 });
        expect(due).toHaveLength(1);
        expect(due[0]!.dueAt).toBe(100);
        expect(due[0]!.ref).toEqual(RETRY_REF);
      } finally {
        rebooted.sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#5 S1 — settle / cancel', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb().db;
  });

  it('settles a pending row to fired with a firedAt stamp', () => {
    const row = armRetry(db, 'attempt-1');
    const settled = settleWakeup(db, row.id, { status: 'fired', firedAt: 5_000 });
    expect(settled?.status).toBe('fired');
    expect(settled?.firedAt).toBe(5_000);
  });

  it('settling is a ONE-WAY door: an already-settled row is never re-settled', () => {
    // At-least-once delivery means a row can be picked up twice in a crash
    // window; the second settle must not overwrite the first outcome (nor
    // resurrect a cancelled alarm as `fired`).
    const row = armRetry(db, 'attempt-1');
    settleWakeup(db, row.id, { status: 'fired', firedAt: 5_000 });

    const second = settleWakeup(db, row.id, { status: 'suppressed', firedAt: 9_000 });

    expect(second).toBeNull();
    expect(getWakeupByKey(db, 'retry', row.dedupeKey)?.status).toBe('fired');
    expect(getWakeupByKey(db, 'retry', row.dedupeKey)?.firedAt).toBe(5_000);
  });

  it('cancels a pending alarm', () => {
    const row = armRetry(db, 'attempt-1');
    expect(cancelWakeup(db, row.id, 5_000)?.status).toBe('cancelled');
    expect(listPendingWakeups(db)).toHaveLength(0);
  });

  it('cancelling an already-fired alarm is refused', () => {
    const row = armRetry(db, 'attempt-1');
    settleWakeup(db, row.id, { status: 'fired', firedAt: 5_000 });
    expect(cancelWakeup(db, row.id, 9_000)).toBeNull();
    expect(getWakeupByKey(db, 'retry', row.dedupeKey)?.status).toBe('fired');
  });

  it('deleteWakeup removes a pending row and FREES its (kind, dedupeKey)', () => {
    // The property the schedule reconciler needs: after a delete, re-arming the
    // SAME (kind, dedupeKey) inserts a fresh PENDING row rather than returning a
    // dead one — the collision `cancelWakeup` would leave.
    const row = armRetry(db, 'attempt-1');
    expect(deleteWakeup(db, row.id)?.id).toBe(row.id);
    expect(getWakeup(db, row.id)).toBeNull();
    expect(listPendingWakeups(db)).toHaveLength(0);

    const rearmed = armRetry(db, 'attempt-1');
    expect(rearmed.status).toBe('pending');
    expect(listPendingWakeups(db)).toHaveLength(1);
  });

  it('deleteWakeup REFUSES a settled row — a fired outcome is permanent', () => {
    const row = armRetry(db, 'attempt-1');
    settleWakeup(db, row.id, { status: 'fired', firedAt: 5_000 });
    expect(deleteWakeup(db, row.id)).toBeNull();
    expect(getWakeup(db, row.id)?.status).toBe('fired');
  });
});

describe('#464 — pruneSettledWakeups (retention)', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb().db;
  });

  /** Arm a pending row under a unique discriminator, then settle it at `firedAt`. */
  function settled(
    discriminator: string,
    status: 'fired' | 'suppressed' | 'cancelled',
    firedAt: number,
  ) {
    const row = armRetry(db, discriminator);
    return settleWakeup(db, row.id, { status, firedAt })!;
  }

  it('deletes settled rows OLDER than the cutoff, keeps NEWER ones', () => {
    const old = settled('attempt-1', 'fired', 1_000);
    const recent = settled('attempt-2', 'fired', 9_000);

    const deleted = pruneSettledWakeups(db, { before: 5_000 });

    expect(deleted).toBe(1);
    expect(getWakeup(db, old.id)).toBeNull();
    expect(getWakeup(db, recent.id)?.id).toBe(recent.id);
  });

  it('NEVER prunes pending rows, however old their dueAt — the claim scan must keep them', () => {
    // A pending row has firedAt = null, so the `firedAt < before` predicate never
    // selects it. Belt-and-suspenders on the `status != 'pending'` filter: an
    // armed alarm is the one thing retention must never touch.
    const armed = armRetry(db, 'attempt-1', /* dueAt far in the past */ 1);

    const deleted = pruneSettledWakeups(db, { before: 10_000 });

    expect(deleted).toBe(0);
    expect(getWakeup(db, armed.id)?.status).toBe('pending');
    expect(listPendingWakeups(db)).toHaveLength(1);
  });

  it('prunes every SETTLED status — fired, suppressed AND cancelled', () => {
    const f = settled('attempt-1', 'fired', 1_000);
    const s = settled('attempt-2', 'suppressed', 1_000);
    const c = settled('attempt-3', 'cancelled', 1_000);

    const deleted = pruneSettledWakeups(db, { before: 5_000 });

    expect(deleted).toBe(3);
    for (const row of [f, s, c]) expect(getWakeup(db, row.id)).toBeNull();
  });

  it('is EXCLUSIVE on the boundary: a row settled exactly AT the cutoff is retained', () => {
    // `firedAt < before`, strict. The cutoff is `now - retentionMs`, so a row
    // exactly at the floor is still within the safe window and must survive —
    // this strictness is what keeps a fired key un-prunable until it is provably
    // past every consumer's replay window (the idempotency guarantee).
    const atCutoff = settled('attempt-1', 'fired', 5_000);
    const justUnder = settled('attempt-2', 'fired', 4_999);

    const deleted = pruneSettledWakeups(db, { before: 5_000 });

    expect(deleted).toBe(1);
    expect(getWakeup(db, atCutoff.id)?.id).toBe(atCutoff.id);
    expect(getWakeup(db, justUnder.id)).toBeNull();
  });

  it('is BOUNDED by `limit`, deleting the OLDEST rows first', () => {
    const a = settled('attempt-1', 'fired', 1_000);
    const b = settled('attempt-2', 'fired', 2_000);
    const c = settled('attempt-3', 'fired', 3_000);

    const deleted = pruneSettledWakeups(db, { before: 10_000, limit: 2 });

    expect(deleted).toBe(2);
    // Oldest two gone; the newest survives for the next sweep.
    expect(getWakeup(db, a.id)).toBeNull();
    expect(getWakeup(db, b.id)).toBeNull();
    expect(getWakeup(db, c.id)?.id).toBe(c.id);
  });

  it('returns 0 when nothing is due for pruning', () => {
    settled('attempt-1', 'fired', 9_000);
    expect(pruneSettledWakeups(db, { before: 5_000 })).toBe(0);
  });

  it('drainSettledWakeups DRAINS a whole backlog to a fixpoint in bounded batches', () => {
    // A batch smaller than the backlog must still fully drain — the loop runs
    // until a batch comes back short. This is what stops a high-volume instance
    // from capping at `batch` rows/sweep forever.
    for (let i = 0; i < 5; i++) settled(`attempt-${i}`, 'fired', 1_000 + i);

    const total = drainSettledWakeups(db, { before: 10_000, batch: 2 });

    expect(total).toBe(5);
    // Fully drained: a further drain finds nothing.
    expect(drainSettledWakeups(db, { before: 10_000, batch: 2 })).toBe(0);
  });

  it('drainSettledWakeups respects the cutoff — leaves rows newer than `before`', () => {
    settled('attempt-1', 'fired', 1_000);
    settled('attempt-2', 'fired', 9_000);
    expect(drainSettledWakeups(db, { before: 5_000, batch: 10 })).toBe(1);
  });

  it('drainSettledWakeups clamps a non-positive batch to 1 rather than spinning forever', () => {
    // A `batch <= 0` would prune 0 rows per call and never break (`0 < 0` is
    // false). The clamp guarantees forward progress for a mistaken caller.
    settled('attempt-1', 'fired', 1_000);
    settled('attempt-2', 'fired', 1_001);
    expect(drainSettledWakeups(db, { before: 10_000, batch: 0 })).toBe(2);
  });
});
