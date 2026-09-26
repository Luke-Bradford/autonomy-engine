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
  /**
   * CX3 (#1320, spec D8) — ask every live, announced, non-detached child of
   * `parentRunId` to cancel, with `source`. Best-effort and never throws: the
   * parent's own fold or terminal must not wait on, or fail for, its children.
   * Each child folds its own cancel, whose own fold reaches ITS children, so this
   * needs no recursion.
   *
   * On the registry, not threaded as a separate dependency, because every holder
   * that folds a cancel already holds this registry (the intent it folds came
   * from here), so no holder can fold a cancel and miss the propagation.
   */
  cancelChildren(parentRunId: string, source: CancelSource): void;
}

export interface RunCancelsOptions {
  /** What `cancelChildren` does. Absent means children are not reached (tests
   * that exercise one run). Production wires `cancelLiveChildren`. */
  cancelChildren?: (parentRunId: string, source: CancelSource) => void;
}

export function createRunCancels(options: RunCancelsOptions = {}): RunCancels {
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
    cancelChildren(parentRunId, source) {
      options.cancelChildren?.(parentRunId, source);
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

/**
 * CX3 (#1320) — the answer a `startChild` gets when the cancel folded while it
 * sat in the per-run cap's queue: its child was never created, so it never ran,
 * and the call node (already `waiting` on this attempt) resolves as a child that
 * the cancel stopped. `node.failed` cannot do this: a `waiting` call node takes
 * only `call.returned`/`call.detached`. `childRunId` is the command's own, the
 * deterministic id the reducer checks.
 */
export function childNeverStarted(
  runId: string,
  command: { callNodeId: string; attemptId: string; childRunId: string },
): Extract<EngineEvent, { type: 'call.returned' }> {
  return {
    type: 'call.returned',
    runId,
    callNodeId: command.callNodeId,
    attemptId: command.attemptId,
    childRunId: command.childRunId,
    childOutcome: 'cancelled',
    outputs: {},
  };
}
