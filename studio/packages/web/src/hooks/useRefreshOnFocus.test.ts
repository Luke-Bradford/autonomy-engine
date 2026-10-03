import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRefreshOnFocus } from './useRefreshOnFocus';

const focus = () => window.dispatchEvent(new Event('focus'));

describe('useRefreshOnFocus', () => {
  it('calls refresh on each window focus, and stops once unmounted', () => {
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useRefreshOnFocus(refresh));
    focus();
    focus();
    expect(refresh).toHaveBeenCalledTimes(2);
    unmount();
    focus();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('listens only while enabled', () => {
    const refresh = vi.fn();
    const { rerender } = renderHook(({ on }) => useRefreshOnFocus(refresh, on), {
      initialProps: { on: false },
    });
    focus();
    expect(refresh).not.toHaveBeenCalled();
    rerender({ on: true });
    focus();
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ on: false });
    focus();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a new refresh replaces the old one rather than adding a second listener', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => useRefreshOnFocus(fn), {
      initialProps: { fn: first },
    });
    rerender({ fn: second });
    focus();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
