import type { z } from 'zod';
import type {
  EngineEvent,
  NodeRunStatus,
  RunState,
  ScheduledWakeup,
  WakeupRef,
} from '@autonomy-studio/shared';
import { getRun } from '../repo/runs.js';
import type { Db } from '../repo/types.js';
import {
  buildEngine,
  DocUnresolvableError,
  driveRun,
  syncRunLifecycle,
  type DriveDeps,
} from '../run/driver.js';
import { appendAndFold, loadEngineEvents, terminalFactFromLog } from '../run/events.js';
import type { WakeupFireResult, WakeupHandler } from './alarms.js';

/**
 * #585 — the shared skeleton behind S1's "fire-a-due-event-and-drive" alarm
 * handlers: `retry` (#1 F2c), `wait` (#4 A6), `external_wait` (#4 A13) and
 * `container_timeout` (#4 A17). All four were a near-verbatim copy-paste — the
 * `wait` handler's own doc called itself "the near-verbatim twin of retry" — so a
 * fix to the shared discipline had to be applied in four places and could drift
 * between them. This is that discipline, extracted ONCE; each kind supplies only
 * its four points of genuine variation (below).
 *
 * ## The invariant contract (identical for every kind — see `alarms.ts`)
 *
 * `fire` runs INSIDE the clock's transaction. The due event is appended TOGETHER
 * with the settle: a settle without the append loses the wake silently (the
 * subject stays parked with a spent alarm); the append without the settle
 * re-fires and double-processes. The fold is PURE, so it belongs inside the
 * transaction (it makes the run ROW agree with the event that just became
 * durable, atomically with the settle); its COMMANDS are deliberately DISCARDED
 * and re-derived under the run's lock by `driveRun` in `afterCommit` — a stale
 * command may have been superseded by a concurrent drive (B1). No bus inside the
 * transaction: the clock publishes the returned envelopes AFTER commit, so a
 * rollback cannot show a subscriber an event that never existed. `appendAndFold`
 * records the fold's diagnostics against the seq it appended at, on the SAME `tx`
 * handle (#497) — a correctness requirement, since this transaction's rollback IS
 * the at-least-once contract.
 *
 * ## Freshness (spec #5: every due event re-checks currency before it fires)
 *
 * Two load-bearing layers, since delivery is at-least-once:
 *   - Layer 1: the LOG decides whether the run is over (#443). Re-driving a
 *     recorded terminal fact under newer reducer rules is the fail-open direction
 *     and is what re-executes a finished run's side effects. This also covers a
 *     run whose drive threw AFTER its alarm was armed (`terminalizeInterrupted`
 *     froze it; its orphaned alarm must not resurrect it).
 *   - Layer 2: the kind's own subject guard (`config.checkFreshness`) — the node
 *     still parked at that attempt, or the container still active.
 *
 * A PERMANENTLY unresolvable version (`DocUnresolvableError` — the row is gone,
 * #508, or present-but-unparseable, #515) throws while resolving the doc; a throw
 * inside the clock's transaction rolls back the settle, leaving the row `pending`
 * and re-delivered on EVERY tick forever for a run that can never be driven again.
 * So SUPPRESS on that type. But ONLY that type — a NON-`DocUnresolvableError`
 * throw is a transient blip the rollback+redeliver is FOR, so rethrow it (the
 * clock leaves the row `pending` for the next tick). Suppressing every throw would
 * classify a passing blip as a dead run and drop the alarm forever.
 */

/** The kind's layer-2 subject guard verdict; a stale subject settles the alarm. */
export type FreshnessVerdict = { fresh: true } | { fresh: false; reason: string };

/**
 * The four points of genuine variation between the durable-alarm handlers. `TRef`
 * is the kind's PARSED ref type (node kinds carry `attemptId`; a container ref
 * does not), so `checkFreshness`/`buildDueEvent`/`settleSideEffect` receive the
 * concrete shape rather than the loose `Record<string,string>`.
 */
