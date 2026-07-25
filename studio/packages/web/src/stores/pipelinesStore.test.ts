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

  /**
   * The Author hub mounts TWO consumers in one commit. Whichever effect React
   * runs first starts the load; the second must see `loading` and stand down,
   * so the request count does not depend on render order.
   */
  it('ensureFresh fetches ONCE when several consumers mount together', async () => {
    const list = vi.fn().mockResolvedValue([pipeline()]);
    const store = createPipelinesStore(list);

    store.getState().ensureFresh();
    store.getState().ensureFresh();
    await vi.waitFor(() => expect(store.getState().status).toBe('ready'));

    expect(list).toHaveBeenCalledTimes(1);
    expect(store.getState().pipelines).toEqual([pipeline()]);
  });

  /**
   * Re-entering the hub RE-READS. Before this, the list was fetched once per
   * page load and a pipeline created by the CLI, an import or a second tab
   * stayed invisible until a browser reload.
   */
  it('ensureFresh refetches once a load has already succeeded', async () => {
    const list = vi.fn().mockResolvedValue([pipeline()]);
    const store = createPipelinesStore(list);

    store.getState().ensureFresh();
    await vi.waitFor(() => expect(store.getState().status).toBe('ready'));
    store.getState().ensureFresh();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
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

  it('does not re-fetch after a failure — ensureFresh is not a retry loop', async () => {
    const list = vi.fn().mockRejectedValue(new Error('offline'));
    const store = createPipelinesStore(list);

    store.getState().ensureFresh();
    await vi.waitFor(() => expect(store.getState().status).toBe('error'));
    store.getState().ensureFresh();

    expect(list).toHaveBeenCalledTimes(1);
  });

  /**
   * The Retry path. A banner describing the PREVIOUS attempt, sitting over an
   * in-flight retry — with the Retry button (gated on `status === 'error'`)
   * vanishing under the cursor — describes a request that is no longer current.
   */
  it('clears the error when a retry STARTS, not only when one succeeds', async () => {
    const pending = deferred<Pipeline[]>();
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(pending.promise);
    const store = createPipelinesStore(list);

    await store.getState().refresh();
    expect(store.getState().error).toBe('offline');

    const retry = store.getState().refresh();
    expect(store.getState()).toMatchObject({ status: 'loading', error: null });

    pending.resolve([]);
    await retry;
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
