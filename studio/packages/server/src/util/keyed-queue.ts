/**
 * #3 G2 — a per-key async task queue. Different keys are independent; one key's
 * tasks run one at a time, in submission order.
 *
 * Two users, both in-process by design:
 *  - every git operation for one owner runs through `run(ownerId, …)`, so two
 *    concurrent requests (connect + fetch, a double-fetch, disconnect racing a
 *    fetch) can never interleave their `git`/filesystem work on the same managed
 *    checkout. The server is the single writer to its managed checkouts, so
 *    process-local serialization IS the whole requirement — no lease table;
 *  - #1423 — the sqlite sink holds `acquire(store, signal)` across its write
 *    transaction, so two copies into one store in this process QUEUE rather than
 *    collide on SQLite's synchronous busy-wait (`connectors/sqlite-sink.ts`).
 */
export class KeyedQueue {
  /** Per-key chain tails; each stored tail is settled-swallowing (never rejects). */
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(key) ?? Promise.resolve();
    // The stored tail never rejects (see below), so a plain `.then` chains fn
    // after the predecessor regardless of how the predecessor fared.
    const next = tail.then(fn);
    // Store a rejection-swallowing guard, NOT `next` itself: the caller gets
    // the real promise (with its rejection), while the chain stays runnable —
    // one failed op must not poison every later op for that owner.
    const guard = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, guard);
    // Drop the map entry once the chain drains so idle keys don't accumulate.
    void guard.then(() => {
      if (this.tails.get(key) === guard) this.tails.delete(key);
    });
    return next;
  }

  /**
   * #1423 — hold the key's slot until the returned `release` is called, for a
   * critical section that does not fit one callback.
   *
   * `signal` bounds only the WAIT: aborting it while queued rejects with
   * `signal.reason` straight away, and the slot this caller would have held is
   * handed on untouched — the next waiter still runs after the current holder,
   * never alongside it. A signal aborted after the slot is granted does nothing
   * here; the holder sees it on its own signal checks. Rejection therefore means
   * exactly "aborted while waiting", and nothing else.
   *
   * `release` is idempotent, so a `finally` that may run twice cannot release a
   * later holder's slot.
   */
  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      // Single-threaded, so this flag settles the "abort lands as the slot is
      // granted" race: whichever runs first wins, and the other is a no-op.
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      void this.run(key, () => {
        signal?.removeEventListener('abort', onAbort);
        // Aborted while waiting: give the slot straight back.
        if (settled) return Promise.resolve();
        settled = true;
        return new Promise<void>((release) => resolve(() => release()));
      });
    });
  }
}
