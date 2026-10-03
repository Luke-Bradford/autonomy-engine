import { useEffect } from 'react';

/**
 * Call `refresh` whenever the window regains focus, while `enabled`.
 *
 * The editor re-reads what another tab, a merge or a scheduler may have
 * changed while it was in the background (#1502, #1476): versions and the live
 * pointer, the repo comparison, the open pull request. Each read is its own
 * guarded load, so a focus that lands while one is in flight supersedes it
 * rather than racing it.
 *
 * `refresh` should be stable (`useCallback`): a new identity re-binds the
 * listener, which is harmless but needless.
 */
export function useRefreshOnFocus(refresh: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh, enabled]);
}
