import type { RunEvent } from '@autonomy-studio/shared';

/**
 * P6 — the RUN EVENT BUS: an in-process pub/sub the run driver publishes every
 * durably-appended `run_events` envelope to, keyed by `runId`, so the live
 * monitor WebSocket can tail a run without polling. It is the ONLY thing that
 * makes the append-log a live feed; it is not a source of truth (the DB is), so
 * a late-joiner always replays from the DB first and this bus only carries what
 * lands after they subscribe. Events are published AFTER the durable append (see
 * `appendEngineEvent`), so a subscriber never sees an event that isn't yet in
 * the log — a WS client can safely dedupe replay-vs-live by the monotonic `seq`.
 *
 * Per-app (a `createRunEventBus()` factory injected into `buildApp`, mirroring
 * `createSupervisor`/`createRunLauncher`), so two app instances in one process
 * never cross-deliver each other's run events (test isolation, multi-tenant).
 *
 * Delivery is SYNCHRONOUS on `publish` (called inside the driver's reduce↔persist
 * turn): a subscriber must therefore do only cheap, non-throwing work — the WS
 * route just buffers the event and returns. A subscriber that throws anyway is
 * ISOLATED (caught + reported via `onListenerError`), so one broken tail can
 * never break the publish loop, another subscriber, or — critically — the run
 * driver that is mid-pump. There is no buffering/backpressure here: a slow
 * consumer is the WS layer's problem (it debounces), not the bus's.
 */

export type RunEventListener = (event: RunEvent) => void;

export interface RunEventBus {
  /** Deliver `event` to every current subscriber of `event.runId`. Synchronous;
   * a no-op when the run has no subscribers. Never throws. */
  publish(event: RunEvent): void;
  /** Subscribe `listener` to a run's live events. Returns an idempotent
   * unsubscribe; calling it more than once (or from inside the listener) is
   * safe and removes only THIS subscription. */
  subscribe(runId: string, listener: RunEventListener): () => void;
  /** Current subscriber count for a run (observability/tests). */
  subscriberCount(runId: string): number;
}

export interface RunEventBusOptions {
  /** Invoked (never re-thrown) when a subscriber's callback throws, so a broken
   * tail is logged rather than silently swallowed or allowed to break publish. */
  onListenerError?: (err: unknown, runId: string) => void;
}

export function createRunEventBus(opts: RunEventBusOptions = {}): RunEventBus {
  const listeners = new Map<string, Set<RunEventListener>>();

  function publish(event: RunEvent): void {
    const set = listeners.get(event.runId);
    if (set === undefined) return;
    // Iterate a SNAPSHOT: a listener that unsubscribes (or subscribes) from
    // within its own callback must not mutate the set we are iterating.
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (err) {
        opts.onListenerError?.(err, event.runId);
      }
    }
  }

  function subscribe(runId: string, listener: RunEventListener): () => void {
    let set = listeners.get(runId);
    if (set === undefined) {
      set = new Set();
      listeners.set(runId, set);
    }
    set.add(listener);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = listeners.get(runId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) listeners.delete(runId);
    };
  }

  function subscriberCount(runId: string): number {
    return listeners.get(runId)?.size ?? 0;
  }

  return { publish, subscribe, subscriberCount };
}
