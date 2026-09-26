import type { NodeRunStatus, RunStatus } from '@autonomy-studio/shared';
import { nodeStatusLabel } from './nodeStatus';

/**
 * CX4 (#1320) — whether the run monitor OFFERS "Cancel run", and what the
 * confirmation tells the operator before they commit to it.
 *
 * Same split as `rerunAction.ts`, for the same reason: this is an OFFER test,
 * not an eligibility test. The server decides from the log and the row (cancel
 * spec D5) and answers `409` with its own sentence when a run has already ended
 * or its log is unreadable; the page shows that sentence verbatim. So this may
 * be weaker than the server, never stronger: a run the page still thinks is live
 * costs one click and a truthful refusal, while withholding the control from a
 * run the server would cancel hides the only way to stop it.
 */

/** The statuses D5 accepts a cancel from — every status that has not ended. */
export const CANCELLABLE_RUN_STATUS: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'pending',
  'queued',
  'running',
  'waiting',
]);

export function canCancelRun(status: RunStatus): boolean {
  return CANCELLABLE_RUN_STATUS.has(status);
}

/**
 * The node statuses a cancel actually stops: work dispatched or about to be
 * (`ready`, `dispatched`), and every hold whose next step the cancel prevents —
 * a retry backoff (D4) and the three parks (D5). `pending`, and the terminal
 * statuses, are not "in progress" and are not named.
 */
const IN_PROGRESS: ReadonlySet<NodeRunStatus> = new Set<NodeRunStatus>([
  'ready',
  'dispatched',
  'retry_pending',
  'wait_pending',
  'external_wait_pending',
  'waiting',
]);

export interface CancelTarget {
  name: string;
  status: NodeRunStatus;
}

/**
 * The confirmation text. Three facts, each one the operator would otherwise
 * have to guess:
 *  - WHAT stops, by name and in the page's own status words, so the prompt is
 *    about this run rather than a generic "are you sure";
 *  - that work already SENT is not undone (the spec's open question 1: a cancel
 *    cannot un-send an `http` POST or un-write rows a `copy` already wrote), so
 *    nobody reads "cancel" as "roll back";
 *  - when a node is waiting on a CHILD run, that the stop is not immediate:
 *    until CX3 propagates the cancel to children, the parent finishes only when
 *    the child ends (CX2 as-built, "known until CX3"). CX4 must not promise an
 *    immediate stop for that run, so it says so.
 */
export function cancelConfirmMessage(targets: readonly CancelTarget[]): string {
  const live = targets.filter((t) => IN_PROGRESS.has(t.status));
  const lines = ['Cancel this run?', ''];
  if (live.length === 0) {
    lines.push('Nothing is in progress right now. No further work will start.');
  } else {
    lines.push('This stops:');
    for (const t of live) lines.push(`  • ${t.name} — ${nodeStatusLabel(t.status)}`);
    lines.push('', 'No further work will start.');
  }
  lines.push('Work already sent (a request made, rows written) is not undone.');
  if (live.some((t) => t.status === 'waiting')) {
    lines.push(
      '',
      'A child run is still live. This run stops only once that child ends — cancelling it does not cancel the child.',
    );
  }
  return lines.join('\n');
}
