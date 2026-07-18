import { z } from 'zod';
import type { EngineEvent } from '@autonomy-studio/shared';
import { RETRY_WAKEUP_KIND, type DriveDeps } from '../run/driver.js';
import {
  createDurableAlarmHandler,
  nodeParkedAtAttemptGuard,
  type DurableAlarmConfig,
} from './durable-alarm-handler.js';
import type { WakeupHandler } from './alarms.js';

/**
 * #1 F2c — the `node_retry` alarm handler: the consumer that closes D4's retry
 * loop, and #5 S1's first real one — the progenitor the wait/external-wait/
 * container-timeout handlers were copied from (#585 folded all four onto the
 * shared `createDurableAlarmHandler` skeleton).
 *
 * The whole retry path, end to end:
 *   1. `node.failed{kind:'transient'}` with policy budget → the reducer folds the
 *      node to `retry_pending` and emits `scheduleRetry` (F2b, pure).
 *   2. `driver.ts`'s `armRetry` arms a durable alarm, then appends
 *      `node.retryScheduled{nextAttemptAt}` (F2c, the clock's half).
 *   3. the alarm comes due → the shared handler appends `node.retryDue`, whose
 *      fold re-dispatches the node under a new attempt.
 *
 * This handler is the ONLY thing that resolves a HOLD (§A.5): `onResumed`
 * re-derives nothing for a `retry_pending` node and the boot reconciler does not
 * select it, so a held run's entire recovery is the durable alarm row this
 * consumes. That is why F2b could not ship without this — F2b alone is a hang, not
 * a degraded retry. The boot reconciler is the ONE other party that touches this
 * kind's rows, and only to re-arm a hold whose alarm the HOLD→ARM crash window
 * lost; it does not FIRE them (that stays here). Both live outside `fire`, so this
 * folding onto the shared skeleton changes neither.
 *
 * The shared skeleton DISCARDS the fold's commands and re-derives them under the
 * run's lock in `driveRun` (the general B1 reason, in `durable-alarm-handler.ts`).
 * That is provably lossless for THIS kind specifically: `driveRun` re-projects the
 * log as it then stands and re-derives the IDENTICAL `dispatchNode` — `onRetryDue`
 * folds the node to `ready` with its new `attemptId`, and `resume` re-emits a
 * `ready` node's dispatch under that same id. (And a throw while resolving the doc
 * is the RESOLVE, not the build: `buildEngine` is total over a schema-valid doc —
 * it folds defects into `docDefects` rather than throwing — so the base's
 * `DocUnresolvableError` split classifies it correctly.)
 */

/**
 * S1's "typed `ref` per kind", validated at ARM time so a malformed ref fails at
 * the call site that wrote it. `attemptId` is the FAILED attempt — the handle the
 * freshness check needs, and what makes each attempt's alarm distinct.
 */
export const RetryWakeupRefSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  attemptId: z.string().min(1),
});

/**
 * What the handler needs: the driver boundary PLUS the per-run drive lock. The
 * lock is what makes this a safe second pump source — see `driveRun`.
 */
export type RetryAlarmDeps = DriveDeps;

const config: DurableAlarmConfig<z.infer<typeof RetryWakeupRefSchema>> = {
  kind: RETRY_WAKEUP_KIND,
  refSchema: RetryWakeupRefSchema,
  // A back-edge round can reset the node, or the clock can re-deliver an alarm
  // whose retry already dispatched — either leaves the node no longer held at
  // this attempt (`node_not_held_at_attempt`), so the alarm settles.
  checkFreshness: nodeParkedAtAttemptGuard('retry_pending', 'node_not_held_at_attempt'),
  buildDueEvent: (ref): EngineEvent => ({
    type: 'node.retryDue',
    runId: ref.runId,
    nodeId: ref.nodeId,
    previousAttemptId: ref.attemptId,
  }),
};

export function createRetryAlarmHandler(deps: RetryAlarmDeps): WakeupHandler {
  return createDurableAlarmHandler(deps, config);
}
