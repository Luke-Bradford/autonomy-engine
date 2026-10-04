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
 * or `null` when the version doc did not resolve (the page then cannot follow a
 * container's blame, and says which container rather than guessing a child).
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

/**
 * The run's `run.finished` event: its reason (`null` when it states none) and
 * when it was appended. `null` before the run finishes. The page reads the end
 * time here as well as from the row, because the row it loaded may predate it.
 */
export function runFinished(
  events: readonly { type: string; payload: unknown; ts: number }[],
): { reason: string | null; ts: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type !== 'run.finished') continue;
    const reason = (e.payload as { reason?: unknown } | null)?.reason;
    return { reason: typeof reason === 'string' ? reason : null, ts: e.ts };
  }
  return null;
}
