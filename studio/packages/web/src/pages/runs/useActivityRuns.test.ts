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
    getMock.mockResolvedValue({ runId: 'r', rows: [] });
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
});
