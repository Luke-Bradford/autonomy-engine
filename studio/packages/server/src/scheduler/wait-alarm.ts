import { z } from 'zod';
import type { EngineEvent, ScheduledWakeup } from '@autonomy-studio/shared';
import { getRun } from '../repo/runs.js';
import type { Db } from '../repo/types.js';
import {
  buildEngine,
  DocUnresolvableError,
  driveRun,
  syncRunLifecycle,
  WAIT_WAKEUP_KIND,
  type DriveDeps,
} from '../run/driver.js';
import { appendAndFold, loadEngineEvents, terminalFactFromLog } from '../run/events.js';
import type { WakeupFireResult, WakeupHandler } from './alarms.js';

/**
 * #4 A5/A6 — the `node_wait` alarm handler: the consumer that closes A6's durable
 * `wait`, and S1's SECOND real handler (retry being the first).
 *
 * The whole wait path, end to end:
 *   1. a ready `wait` node resolves its `${}` `seconds` PURELY and the reducer
 *      emits `scheduleWait{seconds}` (A6, pure).
 *   2. `driver.ts`'s `armWait` arms a durable alarm, then appends
 *      `timer.waitScheduled{dueAt}`, whose fold PARKS the node `wait_pending`.
 *   3. the alarm comes due → THIS handler appends `timer.due`, whose fold COMPLETES
 *      the node (`wait_pending` → `success`, no output) and lets `settle` route the
 *      downstream `success` edge.
 *
 * The near-verbatim twin of `retry-alarm.ts` — same suppression discipline, same
 * transaction contract — with two deliberate differences: the freshness guard is
 * `wait_pending` (not `retry_pending`), and the appended due event is `timer.due`
 * (not `node.retryDue`), which SUCCEEDS the node rather than re-dispatching it.
 *
 * Unlike retry, this handler is NOT the only thing that resolves the hold's
 * crash-recovery: a `wait_pending` node always has a live alarm (the arm precedes
 * the `timer.waitScheduled` append that enters the hold), so the boot reconciler
 * does not touch this kind's rows at all — the durable alarm the clock re-scans
 * every tick IS the recovery.
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

export function createWaitAlarmHandler(deps: WaitAlarmDeps): WakeupHandler {
  return {
    kind: WAIT_WAKEUP_KIND,
    refSchema: WaitWakeupRefSchema,
    fire(row: ScheduledWakeup, _delivery, tx: Db): WakeupFireResult {
      const ref = WaitWakeupRefSchema.parse(row.ref);
      const events = loadEngineEvents(tx, ref.runId);

      // FRESHNESS, layer 1 (spec #5). The LOG decides whether the run is over
      // (#443): a run interrupted after its wait alarm was armed left an orphaned
      // row, and re-driving its recorded terminal is the fail-open direction. Layer
      // 2 is `onWaitDue`'s own `wait_pending` guard — both load-bearing, since
      // delivery is at-least-once. (Identical to `retry-alarm.ts`.)
      if (terminalFactFromLog(events) !== null) {
        return { status: 'suppressed', reason: 'run_already_terminal' };
      }

      const run = getRun(tx, ref.runId);
      if (run === null) return { status: 'suppressed', reason: 'run_not_found' };

      // A PERMANENTLY unresolvable version (`DocUnresolvableError` — gone, or
      // present-but-unparseable) throws here, and a throw inside the clock's
      // transaction rolls back the settle, leaving the row `pending` and
      // re-delivered forever for a run that can never be driven. So SUPPRESS on that
      // type: settle the alarm and stop. But ONLY that type — a NON-
      // `DocUnresolvableError` throw is a transient blip the rollback+redeliver is
      // FOR, so rethrow it. Same split (and reasoning) as `retry-alarm.ts`.
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
        ns.status !== 'wait_pending' ||
        ns.currentAttemptId !== ref.attemptId
      ) {
        // Legitimately reachable, not an error: a back-edge round reset the node, or
        // the clock re-delivered an alarm whose wait already completed. Suppression
        // IS the verdict — the alarm was no longer current — so it settles rather
        // than re-firing forever.
        return { status: 'suppressed', reason: 'node_not_parked_at_attempt' };
      }

      const due: EngineEvent = {
        type: 'timer.due',
        runId: ref.runId,
        nodeId: ref.nodeId,
        previousAttemptId: ref.attemptId,
      };
      // Appended INSIDE the clock's transaction, together with the settle — the
      // invariant `alarms.ts` is built on. A settle without this append loses the
      // wake silently (the node stays parked with a spent alarm); this append
      // without the settle re-fires and double-completes. No bus here: the clock
      // publishes the returned envelopes AFTER commit. The fold is PURE, so it
      // belongs inside the transaction; its COMMANDS are deliberately DISCARDED and
      // re-derived under the run's lock by `driveRun` (the same B1 reasoning
      // `retry-alarm.ts` documents — a stale command may have been superseded by a
      // concurrent drive). `appendAndFold` records the fold's diagnostics against
      // the seq it appended at, on the SAME `tx` handle (#497).
      const result = appendAndFold(tx, undefined, engine, state, due);
      syncRunLifecycle(tx, ref.runId, result.state.status);

      return {
        status: 'fired',
        events: [result.record],
        // Spawning work is forbidden inside the transaction (this module's
        // contract): the drive may bill real LLM calls downstream, and a rollback
        // around that would erase the run's log while the detached drive appended.
        afterCommit: () => driveRun(deps, ref.runId),
      };
    },
  };
}
