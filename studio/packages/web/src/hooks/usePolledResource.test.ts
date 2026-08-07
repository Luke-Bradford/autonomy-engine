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
   * #1000 — AT MOST ONE REQUEST OUTSTANDING. Ticks used to fire whether or not
   * the previous request had come back, so while the endpoint was slower than
   * the interval, requests accumulated without bound: nothing capped them and
   * nothing cancelled them (the `AbortController` is per-EFFECT, aborted only
   * at teardown). These pin the guard that replaced the latest-wins token —
   * with one load at a time, results can no longer arrive out of order at all.
   */
  describe('#1000 — at most one load in flight', () => {
    /** A fetcher whose every call stays pending until the test settles it. */
    function pendingFetcher(): {
      fetcher: (signal: AbortSignal) => Promise<string>;
      settlers: Array<{ resolve: (v: string) => void; reject: (e: Error) => void }>;
    } {
      const settlers: Array<{ resolve: (v: string) => void; reject: (e: Error) => void }> = [];
      const fetcher = vi.fn(
        () =>
          new Promise<string>((resolve, reject) => {
            settlers.push({ resolve, reject });
          }),
      );
      return { fetcher, settlers };
    }

    it('skips every tick that lands while a load is still in flight', async () => {
      const { fetcher, settlers } = pendingFetcher();

      renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
      await waitFor(() => expect(settlers).toHaveLength(1));

      // Twelve intervals' worth of ticks against one unanswered request.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(settlers).toHaveLength(1);
    });

    it('resumes the cadence once the in-flight load settles', async () => {
      const { fetcher, settlers } = pendingFetcher();

      renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
      await waitFor(() => expect(settlers).toHaveLength(1));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(settlers).toHaveLength(1);

      await act(async () => {
        settlers[0]!.resolve('first');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });

      expect(settlers).toHaveLength(2);
    });

    /**
     * Guard hygiene. A rejected load must release the flag exactly as a
     * resolved one does — otherwise the first failure parks the panel dead for
     * the effect's whole lifetime, which is a worse bug than the pile-up.
     */
    it('releases the guard when a load REJECTS, not only when it resolves', async () => {
      const { fetcher, settlers } = pendingFetcher();

      const { result } = renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
      await waitFor(() => expect(settlers).toHaveLength(1));

      await act(async () => {
        settlers[0]!.reject(new Error('boom'));
      });
      await waitFor(() => expect(result.current.error).toBe('boom'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });

      expect(settlers).toHaveLength(2);
    });

    /**
     * THE HONESTY HALF, and the reason the guard alone was not enough.
     *
     * `lastUpdatedAt` is what the UI stamps "as of" with, so it must never
     * overstate how current the figures are. Stamping at RESOLUTION would
     * attribute a slow request's data to the moment it happened to land — and
     * with a one-at-a-time guard that error is no longer bounded by the
     * interval, because a request may now stay outstanding indefinitely.
     */
    it('stamps lastUpdatedAt with when the request was ISSUED, not when it resolved', async () => {
      const { fetcher, settlers } = pendingFetcher();

      const issuedAt = Date.now();
      const { result } = renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
      await waitFor(() => expect(settlers).toHaveLength(1));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      await act(async () => {
        settlers[0]!.resolve('slow');
      });
      await waitFor(() => expect(result.current.data).toBe('slow'));

      expect(result.current.lastUpdatedAt).toBeLessThan(issuedAt + 5_000);
    });

    /**
     * The hide→reveal case the guard would otherwise have made DISHONEST.
     *
     * `stop()` clears the interval but does not abort an in-flight request, so
     * a load issued before the tab hid is still pending on reveal. The wake
     * load is now skipped by the guard, and the pre-hide response is the one
     * that lands — which is fine only because it is stamped with the moment it
     * was ISSUED. Stamped at resolution it would present minutes-old figures
     * as current, which is the single failure this surface cannot have.
     */
    it('does not present a pre-hide response as current after the tab is revealed', async () => {
      const { fetcher, settlers } = pendingFetcher();

      const issuedAt = Date.now();
      const { result } = renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
      await waitFor(() => expect(settlers).toHaveLength(1));

      act(() => setVisibility('hidden'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      act(() => setVisibility('visible'));

      // The wake refresh is skipped — that request is already outstanding.
      expect(settlers).toHaveLength(1);

      await act(async () => {
        settlers[0]!.resolve('prehide');
      });
      await waitFor(() => expect(result.current.data).toBe('prehide'));

      expect(result.current.lastUpdatedAt).toBeLessThan(issuedAt + 5_000);
    });
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
      // Wait for THIS mount's load, not for "the mock has ever been called" —
      // the fetcher accumulates across the loop, so a bare `toHaveBeenCalled()`
      // is already satisfied by visit 0 and every later iteration would unmount
      // without waiting at all.
      const before = fetcher.mock.calls.length;
      const { unmount } = renderHook(() => usePolledResource(fetcher, { intervalMs: 5_000 }));
      await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(before));
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
    // interval over 12s is exactly two ticks, two intervals would be four. The
    // baseline is taken AFTER the eager refresh the redundant event legitimately
    // caused, so that refresh is excluded and this counts ticks alone.
    const beforeWindow = fetcher.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(fetcher.mock.calls.length - beforeWindow).toBe(2);
  });
});
