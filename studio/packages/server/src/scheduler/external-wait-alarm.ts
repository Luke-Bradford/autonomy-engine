import { z } from 'zod';
import type { EngineEvent } from '@autonomy-studio/shared';
import { markExternalWaitExpired } from '../repo/external-waits.js';
import { EXTERNAL_WAIT_WAKEUP_KIND, type DriveDeps } from '../run/driver.js';
import {
  createDurableAlarmHandler,
  nodeParkedAtAttemptGuard,
  type DurableAlarmConfig,
} from './durable-alarm-handler.js';
import type { WakeupHandler } from './alarms.js';

/**
 * #4 A13 — the `node_external_wait` alarm handler: a parked `webhook` node's EXPIRY.
 * One of the four `createDurableAlarmHandler` kinds (#585), and the ONLY one with a
 * `settleSideEffect`: besides the node-parked freshness guard (`external_wait_pending`)
 * and its due event (`externalWait.expired`, which FAILS the node so its `failure`
 * edge routes the timeout/default path), it must also settle the EXTERNAL-WAIT
 * CORRELATION ROW (`markExternalWaitExpired`) atomically with the log.
 *
 * The whole expiry path, end to end:
 *   1. a ready `webhook` node resolves its `${}` `timeoutSeconds` PURELY and the
 *      reducer emits `scheduleExternalWait{timeoutSeconds}` (A13, pure).
 *   2. `driver.ts`'s `armExternalWait` derives the token, arms this durable alarm +
 *      records the correlation row, then appends `externalWait.created{dueAt}`, whose
 *      fold PARKS the node `external_wait_pending`.
 *   3a. the inbound `POST /api/external-wait/:token` route appends
 *       `externalWait.completed` first → the node succeeds and this alarm, when it
 *       later comes due, suppresses (the node is no longer parked at that attempt);
 *       it still marks the correlation row expired ONLY if still `pending` (the
 *       guarded settle is a no-op on the already-completed row).
 *   3b. no callback arrives → the shared handler appends `externalWait.expired`, whose
 *       fold FAILS the node and lets `settle` route the downstream `failure` edge.
 *
 * The correlation-row settle runs at exactly the three points the shared skeleton
 * invokes `settleSideEffect`: on a terminal-log suppress (#580 — the run went
 * terminal while this node was parked; settle the orphan row rather than leak it to
 * the run's `ON DELETE CASCADE`), on a stale (`node_not_parked_at_attempt`) suppress
 * (an inbound callback already completed it, or an at-least-once redelivery — the
 * guarded `WHERE status='pending'` update is a no-op on an already-`completed` row,
 * so it is never downgraded), and on fire (in the same transaction as the log, so
 * the row and the log settle atomically). It is DELIBERATELY not run on
 * `run_not_found`/`doc_unresolvable`.
 *
 * Like `wait-alarm.ts`, an `external_wait_pending` node always has a live alarm (the
 * arm precedes the `externalWait.created` append that enters the park), so the boot
 * reconciler does not touch this kind's rows — the durable alarm the clock re-scans
 * IS the recovery.
 */

/** S1's typed `ref` for the expiry alarm. `attemptId` is the PARKED attempt — the
 * freshness handle the guard needs, and what makes each attempt's alarm distinct. */
export const ExternalWaitWakeupRefSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  attemptId: z.string().min(1),
});

export type ExternalWaitAlarmDeps = DriveDeps;

const config: DurableAlarmConfig<z.infer<typeof ExternalWaitWakeupRefSchema>> = {
  kind: EXTERNAL_WAIT_WAKEUP_KIND,
  refSchema: ExternalWaitWakeupRefSchema,
  checkFreshness: nodeParkedAtAttemptGuard('external_wait_pending', 'node_not_parked_at_attempt'),
  buildDueEvent: (ref): EngineEvent => ({
    type: 'externalWait.expired',
    runId: ref.runId,
    nodeId: ref.nodeId,
    previousAttemptId: ref.attemptId,
  }),
  // Settle the correlation row expired — guarded `WHERE status='pending'`, so a
  // row an inbound callback already `completed` is never downgraded.
  settleSideEffect: (tx, ref, deps) => {
    markExternalWaitExpired(tx, ref, deps.now?.() ?? Date.now());
  },
};

export function createExternalWaitAlarmHandler(deps: ExternalWaitAlarmDeps): WakeupHandler {
  return createDurableAlarmHandler(deps, config);
}
