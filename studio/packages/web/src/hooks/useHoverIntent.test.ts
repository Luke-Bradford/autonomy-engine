import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_DELAY_MS, OPEN_DELAY_MS, useHoverIntent } from './useHoverIntent';

describe('useHoverIntent', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts closed', () => {
    const { result } = renderHook(() => useHoverIntent());
    expect(result.current.open).toBe(false);
  });

  it('does NOT open for a cursor merely passing over', () => {
    const { result } = renderHook(() => useHoverIntent());
    act(() => result.current.handlers.onPointerEnter());
    act(() => void vi.advanceTimersByTime(OPEN_DELAY_MS - 1));
    /* THE load-bearing assertion, and it has to be here rather than only after
       the leave below: an implementation that opens immediately would still be
       closed once the pointer had left, so an end-state-only test passes for
       the very implementation this dwell exists to rule out. */
    expect(result.current.open).toBe(false);

    act(() => result.current.handlers.onPointerLeave());
    act(() => void vi.advanceTimersByTime(10_000));
    expect(result.current.open).toBe(false);
  });

  it('opens once the pointer has dwelled', () => {
    const { result } = renderHook(() => useHoverIntent());
    act(() => result.current.handlers.onPointerEnter());
    expect(result.current.open).toBe(false);
    act(() => void vi.advanceTimersByTime(OPEN_DELAY_MS));
    expect(result.current.open).toBe(true);
  });

  it('delays the close, so a momentary exit does not snatch the ports away', () => {
    const { result } = renderHook(() => useHoverIntent());
    act(() => result.current.handlers.onPointerEnter());
    act(() => void vi.advanceTimersByTime(OPEN_DELAY_MS));

    act(() => result.current.handlers.onPointerLeave());
    act(() => void vi.advanceTimersByTime(CLOSE_DELAY_MS - 1));
    expect(result.current.open).toBe(true);

    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.open).toBe(false);
  });

  it('cancels a pending close when the pointer returns', () => {
    const { result } = renderHook(() => useHoverIntent());
    act(() => result.current.handlers.onPointerEnter());
    act(() => void vi.advanceTimersByTime(OPEN_DELAY_MS));

    act(() => result.current.handlers.onPointerLeave());
    act(() => void vi.advanceTimersByTime(CLOSE_DELAY_MS - 1));
    act(() => result.current.handlers.onPointerEnter());
    act(() => void vi.advanceTimersByTime(10_000));

    // Still open: the return cancelled the close, and re-entering an ALREADY
    // open region must not re-arm the open delay either.
    expect(result.current.open).toBe(true);
  });

  it('opens IMMEDIATELY on focus — a keyboard user cannot dwell', () => {
    const { result } = renderHook(() => useHoverIntent());
    act(() => result.current.handlers.onFocus());
    expect(result.current.open).toBe(true);
  });

  it('keeps the ports out while focus moves BETWEEN them, and closes after the grace', () => {
    const { result } = renderHook(() => useHoverIntent());
    act(() => result.current.handlers.onFocus());

    // Tabbing from one port to the next fires blur then focus in the same task.
    act(() => result.current.handlers.onBlur());
    act(() => result.current.handlers.onFocus());
    act(() => void vi.advanceTimersByTime(10_000));
    expect(result.current.open).toBe(true);

    act(() => result.current.handlers.onBlur());
    act(() => void vi.advanceTimersByTime(CLOSE_DELAY_MS));
    expect(result.current.open).toBe(false);
  });

  it('does not fire a pending timer after unmount', () => {
    const { result, unmount } = renderHook(() => useHoverIntent());
    act(() => result.current.handlers.onPointerEnter());
    unmount();
    // A surviving timer would set state on an unmounted hook; the assertion is
    // that advancing time throws nothing and the last value stays closed.
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(result.current.open).toBe(false);
  });
});
