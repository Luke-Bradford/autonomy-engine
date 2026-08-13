import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Paginated } from '@autonomy-studio/shared';
import { usePagedList } from './usePagedList';

/**
 * #1076 — the accumulating load shape. What is pinned here is what distinguishes
 * it from the other two hooks: pages APPEND, `items` stays `null` until
 * something has actually loaded, and a refresh beats an in-flight older page
 * rather than being dropped by it.
 */

type Page = Paginated<string>;

const page = (items: string[], nextCursor: string | null = null): Page => ({ items, nextCursor });

/** A fetcher whose pages resolve when the test says so, so a request can be
 *  observed WHILE it is in flight — which is the only place the supersession
 *  rules are visible. */
function deferredFetcher() {
  const calls: {
    cursor: string | undefined;
    signal: AbortSignal;
    resolve: (p: Page) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const fetchPage = vi.fn((cursor: string | undefined, signal: AbortSignal) => {
    return new Promise<Page>((resolve, reject) => {
      calls.push({ cursor, signal, resolve, reject });
    });
  });
  return { fetchPage, calls };
}

/** The common case: every page resolves immediately from a scripted queue. */
function scriptedFetcher(pages: Page[]) {
  let call = 0;
  const cursors: (string | undefined)[] = [];
  const fetchPage = vi.fn((cursor: string | undefined) => {
    cursors.push(cursor);
    return Promise.resolve(pages[Math.min(call++, pages.length - 1)]!);
  });
  return { fetchPage, cursors };
}

describe('usePagedList (#1076)', () => {
  it('loads the first page on mount, with no cursor', async () => {
    const { fetchPage, cursors } = scriptedFetcher([page(['a', 'b'], 'cur_1')]);

    const { result } = renderHook(() => usePagedList(fetchPage));

    // Before the answer: nothing has loaded, and that is NOT an empty list.
    expect(result.current.items).toBeNull();
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.items).toEqual(['a', 'b']));
    expect(cursors).toEqual([undefined]);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.lastUpdatedAt).not.toBeNull();
  });

  it('reports an empty first page as an empty list, not as "not loaded"', async () => {
    const { fetchPage } = scriptedFetcher([page([])]);

    const { result } = renderHook(() => usePagedList(fetchPage));

    await waitFor(() => expect(result.current.items).toEqual([]));
    expect(result.current.hasMore).toBe(false);
  });

  it('appends an older page rather than replacing the first', async () => {
    const { fetchPage, cursors } = scriptedFetcher([page(['a'], 'cur_1'), page(['b'], null)]);
    const { result } = renderHook(() => usePagedList(fetchPage));
    await waitFor(() => expect(result.current.items).toEqual(['a']));

    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.items).toEqual(['a', 'b']));
    expect(cursors).toEqual([undefined, 'cur_1']);
    expect(result.current.hasMore).toBe(false);
  });

  it('does not offer to load more once the server says there is no next page', async () => {
    const { fetchPage } = scriptedFetcher([page(['a'], null)]);
    const { result } = renderHook(() => usePagedList(fetchPage));
    await waitFor(() => expect(result.current.items).toEqual(['a']));

    act(() => result.current.loadMore());

    // A no-op, not a request with a null cursor (which the server would read as
    // "start again from the newest" and duplicate the head).
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('drops a second load-more while one is in flight, so a page cannot append twice', async () => {
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.resolve(page(['a'], 'cur_1')));
    await waitFor(() => expect(result.current.items).toEqual(['a']));

    act(() => result.current.loadMore());
    act(() => result.current.loadMore());

    expect(fetchPage).toHaveBeenCalledTimes(2);
    act(() => calls[1]!.resolve(page(['b'], null)));
    await waitFor(() => expect(result.current.items).toEqual(['a', 'b']));
  });

  /**
   * The reason ONE latest-wins counter is the right shape. The older page was
   * computed against a head that the refresh has just replaced; appending it
   * afterwards would splice two different reads of the log together.
   */
  it('lets a refresh void an in-flight older page', async () => {
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.resolve(page(['a'], 'cur_1')));
    await waitFor(() => expect(result.current.items).toEqual(['a']));

    act(() => result.current.loadMore());
    act(() => result.current.refresh());
    expect(calls).toHaveLength(3);

    // The older page answers LAST, and must be ignored.
    act(() => calls[2]!.resolve(page(['a2'], 'cur_9')));
    await waitFor(() => expect(result.current.items).toEqual(['a2']));
    act(() => calls[1]!.resolve(page(['stale'], null)));

    await waitFor(() => expect(result.current.items).toEqual(['a2']));
    expect(result.current.hasMore).toBe(true);
  });

  it('discards an accumulated tail on refresh', async () => {
    const { fetchPage, cursors } = scriptedFetcher([
      page(['a'], 'cur_1'),
      page(['b'], 'cur_2'),
      page(['fresh'], null),
    ]);
    const { result } = renderHook(() => usePagedList(fetchPage));
    await waitFor(() => expect(result.current.items).toEqual(['a']));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toEqual(['a', 'b']));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.items).toEqual(['fresh']));
    expect(cursors).toEqual([undefined, 'cur_1', undefined]);
  });

  it('keeps the current items rendered across a refresh, never blanking to empty', async () => {
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await waitFor(() => expect(calls).toHaveLength(1));
    act(() => calls[0]!.resolve(page(['a'], null)));
    await waitFor(() => expect(result.current.items).toEqual(['a']));

    act(() => result.current.refresh());

    // Mid-refresh: still the old rows. A momentary `[]` would let a caller state
    // "nothing has happened yet" as a fact about the data.
    expect(result.current.items).toEqual(['a']);
    expect(result.current.loading).toBe(false);
    expect(result.current.busy).toBe(true);
  });

  it('surfaces a failed first page as a first-scoped error, with no items', async () => {
    const fetchPage = vi.fn(() => Promise.reject(new Error('network down')));
    const { result } = renderHook(() => usePagedList(fetchPage));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toEqual({ message: 'network down', scope: 'first' });
    expect(result.current.items).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it('keeps the loaded pages when an older page fails, scoping the error to it', async () => {
    let call = 0;
    const fetchPage = vi.fn(() =>
      call++ === 0 ? Promise.resolve(page(['a'], 'cur_1')) : Promise.reject(new Error('boom')),
    );
    const { result } = renderHook(() => usePagedList(fetchPage));
    await waitFor(() => expect(result.current.items).toEqual(['a']));

    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toEqual({ message: 'boom', scope: 'more' });
    // The history already on screen is real and must survive.
    expect(result.current.items).toEqual(['a']);
    // And the reader can try again — a failure is not the end of the log.
    expect(result.current.hasMore).toBe(true);
  });

  it('aborts the in-flight request on unmount', async () => {
    const { fetchPage, calls } = deferredFetcher();
    const { unmount } = renderHook(() => usePagedList(fetchPage));
    await waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]!.signal.aborted).toBe(false);
    unmount();
    expect(calls[0]!.signal.aborted).toBe(true);
  });
});
