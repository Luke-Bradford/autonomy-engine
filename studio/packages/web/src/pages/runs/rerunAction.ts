import type { RunStatus } from '@autonomy-studio/shared';

/**
 * RS — whether the run monitor OFFERS "rerun from failed", and the cost warning
 * the spec requires beside it.
 *
 * ## This is an OFFER test, not an eligibility test
 *
 * The server owns eligibility, and it decides from the EVENT LOG, not from the
 * run row: `createReseedService.rerunFromFailed` (`server/src/run/reseed.ts`)
 * refuses a run with no log, one that has not terminated, one that terminated in
 * `success`, and (#896) one that already has a rerun in flight — each as a
 * `RerunNotEligibleError` carrying a human-readable reason, which the route maps
 * to `409`. Note the last is TRANSIENT and depends on another run's state, which
 * is exactly the kind of rule this module must not try to mirror.
 *
 * This module deliberately does NOT re-implement that algorithm. A client-side
 * copy of a server rule is a second reader of a contract that has one owner,
 * and it drifts silently the moment the owner changes (the defect class #847
 * names). So the split is:
 *
 *  - **this predicate** decides only whether to put the control on screen, from
 *    a single fact — the run's status as the page already computes it. It exists
 *    to avoid offering an action that obviously cannot work (there is no "rerun
 *    from failed" for a run that succeeded, or one still running).
 *  - **the server** decides whether a click actually proceeds, and its `409`
 *    message is surfaced VERBATIM. It is the authority, and it is allowed to
 *    refuse something this predicate offered.
 *
 * That asymmetry is intentional and is why the predicate may be weaker than the
 * server rule but must never be STRONGER: withholding the control on a run the
 * server would have accepted would hide a capability with no way to discover
 * it, whereas offering one the server refuses costs a click and produces a
 * truthful explanation.
 *
 * WHICH status this reads matters, because the lag it can suffer is not the one
 * you would first guess. `RunDetailPage` passes `view?.status ?? run?.status` —
 * the LOG-derived lifecycle first (the same `terminalFactFromLog` fact the
 * server decides on), and the REST row only as a fallback. So the ordinary case
 * is not lagged at all: page and server are reading the same authority.
 *
 * The fallback is where a disagreement can appear, and it fails in the direction
 * this module already prefers. Before the WebSocket has replayed — or if the
 * stream is in `error` and never does — the page falls back to the row, and a
 * row still reading `running` while the log has terminated withholds the control
 * on a run the server WOULD have accepted. That is the "weaker, never stronger"
 * side of the split above: nothing is offered that cannot work, and the control
 * appears once the log arrives. It is a real limitation rather than a
 * theoretical one, and it is stated here rather than left to be discovered.
 */

/**
 * The two statuses that can mean "terminated, and not in success" — the
 * server's own wording in `reseed.ts`: a run that "did not terminate in a
 * FAILURE (`failure`/`interrupted`)" is refused.
 *
 * `success` and `skipped` are terminal but are not failures; `pending`,
 * `queued`, `running` and `waiting` have not terminated at all. Neither group
 * can produce a rerun-from-failed, so neither is offered one.
 */
export const RERUNNABLE_RUN_STATUS: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'failure',
  'interrupted',
]);

/** Whether the monitor should show the rerun-from-failed control for this run. */
export function canRerunFromFailed(status: RunStatus): boolean {
  return RERUNNABLE_RUN_STATUS.has(status);
}

/**
 * Required by the rerun spec ("Cost, audit, monitor"): *"The rerun UI warns
 * 'may incur additional cost.'"*
 *
 * It is a real warning, not boilerplate. A rerun COPIES the frontier it can
 * reuse — those nodes emit no `activity.metered` because they never ran again —
 * but every node from the failure onward re-executes and meters normally. So
 * the price of a rerun is unknown in advance and is not zero, which is exactly
 * what an operator needs told before clicking.
 */
export const RERUN_COST_WARNING =
  'Nodes before the failure are reused, not re-run. Everything from the failure onward runs again, so this may incur additional cost.';
