import { z } from 'zod';
import type { EngineEvent } from '@autonomy-studio/shared';
import { RECHECK_WAKEUP_KIND, type DriveDeps } from '../run/driver.js';
import {
  createDurableAlarmHandler,
  nodeParkedAtAttemptGuard,
  type DurableAlarmConfig,
} from './durable-alarm-handler.js';
import type { WakeupHandler } from './alarms.js';

/**
 * #1600 OR41 C8d — the `node_recheck` alarm: a Get metadata *Wait until* parked
 * `wait_pending` is due for its next check. Appends `node.recheckDue`, whose
 * fold re-dispatches the node under a new attempt.
 *
 * A due re-check STARTS work, but a cancel needs no guard here: the cancel's
 * fold fails the parked node (`onCancelRequested`), so the attempt guard below
 * refuses its alarm, and `onRecheckDue` refuses one in cancel mode too.
 */
export const RecheckWakeupRefSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  attemptId: z.string().min(1),
});

const config: DurableAlarmConfig<z.infer<typeof RecheckWakeupRefSchema>> = {
  kind: RECHECK_WAKEUP_KIND,
  refSchema: RecheckWakeupRefSchema,
  checkFreshness: nodeParkedAtAttemptGuard('wait_pending', 'node_not_parked_at_attempt'),
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
