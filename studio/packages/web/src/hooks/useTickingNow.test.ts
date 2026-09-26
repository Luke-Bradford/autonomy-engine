import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTickingNow } from './useTickingNow';

beforeEach(() => {
  vi.useFakeTimers({ now: 10_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useTickingNow (#890)', () => {
  it('starts at the current time and advances once per interval', () => {
    const { result } = renderHook(() => useTickingNow(1_000));
    expect(result.current).toBe(10_000);

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current).toBe(10_000);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(11_000);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current).toBe(13_000);
  });

  it('stops its interval on unmount, so a closed drill-in leaves no timer behind', () => {
    const { unmount } = renderHook(() => useTickingNow(1_000));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
