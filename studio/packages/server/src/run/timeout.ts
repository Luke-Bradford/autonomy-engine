import { FAILURE_CODES, MAX_TIMER_DELAY_MS, type EngineEvent } from '@autonomy-studio/shared';

/**
 * #1600 OR41 C0a (#1 F3) — the activity timeout: `policy.timeoutSeconds` bounds
 * one ATTEMPT of an execution activity, measured from the moment its adapter
 * starts (after the global limiter grants a slot). On expiry the executor aborts
 * the attempt's controller with `ACTIVITY_TIMEOUT_REASON` — the same per-attempt
 * controller CX2's cancel aborts — and the attempt ends with
 * `activityTimeoutFailure`, which D4's retry policy then handles like any other
 * transient failure — unless the adapter said work may already be applied, when
 * it is permanent (#1804).
 *
 * In process, not a durable alarm. A `dispatched` attempt has a live pump, so an
 * out-of-band append behind it would race the pump's in-memory state; and after a
 * restart the attempt itself is gone — reconcile re-runs it (idempotent, with a
 * fresh budget) or interrupts the run (not idempotent). D4's "never an ephemeral
 * timer" is about the retry WAIT, which stays durable.
 *
 * Cooperative: the timeout is enforced through the attempt's `AbortSignal`, so an
 * adapter that cannot stop mid-call overruns it. A Postgres read checks the signal
 * between batches (a Postgres Script also cancels its block in flight at the
 * server, #1800), and better-sqlite3 is synchronous, so a long SQLite statement
 * blocks the event loop the timer runs on. There is deliberately no watchdog
 * (the run-cancellation spec settles the same for cancel): the pump waits for
 * the adapter so that no adapter work outlives the drive lock.
 */

/**
 * The abort REASON the timeout passes, so a failure the timeout caused can be told
 * apart from the run's cancel (`RUN_CANCELLED_REASON`) and from `runAdapter`'s own
 * `finally` abort. Compared by identity. An `AbortController` aborts once, so
 * whichever of cancel and timeout came first owns the attempt's outcome.
 */
export const ACTIVITY_TIMEOUT_REASON: unknown = Object.freeze({ activityTimedOut: true });

/**
 * D4's terminal for a timed-out attempt: transient, so retry applies uniformly.
 *
 * #1804 — except where the adapter reported that work may already be in the
 * store (`partialWritePossible`): a retry would repeat it, so the timeout keeps
 * the adapter's refusal. It is then `permanent`, still coded `timeout`, and its
 * error carries the adapter's (`refusal`), which says what stays applied.
 */
export function activityTimeoutFailure(
  runId: string,
  nodeId: string,
  attemptId: string,
  timeoutSeconds: number,
  refusal?: string,
): Extract<EngineEvent, { type: 'node.failed' }> {
  const timedOut = `activity timed out after ${timeoutSeconds}s`;
  return {
    type: 'node.failed',
    runId,
    nodeId,
    attemptId,
    error: refusal === undefined ? timedOut : `${timedOut} — ${refusal}`,
    kind: refusal === undefined ? 'transient' : 'permanent',
    code: FAILURE_CODES.TIMEOUT,
  };
}

/**
 * Call `fire` once, `ms` from now, re-arming in `MAX_TIMER_DELAY_MS` steps for a
 * longer span. Returns a cancel that stops it at any point.
 */
export function armDeadline(ms: number, fire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (remaining: number): void => {
    const step = Math.min(remaining, MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => {
      if (remaining > step) arm(remaining - step);
      else fire();
    }, step);
  };
  arm(ms);
  return () => clearTimeout(timer);
}
