/**
 * #1534 — at most one holder per key, refused rather than queued.
 *
 * `KeyedQueue` is the queueing sibling: its callers must all run, in order. This
 * one is for work a caller may simply be told to retry — a second CSV export by
 * the same owner while the first is still walking its runs — where a queue would
 * only hold a connection open and let the waiting list grow without bound.
 *
 * Check and claim are one synchronous step, so two requests cannot both win.
 */
export class KeyedSlots {
  private readonly held = new Set<string>();

  /**
   * Claim `key`, or `null` when it is already held. The returned release is
   * idempotent: calling it twice never frees a slot a later holder has claimed.
   */
  tryAcquire(key: string): (() => void) | null {
    if (this.held.has(key)) return null;
    this.held.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held.delete(key);
    };
  }
}
