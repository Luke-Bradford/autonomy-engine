import { describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { useBusyAction } from './useBusyAction';

/**
 * #960 — the guard is proved by calling `run` TWICE SYNCHRONOUSLY, never by
 * clicking a disabled button.
 *
 * That distinction is the whole point of the hook and it is easy to get wrong.
 * `user.click` does not dispatch on a natively `disabled` button, so a test that
 * asserts `toBeDisabled()` and then clicks again proves only the affordance —
 * delete the ref guard and it stays green. The race being guarded is two clicks
 * landing in ONE tick, before React has re-rendered the button as disabled, so
 * the test has to reproduce that: two `run` calls with no commit in between.
 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useBusyAction', () => {
  it('runs the act for an id that is not in flight', async () => {
    const { result } = renderHook(() => useBusyAction());
    const act1 = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      await result.current.run('a', act1);
    });

    expect(act1).toHaveBeenCalledTimes(1);
  });

  it('DROPS a second call for the same id issued before React re-renders', async () => {
    const { result } = renderHook(() => useBusyAction());
    const gate = deferred();
    const act1 = vi.fn().mockReturnValue(gate.promise);

    await act(async () => {
      // Both calls in one tick, deliberately without awaiting the first — this
      // is the double-click, and `active` is still empty when the second runs.
      void result.current.run('a', act1);
      void result.current.run('a', act1);
    });

    expect(act1).toHaveBeenCalledTimes(1);

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
  });

  it('does NOT drop a concurrent call for a DIFFERENT id', async () => {
    const { result } = renderHook(() => useBusyAction());
    const gateA = deferred();
    const gateB = deferred();
    const actA = vi.fn().mockReturnValue(gateA.promise);
    const actB = vi.fn().mockReturnValue(gateB.promise);

    await act(async () => {
      void result.current.run('a', actA);
      void result.current.run('b', actB);
    });

    expect(actA).toHaveBeenCalledTimes(1);
    expect(actB).toHaveBeenCalledTimes(1);
    // Both rows report busy at once — the reason this is a Set and not a slot.
    expect([...result.current.active].sort()).toEqual(['a', 'b']);

    await act(async () => {
      gateA.resolve();
      gateB.resolve();
      await Promise.all([gateA.promise, gateB.promise]);
    });
  });

  it('exposes the in-flight id for the affordance, and releases it on settle', async () => {
    const { result } = renderHook(() => useBusyAction());
    const gate = deferred();

    expect(result.current.active.has('a')).toBe(false);

    let running!: Promise<void>;
    await act(async () => {
      running = result.current.run('a', () => gate.promise);
    });
    expect(result.current.active.has('a')).toBe(true);

    await act(async () => {
      gate.resolve();
      await running;
    });
    expect(result.current.active.has('a')).toBe(false);
  });

  it('releases the id when the act REJECTS, and re-throws rather than swallowing', async () => {
    const { result } = renderHook(() => useBusyAction());
    const boom = new Error('export failed');

    await act(async () => {
      await expect(result.current.run('a', () => Promise.reject(boom))).rejects.toThrow(boom);
    });

    // Released, so the operator can retry the row that just failed. A guard that
    // leaked the id would disable the button permanently on the one path where
    // retrying is what the operator most wants.
    expect(result.current.active.has('a')).toBe(false);

    const retry = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      await result.current.run('a', retry);
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('survives StrictMode double-mounting', async () => {
    const { result } = renderHook(() => useBusyAction(), { wrapper: StrictMode });
    const act1 = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      await result.current.run('a', act1);
    });

    expect(act1).toHaveBeenCalledTimes(1);
    expect(result.current.active.has('a')).toBe(false);
  });
});
