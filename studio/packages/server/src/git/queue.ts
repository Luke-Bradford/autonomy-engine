/**
 * #3 G2 — a per-key async task queue. Every git operation for one owner runs
 * through `run(ownerId, …)`, so two concurrent requests (connect + fetch, a
 * double-fetch, disconnect racing a fetch) can never interleave their
 * `git`/filesystem work on the same managed checkout. Different keys are
 * independent — one owner's slow clone never queues another owner.
 *
 * In-process only, deliberately: the server is the single writer to its
 * managed checkouts (they live under the server's own `workspaceGitRoot`),
 * so process-local serialization IS the whole requirement — no lease table.
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
}
