/**
 * #1207 — ONE iteration-bounded poll helper for the server suite.
 *
 * WHY ITERATIONS AND NOT A WALL CLOCK, which is the whole reason this exists.
 * A test that waits "up to 2000ms" for a condition is not bounded by the code
 * under test; it is bounded by how much of that budget a loaded machine takes
 * away. It then fails when the box is busy rather than when the code is wrong,
 * and a flaky REQUIRED check is the corrosive kind of failure — it trains a
 * reader to re-run until green, which is how a real failure gets waved through.
 * An iteration bound stretches WITH the load: 200 ticks are 200 ticks whether
 * each one takes 10ms or 40ms, so a slow machine gets a slow pass instead of a
 * spurious red. That is the argument #1124 made when it removed the wall clocks
 * from the gate, and `retry-alarm.test.ts` had been making since it was written.
 *
 * THREE COPIES BECAME ONE. `scheduler/__tests__/retry-alarm.test.ts` (200 x 2ms,
 * with the original of the argument above), `workers/__tests__/
 * process-supervisor.test.ts` (200 x 10ms) and `routes/__tests__/
 * run-stream.test.ts` — that last one the odd one out, a wall-clock 2000ms
 * deadline, i.e. a latent instance of exactly the flake class the other two were
 * written to avoid, in a file that had not reported it yet.
 *
 * A THROWING PREDICATE IS OPT-IN TOLERATED, not tolerated by default. Only
 * `retry-alarm` needs it, and it says why: before `run.started` folds there are
 * no nodes to look at, so an early poll legitimately throws, and "not there yet"
 * and "cannot tell yet" are the same answer to that loop. Making that the
 * default would be a REGRESSION for the other two, where a predicate that throws
 * is a broken predicate: today they fail immediately with the real stack, and a
 * silent retry would turn that into a timeout 200 polls later. Where tolerance
 * IS asked for, the last error is still carried out on the timeout's `cause`, so
 * a permanently-broken predicate is distinguishable from a slow one — which none
 * of the three copies managed.
 *
 * REAL TIMERS ONLY. The tick is a real `setTimeout`, so a suite running under
 * `vi.useFakeTimers()` would hang here rather than poll. None of the callers do;
 * a future one that does must advance the clock itself instead of using this.
 */

export interface UntilOptions {
  /** Polls before giving up. The BOUND — deliberately not a duration. */
  iterations?: number;
  /** Real milliseconds between polls. */
  tickMs?: number;
  /**
   * Treat a THROWING predicate as "not yet" rather than as a failure. Off by
   * default; see the docblock. The last error thrown is reported as the
   * timeout's `cause` either way.
   */
  tolerateThrow?: boolean;
}

/**
 * Poll `check` until it returns true, bounded by ITERATIONS.
 *
 * `label` is required and is what the timeout says — "timed out waiting for:
 * the run to reach node d" is a diagnosis; "until() timed out" is a second
 * investigation.
 */
export async function until(
  check: () => boolean,
  label: string,
  { iterations = 200, tickMs = 10, tolerateThrow = false }: UntilOptions = {},
): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < iterations; i++) {
    if (tolerateThrow) {
      try {
        if (check()) return;
      } catch (err) {
        lastError = err;
      }
    } else if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }
  throw new Error(
    `timed out waiting for: ${label} (${iterations} polls x ${tickMs}ms)`,
    lastError === undefined ? undefined : { cause: lastError },
  );
}
