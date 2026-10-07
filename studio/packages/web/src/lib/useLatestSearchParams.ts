import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, type Location, type NavigateOptions } from 'react-router';

/**
 * #1581 — the URL's search params, written from the URL as it last STOOD
 * rather than as the page last rendered it.
 *
 * The router commits every navigation inside `startTransition`, so the URL
 * moves before the page re-renders with it. react-router's own
 * `useSearchParams` builds a functional update's `prev` from the RENDERED
 * params, so a second write in that gap starts from the first one's `prev`
 * and undoes it: two quick sort clicks counted once (#1581), and leaving a
 * version preview kept `?version=N` (#1579). Every page that writes its view
 * into the URL writes through this hook instead; the lint bans the other one.
 *
 * A write is recorded against the location the page was showing when it was
 * made. While the page still shows that same location — the same object, which
 * every component renders until the router commits a new one — every writer
 * builds on the record. The router's next commit makes it stale by itself, so a
 * Back press or a link is followed, never overwritten.
 *
 * Limits, stated rather than handled:
 *  - a write the router never commits (a `useBlocker` that holds it, a loader
 *    redirect) leaves its record standing until the page next moves. No writer
 *    is exposed to that today: every route hold that shares a page with a
 *    writer holds path changes only (`leavesPath`), and these routes have no
 *    loaders.
 *  - `set` reads the location from the host's layout effect, so a CHILD's
 *    layout effect writing in the same commit as a navigation sees the page
 *    before it. Every writer today writes from an event or a passive effect.
 */
export type SetLatestSearchParams = (
  next: URLSearchParams | ((prev: URLSearchParams) => URLSearchParams),
  options?: NavigateOptions,
) => void;

/** The last write, and the rendered location it was made from. One record for
 * the whole app, so writers in different components build on each other. */
let written: { from: Location; search: string } | null = null;

function latestSearch(rendered: Location): string {
  return written !== null && written.from === rendered ? written.search : rendered.search;
}

/**
 * `[params as rendered, set, latest]`. `set` and `latest` are stable for the
 * component's life: `set` writes from the latest URL and skips a write that
 * changes nothing (no duplicate history entry); `latest` reads the URL as it
 * stands, for code that runs outside a render.
 */
export function useLatestSearchParams(): readonly [
  URLSearchParams,
  SetLatestSearchParams,
  () => URLSearchParams,
] {
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const refs = useRef({ location, navigate });
  useLayoutEffect(() => {
    refs.current = { location, navigate };
  }, [location, navigate]);
  const latest = useCallback(() => new URLSearchParams(latestSearch(refs.current.location)), []);
  const set = useCallback<SetLatestSearchParams>((next, options) => {
    const { location: here, navigate: go } = refs.current;
    const prev = new URLSearchParams(latestSearch(here));
    // A copy, so an updater that edits `prev` in place edits nothing shared.
    const params = typeof next === 'function' ? next(new URLSearchParams(prev)) : next;
    if (params.toString() === prev.toString()) return;
    written = { from: here, search: params.size > 0 ? `?${params}` : '' };
    // Relative, as react-router's own setter writes it: resolved against the
    // router's location, so a link already on its way keeps its path (and, as
    // before, takes these params with it).
    void go(`?${params}`, options);
  }, []);
  return [searchParams, set, latest] as const;
}
