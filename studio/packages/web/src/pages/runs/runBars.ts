import { TERMINAL_RUN_ROW_STATUS, type RunStatus, type RunSummary } from '@autonomy-studio/shared';
import { spanWindow, type SpanLike } from './attemptSpans';

/**
 * U29 (#1015) — the pure classification and grouping behind `RunTimeline`, the
 * cross-run Gantt on `/monitor/runs`.
 *
 * Split out of the component for the reason `attemptSpans.ts` gives for its own
 * split: `react-refresh` refuses a module exporting both components and plain
 * functions, and a verdict, a grouping and a window are all checkable without
 * rendering anything.
 *
 * It reuses U12a's geometry rather than restating it — `spanWindow` and
 * `placeSpans` are generic over `SpanLike` precisely so this surface can. What
 * is NOT shared is the classification: a node has no bar for reasons about the
 * ENGINE (a routed-around node, a control activity, a copied frontier), while a
 * run has no bar for reasons about the ROW's two timestamp columns. Those are
 * different questions with different answers, and merging them would produce a
 * chain that is vague about both.
 */

/** A run's start-and-maybe-finish, with the row it came from. */
export interface RunBar extends SpanLike {
  run: RunSummary;
}

/** One lane of the chart: a pipeline, and the runs of it that can be drawn. */
export interface RunGroup {
  pipelineId: string;
  pipelineName: string;
  /** Oldest first. Never empty — a lane with nothing to draw is not a lane. */
  bars: RunBar[];
}

/** A row the chart refuses to draw, and why. */
export interface UnplottableRun {
  run: RunSummary;
  reason: string;
}

/**
 * Why the chart will not plot this run — `null` when it will.
 *
 * Exhaustive BY CONSTRUCTION over `RunStatus`, following `TERMINAL_RUN_ROW_STATUS`'s
 * construction rather than a `!honest.has(status)` test: a ninth status must land
 * here and force a decision, instead of defaulting onto the axis. Defaulting the
 * WRONG way is the failure that matters — an unplottable row drawn as a bar is a
 * lie, where a plottable row named in the list beneath is merely a shortfall.
 *
 * `queued` is the one status whose start stamp is not a start. `startedAt` holds
 * the ENQUEUE instant until admission re-stamps it (`admitQueuedRun`, and the
 * `queuedAt` docblock on `RunSchema` says so: "admission re-stamps `startedAt`,
 * not this"). Plotting it would claim the run has been executing since it joined
 * the queue, which on a busy workspace is the difference between a two-second
 * run and a two-hour bar. Every other status is honest: `pending` is a row
 * created and driven a microtask later, and `running`/`waiting` and the terminal
 * four all have a real admission behind them.
 */
const UNPLOTTABLE_BY_STATUS: Record<RunStatus, string | null> = {
  queued:
    'held for a concurrency slot — its start stamp is when it was enqueued, not when it began',
  pending: null,
  running: null,
  waiting: null,
  success: null,
  failure: null,
  interrupted: null,
  skipped: null,
};

export function unplottableReason(run: RunSummary): string | null {
  const byStatus = UNPLOTTABLE_BY_STATUS[run.status];
  if (byStatus !== null) return byStatus;

  /* The two integrity cases, and they are here rather than left to the geometry
     because of what the geometry would do with them. Both fail `isMeasurable`,
     so both would fall into the OPEN arm and be drawn hatched to the right edge
     — the visual claim "started here, no end on record" — beside a `success`
     pill. Meanwhile the Duration column states `0ms` for the first of them
     (`formatRunDuration` clamps at zero, deliberately). One row, two surfaces,
     contradictory claims: exactly the failure U12a's third property exists to
     prevent, so the row is NAMED instead of drawn.

     A backwards clock means the wall clock stepped between two writes; a
     terminal row with no finish means a write was lost or the row predates the
     column. Neither is reachable from today's writers (`driver.ts` always
     stamps), which makes this cheap insurance rather than fiction — a legacy or
     hand-edited row is the case it catches. */
  if (run.finishedAt !== null && run.finishedAt < run.startedAt) {
    return 'the recorded finish precedes the start, so no length can be stated';
  }
  if (TERMINAL_RUN_ROW_STATUS.has(run.status) && run.finishedAt === null) {
    return 'settled, but the row records no finish, so no length can be stated';
  }
  return null;
}

