import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceGitSync } from '@autonomy-studio/shared';
import { readWorkspaceGitSync } from '../api/workspaceGit';

/**
 * #1511 / #1689 — the workspace's git comparison (`POST /api/workspace/git/sync`),
 * read once here instead of by hand on each surface that shows it. The pipeline
 * editor's badge and the pipelines list each had their own copy, and the two
 * had already drifted: only the list dropped an in-flight sync when the repo
 * went away.
 *
 * SINGLE-FLIGHT, WITH ONE TRAILING RE-READ. The editor asks for a sync when the
 * repo is known to be connected, when its newest version changes and on focus,
 * and on a reload those three land within half a second of each other. Issued
 * as three requests behind a latest-wins guard, the first two answers were
 * thrown away and the badge waited on the third, which under server contention
 * was the slowest (#1689: 3.1 s and 6.0 s discarded, the third past 5 s). Here a
 * `refresh()` while a read is in flight starts nothing; it marks the reading
 * stale, and when the in-flight answer lands it is SHOWN and exactly one more
 * read follows, however many refreshes arrived meanwhile. Showing it is right:
 * it is what the server said a moment ago, and the follow-up read replaces it.
 * Holding it back would put the badge behind two syncs in a row instead of one.
 * So at most one request is in flight and at most one is queued.
 *
 * This is the opposite of `useGuardedLoad`'s rule, deliberately. That hook
 * exists for a list whose post-mutation refresh must win over an older load;
 * here every read asks the same question with no input, so an older answer is
 * not a wrong one, only an earlier one, and the trailing read covers anything
 * that changed while it was out.
 *
 * `clear()` IS A DISCONNECT. It supersedes the read in flight (its answer is
 * dropped, the queued re-read is cancelled) and empties the reading, so a
 * comparison against a repo that is no longer connected never lands
 * afterwards. A `refresh()` after it starts a new read at once rather than
 * waiting for the dropped one.
 *
 * THREE STATES, as before: `undefined` unread, cleared or failed; `null` when
 * the server answered but its fetch failed, so nothing was compared; else the
 * comparison. `failed` tells a failed read apart from an unread one, for the
 * list's filters. `onUnavailable` runs on a `null` answer. The editor re-reads
 * its publish state there, so `fetch failed` shows at once.
 *
 * The repo STATUS stays with each caller, because the two surfaces read it from
 * different places: the editor from its publish state, the list from
 * `GET /api/workspace/git`. Focus stays with each caller for a similar reason:
 * the list re-reads the status first on focus and refreshes from that.
 *
 * An unmounted component issues nothing and writes nothing, as in
 * `useGuardedLoad`: the controller is created per effect run (StrictMode) and
 * aborted on cleanup.
 */
export interface WorkspaceGitSyncReading {
  sync: WorkspaceGitSync | null | undefined;
  failed: boolean;
  refresh: () => void;
  clear: () => void;
}

export function useWorkspaceGitSync(onUnavailable?: () => void): WorkspaceGitSyncReading {
  const [sync, setSync] = useState<WorkspaceGitSync | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const mountAbort = useRef<AbortController | null>(null);
  // Bumped by `clear()`: a read started under an older generation is void.
  const generation = useRef(0);
  const inFlight = useRef(false);
  const rerun = useRef(false);
  const onUnavailableRef = useRef(onUnavailable);

  useEffect(() => {
    onUnavailableRef.current = onUnavailable;
  }, [onUnavailable]);

  useEffect(() => {
    const controller = new AbortController();
    mountAbort.current = controller;
    return () => {
      controller.abort();
      if (mountAbort.current === controller) mountAbort.current = null;
      // A remount (StrictMode) starts clean: the aborted read never settles
      // into this generation's bookkeeping.
      generation.current += 1;
      inFlight.current = false;
      rerun.current = false;
    };
  }, []);

  const actions = useMemo(() => {
    const start = (): void => {
      const controller = mountAbort.current;
      if (!controller) return;
      const gen = generation.current;
      inFlight.current = true;
      rerun.current = false;
      const settle = (apply: () => void): void => {
        if (controller.signal.aborted || gen !== generation.current) return;
        inFlight.current = false;
        apply();
        if (rerun.current) start();
      };
      readWorkspaceGitSync(controller.signal).then(
        (s) =>
          settle(() => {
            setSync(s);
            setFailed(false);
            if (s === null) onUnavailableRef.current?.();
          }),
        () =>
          settle(() => {
            setSync(undefined);
            setFailed(true);
          }),
      );
    };
    return {
      refresh: (): void => {
        if (inFlight.current) {
          rerun.current = true;
          return;
        }
        start();
      },
      clear: (): void => {
        generation.current += 1;
        inFlight.current = false;
        rerun.current = false;
        setSync(undefined);
        setFailed(false);
      },
    };
  }, []);

  return { sync, failed, refresh: actions.refresh, clear: actions.clear };
}
