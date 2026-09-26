import { useEffect, useState } from 'react';

/**
 * #890 — the wall clock, re-read every `intervalMs` for as long as the caller
 * is mounted.
 *
 * Deliberately a hook a LEAF component calls, not page state. The run detail
 * page refolds its whole log whenever it renders (#849), so a page-level tick
 * would pay that fold once a second; a leaf that owns the clock re-renders
 * only itself. Mount it only where something is actually counting — an idle
 * page should hold no timer at all.
 *
 * Not `AiActivityPage`'s `useNow`, which reads the clock once per render and
 * never ticks. The two names differ on purpose.
 */
export function useTickingNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
