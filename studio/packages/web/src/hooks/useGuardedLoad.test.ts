import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useGuardedLoad } from './useGuardedLoad';

/**
 * #1062 — the interesting properties are all about NOT writing: a superseded
 * answer must not land, in either direction, and a load must not start at all
 * once the component is gone.
 */

/** A promise this test settles by hand, so loads can be answered out of order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Never settles — for a load that is still in flight when something else happens. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('useGuardedLoad', () => {
  it("drops a stale load's answer when a newer load has already answered", async () => {
    const { result } = renderHook(() => useGuardedLoad());
    const onData = vi.fn();
    const onError = vi.fn();
    const mount = deferred<string>();
    const refresh = deferred<string>();

    await act(async () => {
      void result.current(() => mount.promise, { onData, onError });
      void result.current(() => refresh.promise, { onData, onError });
    });

    // The newer load answers first, as it does when a mutation's refresh
    // overtakes the initial page load.
    await act(async () => {
      refresh.resolve('fresh');
      await refresh.promise;
    });
    // ...and the stale one lands second, carrying the pre-mutation list.
    await act(async () => {
      mount.resolve('stale');
      await mount.promise;
    });

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith('fresh');
  });

  it("drops a stale load's REJECTION too", async () => {
    // A stale failure would replace a good list with an error banner just as
    // convincingly as a stale success would replace it with old rows.
    const { result } = renderHook(() => useGuardedLoad());
    const onData = vi.fn();
    const onError = vi.fn();
    const mount = deferred<string>();
    const refresh = deferred<string>();

    await act(async () => {
      void result.current(() => mount.promise, { onData, onError });
      void result.current(() => refresh.promise, { onData, onError });
    });

    await act(async () => {
      refresh.resolve('fresh');
      await refresh.promise;
    });
    await act(async () => {
      mount.reject(new Error('the stale load failed'));
      await mount.promise.catch(() => undefined);
    });

    expect(onError).not.toHaveBeenCalled();
    expect(onData).toHaveBeenCalledWith('fresh');
  });

  it('reports a failure that is still the newest load', async () => {
    // The complement of the case above: dropping stale rejections must not cost
    // the page its ability to report a load that genuinely failed.
    const { result } = renderHook(() => useGuardedLoad());
    const onData = vi.fn();
    const onError = vi.fn();
    const boom = new Error('boom');

    await act(async () => {
      await result.current(() => Promise.reject(boom), { onData, onError });
    });

    expect(onError).toHaveBeenCalledWith(boom);
    expect(onData).not.toHaveBeenCalled();
  });

  it('does not report a failure that the unmount itself caused', async () => {
    // The abort fires on unmount, and a fetch that rejects because of it is
    // reporting the teardown, not a load the operator needs told about. Its
    // ticket is still the newest — nothing superseded it — so the ticket check
    // alone would let it through to a page that no longer exists.
    const { result, unmount } = renderHook(() => useGuardedLoad());
    const onData = vi.fn();
    const onError = vi.fn();
    const load = deferred<string>();

    await act(async () => {
      void result.current(
        (signal) => {
          signal.addEventListener('abort', () => load.reject(new Error('aborted')));
          return load.promise;
        },
        { onData, onError },
      );
    });

    unmount();
    await act(async () => {
      await load.promise.catch(() => undefined);
    });

    expect(onError).not.toHaveBeenCalled();
    expect(onData).not.toHaveBeenCalled();
  });

  it('does not write DATA from a load that resolves after the unmount', async () => {
    // The complement of the case above, and the one the ticket check alone does
    // not cover: nothing superseded this load, so its ticket is still the
    // newest. Whether an aborted fetch rejects or resolves anyway is the
    // fetch's choice — a body read can win the race with the abort — so the
    // success branch has to check the signal itself rather than assume it will
    // be told through a rejection.
    const { result, unmount } = renderHook(() => useGuardedLoad());
    const onData = vi.fn();
    const onError = vi.fn();
    const load = deferred<string>();

    await act(async () => {
      void result.current(() => load.promise, { onData, onError });
    });

    unmount();
    await act(async () => {
      load.resolve('answered after the page was gone');
      await load.promise;
    });

    expect(onData).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not re-report a throw from onData as a failed LOAD', async () => {
    // A chained `.catch` would have handed the caller's own bug to `onError`,
    // which renders it as "could not load …" — a state-writing bug wearing a
    // network failure's clothes. It propagates instead.
    const { result } = renderHook(() => useGuardedLoad());
    const boom = new Error('a bug in the caller');
    const onData = vi.fn(() => {
      throw boom;
    });
    const onError = vi.fn();

    await act(async () => {
      await expect(result.current(() => Promise.resolve('fine'), { onData, onError })).rejects.toBe(
        boom,
      );
    });

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('still loads on the SECOND mount under StrictMode', async () => {
    // StrictMode mounts, tears down and remounts. The controller is therefore
    // created per effect RUN: one hoisted into the ref's initial value would
    // arrive at the second mount already aborted, and — now that the success
    // branch checks the signal — would silently drop every answer the page ever
    // asked for.
    const { result } = renderHook(() => useGuardedLoad(), { wrapper: StrictMode });
    const onData = vi.fn();
    const onError = vi.fn();

    await act(async () => {
      await result.current(() => Promise.resolve('loaded'), { onData, onError });
    });

    expect(onData).toHaveBeenCalledWith('loaded');
    expect(onError).not.toHaveBeenCalled();
  });

  it('starts NO load once the component has unmounted', async () => {
    // Reaching the runner after unmount means the caller was awaiting its own
    // mutation when the page went away. There is nobody left to show a result
    // to, so the request is not issued rather than issued unabortably.
    const { result, unmount } = renderHook(() => useGuardedLoad());
    const onData = vi.fn();
    const onError = vi.fn();
    const fetch = vi.fn(() => Promise.resolve('anything'));

    unmount();
    await act(async () => {
      await result.current(fetch, { onData, onError });
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(onData).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('aborts the signal it handed a load that is still in flight at unmount', async () => {
    const { result, unmount } = renderHook(() => useGuardedLoad());
    const onData = vi.fn();
    const onError = vi.fn();
    let captured: AbortSignal | undefined;

    await act(async () => {
      void result.current(
        (signal) => {
          captured = signal;
          return pending<string>();
        },
        { onData, onError },
      );
    });

    expect(captured?.aborted).toBe(false);
    unmount();
    expect(captured?.aborted).toBe(true);
  });
});
