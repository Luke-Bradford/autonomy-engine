import { useEffect, useRef, useState } from 'react';
import {
  TERMINAL_RUN_ROW_STATUS,
  type ActivityRun,
  type ActivityRunGroup,
} from '@autonomy-studio/shared';
import { getRunActivityRuns } from '../../api/runs';
import { messageOf } from '../../api/client';
import { useGuardedLoad } from '../../hooks/useGuardedLoad';

/** The least time between two reads of a run's activity runs while its log grows. */
export const ACTIVITY_RUNS_REFRESH_MS = 500;

/** How often the rows are re-read while a run this one called is still going. */
export const ACTIVITY_RUNS_CHILD_POLL_MS = 2_000;

export interface ActivityRunsReading {
  /** `null` until the first read answers. */
  readonly rows: readonly ActivityRun[] | null;
  /** The containers the rows sit in, read with them; empty before the first read. */
  readonly groups: readonly ActivityRunGroup[];
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
 *
 * A run this one CALLED moves without a word in this run's log: its status and
 * duration are the child's own row. So while the page is `live` and a called
 * run shown is not finished, the rows are also re-read every
 * `ACTIVITY_RUNS_CHILD_POLL_MS`, through the same single flight.
 */
export function useActivityRuns(
  runId: string,
  lastSeq: number | undefined,
  live: boolean,
): ActivityRunsReading {
  const load = useGuardedLoad();
  const [reading, setReading] = useState<ActivityRunsReading>({
    rows: null,
    groups: [],
    error: null,
  });
  const flight = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    inFlight: boolean;
    /** The `lastSeq` and child-poll tick the newest render saw. */
    wanted: string;
    /** The `wanted` the last read was issued at; `null` before any read. */
    asked: string | null;
    /** Set on unmount, so a read landing afterwards schedules nothing. */
    gone: boolean;
  }>({ timer: null, inFlight: false, wanted: '', asked: null, gone: false });

  const childGoing =
    live &&
    (reading.rows ?? []).some(
      (r) => r.childRun !== null && !TERMINAL_RUN_ROW_STATUS.has(r.childRun.status),
    );
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!childGoing) return;
    const timer = setInterval(() => setTick((t) => t + 1), ACTIVITY_RUNS_CHILD_POLL_MS);
    return () => clearInterval(timer);
  }, [childGoing]);

  // Declared FIRST, so StrictMode's simulated remount clears `gone` before the
  // read below is scheduled.
  useEffect(() => {
    const f = flight.current;
    f.gone = false;
    return () => {
      f.gone = true;
      if (f.timer !== null) clearTimeout(f.timer);
      f.timer = null;
    };
  }, []);

  useEffect(() => {
    const f = flight.current;
    f.wanted = `${lastSeq ?? ''}|${tick}`;
    const schedule = (delay: number) => {
      if (f.timer !== null || f.inFlight || f.gone) return;
      f.timer = setTimeout(() => {
        f.timer = null;
        f.inFlight = true;
        f.asked = f.wanted;
        void load((signal) => getRunActivityRuns(runId, signal), {
          onData: (res) => setReading({ rows: res.rows, groups: res.groups, error: null }),
          onError: (err) => setReading((prev) => ({ ...prev, error: messageOf(err) })),
        }).finally(() => {
          f.inFlight = false;
          if (f.wanted !== f.asked) schedule(ACTIVITY_RUNS_REFRESH_MS);
        });
      }, delay);
    };
    schedule(f.asked === null ? 0 : ACTIVITY_RUNS_REFRESH_MS);
  }, [load, runId, lastSeq, tick]);

  return reading;
}
