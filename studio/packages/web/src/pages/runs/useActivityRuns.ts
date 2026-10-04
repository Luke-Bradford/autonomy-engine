import { useEffect, useRef, useState } from 'react';
import type { ActivityRun } from '@autonomy-studio/shared';
import { getRunActivityRuns } from '../../api/runs';
import { messageOf } from '../../api/client';
import { useGuardedLoad } from '../../hooks/useGuardedLoad';

/** The least time between two reads of a run's activity runs while its log grows. */
export const ACTIVITY_RUNS_REFRESH_MS = 500;

export interface ActivityRunsReading {
  /** `null` until the first read answers. */
  readonly rows: readonly ActivityRun[] | null;
  /** The last read's failure; the rows before it stay on screen. */
  readonly error: string | null;
}

/**
 * #1484 OR35 M2 — the run's activity runs, re-read as its log grows.
 *
 * `lastSeq` is the newest event the page's stream has seen. Each change asks for
 * a read, and reads are THROTTLED rather than debounced: the first change
 * schedules one, and changes that arrive while it is pending ride on it. A
 * debounce would never fire on a run that logs faster than its delay. Since the
 * server appends an event before streaming it, a read scheduled after the last
 * frame always sees it. `useGuardedLoad` keeps only the newest answer.
 */
export function useActivityRuns(runId: string, lastSeq: number | undefined): ActivityRunsReading {
  const load = useGuardedLoad();
  const [reading, setReading] = useState<ActivityRunsReading>({ rows: null, error: null });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const first = useRef(true);

  useEffect(() => {
    if (timer.current !== null) return;
    const delay = first.current ? 0 : ACTIVITY_RUNS_REFRESH_MS;
    first.current = false;
    timer.current = setTimeout(() => {
      timer.current = null;
      void load((signal) => getRunActivityRuns(runId, signal), {
        onData: (res) => setReading({ rows: res.rows, error: null }),
        onError: (err) => setReading((prev) => ({ rows: prev.rows, error: messageOf(err) })),
      });
    }, delay);
  }, [load, runId, lastSeq]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  return reading;
}
