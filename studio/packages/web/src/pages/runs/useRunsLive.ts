import { useEffect, useState, type RefObject } from 'react';

/**
 * #1484 OR35 M1 — how often a live runs list re-reads its first page. A poll,
 * not a socket: a list-level push would need its own per-event ownership check
 * (an event names only its run), would have to apply every filter and sort on
 * the client, and would still re-read the page to place a row. The server's
 * per-row fold is memoized by each log's last seq, so a re-read of a quiet page
 * is a handful of index reads.
 */
export const RUNS_LIVE_POLL_MS = 5_000;

/** Why a live list is not updating right now, in the order they are checked. */
export type RunsLivePause = 'hidden' | 'selecting' | 'scrolled' | 'extended';

export const RUNS_LIVE_PAUSE_LABEL: Record<RunsLivePause, string> = {
  hidden: 'paused while this tab is hidden',
  selecting: 'paused while text is selected',
  scrolled: 'paused while scrolled down',
  extended: 'paused while older runs are loaded — Refresh to resume',
};

/** The status while nothing pauses it, worded from the interval it actually uses. */
export const RUNS_LIVE_UPDATING_LABEL = `Updating every ${RUNS_LIVE_POLL_MS / 1_000}s`;
/** The status after a failed read: still polling, but not current. */
export const RUNS_LIVE_FAILING_LABEL = 'Last update failed — retrying';

/** True when `node` is inside `within` — a `Node` check, so a text node counts. */
function inside(within: Element | null, node: Node | null): boolean {
  return within !== null && node !== null && within.contains(node);
}

/**
 * Whether the list, or anything scrolling it, is scrolled away from the top —
 * the state `scroll` events report, read directly for a list that is already
 * scrolled before any event arrives. The list itself counts, as it does for
 * the events (`inside` is inclusive).
 */
function scrolledDown(list: Element | null): boolean {
  if ((document.scrollingElement?.scrollTop ?? 0) > 0) return true;
  for (let el = list; el !== null; el = el.parentElement) {
    if (el.scrollTop > 0) return true;
  }
  return false;
}

/**
 * #1484 OR35 M1 — keeps a runs list live: while `live` is on and nothing pauses
 * it, `poll()` runs at once and then every `RUNS_LIVE_POLL_MS`.
 *
 * IT PAUSES WHILE THE READER IS USING THE ROWS. A poll can insert a row at the
 * top or re-sort the page, which moves whatever the reader is looking at, so the
 * list holds still while they are:
 *  - scrolled away from the top of whatever scrolls the list (the shell's
 *    content pane, not the window, so this listens for `scroll` in the capture
 *    phase and keeps only targets that CONTAIN the list — the grid's own
 *    sideways scroll is inside it and does not count);
 *  - selecting text inside the list;
 *  - holding older pages (`extended`) — a poll replaces the head and would
 *    discard them, which `usePagedList.poll` refuses anyway; this names it.
 * And while the tab is hidden, where a poll is spent on nobody.
 *
 * The pause is STATE, not a check made at tick time, so the reason on screen is
 * current the moment it changes. Resuming polls at once, so the list catches up
 * on everything it missed rather than up to a whole interval later — the same
 * reason turning Live on does.
 *
 * `ticking` is the other half of the contract: an unfinished run's duration may
 * count only while this is polling AND the last read succeeded, because a count
 * is honest only while the page would hear the run finish (`NodeDuration`'s
 * rule). A failed read keeps polling (the next may succeed) but stops the count.
 */
export function useRunsLive({
  live,
  extended,
  failing,
  poll,
  listRef,
}: {
  live: boolean;
  extended: boolean;
  /** The last live read failed (`usePagedList`'s `'live'` error scope). */
  failing: boolean;
  /** Must be stable (`usePagedList.poll` is), or the interval re-arms every render. */
  poll: () => void;
  listRef: RefObject<Element | null>;
}): { pause: RunsLivePause | null; ticking: boolean } {
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const [selecting, setSelecting] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  /* Listening whether or not Live is on, so the pause is already true when the
     reader switches it on — not stale from the last time it was. */
  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    const onSelection = () => {
      const selection = document.getSelection();
      // Either end: a drag that starts above the rows and ends in them is still
      // a selection the next poll would re-render under.
      setSelecting(
        selection !== null &&
          !selection.isCollapsed &&
          (inside(listRef.current, selection.anchorNode) ||
            inside(listRef.current, selection.focusNode)),
      );
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target === document) {
        setScrolled((document.scrollingElement?.scrollTop ?? 0) > 0);
      } else if (target instanceof Element && inside(target, listRef.current)) {
        setScrolled(target.scrollTop > 0);
      }
    };
    /* #1527 — the reader can already be scrolled or selecting when this
       attaches (a list mounted under a content pane that kept its scroll), and
       no event will say so until they move. Read both now. */
    onSelection();
    setScrolled(scrolledDown(listRef.current));
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('selectionchange', onSelection);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('selectionchange', onSelection);
      document.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [listRef]);

  const pause: RunsLivePause | null = !live
    ? null
    : hidden
      ? 'hidden'
      : selecting
        ? 'selecting'
        : scrolled
          ? 'scrolled'
          : extended
            ? 'extended'
            : null;
  const polling = live && pause === null;

  useEffect(() => {
    if (!polling) return;
    // Usually skipped on mount: the list's own first load is in flight, and a
    // poll never supersedes a request (`usePagedList.poll`).
    poll();
    const timer = setInterval(poll, RUNS_LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, poll]);

  return { pause, ticking: polling && !failing };
}
