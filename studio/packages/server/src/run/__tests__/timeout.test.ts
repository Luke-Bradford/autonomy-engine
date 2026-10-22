import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAILURE_CODES, MAX_TIMER_DELAY_MS } from '@autonomy-studio/shared';
import { activityTimeoutFailure, armDeadline } from '../timeout.js';

describe('#1600 C0a — armDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once, at the deadline and not before', () => {
    const fired = vi.fn();
    armDeadline(1_000, fired);
    vi.advanceTimersByTime(999);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("past setTimeout's 2^31-1 ms limit it waits the whole span (a bare setTimeout fires at once)", () => {
    const fired = vi.fn();
    const thirtyDays = 30 * 24 * 3600 * 1000;
    expect(thirtyDays).toBeGreaterThan(MAX_TIMER_DELAY_MS);
    armDeadline(thirtyDays, fired);
    vi.advanceTimersByTime(1);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(thirtyDays - MAX_TIMER_DELAY_MS - 2);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('the returned cancel stops it, before and after a re-arm', () => {
    const early = vi.fn();
    armDeadline(1_000, early)();
    const late = vi.fn();
    const cancelLate = armDeadline(MAX_TIMER_DELAY_MS + 5_000, late);
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS + 1);
    cancelLate();
    vi.advanceTimersByTime(10_000);
    expect(early).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('#1600 C0a — activityTimeoutFailure', () => {
  it("is D4's transient failure with the reserved timeout code", () => {
    expect(activityTimeoutFailure('r', 'n', 'n#1', 90)).toEqual({
      type: 'node.failed',
      runId: 'r',
      nodeId: 'n',
      attemptId: 'n#1',
      error: 'activity timed out after 90s',
      kind: 'transient',
      code: FAILURE_CODES.TIMEOUT,
    });
  });
});
