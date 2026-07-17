import type { EngineEvent, RunEvent } from '@autonomy-studio/shared';
import { getRun } from '../repo/runs.js';
import { getExternalWaitByTokenHash, markExternalWaitCompleted } from '../repo/external-waits.js';
import { hashExternalWaitToken } from '../webhooks/external-wait-token.js';
import { appendAndFold, loadEngineEvents, terminalFactFromLog } from './events.js';
import {
  buildEngine,
  DocUnresolvableError,
  driveRun,
  syncRunLifecycle,
  type DriveDeps,
} from './driver.js';

/**
 * #4 A13 — the inbound-callback COMPLETER for a parked `webhook` node: the run-side
 * of `POST /api/external-wait/:token`. The HTTP twin of the expiry alarm's
 * `fire` (`scheduler/external-wait-alarm.ts`) — same guard discipline
 * (`terminalFactFromLog` freshness, `external_wait_pending`-at-attempt check),
 * same append-inside-a-transaction + `driveRun`-after-commit shape — but resuming
 * the node to SUCCESS (`externalWait.completed`) instead of failing it, and
 * triggered by an HTTP request rather than a due alarm.
 *
 * `complete(token)` returns a single opaque verdict — `'completed'` iff THIS call
 * appended the completion, `'not_completable'` for EVERYTHING else (unknown token,
 * an already-settled/expired row, a node no longer parked at that attempt, a
 * terminal run, an unresolvable version). The route maps every `'not_completable'`
 * to ONE fail-closed response, so an unknown token and an already-used one are
 * indistinguishable to the caller — a token is never a state oracle.
 */
export interface ExternalWaitCompleter {
  complete(token: string): Promise<'completed' | 'not_completable'>;
}

export function createExternalWaitCompleter(deps: DriveDeps): ExternalWaitCompleter {
  const now = deps.now ?? (() => Date.now());
  return {
    async complete(token: string): Promise<'completed' | 'not_completable'> {
      // Look the token up by its HASH (the raw token is never stored). A miss is
      // the SAME verdict as every other non-completable case — no existence oracle.
      const row = getExternalWaitByTokenHash(deps.db, hashExternalWaitToken(token));
      if (row === null || row.status !== 'pending') return 'not_completable';

      // Guard + settle-row + append in ONE synchronous transaction: better-sqlite3
      // is single-threaded, but the explicit transaction makes the settle+append
      // atomic even if `appendAndFold` throws (no half-settled row without its
      // event), and serializes against a concurrent expiry/duplicate-completion.
      const runId = row.runId;
      const record: RunEvent | null = deps.db.transaction((): RunEvent | null => {
        const events = loadEngineEvents(deps.db, runId);
        // FRESHNESS (spec #5 / #443): the LOG decides whether the run is over —
        // re-driving a recorded terminal is the fail-open direction.
        if (terminalFactFromLog(events) !== null) return null;

        const run = getRun(deps.db, runId);
        if (run === null) return null;

        let engine;
        try {
          engine = buildEngine(deps.resolveDoc(run.pipelineVersionId));
        } catch (err) {
          // A permanently-unresolvable version: not completable, don't roll back.
          if (err instanceof DocUnresolvableError) return null;
          throw err;
        }

        const state = engine.projectRunState(events);
        const ns = state.nodes[row.nodeId];
        if (
          ns === undefined ||
          ns.status !== 'external_wait_pending' ||
          ns.currentAttemptId !== row.attemptId
        ) {
          // The node already completed/expired, was reset by a back-edge round, or
          // this token names a stale attempt — not completable.
          return null;
        }

        // Settle the correlation row FIRST (guarded `WHERE status = 'pending'`): if it
        // returns false we lost the race to a concurrent completion/expiry, so append
        // NOTHING. This is the row-level replay guard; the reducer's
        // `external_wait_pending`-at-attempt fold is the second layer.
        if (!markExternalWaitCompleted(deps.db, row, now())) return null;

        const event: EngineEvent = {
          type: 'externalWait.completed',
          runId,
          nodeId: row.nodeId,
          previousAttemptId: row.attemptId,
        };
        // Bus is `undefined` here: publishing INSIDE the tx would let a WS subscriber
        // observe an event a rollback could erase (the discipline the alarm handlers
        // keep by publishing via `afterCommit`). Publish the committed record below.
        const result = appendAndFold(deps.db, undefined, engine, state, event, deps.log);
        syncRunLifecycle(deps.db, runId, result.state.status);
        return result.record;
      });

      if (record === null) return 'not_completable';
      // AFTER commit: publish the completion to the live-tail bus (never before —
      // see above), then drive. Spawning work (the downstream drive, which may bill
      // real LLM calls) is forbidden inside the transaction.
      deps.bus?.publish(record);
      await driveRun(deps, runId);
      return 'completed';
    },
  };
}
