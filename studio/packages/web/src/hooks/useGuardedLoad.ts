import { useCallback, useEffect, useRef } from 'react';

/**
 * #1062 — the latest-wins list load, once, instead of on each page that needs it.
 *
 * THE RACE IT EXISTS TO KILL. A list page loads on mount and re-loads after
 * every mutation, and its action buttons are not gated behind the first load
 * having arrived. So an operator can create a row while the MOUNT load is still
 * in flight: the post-create refresh resolves first and renders the fresh list,
 * then the mount load lands and overwrites it with the list as it was BEFORE the
 * mutation. The new row appears and silently vanishes, on the one surface that
 * exists to confirm it was stored. Two quick deletes reach the same state from
 * the other direction. An `AbortController` alone does NOT cover this — it fires
 * on unmount, and the component is still very much mounted.
 *
 * Three pages had hand-rolled some or none of the fix (Connections and Triggers
 * none, Secrets all of it) before this hook; the shape had been copied three
 * times and inherited the bug twice.
 *
 * ONE INSTANCE PER STATE TARGET. The ticket is monotonic across every load the
 * instance guards, so pointing one instance at two fetchers that write DIFFERENT
 * state makes each discard the other's result — whichever started second wins
 * twice. `RunsPage` states the same rule for its own two counters. Where a page
 * has one group of state that must move together, give the group ONE fetcher and
 * one instance; where it has genuinely independent targets, give each its own
 * `useGuardedLoad()`.
 *
 * IT DROPS RESULTS, IT DOES NOT CANCEL REQUESTS. A superseded load still runs to
 * completion; its answer is simply not written. The single controller aborts only
 * on unmount. That is deliberate — see `usePolledResource`, which solves the
 * opposite problem with the opposite rule (it DROPS THE NEW LOAD while one is in
 * flight, which is right for a poller and exactly wrong here, because the load
 * that must win is the post-mutation refresh).
 *
 * A NULL CONTROLLER MEANS THE COMPONENT IS GONE, not "no controller available",
 * so the load is not issued at all. The effect below nulls the ref on cleanup;
 * reaching the runner afterwards means the caller was awaiting its own mutation
 * when the page unmounted. Starting an unabortable request on behalf of a
 * component that no longer exists is strictly worse than not starting one —
 * there is nobody left to show the result to. Skipping keeps the invariant TOTAL
 * (no load ever runs without the mount controller) rather than true only at the
 * timings a test happened to pin.
 *
 * THE CALLER'S HALF OF THE CONTRACT, in three parts:
 *
 * 1. The runner is stable for the component's life, so it is safe in a
 *    `useCallback`/`useEffect` dependency list and will not re-arm an effect.
 * 2. Effects run in hook-declaration order within a component, and cleanups in
 *    that same order, so this hook's effect is always set up before — and torn
 *    down before — any effect the caller declares after calling it. That is what
 *    makes the null-controller rule mean "unmounted" rather than "not mounted
 *    yet". It does NOT extend across the parent/child boundary: React runs a
 *    CHILD's passive effects BEFORE its parent's, so a child that called this
 *    runner from its own mount effect would be silently skipped. No caller does
 *    (`ImportPanel`, the one child handed a refresh, performs no I/O on mount —
 *    every request of its is behind the file picker), but a child that starts
 *    doing so must be handed something other than a bare refresh.
 * 3. A RESOLVED load is not evidence the list reloaded. A dropped result and a
 *    skipped load both resolve exactly like a successful one, and failures go to
 *    `onError` rather than to the returned promise, which never rejects. Callers
 *    that awaited a refresh to report "and here it is" must say something they
 *    can still stand behind. (`WorkspaceGitPage` words the same caveat for
 *    `syncStatus`.)
 *
 * WHY HANDLERS AND NOT RETURNED STATE. `usePolledResource` returns its state,
 * which is the established shape here and the better one when a hook owns a
 * single value. It does not fit: these three callers write page-owned state
 * slots they already had, one of them writes THREE of them from a single
 * response, and each keeps its own error wording. Returning state would mean
 * either re-plumbing every consumer of those slots or handing back a value the
 * caller immediately copies into state — the second being an effect-driven
 * mirror, which is the pattern this hook is trying to remove.
 *
 * DELIBERATELY NOT CONVERTED. Four other hand-rolled latest-wins counters remain,
 * because this shape does not fit them: `pipelinesStore` is a store, not a
 * component, and has no mount to hang a controller on; `RunsPage`'s two are
 * dependency-keyed effect loads whose answers are additionally tagged by the
 * filter they were issued under; and `PipelinesPage.invalidateArchived` bumps its
 * counter WITHOUT issuing a load, to void an in-flight answer, which this hook
 * has no vocabulary for. `WorkspaceGitPage` has the unguarded mount shape but
 * not the race: its mutation surfaces render only before the load has arrived,
 * and its post-mutation state comes from callbacks rather than a second load.
 */
export interface GuardedHandlers<T> {
  onData: (value: T) => void;
  onError: (err: unknown) => void;
}

export type GuardedLoad = <T>(
  fetch: (signal: AbortSignal) => Promise<T>,
  handlers: GuardedHandlers<T>,
) => Promise<void>;

export function useGuardedLoad(): GuardedLoad {
  const latestLoad = useRef(0);
  const mountAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    // Created per effect RUN, not once per component: StrictMode mounts, tears
    // down and remounts, so a controller hoisted into the ref's initial value
    // would arrive at the second mount already aborted and fail every load.
    const controller = new AbortController();
    mountAbort.current = controller;
    return () => {
      controller.abort();
      if (mountAbort.current === controller) mountAbort.current = null;
    };
  }, []);

  return useCallback(
    <T,>(fetch: (signal: AbortSignal) => Promise<T>, handlers: GuardedHandlers<T>) => {
      const controller = mountAbort.current;
      if (!controller) return Promise.resolve();
      const ticket = ++latestLoad.current;
      // The promise-callback form, not `async`/`await`: it keeps every setState
      // a handler makes inside a callback rather than in the synchronous body of
      // a caller's mount effect, which is what the `set-state-in-effect` rule
      // requires.
      return fetch(controller.signal)
        .then((value) => {
          if (ticket !== latestLoad.current) return;
          handlers.onData(value);
        })
        .catch((err: unknown) => {
          // A stale REJECTION is dropped for the same reason as a stale success:
          // it would replace a good list with an error banner just as
          // convincingly. An abort is this component unmounting, not a failure
          // to report to anyone.
          if (controller.signal.aborted || ticket !== latestLoad.current) return;
          handlers.onError(err);
        });
    },
    [],
  );
}
