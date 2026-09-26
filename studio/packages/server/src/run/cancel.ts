import { FAILURE_CODES, type CancelSource, type EngineEvent } from '@autonomy-studio/shared';

/**
 * CX2 (#1320) — the process-wide cancel INTENTS and the live-pump POKE registry
 * (spec `2026-09-26-foundation-run-cancellation.md` D6).
 *
 * A cancel cannot be appended by whoever receives it. A live pump holds the run's
 * `RunState` in memory and never re-reads the log, so a `run.cancelRequested`
 * appended beside it would go unseen: the pump would keep dispatching from stale
 * state, and its later appends would land AFTER the cancel, so a replay would fold
 * a different history from the one that ran. So a cancel is recorded here as an
 * INTENT, and exactly one holder turns it into the durable fact: the live pump
 * (through its poke), or, once no pump holds the run, a drive under the run's lock.
 *
 * **An intent is consumed only at the moment it is folded.** A holder `peek`s it,
 * appends and folds the fact, then `take`s it, all in one synchronous tick, so an
 * intent is either still here or already in the log — never neither. An append
 * that throws leaves it here for the next holder. Node is single-threaded, so
 * that is what gives an intent exactly one consumer.
 *
 * In memory only, deliberately, and the crash window this leaves fails SAFE: an
 * intent lost with the process means the run resumes exactly as if nobody had
 * cancelled it, and the operator can cancel again. The route's `202` means
 * "requested", never "done".
 */
export interface RunCancels {
  /** Record a cancel. The FIRST source wins; a repeat is a no-op. */
  request(runId: string, source: CancelSource): void;
  /** Is a cancel waiting to be folded for this run? */
  pending(runId: string): boolean;
  /** Read the intent without consuming it. */
  peek(runId: string): CancelSource | undefined;
  /** Consume the intent. Call only in the tick that folds it, AFTER the append. */
  take(runId: string): CancelSource | undefined;
  /**
   * A live pump publishes how to wake it, for as long as it holds the run.
   * Returns the unregister function, which the pump calls BEFORE its teardown
   * starts dropping events: a poke that lands after that finds no pump, and the
   * intent waits in the map for the drive queued behind the lock.
   */
  registerPoke(runId: string, poke: () => void): () => void;
  /** Wake the run's live pump, if there is one. True when a pump was poked. */
  poke(runId: string): boolean;
}

export function createRunCancels(): RunCancels {
  const intents = new Map<string, CancelSource>();
  const pokes = new Map<string, () => void>();

  return {
    request(runId, source) {
      if (!intents.has(runId)) intents.set(runId, source);
    },
    pending: (runId) => intents.has(runId),
    peek: (runId) => intents.get(runId),
    take(runId) {
      const source = intents.get(runId);
      intents.delete(runId);
      return source;
    },
    registerPoke(runId, poke) {
      pokes.set(runId, poke);
      return () => {
        // Identity-checked: only the pump that registered may remove its entry.
        // One pump per run holds the drive lock at a time, but the check costs
        // nothing and keeps a stale unregister from orphaning a newer pump.
        if (pokes.get(runId) === poke) pokes.delete(runId);
      };
    },
    poke(runId) {
      const poke = pokes.get(runId);
      if (poke === undefined) return false;
      poke();
      return true;
    },
  };
}

/**
 * The abort REASON `executor.abortRun` passes, so a failure the cancel caused can
 * be told apart from the adapter's own (and from `runAdapter`'s own `finally`
 * abort, which carries no reason). Compared by identity.
 */
export const RUN_CANCELLED_REASON: unknown = Object.freeze({ runCancelled: true });

/**
 * The failure an attempt the cancel stopped ends with: aborted in flight and
 * failing without a terminal of its own, or never started at all. One builder,
 * used by the executor and by the pump, so the two cannot drift apart.
 */
export function runCancelledFailure(
  runId: string,
  nodeId: string,
  attemptId: string,
): Extract<EngineEvent, { type: 'node.failed' }> {
  return {
    type: 'node.failed',
    runId,
    nodeId,
    attemptId,
    error: 'run cancelled',
    kind: 'cancelled',
    code: FAILURE_CODES.RUN_CANCELLED,
  };
}
