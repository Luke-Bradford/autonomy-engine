import { z } from 'zod';
import type { EngineEvent, ScheduledWakeup } from '@autonomy-studio/shared';
import { getRun } from '../repo/runs.js';
import type { Db } from '../repo/types.js';
import {
  buildEngine,
  pump,
  syncRunLifecycle,
  RETRY_WAKEUP_KIND,
  type DriverDeps,
} from '../run/driver.js';
import { appendEngineEvent, loadEngineEvents, terminalFactFromLog } from '../run/events.js';
import type { WakeupFireResult, WakeupHandler } from './alarms.js';

/**
 * #1 F2c — the `node_retry` alarm handler: the consumer that closes D4's retry
 * loop, and #5 S1's first real one.
 *
 * The whole retry path, end to end:
 *   1. `node.failed{kind:'transient'}` with policy budget → the reducer folds the
 *      node to `retry_pending` and emits `scheduleRetry` (F2b, pure).
 *   2. `driver.ts`'s `armRetry` arms a durable alarm, then appends
 *      `node.retryScheduled{nextAttemptAt}` (F2c, the clock's half).
 *   3. the alarm comes due → THIS handler appends `node.retryDue`, whose fold
 *      re-dispatches the node under a new attempt.
 *
 * This handler is the ONLY recovery path a held run has (§A.5): `onResumed`
 * re-derives nothing for `retry_pending` and the boot reconciler leaves it
 * alone, precisely because the durable alarm row already survived the crash and
 * re-deriving would DOUBLE-ARM it. That is why F2b could not ship without this.
 */

/**
 * S1's "typed `ref` per kind", validated at ARM time so a malformed ref fails at
 * the call site that wrote it. `attemptId` is the FAILED attempt — the handle the
 * freshness check below needs, and what makes each attempt's alarm distinct.
 */
export const RetryWakeupRefSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  attemptId: z.string().min(1),
});

/** What the handler needs: the driver boundary, minus the executor's own deps. */
export type RetryAlarmDeps = DriverDeps;

export function createRetryAlarmHandler(deps: RetryAlarmDeps): WakeupHandler {
  return {
    kind: RETRY_WAKEUP_KIND,
    refSchema: RetryWakeupRefSchema,
    fire(row: ScheduledWakeup, _delivery, tx: Db): WakeupFireResult {
      const ref = RetryWakeupRefSchema.parse(row.ref);
      const events = loadEngineEvents(tx, ref.runId);

      // FRESHNESS, layer 1 (spec #5: "every due event re-checks currency before
      // it fires, so stale retries can't emit valid-looking events"). Layer 2 is
      // `onRetryDue`'s own `retry_pending` guard — both are load-bearing, since
      // delivery is at-least-once.
      //
      // The LOG decides whether the run is over, not the row and not a re-fold
      // (#443): re-deriving a recorded terminal fact under newer reducer rules is
      // the fail-open direction, and it is what re-executes a finished run's side
      // effects. This also covers the run whose drive threw AFTER its alarm was
      // armed — `terminalizeInterrupted` froze it, and its orphaned alarm must
      // not resurrect it.
      if (terminalFactFromLog(events) !== null) {
        return { status: 'suppressed', reason: 'run_already_terminal' };
      }

      const run = getRun(tx, ref.runId);
      if (run === null) return { status: 'suppressed', reason: 'run_not_found' };

      // The doc must resolve before anything else can be decided. A DELETED
      // pipeline version throws here, and a throw inside the clock's transaction
      // rolls back the settle — leaving the row `pending` and re-delivered on
      // EVERY tick, forever, for a run that can never be driven again. Suppress
      // instead: settle the alarm and stop. (The same hazard `reconcile.ts`
      // avoids by reading the log before `buildEngine`.)
      let engine;
      try {
        engine = buildEngine(deps.resolveDoc(run.pipelineVersionId));
      } catch {
        return { status: 'suppressed', reason: 'doc_unresolvable' };
      }

      const state = engine.projectRunState(events);
      const ns = state.nodes[ref.nodeId];
      if (
        ns === undefined ||
        ns.status !== 'retry_pending' ||
        ns.currentAttemptId !== ref.attemptId
      ) {
        // Legitimately reachable, not an error: a back-edge round reset the node
        // (§A.6), or the clock re-delivered an alarm whose retry already
        // dispatched. Suppression IS the verdict — the alarm was no longer
        // current — so it settles rather than retrying forever.
        return { status: 'suppressed', reason: 'node_not_held_at_attempt' };
      }

      const due: EngineEvent = {
        type: 'node.retryDue',
        runId: ref.runId,
        nodeId: ref.nodeId,
        previousAttemptId: ref.attemptId,
      };
      // Appended INSIDE the clock's transaction, together with the settle — the
      // invariant `alarms.ts` is built on. A settle without this append loses the
      // retry silently (the node is held with a spent alarm); this append without
      // the settle re-fires and double-dispatches. No bus here: the clock
      // publishes the returned envelopes AFTER commit, so a rollback cannot show
      // a live subscriber an event that never existed.
      const appended = appendEngineEvent(tx, due);

      // The fold is PURE, so it belongs inside the transaction — and it MUST be
      // here rather than in `afterCommit`: `projectRunState` returns state only,
      // discarding commands, so re-projecting after commit would silently lose
      // the `dispatchNode` this event exists to produce and leave the run hung.
      // Reducing the PARSED event (never the raw input) for the reason
      // `appendEngineEvent` documents.
      const result = engine.reduce(state, appended.event);
      syncRunLifecycle(tx, ref.runId, result.state.status);

      return {
        status: 'fired',
        events: [appended.record],
        // Spawning work is forbidden inside the transaction (this module's
        // contract): `pump` drives the re-dispatched node, which bills real LLM
        // calls — a rollback around that would erase the run's log while the
        // detached drive kept appending to it.
        afterCommit: () => pump(deps, engine, result.state, result.commands).then(() => undefined),
      };
    },
  };
}
