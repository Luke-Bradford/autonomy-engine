/**
 * Shared retention machinery for the durable ledgers that grow without bound
 * (settled `scheduled_wakeups` #464, `webhook_deliveries` #421). Each ledger owns
 * its own `prune(before, limit)` (the WHERE clause + safety argument is
 * ledger-specific), but the BATCHING discipline — drain to a fixpoint in bounded
 * batches so no single sweep holds the single-writer lock for long — is identical
 * and lives here once.
 */

/**
 * Default per-batch bound for a `drainByBatches` sweep — big enough that a normal
 * sweep is one batch, small enough that a months-deep backlog is pruned in
 * bounded DELETEs rather than one statement holding the single writer lock.
 */
export const RETENTION_BATCH = 1_000;

/**
 * Cap on batches a RECURRING sweep prunes per invocation (≤ 50k rows/batch-of-1k).
 * better-sqlite3 is synchronous and the server is single-threaded, so an UNBOUNDED
 * drain-to-fixpoint on the housekeeping timer would block all in-flight HTTP
 * requests for its whole duration if a backlog ever accumulated (retention
 * re-enabled after being off, a long pause). Bounding each recurring sweep keeps
 * that stall short; the leftover of a large backlog drains across the following
 * sweeps (each batch is a fast indexed DELETE). The BOOT sweep passes no cap — a
 * one-time full drain before the server accepts requests.
 */
export const RETENTION_MAX_BATCHES_PER_SWEEP = 50;

/**
 * Drain a bounded prune to a fixpoint: repeatedly call `prune(batch)` until a
 * batch comes back SHORT (`< batch` — nothing left to prune) OR `maxBatches`
 * invocations are reached. Returns the total pruned. Pure over the clock — the
 * caller bakes `before = now - retentionMs` into its `prune` closure.
 *
 * `batch` is clamped to ≥ 1 so a mistaken `batch <= 0` (which would prune 0 rows
 * forever, since a short batch never arrives) can never spin. `maxBatches`
 * (default unbounded) caps a single invocation so a recurring sweep can bound its
 * blocking — see `RETENTION_MAX_BATCHES_PER_SWEEP`.
 */
export function drainByBatches(
  prune: (limit: number) => number,
  opts: { batch?: number; maxBatches?: number } = {},
): number {
  const batch = Math.max(1, opts.batch ?? RETENTION_BATCH);
  const maxBatches = opts.maxBatches ?? Infinity;
  let total = 0;
  let batches = 0;
  for (;;) {
    if (batches >= maxBatches) break;
    const n = prune(batch);
    total += n;
    batches++;
    if (n < batch) break;
  }
  return total;
}
