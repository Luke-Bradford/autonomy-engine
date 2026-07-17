import { z } from 'zod';
import type { EngineEvent, ScheduledWakeup } from '@autonomy-studio/shared';
import { getRun } from '../repo/runs.js';
import { markExternalWaitExpired } from '../repo/external-waits.js';
import type { Db } from '../repo/types.js';
import {
  buildEngine,
  DocUnresolvableError,
  driveRun,
  EXTERNAL_WAIT_WAKEUP_KIND,
  syncRunLifecycle,
  type DriveDeps,
} from '../run/driver.js';
import { appendAndFold, loadEngineEvents, terminalFactFromLog } from '../run/events.js';
import type { WakeupFireResult, WakeupHandler } from './alarms.js';

/**
 * #4 A13 — the `node_external_wait` alarm handler: a parked `webhook` node's EXPIRY.
 * The near-verbatim twin of `wait-alarm.ts` (S1's second real handler), with two
 * deliberate differences: the freshness guard is `external_wait_pending` (not
 * `wait_pending`), and the appended due event is `externalWait.expired` (not
 * `timer.due`), which FAILS the node (`external_wait_pending` → `failure`, so its
 * `failure` edge routes the timeout/default path) rather than succeeding it.
 *
 * The whole expiry path, end to end:
 *   1. a ready `webhook` node resolves its `${}` `timeoutSeconds` PURELY and the
 *      reducer emits `scheduleExternalWait{timeoutSeconds}` (A13, pure).
 *   2. `driver.ts`'s `armExternalWait` derives the token, arms this durable alarm +
 *      records the correlation row, then appends `externalWait.created{dueAt}`, whose
 *      fold PARKS the node `external_wait_pending`.
 *   3a. the inbound `POST /api/external-wait/:token` route appends
 *       `externalWait.completed` first → the node succeeds and THIS alarm, when it
 *       later comes due, suppresses (the node is no longer parked at that attempt);
 *       it still marks the correlation row expired ONLY if still `pending` (the
 *       guarded settle is a no-op on the already-completed row).
 *   3b. no callback arrives → this handler appends `externalWait.expired`, whose fold
 *       FAILS the node and lets `settle` route the downstream `failure` edge.
 *
 * Like `wait-alarm.ts`, a `external_wait_pending` node always has a live alarm (the
 * arm precedes the `externalWait.created` append that enters the park), so the boot
 * reconciler does not touch this kind's rows — the durable alarm the clock re-scans
 * every tick IS the recovery.
 */

/** S1's typed `ref` for the expiry alarm. `attemptId` is the PARKED attempt — the
 * freshness handle the guard needs, and what makes each attempt's alarm distinct. */
export const ExternalWaitWakeupRefSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  attemptId: z.string().min(1),
});

export type ExternalWaitAlarmDeps = DriveDeps;

export function createExternalWaitAlarmHandler(deps: ExternalWaitAlarmDeps): WakeupHandler {
  return {
    kind: EXTERNAL_WAIT_WAKEUP_KIND,
    refSchema: ExternalWaitWakeupRefSchema,
    fire(row: ScheduledWakeup, _delivery, tx: Db): WakeupFireResult {
      const ref = ExternalWaitWakeupRefSchema.parse(row.ref);
      const events = loadEngineEvents(tx, ref.runId);

      // FRESHNESS, layer 1 (spec #5): the LOG decides whether the run is over
      // (#443) — re-driving a recorded terminal is the fail-open direction. Layer 2
      // is `onExternalWaitExpired`'s own `external_wait_pending` guard; both are
      // load-bearing, since delivery is at-least-once. (Identical to `wait-alarm.ts`.)
      if (terminalFactFromLog(events) !== null) {
        return { status: 'suppressed', reason: 'run_already_terminal' };
      }

      const run = getRun(tx, ref.runId);
      if (run === null) return { status: 'suppressed', reason: 'run_not_found' };

      // A PERMANENTLY unresolvable version throws here; a throw inside the clock's
      // transaction rolls back the settle, leaving the row `pending` and re-delivered
      // forever for a run that can never be driven — so SUPPRESS on that type only. A
      // NON-`DocUnresolvableError` throw is a transient blip the rollback+redeliver is
      // FOR, so rethrow it. Same split as `wait-alarm.ts`.
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
      const ns = state.nodes[ref.nodeId];
      if (
        ns === undefined ||
        ns.status !== 'external_wait_pending' ||
        ns.currentAttemptId !== ref.attemptId
      ) {
        // Legitimately reachable, not an error: an inbound callback already completed
        // the wait (or a back-edge round reset the node, or an at-least-once
        // redelivery). Still settle the CORRELATION ROW to `expired` — but the
        // guarded `WHERE status = 'pending'` update is a no-op if it already
        // `completed`, so a completed row is never downgraded. Suppression IS the
        // verdict: the alarm was no longer current, so it settles rather than
        // re-firing forever.
        markExternalWaitExpired(tx, ref, deps.now?.() ?? Date.now());
        return { status: 'suppressed', reason: 'node_not_parked_at_attempt' };
      }

      const due: EngineEvent = {
        type: 'externalWait.expired',
        runId: ref.runId,
        nodeId: ref.nodeId,
        previousAttemptId: ref.attemptId,
      };
      // Appended INSIDE the clock's transaction, together with the settle — the
      // invariant `alarms.ts` is built on (a settle without this append loses the
      // wake; this append without the settle double-fires). The fold is PURE, so it
      // belongs inside the transaction; its COMMANDS are deliberately DISCARDED and
      // re-derived under the run's lock by `driveRun` (the B1 reasoning `wait-alarm.ts`
      // documents). `appendAndFold` records the fold's diagnostics against the seq it
      // appended at, on the SAME `tx` handle (#497). Mark the correlation row expired
      // in the SAME transaction so the row and the log settle atomically.
      const result = appendAndFold(tx, undefined, engine, state, due);
      markExternalWaitExpired(tx, ref, deps.now?.() ?? Date.now());
      syncRunLifecycle(tx, ref.runId, result.state.status);

      return {
        status: 'fired',
        events: [result.record],
        // Spawning work is forbidden inside the transaction: the drive may bill real
        // LLM calls downstream, and a rollback around that would erase the run's log
        // while the detached drive appended.
        afterCommit: () => driveRun(deps, ref.runId),
      };
    },
  };
}
