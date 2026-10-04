import { useEffect, useRef, useState } from 'react';
import { RunSearchSchema } from '@autonomy-studio/shared';

/**
 * #1484 — a search box over a URL param. What is TYPED is local; what is
 * SEARCHED is the URL's `q`, written 300ms after typing stops so a word is one
 * request, not one per letter. `commit` gets the trimmed text (`''` to delete
 * the param) and whether to REPLACE the history entry: the first write of a
 * search pushes and every refinement replaces, so Back leaves the search in one
 * step rather than one letter at a time — and never skips it entirely.
 *
 * When `q` changes from OUTSIDE (Clear, Back, a link), the box follows it. The
 * comparison is on the trimmed text, so the box does not eat a trailing space
 * the operator is mid-way through typing. A Clear that must also drop text not
 * yet written calls the returned setter with `''`.
 */
export function useSearchBox(
  q: string | null | undefined,
  commit: (next: string, replace: boolean) => void,
): [string, (text: string) => void] {
  const [searchText, setSearchText] = useState(q ?? '');
  // Adjusted during render rather than in an effect (React's "storing
  // information from previous renders"), so the box never paints stale.
  const [syncedQ, setSyncedQ] = useState(q);
  if (syncedQ !== q) {
    setSyncedQ(q);
    if (searchText.trim() !== (q ?? '')) setSearchText(q ?? '');
  }
  // The newest `commit`, so a caller's inline function does not restart the wait.
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => {
    const parsed = RunSearchSchema.safeParse(searchText);
    const next = parsed.success ? parsed.data : '';
    if (next === (q ?? '')) return;
    const timer = window.setTimeout(
      () => commitRef.current(next, q !== null && q !== undefined),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [searchText, q]);
  return [searchText, setSearchText];
}
