import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePolledResource } from './usePolledResource';

/**
 * #917 — the polling contract. The interesting properties are all about NOT
 * fetching: no timer unless one is asked for, none while the tab is hidden.
 */

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePolledResource', () => {
  it('loads once on mount and reports the value', async () => {
    const fetcher = vi.fn().mockResolvedValue('first');

    const { result } = renderHook(() => usePolledResource(fetcher));

    await waitFor(() => expect(result.current.data).toBe('first'));
    expect(result.current.loading).toBe(false);
    expect(result.current.lastUpdatedAt).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  /**
   * The load-bearing one. The quota panel relies on omitting `intervalMs` to
   * stay off a timer entirely — a regression here would turn an open tab into a
   * second continuous poller of the provider.
   */
  it('never polls when no interval is given', async () => {
    const fetcher = vi.fn().mockResolvedValue('x');

    renderHook(() => usePolledResource(fetcher));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('re-fetches on the interval when one is given', async () => {
    const fetcher = vi.fn().mockResolvedValue('x');

    renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });

    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('stops polling while the tab is hidden and refreshes on return', async () => {
    const fetcher = vi.fn().mockResolvedValue('x');

    renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    act(() => setVisibility('hidden'));
    const whileHidden = fetcher.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(whileHidden);

    // Returning refreshes AT ONCE rather than waiting out a whole interval,
    // so the stamp the UI renders is never a whole cadence behind.
    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher.mock.calls.length).toBe(whileHidden + 1);
  });

  it('refetches when the memoized fetcher changes', async () => {
    const first = vi.fn().mockResolvedValue('1h');
    const second = vi.fn().mockResolvedValue('24h');

    const { result, rerender } = renderHook(
      ({ f }: { f: () => Promise<string> }) => usePolledResource(f),
      { initialProps: { f: first } },
    );
    await waitFor(() => expect(result.current.data).toBe('1h'));

    rerender({ f: second });

    await waitFor(() => expect(result.current.data).toBe('24h'));
    expect(second).toHaveBeenCalledTimes(1);
  });

  /**
   * Polls OVERLAP — a tick fires whether or not the previous request came back.
   * Applying results in resolution order would let a slow early request land on
   * top of a fresh later one, and stamp `lastUpdatedAt` with the moment the
   * STALE response arrived, making the page's "as of" text an understatement of
   * how old the figures are. Latest-wins is what makes that claim honest.
   */
  it('ignores a slow earlier response that resolves after a newer one', async () => {
    const resolvers: Array<(value: string) => void> = [];
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const { result } = renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
    await waitFor(() => expect(resolvers).toHaveLength(1));

    // A second poll starts while the first is still in flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(resolvers).toHaveLength(2);

    // The NEWER request answers first…
    await act(async () => {
      resolvers[1]!('fresh');
    });
    await waitFor(() => expect(result.current.data).toBe('fresh'));
    const stampAfterFresh = result.current.lastUpdatedAt;

    // …and then the older one finally lands. It must be discarded outright.
    await act(async () => {
      resolvers[0]!('stale');
    });

    expect(result.current.data).toBe('fresh');
    expect(result.current.lastUpdatedAt).toBe(stampAfterFresh);
  });

  it('does not let a stale rejection overwrite a newer success', async () => {
    const settlers: Array<{ resolve: (v: string) => void; reject: (e: Error) => void }> = [];
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          settlers.push({ resolve, reject });
        }),
    );

    const { result } = renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
    await waitFor(() => expect(settlers).toHaveLength(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(settlers).toHaveLength(2);

    await act(async () => {
      settlers[1]!.resolve('fresh');
    });
    await waitFor(() => expect(result.current.data).toBe('fresh'));

    await act(async () => {
      settlers[0]!.reject(new Error('stale failure'));
    });

    expect(result.current.error).toBeNull();
    expect(result.current.data).toBe('fresh');
  });

  it('surfaces a failure as an error and clears it on the next success', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('recovered');

    const { result } = renderHook(() => usePolledResource(fetcher, { intervalMs: 1_000 }));

    await waitFor(() => expect(result.current.error).toBe('boom'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    await waitFor(() => expect(result.current.data).toBe('recovered'));
    expect(result.current.error).toBeNull();
  });

  it('refreshes on demand', async () => {
    const fetcher = vi.fn().mockResolvedValue('x');

    const { result } = renderHook(() => usePolledResource(fetcher));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    act(() => result.current.refresh());

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});

/**
 * #989 — the TEARDOWN half of the contract, which nothing pinned until now.
 *
 * The tab showing `/monitor/ai` crashed once and auto-reloaded (an OOM or a
 * runaway allocation, not a plain exception), and this hook was the suspect: it
 * is the app's only polling primitive, and a polled surface is the classic home
 * for a timer that compounds instead of being replaced, a retained set that
 * grows, or a cleanup that leaves orphans behind on unmount.
 *
 * These tests are the MEASUREMENT that settles the suspicion rather than a
 * reading of the code. They are deliberately about what does NOT happen after
 * the component goes away — which is exactly the half the original suite left
 * to inspection, because every existing case here keeps the hook mounted.
 *
 * WHAT THIS LEVEL CANNOT SEE: `unmount()` is not how the page unmounts in
 * production, where a react-router route swap does it. The equivalent assertion
 * at that layer — navigate away, watch the request count stay frozen — lives in
 * `e2e/monitor-ai-activity.spec.ts` against the real bundle, and the two are
 * complementary rather than duplicates.
 */
describe('usePolledResource teardown (#989)', () => {
  it('stops polling and leaves no timer behind after unmount', async () => {
    const fetcher = vi.fn().mockResolvedValue('x');

    // Baseline BEFORE mounting: `shouldAdvanceTime` runs a ticker of its own, so
    // the honest measure is that the count RETURNS to where it started, not that
    // it reaches zero.
    const baselineTimers = vi.getTimerCount();

    const { unmount } = renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(vi.getTimerCount()).toBeGreaterThan(baselineTimers);

    unmount();

    // The direct measurement: the interval is gone, not merely quiet.
    expect(vi.getTimerCount()).toBe(baselineTimers);

    const afterUnmount = fetcher.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetcher.mock.calls.length).toBe(afterUnmount);
  });

  /**
   * The `#896` shape: a listener that outlives its component. An orphan here is
   * worse than an orphan interval, because the document-level `visibilitychange`
   * keeps firing it forever and each unmounted instance answers with a fetch —
   * so the cost grows with how many times the page has been visited, which is
   * precisely the profile of a tab that dies after hours of navigation.
   */
  it('does not answer a visibility change after unmount', async () => {
    const fetcher = vi.fn().mockResolvedValue('x');

    const { unmount } = renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    unmount();
    const afterUnmount = fetcher.mock.calls.length;

    await act(async () => {
      setVisibility('hidden');
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetcher.mock.calls.length).toBe(afterUnmount);
  });

  /**
   * Repeated visits must cost what ONE visit costs. This is the arithmetic the
   * crash hypothesis turns on: if teardown were partial, every mount would add a
   * poller and the request rate would climb with visit count rather than stay
   * flat with elapsed time.
   */
  it('does not accumulate pollers across repeated mounts', async () => {
    const fetcher = vi.fn().mockResolvedValue('x');
    const baselineTimers = vi.getTimerCount();

    for (let visit = 0; visit < 5; visit += 1) {
      const { unmount } = renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
      await waitFor(() => expect(fetcher).toHaveBeenCalled());
      unmount();
    }

    expect(vi.getTimerCount()).toBe(baselineTimers);

    const afterVisits = fetcher.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetcher.mock.calls.length).toBe(afterVisits);
  });

  /**
   * The third shape the ticket names — state that APPENDS rather than replaces,
   * so the retained set grows with every poll. Pinned rather than left to
   * inspection: it is one line in the hook and the whole difference between a
   * page that can sit open all day and one that cannot.
   */
  it('replaces the polled value rather than accumulating it', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second')
      .mockResolvedValue('third');

    const { result } = renderHook(() => usePolledResource(fetcher, { intervalMs: 1_000 }));
    await waitFor(() => expect(result.current.data).toBe('first'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    // `toBe` is identity, so this already excludes an accumulator: an appending
    // setData would hold ['first','second','third'] here, not the string.
    await waitFor(() => expect(result.current.data).toBe('third'));
  });

  /**
   * The LITERAL "timer that compounds" the ticket names, which none of the
   * tests above reach. Every remount and every revisit they exercise passes
   * through a real `stop()` first — unmount, or a genuine hidden phase — so the
   * `timer ??=` guard in `start()` is never the thing keeping the count at one.
   * Pre-PR review caught that: with the guard mutated to a plain assignment,
   * all of them still passed.
   *
   * The path that does reach it: two `visibilitychange` events both reporting
   * `visible`, with no `hidden` in between. Browsers do fire a redundant one,
   * and `onVisibility` calls `start()` on every visible event without a
   * matching `stop()` — so without the guard the second one arms a SECOND
   * interval and orphans the first, doubling the poll rate for as long as the
   * page stays open. That is the compounding shape exactly, and it needs no
   * navigation at all to happen.
   */
  it('does not arm a second interval when visible fires twice without a hidden', async () => {
    const fetcher = vi.fn().mockResolvedValue('x');
    const baselineTimers = vi.getTimerCount();

    renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    const withOneInterval = vi.getTimerCount();
    expect(withOneInterval).toBeGreaterThan(baselineTimers);

    // Redundant `visible`, no `hidden` first. The immediate refresh it triggers
    // is intended and counted below; a second INTERVAL is not.
    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(vi.getTimerCount()).toBe(withOneInterval);

    // And the cadence is unchanged, which is the consequence that matters: one
    // interval over 12s is two ticks, two intervals would be four. The `+ 1`
    // is the eager refresh the redundant event legitimately caused.
    const beforeWindow = fetcher.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(fetcher.mock.calls.length - beforeWindow).toBe(2);
  });
});