export interface DurableAlarmConfig<TRef extends WakeupRef & { runId: string }> {
  /** The `kind` this handler serves (S1's registry key). */
  kind: string;
  /** S1's "typed `ref` per kind", validated at ARM time and re-parsed here. */
  refSchema: z.ZodType<TRef>;
  /**
   * Layer-2 freshness: is the alarm's subject still CURRENT in the projection?
   * A `{fresh:false}` verdict settles the alarm with its `reason` rather than
   * firing — the subject moved on (a completed wait, a back-edge reset, an exited
   * loop) or the clock re-delivered an already-processed alarm.
   */
  checkFreshness(state: RunState, ref: TRef): FreshnessVerdict;
  /** The due event this alarm appends on fire, built entirely from the ref. */
  buildDueEvent(ref: TRef): EngineEvent;
  /**
   * OPTIONAL side-effect run at settle time — the ONLY variation beyond the
   * event. Today only `external_wait` uses it, to settle its correlation row
   * (`markExternalWaitExpired`) atomically with the log. Invoked at EXACTLY three
   * points — terminal-log suppress, stale (layer-2) suppress, and on fire (between
   * the append and the lifecycle sync) — and DELIBERATELY NOT on `run_not_found`
   * or `doc_unresolvable` (the run row / version is gone; there is nothing whose
   * correlation to settle, and those paths are the exceptional ones). Preserving
   * that asymmetry is load-bearing; see `external-wait-alarm.ts`.
   */
  settleSideEffect?(tx: Db, ref: TRef, deps: DriveDeps): void;
}

/**
 * Build a `WakeupHandler` for one durable-alarm kind from its `config`. The body
 * is the extracted skeleton documented above; the config supplies the four
 * variation points and nothing else.
 */
export function createDurableAlarmHandler<TRef extends WakeupRef & { runId: string }>(
  deps: DriveDeps,
  config: DurableAlarmConfig<TRef>,
): WakeupHandler {
  return {
    kind: config.kind,
    refSchema: config.refSchema,
    fire(row: ScheduledWakeup, _delivery, tx: Db): WakeupFireResult {
      const ref = config.refSchema.parse(row.ref);
      const events = loadEngineEvents(tx, ref.runId);

      // FRESHNESS layer 1: the log is authoritative for terminality (#443).
      if (terminalFactFromLog(events) !== null) {
        config.settleSideEffect?.(tx, ref, deps);
        return { status: 'suppressed', reason: 'run_already_terminal' };
      }

      const run = getRun(tx, ref.runId);
      if (run === null) return { status: 'suppressed', reason: 'run_not_found' };

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
      const verdict = config.checkFreshness(state, ref);
      if (!verdict.fresh) {
        // Legitimately reachable, not an error: the subject moved on, or an
        // at-least-once redelivery of an already-processed alarm. Suppression IS
        // the verdict, so it settles rather than firing forever.
        config.settleSideEffect?.(tx, ref, deps);
        return { status: 'suppressed', reason: verdict.reason };
      }

      // Appended INSIDE the clock's transaction, together with the settle (see the
      // module doc). The commands are discarded and re-derived under the run's
      // lock by `driveRun`.
      const due = config.buildDueEvent(ref);
      const result = appendAndFold(tx, undefined, engine, state, due);
      config.settleSideEffect?.(tx, ref, deps);
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

/**
 * A layer-2 guard for a NODE parked at a specific attempt (retry/wait/
 * external-wait): the node must exist, be at `expectedStatus`, and its
 * `currentAttemptId` must match the alarm's parked attempt. Any mismatch is a
 * stale delivery — a back-edge round reset the node, or the park already resolved.
 */
export function nodeParkedAtAttemptGuard(
  expectedStatus: NodeRunStatus,
  reason: string,
): (state: RunState, ref: { nodeId: string; attemptId: string }) => FreshnessVerdict {
  return (state, ref) => {
    const ns = state.nodes[ref.nodeId];
    if (ns === undefined || ns.status !== expectedStatus || ns.currentAttemptId !== ref.attemptId) {
      return { fresh: false, reason };
    }
    return { fresh: true };
  };
}

/**
 * A layer-2 guard for a CONTAINER still `active` (container-timeout): the whole
 * (runId, containerId) pair is the freshness handle — a container timeout is armed
 * ONCE per run at enter, so there is no attempt to match. An exited loop
 * (`exitWhen`/`maxRounds`/a child failure) or an already-fired timeout is stale.
 */
export function containerActiveGuard(
  reason: string,
): (state: RunState, ref: { containerId: string }) => FreshnessVerdict {
  return (state, ref) => {
    const cs = state.containers[ref.containerId];
    if (cs === undefined || cs.status !== 'active') {
      return { fresh: false, reason };
    }
    return { fresh: true };
  };
}
