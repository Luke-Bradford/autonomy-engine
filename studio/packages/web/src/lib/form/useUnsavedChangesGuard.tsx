import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useBlocker, type Blocker } from 'react-router';

/**
 * #1396 — the one unsaved-changes guard every resource form uses.
 *
 * Three ways out of a dirty form, all held at the same prompt:
 *   - an in-page action (Cancel, Close, Escape, opening another row's form),
 *     which the page routes through `request`;
 *   - a route change, which `routeHold` holds (the app is a data router);
 *   - closing or reloading the tab, which only the browser's own
 *     `beforeunload` prompt can hold — a page cannot draw its own there.
 *
 * A clean form is never prompted: `request` runs the action at once, and the
 * route hold and the `beforeunload` listener exist only while `dirty`.
 */
export interface UnsavedChangesGuard {
  /** Whether the "discard unsaved changes?" prompt is showing. */
  readonly confirming: boolean;
  /** Run `action` now if the form is clean, otherwise hold it at the prompt. */
  request: (action: () => void) => void;
  /** Throw the edits away and carry on with whatever was held. */
  discard: () => void;
  /** Stay on the form; the held action is dropped. */
  keep: () => void;
  /**
   * Render this anywhere in the page. It is `null` while the form is clean,
   * and that is the point of it being an element rather than a `useBlocker`
   * call in this hook: React Router warns about EVERY registered blocker on a
   * navigation it did not create (a typed URL, `page.goto`), even one that
   * would not block. So the blocker is mounted only while there is something
   * to hold.
   */
  readonly routeHold: ReactNode;
}

export function useUnsavedChangesGuard(dirty: boolean): UnsavedChangesGuard {
  // A function in state must be wrapped, or React calls it as an updater.
  const [held, setHeld] = useState<{ action: () => void } | null>(null);
  const [blocked, setBlocked] = useState<Blocker | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chromium still needs `returnValue` set to show the prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const request = useCallback(
    (action: () => void) => {
      if (dirty) setHeld({ action });
      else action();
    },
    [dirty],
  );

  const discard = useCallback(() => {
    blocked?.proceed?.();
    setBlocked(null);
    const pending = held;
    setHeld(null);
    pending?.action();
  }, [blocked, held]);

  const keep = useCallback(() => {
    blocked?.reset?.();
    setBlocked(null);
    setHeld(null);
  }, [blocked]);

  return {
    confirming: held !== null || blocked !== null,
    request,
    discard,
    keep,
    routeHold: dirty ? <RouteHold onBlocked={setBlocked} /> : null,
  };
}

/** Holds every route change while mounted, and hands the held one up. */
function RouteHold({ onBlocked }: { onBlocked: (blocker: Blocker) => void }) {
  const blocker = useBlocker(true);
  useEffect(() => {
    if (blocker.state === 'blocked') onBlocked(blocker);
  }, [blocker, onBlocked]);
  return null;
}
