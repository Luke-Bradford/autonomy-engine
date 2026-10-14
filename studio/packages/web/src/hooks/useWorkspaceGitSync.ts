import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceGitSync } from '@autonomy-studio/shared';
import { readWorkspaceGitSync } from '../api/workspaceGit';

/**
 * #1511 / #1689 — the workspace's git comparison (`POST /api/workspace/git/sync`),
 * read here instead of by hand on each surface that shows it: the pipeline
 * editor's badge and the pipelines list.
 *
 * SINGLE-FLIGHT, WITH ONE TRAILING RE-READ. The editor asks for a sync when the
 * repo is known to be connected, when its newest version changes and on focus,
 * and on a reload those three land together. Issued as three requests behind a
 * latest-wins guard, the first two answers were thrown away and the badge
 * waited on the slowest. Here a `refresh()` while a read is in flight starts
 * nothing; it marks the reading stale, and when the in-flight answer lands it
 * is SHOWN and exactly one more read follows, however many refreshes arrived
 * meanwhile. Showing it is right: it is what the server said a moment ago, and
 * the trailing read replaces it. So at most one read is pending and at most one
 * is queued.
 *
 * This is the opposite of `useGuardedLoad`'s rule, deliberately. That hook
 * exists for a list whose post-mutation refresh must win over an older load;
 * here every read asks the same question with no input, so an older answer is
 * not a wrong one, only an earlier one, and the trailing read covers anything
 * that changed while it was out.
 *
 * A READ THAT NEVER ANSWERS must not stop every later one: `apiFetch` has no
 * deadline, so a refresh arriving once the pending read is older than
 * `STALE_AFTER_MS` gives up on it (its answer is dropped) and starts a new one.
 *
 * `clear()` IS A DISCONNECT. It drops the pending read's answer, cancels the
 * queued re-read and empties the reading, so a comparison against a repo that
 * is no longer connected never lands afterwards. A `refresh()` after it starts
 * a new read at once. A dropped read is not aborted: the mount controller is
 * shared, so it still runs to completion on the server.
 *
 * `sync` is `undefined` while unread, cleared or failed, `null` when the server
 * answered but its own fetch failed (nothing was compared), else the
 * comparison. `failed` tells a failed read from an unread one, for the list's
 * filters. `onUnavailable` runs on a `null` answer; the editor re-reads its
 * publish state there, so `fetch failed` shows at once.
 *
 * The repo STATUS and focus stay with each caller: the editor reads the status
 * from its publish state and the list from `GET /api/workspace/git`, and the
 * list re-reads the status first on focus and refreshes from that.
 */
export const STALE_AFTER_MS = 30_000;

export interface WorkspaceGitSyncReading {
  sync: WorkspaceGitSync | null | undefined;
  failed: boolean;
  refresh: () => void;
  clear: () => void;
}

export function useWorkspaceGitSync(onUnavailable?: () => void): WorkspaceGitSyncReading {
  const [sync, setSync] = useState<WorkspaceGitSync | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  // Per effect run, not per component (StrictMode remounts); null once unmounted.
  const mountAbort = useRef<AbortController | null>(null);
  // Bumped by every read, `clear()` and unmount: a read started under an older
  // generation writes nothing and starts nothing, so its queued re-read dies
  // with it (each new read resets `rerun`).
  const generation = useRef(0);
  // When the pending read started, or null when none is pending.
  const pendingSince = useRef<number | null>(null);
  const rerun = useRef(false);
  // The latest callback, so `refresh`/`clear` stay stable for effect deps.
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
      generation.current += 1;
      pendingSince.current = null;
    };
  }, []);

  const actions = useMemo(() => {
    const start = (): void => {
      const controller = mountAbort.current;
      if (!controller) return;
      const gen = ++generation.current;
      pendingSince.current = Date.now();
      rerun.current = false;
      const settle = (apply: () => void): void => {
        if (gen !== generation.current) return;
        pendingSince.current = null;
        // `finally`, so a throwing `onUnavailable` does not lose the re-read.
        try {
          apply();
        } finally {
          if (rerun.current) start();
        }
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
        const since = pendingSince.current;
        if (since !== null && Date.now() - since < STALE_AFTER_MS) {
          rerun.current = true;
          return;
        }
        start();
      },
      clear: (): void => {
        generation.current += 1;
        pendingSince.current = null;
        setSync(undefined);
        setFailed(false);
      },
    };
  }, []);

  return { sync, failed, refresh: actions.refresh, clear: actions.clear };
}
