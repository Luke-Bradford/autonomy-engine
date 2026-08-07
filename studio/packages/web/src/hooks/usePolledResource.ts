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
 * PAUSES WHILE THE TAB IS HIDDEN. A monitoring page left open in a background
 * tab overnight would otherwise issue thousands of requests nobody is reading.
 * It refreshes IMMEDIATELY on becoming visible again, so the pause can never be
 * mistaken for stale data being presented as current — the returned
 * `lastUpdatedAt` is what the UI stamps so "as of" is always literally true.
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

    const load = async (): Promise<void> => {
      try {
        const next = await fetcher(controller.signal);
        if (cancelled) return;
        setData(next);
        setError(null);
        setLastUpdatedAt(Date.now());
      } catch (err) {
        // An abort is this effect tearing down, not a failure to report.
        if (cancelled || controller.signal.aborted) return;
        setError(messageOf(err));
      } finally {
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
