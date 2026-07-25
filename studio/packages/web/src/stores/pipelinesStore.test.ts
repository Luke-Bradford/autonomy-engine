import { describe, expect, it, vi } from 'vitest';
import type { Pipeline } from '@autonomy-studio/shared';
import { createPipelinesStore } from './pipelinesStore';

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'pl_1',
    resourceId: 'res_pl1',
    ownerId: 'local',
    name: 'My pipeline',
    concurrency: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** A `listPipelines` stub whose resolution this test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('pipelinesStore', () => {
  it('starts idle with no pipelines and no error', () => {
    const store = createPipelinesStore(vi.fn());
    expect(store.getState()).toMatchObject({ status: 'idle', pipelines: [], error: null });
  });

  it('ensureLoaded fetches once, however many consumers ask', async () => {
    const list = vi.fn().mockResolvedValue([pipeline()]);
    const store = createPipelinesStore(list);

    store.getState().ensureLoaded();
    store.getState().ensureLoaded();
    await vi.waitFor(() => expect(store.getState().status).toBe('ready'));
    store.getState().ensureLoaded();

    expect(list).toHaveBeenCalledTimes(1);
    expect(store.getState().pipelines).toEqual([pipeline()]);
  });

  it('refresh always refetches, even once ready', async () => {
    const list = vi.fn().mockResolvedValue([]);
    const store = createPipelinesStore(list);

    await store.getState().refresh();
    await store.getState().refresh();

    expect(list).toHaveBeenCalledTimes(2);
  });

  it('records a load failure as an error status with the message', async () => {
    const store = createPipelinesStore(vi.fn().mockRejectedValue(new Error('offline')));

    await store.getState().refresh();

    expect(store.getState().status).toBe('error');
    expect(store.getState().error).toBe('offline');
  });

  it('does not re-fetch after a failure — ensureLoaded is not a retry loop', async () => {
    const list = vi.fn().mockRejectedValue(new Error('offline'));
    const store = createPipelinesStore(list);

    store.getState().ensureLoaded();
    await vi.waitFor(() => expect(store.getState().status).toBe('error'));
    store.getState().ensureLoaded();

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good list when a REFRESH fails, and clears the error when one succeeds', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([pipeline()])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([pipeline({ id: 'pl_2' })]);
    const store = createPipelinesStore(list);

    await store.getState().refresh();
    await store.getState().refresh();
    // Stale-but-true beats blank: a failed refresh must not erase what we know.
    expect(store.getState().pipelines).toEqual([pipeline()]);
    expect(store.getState().error).toBe('offline');

    await store.getState().refresh();
    expect(store.getState().error).toBeNull();
    expect(store.getState().pipelines).toEqual([pipeline({ id: 'pl_2' })]);
  });

  it('ignores a SUPERSEDED load that resolves after a newer one', async () => {
    const slow = deferred<Pipeline[]>();
    const fast = deferred<Pipeline[]>();
    const list = vi.fn().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const store = createPipelinesStore(list);

    const first = store.getState().refresh();
    const second = store.getState().refresh();
    // The SECOND request wins, then the first (older) one lands late.
    fast.resolve([pipeline({ id: 'pl_new' })]);
    await second;
    slow.resolve([pipeline({ id: 'pl_stale' })]);
    await first;

    expect(store.getState().pipelines).toEqual([pipeline({ id: 'pl_new' })]);
    expect(store.getState().status).toBe('ready');
  });

  it('ignores a SUPERSEDED load that REJECTS after a newer one succeeded', async () => {
    const slow = deferred<Pipeline[]>();
    const fast = deferred<Pipeline[]>();
    const list = vi.fn().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const store = createPipelinesStore(list);

    const first = store.getState().refresh();
    const second = store.getState().refresh();
    fast.resolve([pipeline()]);
    await second;
    slow.reject(new Error('the abandoned one failed'));
    await first;

    // A stale failure must not bury a fresher success under an error banner.
    expect(store.getState().status).toBe('ready');
    expect(store.getState().error).toBeNull();
  });

  it('never rejects — refresh resolves even when the fetch throws', async () => {
    const store = createPipelinesStore(vi.fn().mockRejectedValue(new Error('boom')));
    await expect(store.getState().refresh()).resolves.toBeUndefined();
  });
});
