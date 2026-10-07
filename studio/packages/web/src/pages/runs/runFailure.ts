import { parseInstanceKey, type ActivityRun, type RunState } from '@autonomy-studio/shared';

/**
 * #1484 OR35 M2 — what a failed run's banner names, read from the engine's own
 * blame rather than guessed from the table.
 *
 * The run's terminal reason (`run.finished.reason`, `RunOutcome`'s docblock in
 * `engine/types.ts`) is `node_failed:<id>` for a run an activity failed, where
 * the id is a TOP-LEVEL node or container, never an instance key. A blamed
 * container records its own cause in `containers[id].reason`: `child_failed:<id>`
 * names the child it blames (an instance key, `w@2`, inside a parallel ForEach),
 * and anything else (`timeout`, `no_progress`, `capped`, …) is the container's
 * own failure, with no child to point at. So the blame is followed down through
 * `child_failed:` to the activity that actually failed.
 *
 * The row is the LAST failed attempt of that activity: the exact instance first,
 * then the canvas node it is an item of. "The last failed row under the
 * container" would be wrong: a child failure the container absorbed (a handled
 * one) can come after the one it blamed.
 */
export type RunFailure =
  | {
      kind: 'activity';
      /** The failed instance as the engine names it (`w@2` in a parallel item). */
      nodeId: string;
      /** The canvas node behind it, which names it. */
      activityId: string;
      /** Its last failed attempt; `null` while the rows have not loaded. */
      row: ActivityRun | null;
    }
  | { kind: 'container'; containerId: string; reason: string }
  | { kind: 'run'; reason: string | null };

const NODE_FAILED = 'node_failed:';
const CHILD_FAILED = 'child_failed:';

/**
 * `reason` is the run's terminal reason; `containers` is the projected state's,
 * or `null` when the version doc did not resolve. The page then cannot follow a
 * container's blame, so it names the blamed id (container or activity) and
 * attaches the row only when one is that exact node, never a guessed child.
 */
export function runFailure(
  reason: string | null,
  containers: RunState['containers'] | null,
  rows: readonly ActivityRun[] | null,
): RunFailure {
  if (reason === null || !reason.startsWith(NODE_FAILED)) return { kind: 'run', reason };
  let blamed = reason.slice(NODE_FAILED.length);
  // Bounded by the number of containers, so a malformed cycle cannot spin.
  for (let hops = 0; containers !== null && hops <= Object.keys(containers).length; hops++) {
    const why = containers[blamed]?.reason;
    if (why === undefined) break;
    if (!why.startsWith(CHILD_FAILED))
      return { kind: 'container', containerId: blamed, reason: why };
    blamed = why.slice(CHILD_FAILED.length);
  }
  const parsed = parseInstanceKey(blamed)?.docId ?? blamed;
  const failed = (rows ?? []).filter((r) => r.status === 'failure');
  const row =
    failed.findLast((r) => r.nodeId === blamed) ??
    failed.findLast((r) => r.activityId === parsed) ??
    null;
  // The row's own canvas node when there is one: a sequential doc may hold a
  // literal `x@2` id, which only the server's resolution gets right.
  return { kind: 'activity', nodeId: blamed, activityId: row?.activityId ?? parsed, row };
}

/** #1541 — the doc id of what failed: the activity, or the container whose own
 * rule failed. What the banner names, and what its "Open in editor" selects. */
export function failedNodeId(failure: Exclude<RunFailure, { kind: 'run' }>): string {
  return failure.kind === 'activity' ? failure.activityId : failure.containerId;
}

/**
 * #1541 — the longest the failure banner waits for the activity runs to catch
 * up with the log (they are read after it, throttled). Past it the banner says
 * what it can without them: a read that hangs must not hide what failed.
 */
export const FAILURE_BANNER_HOLD_MS = 2_000;

/**
 * How the run's log says it ENDED: its `run.finished` event (the reason, `null`
 * when it states none) or its `run.interrupted` event (no outcome reason; the
 * banner never reads one for an interrupted run), and when it was appended.
 * `null` before either. The page reads the end time here as well as from the
 * row, because the row it loaded may predate the end.
 */
export function runFinished(
  events: readonly { type: string; payload: unknown; ts: number }[],
): { reason: string | null; ts: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    // A start AFTER the end means the run was picked up again: it has not ended.
    if (e?.type === 'run.started') return null;
    if (e?.type === 'run.interrupted') return { reason: null, ts: e.ts };
    if (e?.type !== 'run.finished') continue;
    const reason = (e.payload as { reason?: unknown } | null)?.reason;
    return { reason: typeof reason === 'string' ? reason : null, ts: e.ts };
  }
  return null;
}

/**
 * When the run started, by its log: the LAST `run.started`'s `startedAt` (the
 * driver stamps it from the row at admission, so a run queued while the page
 * loaded gets its real start, not the enqueue placeholder the row held). `null`
 * when the log has none, or one written before the stamp existed.
 */
export function runStartedAt(events: readonly { type: string; payload: unknown }[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type !== 'run.started') continue;
    const at = (e.payload as { startedAt?: unknown } | null)?.startedAt;
    const ms = typeof at === 'string' ? Date.parse(at) : Number.NaN;
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}
