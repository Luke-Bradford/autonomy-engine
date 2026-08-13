import { useCallback, useEffect, useState } from 'react';
import type { Paginated } from '@autonomy-studio/shared';
import { messageOf } from '../api/client';
import { useGuardedLoad } from './useGuardedLoad';

/**
 * #1076 — a keyset-paginated list a reader extends on demand: the first page on
 * mount, then one older page per "load more".
 *
 * THE THIRD LOAD SHAPE, and the split from the other two is worth stating
 * because picking wrong is silent. `usePolledResource` owns ONE value that a
 * later fetch REPLACES, and drops a new load while one is in flight (right for
 * a poller). `useGuardedLoad` owns no state at all — it hands a page's own
 * state slots a latest-wins runner, for a list that reloads after a mutation.
 * This one owns an ACCUMULATING value: a later fetch appends rather than
 * replaces, so it needs the page-walk position (`nextCursor`) as state beside
 * the items, which is precisely what neither of the others has.
 *
 * IT DOES NOT HAND-ROLL A FOURTH LATEST-WINS COUNTER. `useGuardedLoad` already
 * is one, with the mount-abort and the two-argument `.then` discipline written
 * down and tested; this hook is its state-owning wrapper. That reuse also gets
 * the invariant right for free: ONE counter, because there is ONE state target
 * (the list). A refresh MUST void an in-flight "load older" — the older page
 * was computed against the cursor of a head that no longer exists, so appending
 * it after the head was replaced would splice two different reads of the log
 * together. A counter per action would have permitted exactly that.
 *
 * REFRESH REPLACES, IT DOES NOT BLANK. It re-reads the first page and discards
 * any accumulated tail, but leaves the current items rendered until the new
 * page arrives, so `items === null` keeps its one meaning: nothing has been
 * successfully loaded YET. That distinction is load-bearing for a caller that
 * words an empty list ("nothing has happened to this workspace yet") — a
 * momentary `[]` mid-refresh would state that as a fact about the workspace
 * rather than about the request. Discarding the tail rather than re-fetching it
 * is the honest side of the trade: entries appended since the last read shift
 * the whole descending sequence, so a refreshed head glued to a stale tail
 * would silently skip the rows in between.
 *
 * THE FETCHER MUST BE MEMOIZED (`useCallback`) — the same half of the contract
 * `usePolledResource` asks for, and for the same reason: it is a dependency of
 * the mount effect, so an inline arrow would re-issue the first page on every
 * render.
 */

/** Which request failed, so a caller can word the two cases differently — a
 * failed first page and a failed older page are not the same news. */
export interface PagedListError {
  message: string;
  scope: 'first' | 'more';
}

export interface PagedList<T> {
  /** `null` until the first page has successfully loaded — never a manufactured `[]`. */
  items: T[] | null;
  error: PagedListError | null;
  /** True during the FIRST load only: there is nothing to show yet. */
  loading: boolean;
  /** True whenever any request is in flight, including a refresh or an older page. */
  busy: boolean;
  /** True when the server said there are older entries to fetch. */
  hasMore: boolean;
  /** When the FIRST page was last requested, epoch ms; `null` before the first success. */
  lastUpdatedAt: number | null;
  /** Fetches the next older page and APPENDS it. No-op while busy or at the end. */
  loadMore: () => void;
  /** Re-reads the first page, discarding any accumulated tail. */
  refresh: () => void;
}

export function usePagedList<T>(
  fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<Paginated<T>>,
): PagedList<T> {
  const runLoad = useGuardedLoad();
  const [items, setItems] = useState<T[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<PagedListError | null>(null);
  const [pending, setPending] = useState<'first' | 'more' | null>('first');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  /**
   * Issues one page. It deliberately performs NO setState of its own: the mount
   * effect below calls it, and a state write in the synchronous body of an
   * effect triggers a cascading render (the rule `useGuardedLoad`'s docblock
   * names). `pending` is initialised to `'first'` for exactly that reason, and
   * the two USER-driven entry points set it themselves before calling in.
   */
  const load = useCallback(
    (cursor: string | undefined, scope: 'first' | 'more') => {
      // Stamped at ISSUE, not at arrival, so a caller's "as of" is literally
      // true for a response that was in flight for a while — `usePolledResource`
      // makes the same promise in the same words.
      const issuedAt = Date.now();
      // `void`: the runner's promise settles after its handlers have written
      // state, and it rejects only if one of THEM threw — there is nothing here
      // to await and nothing a caller could do with it.
      void runLoad<Paginated<T>>((signal) => fetchPage(cursor, signal), {
        onData: (page) => {
          setItems((prev) => (scope === 'first' ? page.items : [...(prev ?? []), ...page.items]));
          setNextCursor(page.nextCursor);
          setError(null);
          setPending(null);
          if (scope === 'first') setLastUpdatedAt(issuedAt);
        },
        onError: (err) => {
          // The items already loaded stay rendered. A failed older page must not
          // cost the reader the history they were already looking at.
          setError({ message: messageOf(err), scope });
          setPending(null);
        },
      });
    },
    [fetchPage, runLoad],
  );

  useEffect(() => {
    load(undefined, 'first');
  }, [load]);

  const refresh = useCallback(() => {
    // No busy guard: a refresh is the load that must WIN, so it supersedes
    // whatever is in flight (`useGuardedLoad`'s counter drops the loser's
    // answer) rather than being dropped by it.
    setPending('first');
    load(undefined, 'first');
  }, [load]);

  const loadMore = useCallback(() => {
    // Unlike a refresh, an older page is DROPPED while one is in flight: two
    // concurrent ones would both read from the same cursor and append the same
    // rows twice, and there is no newer intent to honour. A null cursor means
    // the log ended — issuing the request anyway would re-read the newest page
    // and append the head a second time.
    if (pending !== null || nextCursor === null) return;
    setPending('more');
    load(nextCursor, 'more');
  }, [load, nextCursor, pending]);

  return {
    items,
    error,
    loading: pending === 'first' && items === null,
    busy: pending !== null,
    hasMore: nextCursor !== null,
    lastUpdatedAt,
    loadMore,
    refresh,
  };
}