/**
 * A run as a span. An unfinished run states NO end rather than an end of `now` —
 * the no-clock property, at its source. `?? undefined` because `SpanLike` speaks
 * the log's `undefined` while the row column is a SQL `null`.
 */
export function toRunBar(run: RunSummary): RunBar {
  return { run, startedAtMs: run.startedAt, endedAtMs: run.finishedAt ?? undefined };
}

export interface GroupedRuns {
  /** Lanes, in the order the workspace got busy. */
  groups: RunGroup[];
  /**
   * Every row the chart would not draw, with its reason, in the order they were
   * handed in — this does not sort them.
   *
   * Stated as a pass-through rather than as "newest first", which is what it
   * LOOKS like on screen and would be a claim this function cannot keep:
   * `listRunSummaries` orders `desc(startedAt)` and `filterRunsByTab` preserves
   * order, so the rows arrive newest-first and the list renders newest-first —
   * but nothing here enforces that, and a caller passing rows in another order,
   * or a change to the server's `ORDER BY`, would quietly falsify it. The
   * precondition is the caller's; `groupRunsByPipeline`'s docblock repeats it.
   */
  unplottable: UnplottableRun[];
  /**
   * The ONE axis every lane is drawn against, or `null` when nothing is
   * plottable. Measured across ALL groups, which is the whole claim of a
   * cross-run chart: a per-group window would stretch each lane to full width
   * independently and answer no cross-run question at all.
   */
  window: { from: number; to: number } | null;
}

/**
 * Lanes, refusals and the shared window, from one pass over the rows.
 *
 * The GROUPS are sorted here and their ordering is guaranteed. The `unplottable`
 * list is NOT: it comes back in the order `runs` was given, so the caller owns
 * how it reads. `RunsPage` hands over `visible`, which is newest-first.
 */
export function groupRunsByPipeline(runs: readonly RunSummary[]): GroupedRuns {
  const unplottable: UnplottableRun[] = [];
  const lanes = new Map<string, RunGroup>();

  for (const run of runs) {
    const reason = unplottableReason(run);
    if (reason !== null) {
      unplottable.push({ run, reason });
      continue;
    }
    let lane = lanes.get(run.pipelineId);
    if (lane === undefined) {
      lane = { pipelineId: run.pipelineId, pipelineName: run.pipelineName, bars: [] };
      lanes.set(run.pipelineId, lane);
    }
    lane.bars.push(toRunBar(run));
  }

  const groups = [...lanes.values()];
  for (const lane of groups) {
    lane.bars.sort((a, b) => a.startedAtMs - b.startedAtMs || a.run.id.localeCompare(b.run.id));
  }
  /* Earliest bar first, so the chart reads top-left to bottom-right. Every tie
     is broken all the way down — start, then name, then id — because a chart
     that reshuffles its lanes between two renders of the same rows is one the
     operator cannot compare against the last one they looked at. `bars[0]` is
     safe: a lane exists only because a bar was pushed into it. */
  groups.sort(
    (a, b) =>
      (a.bars[0]?.startedAtMs ?? 0) - (b.bars[0]?.startedAtMs ?? 0) ||
      a.pipelineName.localeCompare(b.pipelineName) ||
      a.pipelineId.localeCompare(b.pipelineId),
  );

  return {
    groups,
    unplottable,
    window: spanWindow(
      (function* () {
        for (const lane of groups) yield* lane.bars;
      })(),
    ),
  };
}
