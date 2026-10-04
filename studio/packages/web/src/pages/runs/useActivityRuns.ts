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
 * `lastSeq` is the newest event the page's stream has seen. A change asks for a
 * read, and reads are THROTTLED and SINGLE-FLIGHT:
 * - the first change schedules a read, and changes while it is pending ride on
 *   it. A debounce would never fire on a run that logs faster than its delay.
 * - no read starts while one is in flight. When it lands, if the stream moved on
 *   meanwhile, one more is scheduled. A slow server therefore gets one request at
 *   a time, never a pile of superseded ones.
 * Since the server appends an event before streaming it, the read that follows
 * the last frame always sees it.
 */
export function useActivityRuns(runId: string, lastSeq: number | undefined): ActivityRunsReading {
  const load = useGuardedLoad();
  const [reading, setReading] = useState<ActivityRunsReading>({ rows: null, error: null });
  const flight = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    inFlight: boolean;
    /** The `lastSeq` the newest render saw. */
    wanted: number | undefined;
    /** The `lastSeq` the last read was issued at; `null` before any read. */
    asked: number | undefined | null;
    /** Set on unmount, so a read landing afterwards schedules nothing. */
    gone: boolean;
  }>({ timer: null, inFlight: false, wanted: lastSeq, asked: null, gone: false });

  useEffect(() => {
    const f = flight.current;
    f.wanted = lastSeq;
    const schedule = (delay: number) => {
      if (f.timer !== null || f.inFlight || f.gone) return;
      f.timer = setTimeout(() => {
        f.timer = null;
        f.inFlight = true;
        f.asked = f.wanted;
        void load((signal) => getRunActivityRuns(runId, signal), {
          onData: (res) => setReading({ rows: res.rows, error: null }),
          onError: (err) => setReading((prev) => ({ rows: prev.rows, error: messageOf(err) })),
        }).finally(() => {
          f.inFlight = false;
          if (f.wanted !== f.asked) schedule(ACTIVITY_RUNS_REFRESH_MS);
        });
      }, delay);
    };
    schedule(f.asked === null ? 0 : ACTIVITY_RUNS_REFRESH_MS);
  }, [load, runId, lastSeq]);

  useEffect(() => {
    const f = flight.current;
    f.gone = false;
    return () => {
      f.gone = true;
      if (f.timer !== null) clearTimeout(f.timer);
      f.timer = null;
    };
  }, []);

  return reading;
}
