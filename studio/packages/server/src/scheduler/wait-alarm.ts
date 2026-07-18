import { z } from 'zod';
import type { EngineEvent } from '@autonomy-studio/shared';
import { WAIT_WAKEUP_KIND, type DriveDeps } from '../run/driver.js';
import {
  createDurableAlarmHandler,
  nodeParkedAtAttemptGuard,
  type DurableAlarmConfig,
} from './durable-alarm-handler.js';
import type { WakeupHandler } from './alarms.js';

/**
 * #4 A5/A6 — the `node_wait` alarm handler: the consumer that closes A6's durable
 * `wait`, and S1's SECOND real handler (retry being the first).
 *
 * The whole wait path, end to end:
 *   1. a ready `wait` node resolves its `${}` `seconds` PURELY and the reducer
 *      emits `scheduleWait{seconds}` (A6, pure).
 *   2. `driver.ts`'s `armWait` arms a durable alarm, then appends
 *      `timer.waitScheduled{dueAt}`, whose fold PARKS the node `wait_pending`.
 *   3. the alarm comes due → the shared handler appends `timer.due`, whose fold
 *      COMPLETES the node (`wait_pending` → `success`, no output) and lets `settle`
 *      route the downstream `success` edge.
 *
 * One of the four `createDurableAlarmHandler` kinds (#585): its only variation
 * from the shared skeleton is the freshness status (`wait_pending`) and the due
 * event (`timer.due`), which SUCCEEDS the node rather than re-dispatching it. Like
 * the others, a `wait_pending` node always has a live alarm (the arm precedes the
 * `timer.waitScheduled` append that enters the hold), so the boot reconciler does
 * not touch this kind's rows — the durable alarm the clock re-scans IS the recovery.
 */

/**
 * S1's "typed `ref` per kind", validated at ARM time so a malformed ref fails at
 * the call site that wrote it. `attemptId` is the PARKED attempt — the handle the
 * freshness check needs, and what makes each attempt's alarm distinct.
 */
export const WaitWakeupRefSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  attemptId: z.string().min(1),
});

/** What the handler needs: the driver boundary PLUS the per-run drive lock. */
export type WaitAlarmDeps = DriveDeps;

const config: DurableAlarmConfig<z.infer<typeof WaitWakeupRefSchema>> = {
  kind: WAIT_WAKEUP_KIND,
  refSchema: WaitWakeupRefSchema,
  checkFreshness: nodeParkedAtAttemptGuard('wait_pending', 'node_not_parked_at_attempt'),
  buildDueEvent: (ref): EngineEvent => ({
    type: 'timer.due',
    runId: ref.runId,
    nodeId: ref.nodeId,
    previousAttemptId: ref.attemptId,
  }),
};

export function createWaitAlarmHandler(deps: WaitAlarmDeps): WakeupHandler {
  return createDurableAlarmHandler(deps, config);
}
