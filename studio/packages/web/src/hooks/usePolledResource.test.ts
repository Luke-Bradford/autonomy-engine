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
