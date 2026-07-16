import pLimit, { type LimitFunction } from 'p-limit';

/**
 * #1 F2c — the per-run DRIVE registry: the primitive that makes "exactly one
 * drive per run" structural rather than accidental.
 *
 * `executor.ts` states the invariant this enforces: *"within a single run the
 * driver's `pump` is sequential"*. Until F2c that was true only because the
 * LAUNCHER was the sole thing that could pump a run. The retry alarm is a SECOND
 * entry point, and nothing serialized the two: each `pump` carries its own
 * in-memory `RunState` (`driver.ts` — `let state = initialState`) and never
 * re-reads the log, so two concurrent drives diverge permanently and BOTH write.
 * Measured before this existed: a shared successor dispatched TWICE under the
 * same `attemptId` (a real LLM call billed twice), then the run hung with no
 * `run.finished`.
 *
 * Serializing is only HALF the fix, and the other half lives in `driveRun`: a
 * second drive that waits its turn and then pumps its own STALE snapshot still
 * diverges. The lock exists so that re-projecting from the log has a window in
 * which nothing else can append — the two are one mechanism.
 *
 * Per RUN, never global: one slow LLM call must not queue every other run in the
 * system behind it.
 */

export interface RunDrives {
  /**
   * Run `work` with exclusive access to `runId`, queued behind any drive already
   * running for it. FIFO. `work`'s resolution/rejection is passed straight
   * through to THIS caller and to nobody else — a thrown drive must not wedge
   * the run's later retries.
   *
   * REGISTERS SYNCHRONOUSLY: when this returns, `idle()` is already false. The
   * alarm clock does not await `afterCommit`, so `whenIdle()` is the only handle
   * on an alarm-spawned drive; a late registration would make it resolve before
   * the drive it is meant to await had even started.
   */
  serialize<T>(runId: string, work: () => Promise<T>): Promise<T>;
  /** Resolve once every drive (including ones drives spawn) has settled. */
  whenIdle(): Promise<void>;
  /** Whether any drive is running or queued. */
  idle(): boolean;
  /** How many runs currently have a live chain — a leak check for tests. */
  size(): number;
}

export function createRunDrives(): RunDrives {
  /**
   * One `pLimit(1)` per run IS the per-run mutex: p-limit already gives FIFO
   * ordering, synchronous registration (`pendingCount` reflects the call before
   * it returns), and rejection isolation — all verified against p-limit@7, all
   * pinned in `drives.test.ts`. It is already a dependency (`executor.ts`'s
   * worker pool uses it), so hand-rolling a promise chain here would be a second,
   * less-tested implementation of the same thing.
   */
  const byRun = new Map<string, LimitFunction>();
  /** Every drive not yet settled — `whenIdle`'s handle, mirroring `launcher.ts`. */
  const outstanding = new Set<Promise<void>>();

  function serialize<T>(runId: string, work: () => Promise<T>): Promise<T> {
    let limit = byRun.get(runId);
    if (limit === undefined) {
      limit = pLimit(1);
      byRun.set(runId, limit);
    }
    const slot = limit;
    const result = slot(work);

    // Drop the entry once this run's chain drains, so a long-lived server does
    // not accumulate one limiter per run it has ever driven. Checked AFTER the
    // drive settles, and re-checked against the live entry: a drive queued in the
    // meantime keeps the chain (and its limiter) alive, and `byRun.get` may by
    // then be a DIFFERENT limiter — deleting that one would hand two concurrent
    // callers separate locks, which is the bug this module exists to prevent.
    //
    // `catch(() => undefined)` FIRST so this bookkeeping chain never rejects: the
    // caller owns `result`'s rejection, and a second unhandled branch off it
    // would crash the process. It does not swallow anything — `result` itself is
    // returned unmodified.
    const settled: Promise<void> = result
      .catch(() => undefined)
      .then(() => {
        if (slot.activeCount === 0 && slot.pendingCount === 0 && byRun.get(runId) === slot) {
          byRun.delete(runId);
        }
      });
    // Added SYNCHRONOUSLY (before this returns) — see `serialize`'s contract.
    outstanding.add(settled);
    void settled.finally(() => outstanding.delete(settled));
    return result;
  }

  async function whenIdle(): Promise<void> {
    // Loops rather than awaiting one snapshot: a drive can SPAWN another drive (a
    // retry's pump arming the next attempt, a call node's child), so the set is
    // not fixed at entry. A settling drive's `finally` removes it before this
    // `allSettled` resolves, so re-checking is what catches the spawned one.
    // Same shape and same reason as `launcher.ts`'s `whenIdle`.
    while (outstanding.size > 0) {
      await Promise.allSettled([...outstanding]);
    }
  }

  return {
    serialize,
    whenIdle,
    idle: () => outstanding.size === 0,
    size: () => byRun.size,
  };
}
