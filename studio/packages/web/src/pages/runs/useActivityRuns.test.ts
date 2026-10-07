import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as runsApi from '../../api/runs';
import type { ActivityRun, RunStatus } from '@autonomy-studio/shared';
import {
  ACTIVITY_RUNS_CHILD_POLL_MS,
  ACTIVITY_RUNS_REFRESH_MS,
  useActivityRuns,
} from './useActivityRuns';

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
    const { rerender } = renderHook(({ seq }) => useActivityRuns('r', seq, true), {
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
    const { rerender } = renderHook(({ seq }) => useActivityRuns('r', seq, true), {
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

  it('#1541 — says which frame each landed read was asked at, and keeps it through a failure', async () => {
    let answer!: (v: { runId: string; rows: []; groups: [] }) => void;
    getMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { result, rerender } = renderHook(({ seq }) => useActivityRuns('r', seq, true), {
      initialProps: { seq: 3 as number | undefined },
    });
    expect(result.current.readAt).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    // Frames arrive while the read asked at 3 is in flight: it is still 3's.
    rerender({ seq: 7 });
    await act(async () => {
      answer({ runId: 'r', rows: [], groups: [] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.readAt).toBe(3);
    // The follow-up read is asked at 7.
    await act(async () => vi.advanceTimersByTimeAsync(ACTIVITY_RUNS_REFRESH_MS));
    expect(result.current.readAt).toBe(7);

    getMock.mockRejectedValueOnce(new Error('boom'));
    rerender({ seq: 9 });
    await act(async () => vi.advanceTimersByTimeAsync(ACTIVITY_RUNS_REFRESH_MS));
    expect(result.current.error).toMatch(/boom/);
    expect(result.current.readAt).toBe(7);
  });

  it('schedules nothing once unmounted, even when a read lands afterwards', async () => {
    let answer!: (v: { runId: string; rows: []; groups: [] }) => void;
    getMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { rerender, unmount } = renderHook(({ seq }) => useActivityRuns('r', seq, true), {
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
    renderHook(() => useActivityRuns('r', 1, true), { wrapper: StrictMode });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(getMock).toHaveBeenCalled();
  });

  it('re-reads while a called run is going and the page is live, and stops when it ends', async () => {
    const caller = (status: RunStatus) =>
      ({
        key: 'c#0',
        childRun: { id: 'k', pipelineName: 'Child', status, startedAt: 1, finishedAt: null },
      }) as unknown as ActivityRun;
    getMock.mockResolvedValue({ runId: 'r', rows: [caller('running')], groups: [] });
    // Time in steps, so each tick's render lands before the next one.
    const pass = async (ms: number) => {
      for (let t = 0; t < ms; t += 250) await act(async () => vi.advanceTimersByTimeAsync(250));
    };
    const { rerender } = renderHook(({ live }) => useActivityRuns('r', 1, live), {
      initialProps: { live: true },
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(getMock).toHaveBeenCalledTimes(1);
    // No new frame in this run's log, yet the child's row is read again.
    await pass(ACTIVITY_RUNS_CHILD_POLL_MS * 2 + 1_000);
    expect(getMock.mock.calls.length).toBeGreaterThanOrEqual(3);

    // A page that would not hear the run settle does not poll for it.
    rerender({ live: false });
    let before = getMock.mock.calls.length;
    await pass(ACTIVITY_RUNS_CHILD_POLL_MS * 3);
    expect(getMock.mock.calls.length).toBe(before);

    // Live again, the child finishes: one read sees it, then nothing more.
    getMock.mockResolvedValue({ runId: 'r', rows: [caller('success')], groups: [] });
    rerender({ live: true });
    await pass(ACTIVITY_RUNS_CHILD_POLL_MS * 2);
    before = getMock.mock.calls.length;
    await pass(ACTIVITY_RUNS_CHILD_POLL_MS * 3);
    expect(getMock.mock.calls.length).toBe(before);
  });

  it('a child-poll tick that a read in flight absorbs does not re-render the page (#1552)', async () => {
    const going = {
      key: 'c#0',
      childRun: {
        id: 'k',
        pipelineName: 'Child',
        status: 'running',
        startedAt: 1,
        finishedAt: null,
      },
    } as unknown as ActivityRun;
    getMock.mockResolvedValueOnce({ runId: 'r', rows: [going], groups: [] });
    // The next read hangs until released, so each poll tick lands on a read in flight.
    let release: (() => void) | undefined;
    getMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ runId: 'r', rows: [going], groups: [] });
        }),
    );
    getMock.mockImplementation(() => new Promise(() => {}));
    // Time in steps, so each tick's render lands before the next one.
    const pass = async (ms: number) => {
      for (let t = 0; t < ms; t += 250) await act(async () => vi.advanceTimersByTimeAsync(250));
    };
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useActivityRuns('r', 1, true);
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await pass(ACTIVITY_RUNS_CHILD_POLL_MS + ACTIVITY_RUNS_REFRESH_MS);
    expect(getMock).toHaveBeenCalledTimes(2);
    const settled = renders;
    await pass(ACTIVITY_RUNS_CHILD_POLL_MS * 3);
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(renders).toBe(settled);

    // The ticks it absorbed still ask for one more read once it lands, not one each.
    release?.();
    await pass(ACTIVITY_RUNS_REFRESH_MS);
    expect(getMock).toHaveBeenCalledTimes(3);
  });
});
