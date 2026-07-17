import { checkInboundOutputs, type EngineEvent, type RunEvent } from '@autonomy-studio/shared';
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
 * `complete(token, body)` returns one of THREE verdicts:
 *  - `'completed'` iff THIS call appended the completion;
 *  - `'not_completable'` for the fail-closed set (unknown token, an
 *    already-settled/expired row, a node no longer parked at that attempt, a
 *    terminal run, an unresolvable version) — the route maps ALL of these to ONE
 *    response, so an unknown token and an already-used one are indistinguishable:
 *    a token is never a state oracle;
 *  - `'invalid_payload'` (#4 A16) when the callback body FAILS the webhook's
 *    declared `config.outputs` contract. This is reachable ONLY after the token,
 *    freshness and parked-at-attempt checks all PASS — i.e. only a holder of a
 *    LIVE token for a currently-parked node can see it — so naming the defect is
 *    not a state oracle. The row is left `pending` and NOTHING is appended, so the
 *    node stays parked and the caller can retry with a correct body before the
 *    expiry alarm bounds the wait.
 */
export type ExternalWaitOutcome = 'completed' | 'not_completable' | 'invalid_payload';

/**
 * The completer's result. `reason` is set ONLY for `'invalid_payload'` — the
 * human contract-mismatch text from `checkInboundOutputs` (e.g. `missing declared
 * output 'decision'`), which the route surfaces in the 422 body so a legitimate
 * token holder knows WHICH field to correct on retry. Safe to reveal: the 422 is
 * reachable only by a holder of a LIVE token for a currently-parked node, so it is
 * not a state oracle (see `checkInboundOutputs`' doc).
 */
export interface ExternalWaitCompletion {
  outcome: ExternalWaitOutcome;
  reason?: string;
}

export interface ExternalWaitCompleter {
  complete(token: string, body: Buffer | undefined): Promise<ExternalWaitCompletion>;
}

/**
 * #4 A16 — parse an inbound callback body (an untrusted `Buffer`) into a plain
 * object for `checkInboundOutputs`. An empty/absent body, a non-JSON body, or a
 * JSON value that is not a plain object (a bare string/number/array/null) all
 * collapse to `{}` — the contract then decides: a webhook with declared keys
 * `422`s (all keys missing), one with no declared keys completes with `{}` (A13
 * accepted any body). `JSON.parse` is guarded so a garbage body is never a 500.
 */
function parseCallbackBody(body: Buffer | undefined): Record<string, unknown> {
  if (body === undefined || body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return {};
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function createExternalWaitCompleter(deps: DriveDeps): ExternalWaitCompleter {
  const now = deps.now ?? (() => Date.now());
  return {
    async complete(token: string, body: Buffer | undefined): Promise<ExternalWaitCompletion> {
      // Look the token up by its HASH (the raw token is never stored). A miss is
      // the SAME verdict as every other non-completable case — no existence oracle.
      const row = getExternalWaitByTokenHash(deps.db, hashExternalWaitToken(token));
      if (row === null || row.status !== 'pending') return { outcome: 'not_completable' };

      // Parse the untrusted body up front (pure); the contract-aware validation
      // runs INSIDE the tx, after the parked check, so `invalid_payload` is only
      // ever reachable by a live token for a currently-parked node.
      const payload = parseCallbackBody(body);

      // Guard + settle-row + append in ONE synchronous transaction: better-sqlite3
      // is single-threaded, but the explicit transaction makes the settle+append
      // atomic even if `appendAndFold` throws (no half-settled row without its
      // event), and serializes against a concurrent expiry/duplicate-completion.
      const runId = row.runId;
      type TxResult = { verdict: ExternalWaitOutcome; record: RunEvent | null; reason?: string };
      const result: TxResult = deps.db.transaction((): TxResult => {
        const events = loadEngineEvents(deps.db, runId);
        // FRESHNESS (spec #5 / #443): the LOG decides whether the run is over —
        // re-driving a recorded terminal is the fail-open direction.
        if (terminalFactFromLog(events) !== null) {
          return { verdict: 'not_completable', record: null };
        }

        const run = getRun(deps.db, runId);
        if (run === null) return { verdict: 'not_completable', record: null };

        const doc = deps.resolveDoc(run.pipelineVersionId);
        let engine;
        try {
          engine = buildEngine(doc);
        } catch (err) {
          // A permanently-unresolvable version: not completable, don't roll back.
          if (err instanceof DocUnresolvableError) {
            return { verdict: 'not_completable', record: null };
          }
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
          return { verdict: 'not_completable', record: null };
        }

        // #4 A16 — validate the callback body against the webhook's declared
        // `config.outputs` at the BOUNDARY, AFTER the parked check (so a guesser
        // never reaches it) and BEFORE `markExternalWaitCompleted` (so a bad body
        // settles nothing and appends nothing — the node stays parked to retry).
        const node = doc.nodes.find((n) => n.id === row.nodeId);
        if (node === undefined) return { verdict: 'not_completable', record: null };
        const checked = checkInboundOutputs(node, payload);
        if (!checked.ok) {
          return { verdict: 'invalid_payload', record: null, reason: checked.reason };
        }

        // Settle the correlation row FIRST (guarded `WHERE status = 'pending'`): if
        // it returns false we lost the race to a concurrent completion/expiry, so
        // append NOTHING. This is the row-level replay guard; the reducer's
        // `external_wait_pending`-at-attempt fold is the second layer.
        if (!markExternalWaitCompleted(deps.db, row, now())) {
          return { verdict: 'not_completable', record: null };
        }

        const event: EngineEvent = {
          type: 'externalWait.completed',
          runId,
          nodeId: row.nodeId,
          previousAttemptId: row.attemptId,
          outputs: checked.outputs,
        };
        // Bus is `undefined` here: publishing INSIDE the tx would let a WS subscriber
        // observe an event a rollback could erase (the discipline the alarm handlers
        // keep by publishing via `afterCommit`). Publish the committed record below.
        const folded = appendAndFold(deps.db, undefined, engine, state, event, deps.log);
        syncRunLifecycle(deps.db, runId, folded.state.status);
        return { verdict: 'completed', record: folded.record };
      });

      if (result.record === null) return { outcome: result.verdict, reason: result.reason };
      // AFTER commit: publish the completion to the live-tail bus (never before —
      // see above), then drive. Spawning work (the downstream drive, which may bill
      // real LLM calls) is forbidden inside the transaction.
      deps.bus?.publish(result.record);
      await driveRun(deps, runId);
      return { outcome: 'completed' };
    },
  };
}
