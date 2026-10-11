import type { RunStatus, WaitingReason } from '@autonomy-studio/shared';
import { runStatusLabel } from './runStatus';

/**
 * #870 — a run's status as the Monitor's one pill: the WORD from the one
 * run-status vocabulary, the CLASS (its hue) from the status itself, so the two
 * cannot drift. #1594 OR40 S6 folded the inline copies on Home, Pipelines, the
 * Runs grid, a run's header and its child runs into this one.
 */
export function RunStatusPill({
  status,
  waitingReason = null,
}: {
  status: RunStatus;
  waitingReason?: WaitingReason | null;
}) {
  return (
    <span className={`run-status run-status-${status}`}>
      {runStatusLabel(status, waitingReason)}
    </span>
  );
}
