import type { LimitFunction } from 'p-limit';

/**
 * #1720 — one bounded attempt against an operator-named store, answered within
 * a budget however the store behaves. Test connection (`connectors/probe.ts`)
 * and Preview / List tables (`datamove/preview.ts`) both run through it; each
 * keeps its own pool (`PROBE_CONCURRENCY` vs `PREVIEW_CONCURRENCY`, see
 * `limits.ts`), so the limiter is an argument.
 *
 * The CALLER's answer is settled independently of the SLOT. Racing the backstop
 * INSIDE the limited function was probe's first shape and it did not bound what
 * the cap exists to bound: `pLimit` frees a slot when the function it wrapped
 * settles, and that function settled on the RACE — so a hung adapter released
 * its slot after `backstopMs` while its socket (and, for postgres, its
 * server-side session) kept running, uncounted. Holding the slot until the REAL
 * attempt settles keeps live attempts at the pool's size; the caller is
 * answered on its own timer regardless.
 *
 * The timer starts BEFORE admission, so `backstopMs` is a TOTAL budget over
 * queue wait plus attempt. Holding slots through a hang means a saturated pool
 * can leave an attempt queued indefinitely, and a timer that only started on
 * admission would never fire for it. `onStop` is told whether the attempt was
 * admitted, so it can say "the store was slow" or "the server is busy"
 * honestly.
 *
 * An attempt that finds its caller already answered while it was queued
 * declines to start: opening a session now would spend a connection (and a
 * credential) on an answer nobody will read.
 *
 * `onStop` and `onThrow` must not throw — they build the caller's sentence and
 * run on a timer or inside the pool, where a throw has no caller to reach.
 */
export type BoundedStop = 'backstop' | 'cancelled';

export interface BoundedAttemptArgs<T> {
  readonly limit: LimitFunction;
  readonly backstopMs: number;
  /** The caller leaving (an HTTP request closed); answers with `cancelled`. */
  readonly signal?: AbortSignal;
  /** The attempt. Its signal aborts once the caller has been answered without it. */
  readonly work: (signal: AbortSignal) => Promise<T>;
  readonly onStop: (stop: BoundedStop, admitted: boolean) => T;
  /** A `work` that rejected rather than resolving a failure. */
  readonly onThrow: (err: unknown) => T;
}

export function runBounded<T>(args: BoundedAttemptArgs<T>): Promise<T> {
  const { limit, backstopMs, signal, work, onStop, onThrow } = args;

  const controller = new AbortController();
  let admitted = false;
  let settled = false;
  let settle!: (result: T) => void;
  const answer = new Promise<T>((resolve) => {
    // Once the caller has its answer nothing needs the timer or the listener,
    // however it was answered. The SLOT is a separate matter and stays held
    // until the work ends.
    settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
      resolve(result);
    };
  });
  function stop(reason: BoundedStop) {
    if (settled) return;
    settle(onStop(reason, admitted));
    controller.abort();
  }
  function onCallerAbort() {
    stop('cancelled');
  }

  const timer = setTimeout(() => stop('backstop'), backstopMs);
  // Never hold the process open. The case this timer exists for is a store
  // that has HUNG, so without `unref` a graceful `app.close()` could sit waiting
  // out the full backstop for an answer nobody is going to read.
  timer.unref?.();
  if (signal?.aborted === true) onCallerAbort();
  else signal?.addEventListener('abort', onCallerAbort, { once: true });

  void limit(async () => {
    if (settled) return;
    admitted = true;
    try {
      settle(await work(controller.signal));
    } catch (err) {
      if (!settled) settle(onThrow(err));
    }
  });

  return answer;
}
