import { useCallback, useEffect, useState } from 'react';
import { messageOf } from '../api/client';

/**
 * #917 — a fetch that can refresh itself, and can be told not to.
 *
 * The app had no polling at all before this: every list refreshes on an explicit
 * button and the run detail rides a per-run WebSocket. That is still the right
 * default, so this hook makes the interval OPTIONAL — omit `intervalMs` and it
 * is a load-on-mount-plus-manual-refresh hook, which is the only form the quota
 * panel is allowed to use (polling the provider on a timer is the contention the
 * one-sampler invariant forbids).
 *
 * PAUSES THE CADENCE WHILE THE TAB IS HIDDEN. A monitoring page left open in a
 * background tab overnight would otherwise issue thousands of requests nobody is
 * reading. The pause governs the TIMER, not the initial load: the load on mount
 * runs regardless of visibility, because the interval-less callers (the quota
 * panel, the triggers page) return before the visibility listener is even
 * registered, and gating it would leave them with no data at all and no route
 * to any but a manual refresh.
 *
 * It asks for a refresh on becoming visible again — skipped, per the one-load
 * rule below, if a request is already outstanding, which is not a loss because
 * fresh data is by definition already on its way. The pause therefore cannot be
 * mistaken for stale data presented as current, but that guarantee rests on
 * `lastUpdatedAt` rather than on the wake refresh: it is stamped with the moment
 * the request was ISSUED, so the UI's "as of" is literally true even for a
 * response that was in flight across the whole hidden period.
 *
 * NOT THE HOOK FOR A LIST THAT RELOADS AFTER A MUTATION — use `useGuardedLoad`.
 * The two sit side by side with OPPOSITE drop rules, and picking the wrong one
 * is silent: this hook drops the NEW load while one is in flight, which is right
 * for a poller and exactly wrong for a post-mutation refresh, because the
 * refresh is the load that must win. That one drops the stale ANSWER instead.
 *
 * THE FETCHER MUST BE MEMOIZED (`useCallback`). It is a dependency of the effect
 * below, which is what makes a fetcher that closes over changed state — a new
 * window, a new filter — actually refetch rather than keep serving the old
 * query. The cost of that correctness is that an unmemoized inline arrow would
 * re-arm the interval on every render, and at a 5s cadence could approach never
 * firing. Memoizing is the caller's half of the contract.
 */
export interface PolledResource<T> {
  data: T | null;
  error: string | null;
  /** True during the FIRST load only; a background refresh must not blank the page. */
  loading: boolean;
  /** When `data` was last successfully fetched, epoch ms; `null` before the first success. */
  lastUpdatedAt: number | null;
  refresh: () => void;
}

export function usePolledResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: { intervalMs?: number } = {},
): PolledResource<T> {
  const { intervalMs } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    /*
     * ONE LOAD AT A TIME (#1000). Ticks used to fire whether or not the previous
     * request had come back, and nothing capped or cancelled the result: the
     * `AbortController` here is per-EFFECT, so its abort means "tear down" and
     * cannot be reused to cancel a single poll. Whenever the endpoint was slower
     * than `intervalMs`, requests therefore accumulated WITHOUT BOUND for as long
     * as that lasted.
     *
     * A tick that lands while a load is outstanding is dropped rather than
     * queued. The cadence degrades to the server's real speed, which is the
     * honest behaviour: a page that cannot be refreshed every 5s should poll
     * every 5s in name only. Known cost, accepted deliberately — a request that
     * never returns now parks the panel until something remounts the effect (a
     * new `fetcher`, `intervalMs` or `refresh()`, each of which aborts it via the
     * dependency change), where before a later tick could still land. The
     * alternative shape — a per-load controller cancelling the previous request —
     * is bounded too, but on a consistently slow server every request would be
     * cancelled before completing and the panel would render nothing at all.
     *
     * This REPLACES the monotonic latest-wins token that used to live here. With
     * one load at a time, results cannot arrive out of order within an effect,
     * and across effects `cancelled` already discards them — so the token had
     * become unreachable, and unreachable defence behind tests that can no longer
     * exercise it is its own defect.
     *
     * `lastUpdatedAt` is stamped at ISSUE, not at resolution. That is what keeps
     * the UI's "as of" true rather than an understatement of how old the figures
     * are, and it matters more under this guard than it did before: a response
     * may now be outstanding for far longer than one interval — across an entire
     * hidden-tab period, since pausing the timer does not abort a request already
     * in flight.
     */
    let inFlight = false;

    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      const issuedAt = Date.now();
      try {
        const next = await fetcher(controller.signal);
        if (cancelled) return;
        setData(next);
        setError(null);
        setLastUpdatedAt(issuedAt);
      } catch (err) {
        // An abort is this effect tearing down, not a failure to report.
        if (cancelled || controller.signal.aborted) return;
        setError(messageOf(err));
      } finally {
        // UNCONDITIONALLY, and on the rejection path too: a guard left set by a
        // failed load would park the panel dead for this effect's whole life,
        // which is a worse bug than the pile-up it exists to prevent.
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    if (intervalMs === undefined) {
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    let timer: ReturnType<typeof setInterval> | undefined;
    const start = (): void => {
      timer ??= setInterval(() => void load(), intervalMs);
    };
    const stop = (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        stop();
      } else {
        // Refresh at once, THEN resume the cadence: the first post-wake tick
        // would otherwise be a whole interval away, showing data from before
        // the tab was hidden under a stamp that keeps looking recent.
        void load();
        start();
      }
    };

    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      controller.abort();
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetcher, intervalMs, reloadKey]);

  return { data, error, loading, lastUpdatedAt, refresh };
}
