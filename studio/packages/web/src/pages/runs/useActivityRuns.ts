import { useEffect, useRef, useState } from 'react';
import {
  TERMINAL_RUN_ROW_STATUS,
  type ActivityRun,
  type ActivityRunGroup,
  type ActivityRunsBasis,
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
  /** #1557 — what the rows were projected from; `null` before the first read.
   * `log`: the run's version no longer resolves, so they say less. */
  readonly basis: ActivityRunsBasis | null;
  /** The last read's failure; the rows before it stay on screen. */
  readonly error: string | null;
  /**
   * #1541 — the stream's `lastSeq` the rows on screen were asked at, or `null`
   * before the first read lands. The server appends before it streams, so rows
   * asked at N reflect at least the log up to N. A failed read keeps the last.
   * A read asked before the stream's first frame is `null`, so a finished run's
   * page has a `readAt` once the read after its replay lands.
   */
  readonly readAt: number | null;
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
    basis: null,
    error: null,
    readAt: null,
  });
  const flight = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    inFlight: boolean;
    /** The `lastSeq` the newest render saw, and the child-poll tick. */
    wanted: string;
    /** Child-poll ticks so far. A ref, not state: a tick the flight absorbs renders nothing. */
    poll: number;
    /** Asks for a read at the current tick; installed by the read effect. */
    kick: (() => void) | null;
    /** The `wanted` the last read was issued at; `null` before any read. */
    asked: string | null;
    /** The `lastSeq` the newest render saw, for `readAt`. */
    wantedSeq: number | undefined;
    /** Set on unmount, so a read landing afterwards schedules nothing. */
    gone: boolean;
  }>({
    timer: null,
    inFlight: false,
    wanted: '',
    poll: 0,
    kick: null,
    asked: null,
    wantedSeq: undefined,
    gone: false,
  });

  const childGoing =
    live &&
    (reading.rows ?? []).some(
      (r) => r.childRun !== null && !TERMINAL_RUN_ROW_STATUS.has(r.childRun.status),
    );
  useEffect(() => {
    if (!childGoing) return;
    const f = flight.current;
    const timer = setInterval(() => {
      f.poll += 1;
      f.kick?.();
    }, ACTIVITY_RUNS_CHILD_POLL_MS);
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
    const schedule = (delay: number) => {
      if (f.timer !== null || f.inFlight || f.gone) return;
      f.timer = setTimeout(() => {
        f.timer = null;
        f.inFlight = true;
        f.asked = f.wanted;
        const askedAt = f.wantedSeq ?? null;
        void load((signal) => getRunActivityRuns(runId, signal), {
          onData: (res) =>
            setReading({
              rows: res.rows,
              groups: res.groups,
              basis: res.basis,
              error: null,
              readAt: askedAt,
            }),
          onError: (err) => setReading((prev) => ({ ...prev, error: messageOf(err) })),
        }).finally(() => {
          f.inFlight = false;
          if (f.wanted !== f.asked) schedule(ACTIVITY_RUNS_REFRESH_MS);
        });
      }, delay);
    };
    f.kick = () => {
      f.wanted = `${lastSeq ?? ''}|${f.poll}`;
      f.wantedSeq = lastSeq;
      schedule(f.asked === null ? 0 : ACTIVITY_RUNS_REFRESH_MS);
    };
    f.kick();
  }, [load, runId, lastSeq]);

  return reading;
}
