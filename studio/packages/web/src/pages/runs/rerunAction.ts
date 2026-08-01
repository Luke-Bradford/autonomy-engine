import type { RunStatus } from '@autonomy-studio/shared';

/**
 * RS — whether the run monitor OFFERS "rerun from failed", and the cost warning
 * the spec requires beside it.
 *
 * ## This is an OFFER test, not an eligibility test
 *
 * The server owns eligibility, and it decides from the EVENT LOG, not from the
 * run row: `createReseedService.rerunFromFailed` (`server/src/run/reseed.ts`)
 * refuses a run with no log, one that has not terminated, and one that
 * terminated in `success` — each as a `RerunNotEligibleError` carrying a
 * human-readable reason, which the route maps to `409`.
 *
 * This module deliberately does NOT re-implement that algorithm. A client-side
 * copy of a server rule is a second reader of a contract that has one owner,
 * and it drifts silently the moment the owner changes (the defect class #847
 * names). So the split is:
 *
 *  - **this predicate** decides only whether to put the control on screen, from
 *    the one fact the row already carries — the status. It exists to avoid
 *    offering an action that obviously cannot work (there is no "rerun from
 *    failed" for a run that succeeded, or one still running).
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
 * The row can also legitimately disagree with the log for a moment — the row is
 * a projection of the log (#443 makes the log the authority), so a run whose
 * terminal event has landed but whose row has not yet been patched will show as
 * running here. The server still answers correctly; the control simply appears
 * a beat later.
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
