import { z } from 'zod';
import type { EngineEvent } from '@autonomy-studio/shared';
import { RECHECK_WAKEUP_KIND, type DriveDeps } from '../run/driver.js';
import {
  createDurableAlarmHandler,
  nodeParkedAtAttemptGuard,
  RUN_CANCEL_REQUESTED,
  type DurableAlarmConfig,
} from './durable-alarm-handler.js';
import type { WakeupHandler } from './alarms.js';

/**
 * #1600 OR41 C8d — the `node_recheck` alarm: a Get metadata *Wait until* parked
 * `wait_pending` is due for its next check. Appends `node.recheckDue`, whose
 * fold re-dispatches the node under a new attempt.
 *
 * Unlike wait's timer, a due re-check STARTS work, so a run whose cancel is
 * folded is refused here (CX5's container-timeout rule), as well as in the fold.
 */
export const RecheckWakeupRefSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  attemptId: z.string().min(1),
});

const parkedAtAttempt = nodeParkedAtAttemptGuard('wait_pending', 'node_not_parked_at_attempt');

const config: DurableAlarmConfig<z.infer<typeof RecheckWakeupRefSchema>> = {
  kind: RECHECK_WAKEUP_KIND,
  refSchema: RecheckWakeupRefSchema,
  checkFreshness: (state, ref) =>
    state.cancelRequested !== null
      ? { fresh: false, reason: RUN_CANCEL_REQUESTED }
      : parkedAtAttempt(state, ref),
  buildDueEvent: (ref): EngineEvent => ({
    type: 'node.recheckDue',
    runId: ref.runId,
    nodeId: ref.nodeId,
    previousAttemptId: ref.attemptId,
  }),
};

export function createRecheckAlarmHandler(deps: DriveDeps): WakeupHandler {
  return createDurableAlarmHandler(deps, config);
}
