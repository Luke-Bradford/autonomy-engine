import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { WorkspaceGitSync } from '@autonomy-studio/shared';
import * as workspaceGitApi from '../api/workspaceGit';
import { useWorkspaceGitSync } from './useWorkspaceGitSync';

vi.mock('../api/workspaceGit', () => ({ readWorkspaceGitSync: vi.fn() }));
const syncMock = vi.mocked(workspaceGitApi.readWorkspaceGitSync);

/** A read this test answers by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const reading = (n: number) => ({ marker: n }) as unknown as WorkspaceGitSync;

/** Queue `count` hand-answered reads, in call order. */
function queueReads(count: number) {
  const reads = Array.from({ length: count }, () => deferred<WorkspaceGitSync | null>());
  for (const r of reads) syncMock.mockImplementationOnce(() => r.promise);
  return reads;
}

async function answer(
  r: ReturnType<typeof deferred<WorkspaceGitSync | null>>,
  value: WorkspaceGitSync | null,
) {
  await act(async () => {
    r.resolve(value);
    await r.promise;
  });
}

beforeEach(() => {
  syncMock.mockReset();
});

describe('useWorkspaceGitSync', () => {
  it('#1689 — refreshes while a read is in flight start nothing, and coalesce into ONE trailing read', async () => {
    const [first, second] = queueReads(2);
    const { result } = renderHook(() => useWorkspaceGitSync());

    // The editor's reload: connected, headVersion and focus, back to back.
    act(() => {
      result.current.refresh();
      result.current.refresh();
      result.current.refresh();
    });
    expect(syncMock).toHaveBeenCalledTimes(1);

    // The in-flight answer is SHOWN, not discarded, and one more read follows.
    await answer(first!, reading(1));
    expect(result.current.sync).toEqual(reading(1));
    expect(syncMock).toHaveBeenCalledTimes(2);

    await answer(second!, reading(2));
    expect(result.current.sync).toEqual(reading(2));
    expect(syncMock).toHaveBeenCalledTimes(2);
  });

  it('a refresh after a read has landed starts a new one at once', async () => {
    const [first] = queueReads(2);
    const { result } = renderHook(() => useWorkspaceGitSync());
    act(() => result.current.refresh());
    await answer(first!, reading(1));
    expect(syncMock).toHaveBeenCalledTimes(1);
    act(() => result.current.refresh());
    expect(syncMock).toHaveBeenCalledTimes(2);
  });

  it('clear() drops the read in flight, cancels the queued re-read, and lets a refresh start at once', async () => {
    const [stale, fresh] = queueReads(2);
    const { result } = renderHook(() => useWorkspaceGitSync());
    act(() => {
      result.current.refresh();
      result.current.refresh(); // queues a trailing read
    });

    act(() => result.current.clear());
    // A reconnect does not wait on the dropped read.
    act(() => result.current.refresh());
    expect(syncMock).toHaveBeenCalledTimes(2);

    // The read from before the disconnect lands: dropped, and it does not
    // start the trailing read it had queued.
    await answer(stale!, reading(1));
    expect(result.current.sync).toBeUndefined();
    expect(syncMock).toHaveBeenCalledTimes(2);

    await answer(fresh!, reading(2));
    expect(result.current.sync).toEqual(reading(2));
  });

  it('clear() empties a reading that had landed', async () => {
    const [first] = queueReads(1);
    const { result } = renderHook(() => useWorkspaceGitSync());
    act(() => result.current.refresh());
    await answer(first!, reading(1));
    act(() => result.current.clear());
    expect(result.current.sync).toBeUndefined();
    expect(result.current.failed).toBe(false);
  });

  it('a null answer is kept as null and calls onUnavailable', async () => {
    const [first] = queueReads(1);
    const onUnavailable = vi.fn();
    const { result } = renderHook(() => useWorkspaceGitSync(onUnavailable));
    act(() => result.current.refresh());
    await answer(first!, null);
    expect(result.current.sync).toBeNull();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('a failed read clears the reading and says it failed, until a read answers', async () => {
    const [ok, bad, again] = queueReads(3);
    const { result } = renderHook(() => useWorkspaceGitSync());
    act(() => result.current.refresh());
    await answer(ok!, reading(1));

    act(() => result.current.refresh());
    await act(async () => {
      bad!.reject(new Error('boom'));
      await bad!.promise.catch(() => {});
    });
    expect(result.current.sync).toBeUndefined();
    expect(result.current.failed).toBe(true);

    act(() => result.current.refresh());
    await answer(again!, reading(3));
    expect(result.current.failed).toBe(false);
    expect(result.current.sync).toEqual(reading(3));
  });

  it('an answer that lands after unmount writes nothing and starts nothing', async () => {
    const [first] = queueReads(1);
    const onUnavailable = vi.fn();
    const { result, unmount } = renderHook(() => useWorkspaceGitSync(onUnavailable));
    act(() => {
      result.current.refresh();
      result.current.refresh();
    });
    unmount();
    await act(async () => {
      first!.resolve(null);
      await first!.promise;
    });
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(syncMock).toHaveBeenCalledTimes(1);
  });
});
