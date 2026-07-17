import { z } from 'zod';
import type { EngineEvent, ScheduledWakeup } from '@autonomy-studio/shared';
import { getRun } from '../repo/runs.js';
import type { Db } from '../repo/types.js';
import {
  buildEngine,
  CONTAINER_TIMEOUT_WAKEUP_KIND,
  DocUnresolvableError,
  driveRun,
  syncRunLifecycle,
  type DriveDeps,
} from '../run/driver.js';
import { appendAndFold, loadEngineEvents, terminalFactFromLog } from '../run/events.js';
import type { WakeupFireResult, WakeupHandler } from './alarms.js';

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
 *   3. the alarm comes due → THIS handler appends `container.timedOut`, whose fold
 *      NEUTRALIZES the loop's still-live children and FAILS the loop
 *      (`active` → `failure`, reason `timeout`), routing its outer failure edge.
 *
 * The near-twin of `external-wait-alarm.ts` — an alarm that FAILS its subject on
 * fire, same suppression discipline, same transaction contract — with two
 * deliberate differences: the freshness handle is a CONTAINER's `active` status
 * (not a node's parked status at an attempt), and the appended due event is
 * `container.timedOut`.
 *
 * Like wait/external-wait, this handler needs no boot re-arm: the arm precedes the
 * `container.timeoutScheduled` append, so a loop that recorded the marker always
 * has a live alarm the clock re-scans every tick. The one gap — a crash in the
 * enter→arm window — is healed by `onResumed`'s re-emit (a loop `active` with a
 * `timeout` but no `timeoutDueAt`), not here.
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

export function createContainerTimeoutAlarmHandler(deps: ContainerTimeoutAlarmDeps): WakeupHandler {
  return {
    kind: CONTAINER_TIMEOUT_WAKEUP_KIND,
    refSchema: ContainerTimeoutWakeupRefSchema,
    fire(row: ScheduledWakeup, _delivery, tx: Db): WakeupFireResult {
      const ref = ContainerTimeoutWakeupRefSchema.parse(row.ref);
      const events = loadEngineEvents(tx, ref.runId);

      // FRESHNESS, layer 1 (spec #5). The LOG decides whether the run is over
      // (#443): a run interrupted after its timeout alarm was armed left an orphaned
      // row, and re-driving its recorded terminal is the fail-open direction. Layer
      // 2 is the `active`-container guard below — both load-bearing, since delivery
      // is at-least-once. (Identical shape to `wait-alarm.ts`.)
      if (terminalFactFromLog(events) !== null) {
        return { status: 'suppressed', reason: 'run_already_terminal' };
      }

      const run = getRun(tx, ref.runId);
      if (run === null) return { status: 'suppressed', reason: 'run_not_found' };

      // A PERMANENTLY unresolvable version (`DocUnresolvableError` — gone, or
      // present-but-unparseable) throws here, and a throw inside the clock's
      // transaction rolls back the settle, leaving the row `pending` and re-delivered
      // forever for a run that can never be driven. So SUPPRESS on that type: settle
      // the alarm and stop. But ONLY that type — a NON-`DocUnresolvableError` throw is
      // a transient blip the rollback+redeliver is FOR, so rethrow it. Same split
      // (and reasoning) as `wait-alarm.ts`.
      let engine;
      try {
        engine = buildEngine(deps.resolveDoc(run.pipelineVersionId));
      } catch (err) {
        if (err instanceof DocUnresolvableError) {
          return { status: 'suppressed', reason: 'doc_unresolvable' };
        }
        throw err;
      }

      const state = engine.projectRunState(events);
      const cs = state.containers[ref.containerId];
      if (cs === undefined || cs.status !== 'active') {
        // Legitimately reachable, not an error: the loop exited via
        // `exitWhen`/`maxRounds`/a child failure BEFORE the timeout fired, or the
        // clock re-delivered an already-fired timeout. Suppression IS the verdict —
        // the loop is no longer active — so it settles rather than re-firing forever.
        return { status: 'suppressed', reason: 'container_not_active' };
      }

      const due: EngineEvent = {
        type: 'container.timedOut',
        runId: ref.runId,
        containerId: ref.containerId,
      };
      // Appended INSIDE the clock's transaction, together with the settle — the
      // invariant `alarms.ts` is built on. A settle without this append loses the
      // wake silently (the loop stays active with a spent alarm); this append without
      // the settle re-fires and double-processes. No bus here: the clock publishes the
      // returned envelopes AFTER commit. The fold is PURE, so it belongs inside the
      // transaction; its COMMANDS are deliberately DISCARDED and re-derived under the
      // run's lock by `driveRun` (the same B1 reasoning `wait-alarm.ts` documents — a
      // stale command may have been superseded by a concurrent drive). `appendAndFold`
      // records the fold's diagnostics against the seq it appended at, on the SAME
      // `tx` handle (#497).
      const result = appendAndFold(tx, undefined, engine, state, due);
      syncRunLifecycle(tx, ref.runId, result.state.status);

      return {
        status: 'fired',
        events: [result.record],
        // Spawning work is forbidden inside the transaction (this module's contract):
        // the drive may bill real LLM calls downstream (a handled outer failure edge
        // can lead to more nodes), and a rollback around that would erase the run's log
        // while the detached drive appended.
        afterCommit: () => driveRun(deps, ref.runId),
      };
    },
  };
}
