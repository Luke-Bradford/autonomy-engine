import type { EngineEvent, RunState } from '@autonomy-studio/shared';
import { listRuns } from '../repo/runs.js';
import type { Db } from '../repo/types.js';
import { buildEngine, pump, syncRunLifecycle, type DocResolver, type Executor } from './driver.js';
import type { RunEventBus } from './event-bus.js';
import { appendEngineEvent, loadEngineEvents } from './events.js';

/**
 * P2d — the BOOT RECONCILER: the run engine's recovery boundary. An in-process
 * driver means NO run can be mid-execution across a restart, so on boot every
 * `runs` row still `running` is by definition a crash survivor whose in-flight
 * work was lost. This module applies the per-activity RESUME POLICY (mined from
 * the prototype, spec'd in the target architecture):
 *
 *   - a node still `dispatched` whose activity is PROVABLY IDEMPOTENT (the flag
 *     PERSISTED in its `node.dispatched` event — never recomputed here, CP1 Q4)
 *     → safe to re-run: append `run.resumed` + `node.retryRequested` so the
 *     reducer re-dispatches it under a NEW attempt (the stale pre-crash result
 *     is then ignored by attempt-id).
 *   - a node still `dispatched` that is NOT provably idempotent (an LLM call
 *     that may already be billed, an `agent_cli` subprocess) → re-running could
 *     double-execute a side effect, so the whole run is FROZEN `interrupted`
 *     (needs-attention) via `run.interrupted`. NEVER a silent resume.
 *
 * Absence of evidence is treated as the unsafe side: a `dispatched` node whose
 * idempotent flag is missing or `false` forces the interrupt.
 *
 * A `waiting` call node is always safe to re-emit (its deterministic
 * `childRunId` makes re-`startChild` idempotent), so `run.resumed` recovers it
 * without an interrupt. A `ready` node (dispatch DECIDED but its `node.dispatched`
 * never persisted) is re-emitted under its EXISTING attempt — safe ONLY under the
 * executor contract that a `node.dispatched` (with its idempotent flag) is
 * durably appended BEFORE the activity's side effect runs (see the `Executor`
 * doc in `driver.ts`). Under that contract a crash after a side effect always
 * leaves the node `dispatched` (caught by the idempotent gate above), never
 * `ready`. Honouring it is the P3 executor's obligation; the P2 stub, being
 * synchronous with no real side effect, trivially satisfies it.
 *
 * The reconciler ALSO finalizes a run that reached its terminal node event but
 * crashed before `run.finished` landed: `run.resumed` re-runs the walk (see
 * `onResumed` in the reducer), regenerating the dropped `finishRun`. That needs
 * no executor, so it happens even on a no-executor P2 boot (reported `finalized`).
 *
 * Everything here is event-sourced: the verdict is a fact APPENDED to the log,
 * so the projection and the durable log never diverge (`interrupted`/`resumed`/
 * `finalized` are reachable only by folding these events, never by an
 * out-of-band patch).
 */

/**
 * The executor the finalize path passes to `pump` when NO real executor is
 * available: a run being finalized has only a `finishRun` command (the driver's
 * own), so the executor must never be invoked. This throws if it somehow is —
 * fail-loud rather than silently mis-driving a run.
 */
const refuseToExecute: Executor = {
  // Throws synchronously ON CALL (not merely on iteration): the finalize path
  // carries only `finishRun` — the driver's own command — so this is never
  // invoked; if a bug ever routed a dispatch/startChild here, fail loud.
  perform(): AsyncIterable<EngineEvent> {
    throw new Error('reconcile finalize path must not dispatch — expected only finishRun');
  },
};

export interface ReconcileDeps {
  db: Db;
  resolveDoc: DocResolver;
  /**
   * When provided, resumable runs are DRIVEN to completion immediately (the
   * "reconciler + driver" of the P2d ticket). When absent — P2 boot, before P3
   * supplies the real executor — a resumable run is left untouched and reported
   * as `deferred`: it cannot be re-run without a way to execute its activities,
   * so we do NOT append resume events we could not follow through on. Interrupts
   * (which need no executor) are ALWAYS applied.
   */
  executor?: Executor;
  /** P6 — the live-monitor bus, threaded through so reconcile-appended events
   * (`run.interrupted`/`run.resumed`/…) publish through the same choke point.
   * Boot reconcile runs before the server accepts connections, so nothing is
   * watching yet; wiring it keeps the append path uniform (every appended event
   * publishes) rather than being a live requirement today. */
  bus?: RunEventBus;
}

