import { and, asc, eq } from 'drizzle-orm';
import { externalWaits } from '../db/schema.js';
import { newId } from './ids.js';
import type { Db } from './types.js';

/**
 * #4 A13 — the `webhook` external-wait CORRELATION store (see `db/schema.ts`
 * `externalWaits`). Links a parked `(runId, nodeId, attemptId)` to its capability
 * token's SHA-256 hash, so an inbound callback can be authenticated + correlated,
 * and settles `pending` → `completed`/`expired` exactly once.
 *
 * The RAW token never lives here — only its hash. Every settle is `WHERE status =
 * 'pending'` so a completed row is never downgraded by a late timeout alarm (and
 * vice-versa), which is the durable half of the reducer's own idempotent fold.
 */

export type ExternalWaitRow = typeof externalWaits.$inferSelect;

/**
 * Idempotently RECORD a parked external wait: INSERT a fresh `pending` row keyed
 * by `(runId, nodeId, attemptId)`. If a row for that triple already exists (a
 * crash-recovery re-arm — the token is DERIVED deterministically, so the same
 * triple always reproduces the same `tokenHash`), the insert is a no-op and the
 * EXISTING row is returned. Either way the caller gets the canonical row, so the
 * `externalWait.created` event it then appends carries the row's real `expiresAt`.
 *
 * Ordering is arm-before-append: the driver calls this (and arms the alarm) BEFORE
 * appending `externalWait.created`, so an `external_wait_pending` node always has a
 * live correlation row + alarm.
 */
export function recordExternalWait(
  db: Db,
  input: {
    runId: string;
    nodeId: string;
    attemptId: string;
    tokenHash: string;
    expiresAt: number;
    now: number;
  },
): ExternalWaitRow {
  db.insert(externalWaits)
    .values({
      id: newId('ewait'),
      runId: input.runId,
      nodeId: input.nodeId,
      attemptId: input.attemptId,
      tokenHash: input.tokenHash,
      status: 'pending',
      createdAt: input.now,
      expiresAt: input.expiresAt,
      resolvedAt: null,
    })
    // ANY unique conflict (the (runId,nodeId,attemptId) OR the deterministic
    // token_hash — both collide together for the same triple) is a re-arm: keep the
    // ORIGINAL row rather than minting a second token/expiry.
    .onConflictDoNothing()
    .run();
  const row = getExternalWaitByAttempt(db, input.runId, input.nodeId, input.attemptId);
  if (row === null) {
    // Unreachable: we just inserted-or-ignored a row for exactly this triple.
    throw new Error(
      `external wait row missing after upsert for ${input.runId}/${input.nodeId}/${input.attemptId}`,
    );
  }
  return row;
}

/** The row a presented token maps to (looked up by its SHA-256 hash), any status,
 * or `null`. Returns whatever the status — the caller decides completability, so
 * an unknown token and a settled one stay INDISTINGUISHABLE to the caller. */
export function getExternalWaitByTokenHash(db: Db, tokenHash: string): ExternalWaitRow | null {
  return (
    db.select().from(externalWaits).where(eq(externalWaits.tokenHash, tokenHash)).get() ?? null
  );
}

function getExternalWaitByAttempt(
  db: Db,
  runId: string,
  nodeId: string,
  attemptId: string,
): ExternalWaitRow | null {
  return (
    db
      .select()
      .from(externalWaits)
      .where(
        and(
          eq(externalWaits.runId, runId),
          eq(externalWaits.nodeId, nodeId),
          eq(externalWaits.attemptId, attemptId),
        ),
      )
      .get() ?? null
  );
}

/** The `pending` external waits of a run (for the owner-scoped callback-URL
 * retrieval endpoint), oldest-created first. */
export function listPendingExternalWaitsByRun(db: Db, runId: string): ExternalWaitRow[] {
  return db
    .select()
    .from(externalWaits)
    .where(and(eq(externalWaits.runId, runId), eq(externalWaits.status, 'pending')))
    .orderBy(asc(externalWaits.createdAt))
    .all();
}

/** The correlation key both settle paths address a row by — the inbound route (from
 * the token-hash lookup's row) and the expiry alarm (from its `ref`) both hold it. */
export interface ExternalWaitAttempt {
  runId: string;
  nodeId: string;
  attemptId: string;
}

function settleExternalWait(
  db: Db,
  key: ExternalWaitAttempt,
  status: 'completed' | 'expired',
  now: number,
): boolean {
  const res = db
    .update(externalWaits)
    .set({ status, resolvedAt: now })
    .where(
      and(
        eq(externalWaits.runId, key.runId),
        eq(externalWaits.nodeId, key.nodeId),
        eq(externalWaits.attemptId, key.attemptId),
        eq(externalWaits.status, 'pending'),
      ),
    )
    .run();
  return res.changes > 0;
}

/**
 * Settle a `pending` row to `completed`, addressed by its `(runId,nodeId,attemptId)`.
 * Guarded `WHERE status = 'pending'` so it is idempotent and NEVER downgrades an
 * already-settled (expired) row. Returns `true` iff THIS call performed the settle
 * (exactly-once), which the inbound route uses to decide whether it is the one that
 * appends `externalWait.completed`.
 */
export function markExternalWaitCompleted(db: Db, key: ExternalWaitAttempt, now: number): boolean {
  return settleExternalWait(db, key, 'completed', now);
}

/**
 * Settle a `pending` row to `expired`. Guarded `WHERE status = 'pending'` so a
 * timeout alarm firing AFTER an inbound completion (the completed-then-timeout
 * race) is a no-op that never downgrades the completed row. Returns `true` iff THIS
 * call performed the settle.
 */
export function markExternalWaitExpired(db: Db, key: ExternalWaitAttempt, now: number): boolean {
  return settleExternalWait(db, key, 'expired', now);
}
