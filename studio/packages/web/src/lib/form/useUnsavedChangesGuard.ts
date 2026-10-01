import { useCallback, useEffect, useState } from 'react';
import { useBlocker } from 'react-router';

/**
 * #1396 — the one unsaved-changes guard every resource form uses.
 *
 * Three ways out of a dirty form, all held at the same prompt:
 *   - an in-page action (Cancel, Close, Escape, opening another row's form),
 *     which the page routes through `request`;
 *   - a route change, which `useBlocker` holds (the app is a data router);
 *   - closing or reloading the tab, which only the browser's own
 *     `beforeunload` prompt can hold — a page cannot draw its own there.
 *
 * A clean form is never prompted: `request` runs the action at once, and the
 * blocker and the `beforeunload` listener are only armed while `dirty`.
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
}

export function useUnsavedChangesGuard(dirty: boolean): UnsavedChangesGuard {
  // A function in state must be wrapped, or React calls it as an updater.
  const [held, setHeld] = useState<{ action: () => void } | null>(null);
  const blocker = useBlocker(dirty);

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
    if (blocker.state === 'blocked') blocker.proceed();
    const pending = held;
    setHeld(null);
    pending?.action();
  }, [blocker, held]);

  const keep = useCallback(() => {
    if (blocker.state === 'blocked') blocker.reset();
    setHeld(null);
  }, [blocker]);

  return { confirming: held !== null || blocker.state === 'blocked', request, discard, keep };
}
