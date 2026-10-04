import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { Paginated } from '@autonomy-studio/shared';
import { PAGE_STALLED_MS, POLL_DEADLINE_MS, usePagedList } from './usePagedList';

/**
 * #1076 — the accumulating load shape. What is pinned here is what distinguishes
 * it from the other two hooks: pages APPEND, `items` stays `null` until
 * something has actually loaded, and a refresh beats an in-flight older page
 * rather than being dropped by it.
 */

type Page = Paginated<string>;
/** The hook's fetcher contract, named so a test can swap one implementation for
 *  another (scripted → deferred) without the props type narrowing to the first. */
type Fetcher = (cursor: string | undefined, signal: AbortSignal) => Promise<Page>;

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

  it('drops a row an older page repeats when keyOf is given, keeping the first sighting (#1484)', async () => {
    // A sorted runs list orders by MUTABLE keys, so a row can cross the cursor
    // between two pages and come back; rendered twice it is a React key clash.
    const { fetchPage } = scriptedFetcher([page(['a', 'b'], 'c1'), page(['b', 'c'])]);
    const keyOf = (s: string) => s;
    const { result } = renderHook(() => usePagedList(fetchPage, keyOf));
    await waitFor(() => expect(result.current.items).toEqual(['a', 'b']));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toEqual(['a', 'b', 'c']));
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

  /**
   * #1083 — a NEW fetcher is a new list. The distinction from a refresh (same
   * fetcher, rows kept) is the whole point: `RunsPage` memoizes its fetcher on
   * the filter axes, so this fires when the operator changes a filter, and the
   * rows on screen are then the PREVIOUS filter's answer.
   */
  it('blanks the list when the fetcher changes, and reloads from the first page', async () => {
    const first = scriptedFetcher([page(['a'], 'cur_1'), page(['b'], 'cur_2')]);
    const { result, rerender } = renderHook(({ f }: { f: Fetcher }) => usePagedList(f), {
      initialProps: { f: first.fetchPage as Fetcher },
    });
    await waitFor(() => expect(result.current.items).toEqual(['a']));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toEqual(['a', 'b']));

    const second = scriptedFetcher([page(['x'], null)]);
    rerender({ f: second.fetchPage });

    // Synchronously blank — the previous filter's rows must not be readable
    // under the new one, not even for a frame.
    expect(result.current.items).toBeNull();
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.items).toEqual(['x']));
    // From the FIRST page: resuming the old cursor would splice one query's
    // position into another query's result set.
    expect(second.cursors).toEqual([undefined]);
  });

  it('drops the previous list’s cursor with it, so Load more cannot resume the wrong query', async () => {
    const first = scriptedFetcher([page(['a'], 'cur_1')]);
    const { result, rerender } = renderHook(({ f }: { f: Fetcher }) => usePagedList(f), {
      initialProps: { f: first.fetchPage as Fetcher },
    });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    // DEFERRED, so the assertions land in the window that actually matters: the
    // new list's first page is in flight and has not yet overwritten the cursor.
    // An earlier version of this test resolved immediately and was VACUOUS —
    // deleting `setNextCursor(null)` from the reset kept it green, because the
    // arriving page nulled the cursor anyway. (Measured: 13/13 passed under that
    // mutation.) The defect being guarded only exists mid-flight.
    const second = deferredFetcher();
    rerender({ f: second.fetchPage });

    // The old list said there was more; the new list has not said anything yet,
    // and "more" must not be inherited across the two.
    expect(result.current.hasMore).toBe(false);
    act(() => result.current.loadMore());
    // Exactly the one first-page request, and it carries NO cursor. A surviving
    // `cur_1` would resume a position in the previous query's result set.
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]!.cursor).toBeUndefined();
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

