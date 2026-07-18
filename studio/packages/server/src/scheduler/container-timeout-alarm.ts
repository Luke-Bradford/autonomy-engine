import { z } from 'zod';
import type { EngineEvent } from '@autonomy-studio/shared';
import { CONTAINER_TIMEOUT_WAKEUP_KIND, type DriveDeps } from '../run/driver.js';
import {
  containerActiveGuard,
  createDurableAlarmHandler,
  type DurableAlarmConfig,
} from './durable-alarm-handler.js';
import type { WakeupHandler } from './alarms.js';

/**
 * #4 A17 — the `container_timeout` alarm handler: the consumer that closes A17's
 * durable `loop` wall-clock timeout, and S1's FOURTH real handler (retry, wait,
 * external-wait being the first three). The first CONTAINER-scoped handler — its
 * alarm names a container, not a node.
 *
 * The whole timeout path, end to end:
 *   1. a `loop` with a `timeout` goes `active` and the reducer emits
 *      `scheduleContainerTimeout{seconds}` at container-enter (pure).
 *   2. `driver.ts`'s `armContainerTimeout` arms a durable alarm, then appends
 *      `container.timeoutScheduled{dueAt}`, whose fold STAMPS the loop's
 *      `timeoutDueAt` (parks nothing — children keep running).
 *   3. the alarm comes due → the shared handler appends `container.timedOut`, whose
 *      fold NEUTRALIZES the loop's still-live children and FAILS the loop
 *      (`active` → `failure`, reason `timeout`), routing its outer failure edge.
 *
 * One of the four `createDurableAlarmHandler` kinds (#585): unlike its three node
 * twins the freshness handle is a CONTAINER's `active` status (no attempt to
 * match — a container timeout is armed ONCE per run at enter), and the due event
 * FAILS its subject. Like the others it needs no boot re-arm: the arm precedes the
 * `container.timeoutScheduled` append, so a loop that recorded the marker always
 * has a live alarm the clock re-scans. The one gap — a crash in the enter→arm
 * window — is healed by `onResumed`'s re-emit (a loop `active` with a `timeout`
 * but no `timeoutDueAt`), not here.
 */

/**
 * S1's "typed `ref` per kind", validated at ARM time so a malformed ref fails at
 * the call site that wrote it. No `attemptId`: a container timeout is armed ONCE
 * per run (at enter), so the (runId, containerId) pair is the whole freshness
 * handle — the fold/handler ask "is the container still active", not "is this the
 * current attempt".
 */
export const ContainerTimeoutWakeupRefSchema = z.object({
  runId: z.string().min(1),
  containerId: z.string().min(1),
});

/** What the handler needs: the driver boundary PLUS the per-run drive lock. */
export type ContainerTimeoutAlarmDeps = DriveDeps;

const config: DurableAlarmConfig<z.infer<typeof ContainerTimeoutWakeupRefSchema>> = {
  kind: CONTAINER_TIMEOUT_WAKEUP_KIND,
  refSchema: ContainerTimeoutWakeupRefSchema,
  // The loop can exit via `exitWhen`/`maxRounds`/a child failure BEFORE the
  // timeout fires, or the clock can re-deliver an already-fired timeout — either
  // leaves the container no longer `active` (`container_not_active`), so it settles.
  checkFreshness: containerActiveGuard('container_not_active'),
  buildDueEvent: (ref): EngineEvent => ({
    type: 'container.timedOut',
    runId: ref.runId,
    containerId: ref.containerId,
  }),
};

export function createContainerTimeoutAlarmHandler(deps: ContainerTimeoutAlarmDeps): WakeupHandler {
  return createDurableAlarmHandler(deps, config);
}
