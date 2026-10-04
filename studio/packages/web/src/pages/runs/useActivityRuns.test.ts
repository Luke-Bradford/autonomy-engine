import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as runsApi from '../../api/runs';
import { ACTIVITY_RUNS_REFRESH_MS, useActivityRuns } from './useActivityRuns';

vi.mock('../../api/runs', async (importActual) => ({
  ...(await importActual<typeof import('../../api/runs')>()),
  getRunActivityRuns: vi.fn(),
}));
const getMock = vi.mocked(runsApi.getRunActivityRuns);

describe('#1484 M2 useActivityRuns', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getMock.mockReset();
    getMock.mockResolvedValue({ runId: 'r', rows: [], groups: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('reads at once, then at most once per interval while frames keep arriving, never starving', async () => {
    const { rerender } = renderHook(({ seq }) => useActivityRuns('r', seq), {
      initialProps: { seq: undefined as number | undefined },
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(getMock).toHaveBeenCalledTimes(1);

    // A frame every 100ms for 2s: a debounce would never fire; this reads ~4 times.
    for (let seq = 1; seq <= 20; seq += 1) {
      rerender({ seq });
      await act(async () => vi.advanceTimersByTimeAsync(100));
    }
    const during = getMock.mock.calls.length - 1;
    expect(during).toBeGreaterThanOrEqual(3);
    expect(during).toBeLessThanOrEqual(2_000 / ACTIVITY_RUNS_REFRESH_MS + 1);

    // The last frame is always followed by a read.
    rerender({ seq: 21 });
    const before = getMock.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(ACTIVITY_RUNS_REFRESH_MS));
    expect(getMock.mock.calls.length).toBe(before + 1);
  });

  it('never has two reads in flight, and re-reads once when the stream moved on meanwhile', async () => {
    let answer!: (v: { runId: string; rows: []; groups: [] }) => void;
    getMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { rerender } = renderHook(({ seq }) => useActivityRuns('r', seq), {
      initialProps: { seq: 1 as number | undefined },
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(getMock).toHaveBeenCalledTimes(1);

    // The first read hangs while frames keep arriving: nothing new is sent.
    for (let seq = 2; seq <= 10; seq += 1) {
      rerender({ seq });
      await act(async () => vi.advanceTimersByTimeAsync(ACTIVITY_RUNS_REFRESH_MS));
    }
    expect(getMock).toHaveBeenCalledTimes(1);

    // It lands; the stream moved on, so exactly one more read follows.
    await act(async () => {
      answer({ runId: 'r', rows: [], groups: [] });
      await vi.advanceTimersByTimeAsync(ACTIVITY_RUNS_REFRESH_MS * 4);
    });
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('schedules nothing once unmounted, even when a read lands afterwards', async () => {
    let answer!: (v: { runId: string; rows: []; groups: [] }) => void;
    getMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { rerender, unmount } = renderHook(({ seq }) => useActivityRuns('r', seq), {
      initialProps: { seq: 1 as number | undefined },
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    rerender({ seq: 2 });
    unmount();

    await act(async () => {
      answer({ runId: 'r', rows: [], groups: [] });
      await vi.advanceTimersByTimeAsync(0);
    });
    // `useGuardedLoad` would refuse the read anyway; no timer is left either.
    expect(vi.getTimerCount()).toBe(0);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it('reads at once under StrictMode, whose simulated remount runs every cleanup first', async () => {
    renderHook(() => useActivityRuns('r', 1), { wrapper: StrictMode });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(getMock).toHaveBeenCalled();
  });
});