describe('usePagedList poll (#1484 live mode)', () => {
  it('re-reads the first page and replaces the head without ever going busy', async () => {
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await act(async () => calls[0]!.resolve(page(['a'], 'cur_1')));
    expect(result.current.items).toEqual(['a']);

    // The "as of" stamp moves with a poll, so an unfinished row's clock does too.
    const now = vi.spyOn(Date, 'now').mockReturnValue(9_999_999_999_999);
    act(() => result.current.poll());
    now.mockRestore();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.cursor).toBeUndefined();
    // In flight, and still not busy: a Refresh button stays enabled on every tick.
    expect(result.current.busy).toBe(false);

    await act(async () => calls[1]!.resolve(page(['new', 'a'], 'cur_2')));
    expect(result.current.items).toEqual(['new', 'a']);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.lastUpdatedAt).toBe(9_999_999_999_999);
  });

  it('is skipped while any request is in flight, so it never supersedes one', async () => {
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));

    // The first page is still in flight.
    act(() => result.current.poll());
    expect(calls).toHaveLength(1);

    await act(async () => calls[0]!.resolve(page(['a'])));
    act(() => result.current.poll());
    expect(calls).toHaveLength(2);
    // A second tick while that poll is in flight is dropped too.
    act(() => result.current.poll());
    expect(calls).toHaveLength(2);
  });

  it('does not stick when a poll is superseded and never runs its handlers', async () => {
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await act(async () => calls[0]!.resolve(page(['a'])));

    act(() => result.current.poll());
    act(() => result.current.refresh());
    await act(async () => calls[2]!.resolve(page(['b'])));
    // The superseded poll settles afterwards; its answer is dropped…
    await act(async () => calls[1]!.resolve(page(['stale'])));
    expect(result.current.items).toEqual(['b']);

    // …but it no longer counts as in flight, so the next tick polls.
    act(() => result.current.poll());
    expect(calls).toHaveLength(4);
  });

  it('is skipped once an older page is appended, and resumes after a refresh', async () => {
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await act(async () => calls[0]!.resolve(page(['a'], 'cur_1')));

    act(() => result.current.loadMore());
    await act(async () => calls[1]!.resolve(page(['b'])));
    expect(result.current.items).toEqual(['a', 'b']);
    expect(result.current.extended).toBe(true);

    // Replacing the head now would throw away 'b', which the reader asked for.
    act(() => result.current.poll());
    expect(calls).toHaveLength(2);

    act(() => result.current.refresh());
    await act(async () => calls[2]!.resolve(page(['a'], 'cur_1')));
    expect(result.current.extended).toBe(false);
    act(() => result.current.poll());
    expect(calls).toHaveLength(4);
  });

  it("keeps the rows on a failed poll, reports it as 'live', and clears it on the next good one", async () => {
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await act(async () => calls[0]!.resolve(page(['a'])));

    act(() => result.current.poll());
    await act(async () => calls[1]!.reject(new Error('down')));
    expect(result.current.items).toEqual(['a']);
    expect(result.current.error).toEqual({ message: 'down', scope: 'live' });

    act(() => result.current.poll());
    await act(async () => calls[2]!.resolve(page(['a'])));
    expect(result.current.error).toBeNull();
  });
});

describe('usePagedList poll deadline (#1527)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails a poll that never answers, so polling is not held off for good', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await act(async () => calls[0]!.resolve(page(['a'])));

    // This poll hangs: no answer, and no settle.
    act(() => result.current.poll());
    expect(calls).toHaveLength(2);
    // A Refresh supersedes its answer but cannot settle it.
    act(() => result.current.refresh());
    await act(async () => calls[2]!.resolve(page(['b'])));
    act(() => result.current.poll());
    expect(calls).toHaveLength(3);

    // At the deadline the hung poll is aborted and settles…
    await act(async () => {
      vi.advanceTimersByTime(POLL_DEADLINE_MS);
    });
    expect(calls[1]!.signal.aborted).toBe(true);
    // …so the next tick polls again.
    act(() => result.current.poll());
    expect(calls).toHaveLength(4);
  });

  it("reports a hung poll as a failed 'live' read, keeping the rows", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await act(async () => calls[0]!.resolve(page(['a'])));

    act(() => result.current.poll());
    await act(async () => {
      vi.advanceTimersByTime(POLL_DEADLINE_MS - 1);
    });
    expect(result.current.error).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.error).toEqual({ message: 'no answer in 15s', scope: 'live' });
    expect(result.current.items).toEqual(['a']);
  });

  it('gives a page the reader asked for no deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await act(async () => {
      vi.advanceTimersByTime(POLL_DEADLINE_MS * 4);
    });
    expect(calls[0]!.signal.aborted).toBe(false);
    expect(result.current.loading).toBe(true);
    await act(async () => calls[0]!.resolve(page(['a'])));
    expect(result.current.items).toEqual(['a']);
  });
});

