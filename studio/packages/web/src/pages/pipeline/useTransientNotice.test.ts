import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useTransientNotice } from './useTransientNotice';

/**
 * A notice nobody clears is a notice that lies.
 *
 * The clipboard line on the canvas describes a gesture that is already over —
 * unlike the save line, no later act owns wiping it — so if it does not expire
 * it sits there under unrelated later work still claiming to describe it.
 */
describe('useTransientNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('starts empty and shows what it is given', () => {
    const { result } = renderHook(() => useTransientNotice(5_000));

    expect(result.current[0]).toBeNull();

    act(() => result.current[1]('Copied 2 activities.'));

    expect(result.current[0]).toBe('Copied 2 activities.');
  });

  it('clears itself once the window is up, and not a tick before', () => {
    const { result } = renderHook(() => useTransientNotice(5_000));

    act(() => result.current[1]('Pasted 2 activities.'));
    act(() => void vi.advanceTimersByTime(4_999));

    expect(result.current[0]).toBe('Pasted 2 activities.');

    act(() => void vi.advanceTimersByTime(1));

    expect(result.current[0]).toBeNull();
  });

  /**
   * The case a `useEffect` keyed on the message itself gets WRONG: copying the
   * same selection twice sets identical text, so the state never changes and
   * the effect never re-runs — the second copy would inherit the first's
   * already-half-spent window and vanish early. Re-arming imperatively on the
   * gesture, not reactively on the text, is what makes a repeat honest.
   */
  it('re-arms the full window on a repeat gesture, same text or not', () => {
    const { result } = renderHook(() => useTransientNotice(5_000));

    act(() => result.current[1]('Copied 2 activities.'));
    act(() => void vi.advanceTimersByTime(4_000));
    act(() => result.current[1]('Copied 2 activities.'));

    // 4s of the FIRST window plus 4s more: past the first deadline, inside the
    // second. A stale timer would have cleared this already.
    act(() => void vi.advanceTimersByTime(4_000));

    expect(result.current[0]).toBe('Copied 2 activities.');

    act(() => void vi.advanceTimersByTime(1_000));

    expect(result.current[0]).toBeNull();
  });

  it('drops its pending timer on unmount rather than setting state on a dead component', () => {
    const { result, unmount } = renderHook(() => useTransientNotice(5_000));

    act(() => result.current[1]('Duplicated 2 activities.'));
    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
