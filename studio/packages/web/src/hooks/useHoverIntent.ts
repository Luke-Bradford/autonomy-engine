import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * #997 — hover INTENT, not raw hover.
 *
 * The canvas's source ports collapse to one point at rest and fan out when a
 * node is hovered. Wiring that to bare `mouseenter`/`mouseleave` produces two
 * failures the ticket names explicitly, and this hook exists for exactly those:
 *
 *   * a cursor merely CROSSING the canvas would set off a wave of nodes opening
 *     and closing behind it — noisier than the always-on dots the change exists
 *     to remove. Hence the open DELAY: the pointer must dwell.
 *   * a momentary exit — crossing an edge drawn over the node, a sub-pixel
 *     jitter at the boundary, the pointer reaching for a port that has just
 *     appeared — would snatch the ports away mid-gesture. Hence the close
 *     GRACE, and the fact that returning CANCELS a pending close.
 *
 * FOCUS IS NOT HOVER, and is deliberately not delayed. A keyboard user cannot
 * dwell; arriving on a node is already a deliberate act, so the dwell would only
 * make the ports lag behind the focus ring. Blur still takes the close grace,
 * which is what keeps the fan open while focus moves from one port to the next
 * (a tab between siblings fires blur then focus in the same task).
 *
 * The delays are exported so the tests and any caller that needs to reason about
 * the timing read the SAME numbers this hook uses, rather than restating them.
 */

/** Dwell before fanning out. Long enough to ignore a pass-over, short enough not to feel laggy. */
export const OPEN_DELAY_MS = 120;

/** Grace before collapsing, cancelled if the pointer or focus returns. */
export const CLOSE_DELAY_MS = 200;

export interface HoverIntent {
  /** Whether the region is currently "entered with intent". */
  open: boolean;
  handlers: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onFocus: () => void;
    onBlur: () => void;
  };
}

export function useHoverIntent({
  openDelayMs = OPEN_DELAY_MS,
  closeDelayMs = CLOSE_DELAY_MS,
} = {}): HoverIntent {
  const [open, setOpen] = useState(false);
  /* ONE timer handle, because open and close are mutually exclusive states of
     the same region: arming either must disarm the other, and holding two
     handles is how a close survives a re-entry and collapses the fan a beat
     after the user reached it. */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /* A pending timer that outlives the component would set state on an unmounted
     hook. Cleanup is the whole reason this is a hook rather than two inline
     handlers. */
  useEffect(() => clear, [clear]);

  const enter = useCallback(() => {
    clear();
    /* Re-entering an ALREADY open region must not re-arm the dwell — that would
       briefly close nothing but would restart the clock for no reason, and it is
       the state a returning pointer lands in most often. */
    setOpen((wasOpen) => {
      if (!wasOpen) timer.current = setTimeout(() => setOpen(true), openDelayMs);
      return wasOpen;
    });
  }, [clear, openDelayMs]);

  const leave = useCallback(() => {
    clear();
    timer.current = setTimeout(() => setOpen(false), closeDelayMs);
  }, [clear, closeDelayMs]);

  /* Focus opens NOW. It also clears a pending close, so focus arriving during
     the grace window (clicking a port collapses no fan) is stable. */
  const focus = useCallback(() => {
    clear();
    setOpen(true);
  }, [clear]);

  /* STABLE across renders, and that is a contract rather than an optimisation:
     callers subscribe these to an element they do not render — React Flow owns
     the focusable node wrapper, which is the PARENT of the box a custom node
     draws, so keyboard arrival can only be observed by adding a listener to it.
     A fresh object each render would tear down and re-add that listener on
     every render, and a focus landing in the gap would be missed. */
  const handlers = useMemo(
    () => ({ onPointerEnter: enter, onPointerLeave: leave, onFocus: focus, onBlur: leave }),
    [enter, leave, focus],
  );

  return { open, handlers };
}