export interface ReconcileReport {
  /** Runs that got `run.resumed` + `node.retryRequested` and were re-driven. */
  resumed: string[];
  /** Runs frozen `interrupted` (a non-idempotent activity was in flight). */
  interrupted: string[];
  /** Resumable runs left for a later boot with an executor (no executor now). */
  deferred: string[];
  /** Running rows whose LOG already ended terminal; only `runs.status` resynced. */
  resynced: string[];
  /** Runs that only needed their crash-dropped `finishRun` reconstructed (no
   * executor required) — reached their terminal node event but crashed before
   * `run.finished`; now terminalized. */
  finalized: string[];
}

/**
 * The PERSISTED idempotent flag for a node's given attempt, read from that
 * attempt's `node.dispatched` event in the log (never recomputed — CP1 Q4).
 * `undefined` when no such event exists (treated as the unsafe side by callers).
 */
function idempotentFlagFor(
  events: EngineEvent[],
  nodeId: string,
  attemptId: string,
): boolean | undefined {
  let flag: boolean | undefined;
  for (const e of events) {
    if (e.type === 'node.dispatched' && e.nodeId === nodeId && e.attemptId === attemptId) {
      flag = e.idempotent;
    }
  }
  return flag;
}

/** The nodes still in flight (`dispatched`) at crash time, in stable id order. */
function dispatchedNodes(state: RunState): { id: string; attemptId: string }[] {
  return Object.keys(state.nodes)
    .sort()
    .filter((id) => state.nodes[id]!.status === 'dispatched')
    .map((id) => ({ id, attemptId: state.nodes[id]!.currentAttemptId! }));
}

export async function reconcileOnBoot(deps: ReconcileDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    resumed: [],
    interrupted: [],
    deferred: [],
    resynced: [],
    finalized: [],
  };

  for (const run of listRuns(deps.db, { status: 'running' })) {
    const events = loadEngineEvents(deps.db, run.id);
    const engine = buildEngine(deps.resolveDoc(run.pipelineVersionId));
    const state = engine.projectRunState(events);

    // Defensive: if the LOG already ended on a terminal fact, the row's
    // `running` status is merely stale (a crash between the terminal append and
    // its lifecycle sync). Re-sync the row from the projection and move on.
    if (state.status !== 'running') {
      syncRunLifecycle(deps.db, run.id, state);
      report.resynced.push(run.id);
      continue;
    }

    const inFlight = dispatchedNodes(state);
    const notProvablyIdempotent = inFlight.filter(
      ({ id, attemptId }) => idempotentFlagFor(events, id, attemptId) !== true,
    );

    if (notProvablyIdempotent.length > 0) {
      const reason = `non_idempotent_in_flight:${notProvablyIdempotent.map((n) => n.id).join(',')}`;
      const interrupted: EngineEvent = { type: 'run.interrupted', runId: run.id, reason };
      appendEngineEvent(deps.db, interrupted, deps.bus);
      syncRunLifecycle(deps.db, run.id, engine.reduce(state, interrupted).state);
      report.interrupted.push(run.id);
      continue;
    }

    // Build (WITHOUT persisting yet) the reconcile events + the commands they
    // regenerate: `run.resumed` re-derives the walk — re-emitting `ready`/
    // `waiting` dispatches, dispatching any genuinely newly-ready pending node,
    // AND regenerating the ephemeral `finishRun` a crash between a terminal node
    // event and `run.finished` would have dropped — then a `node.retryRequested`
    // per idempotent in-flight node re-dispatches it under a NEW attempt.
    const reconcileEvents: EngineEvent[] = [
      { type: 'run.resumed', runId: run.id, reason: 'boot_reconcile' },
      ...inFlight.map(({ id, attemptId }): EngineEvent => ({
        type: 'node.retryRequested',
        runId: run.id,
        nodeId: id,
        previousAttemptId: attemptId,
        reason: 'boot_reconcile',
      })),
    ];
    let next = state;
    const commands = [];
    for (const ev of reconcileEvents) {
      const result = engine.reduce(next, ev);
      next = result.state;
      commands.push(...result.commands);
    }

    // `finishRun` is the driver's OWN command (no executor); `dispatchNode`/
    // `startChild` need one. A run that only needs its dropped `finishRun`
    // reconstructed can be FINALIZED with no executor; one with live work to
    // re-run needs the executor — without it we DEFER, appending nothing we
    // cannot follow through on.
    const needsExecutor = commands.some((c) => c.type !== 'finishRun');
    if (needsExecutor && deps.executor === undefined) {
      report.deferred.push(run.id);
      continue;
    }

    for (const ev of reconcileEvents) appendEngineEvent(deps.db, ev, deps.bus);
    syncRunLifecycle(deps.db, run.id, next);
    await pump(
      {
        db: deps.db,
        resolveDoc: deps.resolveDoc,
        executor: deps.executor ?? refuseToExecute,
        bus: deps.bus,
      },
      engine,
      next,
      commands,
    );
    (needsExecutor ? report.resumed : report.finalized).push(run.id);
  }

  return report;
}
