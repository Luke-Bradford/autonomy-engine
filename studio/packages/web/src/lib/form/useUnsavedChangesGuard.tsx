import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useBlocker, type Blocker, type BlockerFunction } from 'react-router';

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

export interface UnsavedChangesGuardOptions {
  /**
   * Which route changes to hold while dirty. Every one by default: a resource
   * form closes on any navigation. `false` holds none, for a form inside a
   * page that holds route changes itself.
   */
  readonly holdRoute?: boolean | BlockerFunction;
}

export function useUnsavedChangesGuard(
  dirty: boolean,
  { holdRoute = true }: UnsavedChangesGuardOptions = {},
): UnsavedChangesGuard {
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

  // #1438 — a form that goes clean while the prompt is up (its save landed, the
  // record was deleted, the edits were undone by hand) has nothing left to ask
  // about, and the prompt existed only to protect those edits. So whatever was
  // held carries on, as Discard would have carried it on: the link the operator
  // clicked, the other row they opened. Dropping it left their click doing
  // nothing at all.
  //
  // A held route change is carried on by `RouteHold` itself, which stays
  // mounted until it has (react-router's `proceed()` on a blocker that has
  // unregistered throws: the router has forgotten it). A held in-page action
  // is handed over during render (React's derived-state pattern), so the
  // prompt is never painted for it, and run by the effect after.
  const [carry, setCarry] = useState<{ action: () => void } | null>(null);
  if (!dirty && held !== null) {
    setCarry(held);
    setHeld(null);
  }
  useEffect(() => {
    carry?.action();
  }, [carry]);

  const request = useCallback(
    (action: () => void) => {
      if (dirty) setHeld({ action });
      else action();
    },
    [dirty],
  );

  const discard = useCallback(() => {
    if (blocked?.state === 'blocked') blocked.proceed();
    setBlocked(null);
    const pending = held;
    setHeld(null);
    pending?.action();
  }, [blocked, held]);

  const keep = useCallback(() => {
    if (blocked?.state === 'blocked') blocked.reset();
    setBlocked(null);
    setHeld(null);
  }, [blocked]);

  return {
    // Only while dirty: a clean form's held route change is about to carry on
    // (above), and the prompt must not be painted for it even once.
    confirming: dirty && (held !== null || blocked !== null),
    request,
    discard,
    keep,
    // `false` mounts no blocker at all: even `useBlocker(false)` registers one,
    // and the router consults only one (#1476 — the editor's own leave guard).
    routeHold:
      (dirty || blocked !== null) && holdRoute !== false ? (
        <RouteHold when={holdRoute} release={!dirty} onBlocked={setBlocked} />
      ) : null,
  };
}

/**
 * Holds the route changes `when` names while mounted, and hands the held one
 * up. Once `release` (the form went clean), it lets the held one through and
 * then reports that nothing is held.
 */
function RouteHold({
  when,
  release,
  onBlocked,
}: {
  when: boolean | BlockerFunction;
  release: boolean;
  onBlocked: (blocker: Blocker | null) => void;
}) {
  const blocker = useBlocker(when);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (release) blocker.proceed();
      else onBlocked(blocker);
    } else if (release) {
      onBlocked(null);
    }
  }, [blocker, release, onBlocked]);
  return null;
}