describe('usePagedList stalled (#1529)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls a first page stalled once it goes unanswered, without aborting it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await act(async () => {
      vi.advanceTimersByTime(PAGE_STALLED_MS - 1);
    });
    expect(result.current.stalled).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.stalled).toBe(true);
    expect(result.current.busy).toBe(true);
    expect(calls[0]!.signal.aborted).toBe(false);

    // A late answer is still taken, and the list is no longer stalled.
    await act(async () => calls[0]!.resolve(page(['a'])));
    expect(result.current.items).toEqual(['a']);
    expect(result.current.stalled).toBe(false);
  });

  it('gives a refresh of a stalled page a fresh window, and takes its answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await act(async () => {
      vi.advanceTimersByTime(PAGE_STALLED_MS);
    });
    expect(result.current.stalled).toBe(true);

    act(() => result.current.refresh());
    expect(result.current.stalled).toBe(false);
    expect(calls).toHaveLength(2);
    await act(async () => {
      vi.advanceTimersByTime(PAGE_STALLED_MS - 1);
    });
    expect(result.current.stalled).toBe(false);
    await act(async () => calls[1]!.resolve(page(['b'])));
    expect(result.current.items).toEqual(['b']);
    expect(result.current.busy).toBe(false);
  });

  it('never calls a quiet list stalled, nor one whose answer came in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await act(async () => calls[0]!.resolve(page(['a'], 'c1')));
    await act(async () => {
      vi.advanceTimersByTime(PAGE_STALLED_MS * 2);
    });
    expect(result.current.stalled).toBe(false);

    // An older page that hangs stalls too: it holds `busy` just the same.
    act(() => result.current.loadMore());
    await act(async () => {
      vi.advanceTimersByTime(PAGE_STALLED_MS);
    });
    expect(result.current.stalled).toBe(true);
  });
});

describe('usePagedList poll — regressions (#1484 review)', () => {
  it('polls again after a NEW list whose first page failed, even if the old one was extended', async () => {
    const first = deferredFetcher();
    const { result, rerender } = renderHook(({ f }: { f: Fetcher }) => usePagedList(f), {
      initialProps: { f: first.fetchPage as Fetcher },
    });
    await act(async () => first.calls[0]!.resolve(page(['a'], 'cur_1')));
    act(() => result.current.loadMore());
    await act(async () => first.calls[1]!.resolve(page(['b'])));
    expect(result.current.extended).toBe(true);

    // A filter change: a new list, whose first page fails.
    const second = deferredFetcher();
    rerender({ f: second.fetchPage as Fetcher });
    await act(async () => second.calls[0]!.reject(new Error('down')));
    expect(result.current.extended).toBe(false);

    act(() => result.current.poll());
    expect(second.calls).toHaveLength(2);
  });

  it('a fetcher that throws synchronously still settles, so polling is not held off', async () => {
    let throwNext = false;
    const fetchPage = vi.fn((): Promise<Page> => {
      if (throwNext) throw new Error('sync');
      return Promise.resolve(page(['a']));
    });
    const { result } = renderHook(() => usePagedList(fetchPage));
    await waitFor(() => expect(result.current.items).toEqual(['a']));

    throwNext = true;
    act(() => result.current.poll());
    await waitFor(() => expect(result.current.error?.scope).toBe('live'));
    throwNext = false;
    act(() => result.current.poll());
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('a good poll does not clear a failed older page', async () => {
    const { fetchPage, calls } = deferredFetcher();
    const { result } = renderHook(() => usePagedList(fetchPage));
    await act(async () => calls[0]!.resolve(page(['a'], 'cur_1')));
    act(() => result.current.loadMore());
    await act(async () => calls[1]!.reject(new Error('older failed')));
    expect(result.current.error?.scope).toBe('more');

    act(() => result.current.poll());
    await act(async () => calls[2]!.resolve(page(['a'], 'cur_1')));
    expect(result.current.error).toEqual({ message: 'older failed', scope: 'more' });
  });
});
