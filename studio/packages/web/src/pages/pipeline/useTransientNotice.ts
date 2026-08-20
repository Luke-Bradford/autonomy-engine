import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A one-line notice that clears itself after `ms`.
 *
 * For feedback about a gesture that is ALREADY OVER. The canvas' save line can
 * live in plain state because the next save owns wiping it — every save handler
 * opens with `setSaveMsg(null)`, so the line on screen always belongs to the
 * most recent attempt. A copy/paste/duplicate has no such successor: nothing
 * else on the canvas has any business clearing it, so left alone it persists
 * indefinitely, sitting under unrelated later work still claiming to describe
 * it.
 *
 * The window is re-armed on the GESTURE rather than reactively on the text,
 * which is what makes a repeat honest: copying the same selection twice sets
 * identical text, so a `useEffect` keyed on the message would not re-run and
 * the second copy would inherit the first's half-spent window.
 *
 * `clear` is for the other way a notice can stop being true: not time passing,
 * but the thing it described going away. A gesture report on a panel that has
 * since re-seeded onto a different doc is stale immediately, and waiting out the
 * window would leave it claiming to describe work the author has already
 * committed.
 *
 * @param ms how long the notice stays up, from the most recent `show`.
 * @returns the current notice (or `null`), the function that raises one, and the
 *   function that drops it early.
 */
export function useTransientNotice(
  ms: number,
): [string | null, (text: string) => void, () => void] {
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(
    (text: string) => {
      setNotice(text);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setNotice(null), ms);
    },
    [ms],
  );

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setNotice(null);
  }, []);

  // A pending timer outliving the component would set state on a dead one.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return [notice, show, clear];
}
