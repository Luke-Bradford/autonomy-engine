import {
  terminalStatusOf,
  type ArmWakeupInput,
  type EngineEvent,
  type RunState,
} from '@autonomy-studio/shared';
import { listRuns } from '../repo/runs.js';
import type { Db } from '../repo/types.js';
import {
  buildEngine,
  pump,
  retryArmInput,
  syncRunLifecycle,
  type DocResolver,
  type Executor,
  type RetryAlarms,
} from './driver.js';
import type { RunEventBus } from './event-bus.js';
import { appendEngineEvent, loadEngineEvents, terminalFactFromLog } from './events.js';

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
 *
 * ## Why this pumps WITHOUT the per-run drive lock
 *
 * F2c made "exactly one drive per run" structural (`run/drives.ts`), and the two
 * RUNTIME entry points — the launcher and the retry alarm — carry the lock. This
 * one does not, because at boot it is provably the only pump source: `buildApp`
 * awaits `reconcileOnBoot` BEFORE it starts the alarm clock's interval and before
 * the launcher or scheduler exist. That ordering is load-bearing rather than
 * incidental — with the interval started first, a 1s tick would fire an alarm
 * into a run this loop is mid-`pump` on, which is exactly B1 — so it is stated at
 * its one call site too. Anything that ever calls this against a LIVE app must
 * take the lock instead of relying on this paragraph.
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
   * F2c — the alarm seam `pump` needs. REQUIRED for the same reason it is on
   * `DriverDeps`: a resumed run can fail transiently and emit `scheduleRetry`
   * like any other, and a driver that cannot arm it hangs the run. Its `find`
   * half is what `recoverHeld` checks a hold's alarm row with.
   */
  alarms: RetryAlarms;
  /** Clock seam (epoch ms) for a RE-ARMED retry's `dueAt`; mirrors `DriverDeps.now`. */
  now?: () => number;
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
  /**
   * Runs HELD on a node's retry (F2b's `retry_pending`) whose durable alarm row
   * is present and pending, left untouched on purpose: that row outlived the
   * crash and re-fires on its own (§A.5). Reported so a held run is visibly
   * waiting rather than silently indistinguishable from a stuck one.
   */
  held: string[];
  /**
   * Held runs whose alarm row was MISSING and has been re-armed — a SUBSET of
   * `held` (they are reported in both: they are held, and this is why they still
   * are). Non-empty means a crash landed in the HOLD→ARM window, which is worth
   * seeing in a boot report rather than inferring from the log.
   */
  rearmed: string[];
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

/**
 * F2c/B2 — decide what a HELD run's alarm row actually says, and act on it.
 *
 * The premise this exists to kill: §A.5 originally said a held run needs nothing
 * at boot, because "the durable alarm row IS the recovery mechanism, and
 * re-deriving a retry from the projection would DOUBLE-ARM it". Both halves were
 * wrong, and the safest-sounding option was the unrecoverable one:
 *
 *  - Re-arming cannot double-arm. `armWakeup` is upsert-if-absent and returns the
 *    EXISTING row whatever its status ("a replayed `scheduleRetry` for an attempt
 *    whose alarm already fired must be a no-op, not a resurrection" — its own
 *    comment). Idempotence is exactly what makes re-arming free.
 *  - The HOLD becomes durable strictly BEFORE the alarm exists. `node.failed`
 *    folds to `retry_pending` and only QUEUES `scheduleRetry`; `pump` drains that
 *    at the queue TAIL, so the gap spans every intervening command — minutes of
 *    LLM calls, not a sub-tick window. A crash in there leaves a log projecting
 *    to `retry_pending` with NO alarm row, and "do nothing" then strands the run
 *    `running` FOREVER, across every subsequent boot.
 *
 * So the row is checked, not assumed, and there are THREE cases — not two.
 * Reporting `held` for a run with no live alarm reports a hang as if it were a
 * wait.
 *
 * Note what makes the missing-row case safe to heal: `armRetry` arms BEFORE it
 * appends, so "no row" implies its `node.retryScheduled` never landed either.
 * Appending one here therefore cannot duplicate a fact already in the log. The
 * reverse window (row armed, append lost) costs only observability, which is the
 * asymmetry `armRetry` chose deliberately.
 */
function recoverHeld(
  deps: ReconcileDeps,
  run: { id: string; pipelineVersionId: string },
  state: RunState,
  heldNodes: string[],
): 'held' | 'rearmed' | 'interrupted' {
  // CLASSIFY EVERY held node before changing anything. Deciding and acting in one
  // pass would arm a sibling's alarm and only then discover another node is
  // stranded — leaving a pending alarm on a run this function is about to freeze.
  // (Harmless, as it happens: the handler's terminal check would suppress it. But
  // "harmless because something downstream catches it" is not the same as not
  // doing it, and the interrupt genuinely must take precedence.)
  const spent: string[] = [];
  const missing: { nodeId: string; input: ArmWakeupInput }[] = [];

  for (const nodeId of heldNodes) {
    // The FAILED attempt, and provably so: `onFailed` gates on
    // `event.attemptId === ns.currentAttemptId` and its retry branch folds only
    // `{status:'retry_pending'}`, leaving `currentAttemptId` untouched. So a held
    // node's `currentAttemptId` IS the attempt its alarm is keyed to.
    const failedAttemptId = state.nodes[nodeId]!.currentAttemptId!;
    const input = retryArmInput(deps, {
      runId: run.id,
      pipelineVersionId: run.pipelineVersionId,
      nodeId,
      failedAttemptId,
    });
    const existing = deps.alarms.find(input);

    if (existing === null) {
      missing.push({ nodeId, input });
    } else if (existing.status !== 'pending') {
      // The row exists but is SPENT (fired/suppressed/cancelled) while the node
      // is still held — the alarm came and went without resolving the hold. NOT
      // re-armable: `arm` would return this very row (same derived key) and
      // change nothing, and the `node.retryScheduled` appended from it would
      // record a due time in the PAST for an alarm that will never fire again.
      // Nothing can advance this run, so freeze it as needs-attention rather
      // than report it as waiting.
      spent.push(nodeId);
    }
    // else: a pending row — a healthy hold, nothing to do.
  }

  if (spent.length > 0) {
    const reason = `retry_alarm_spent:${spent.join(',')}`;
    const interrupted: EngineEvent = { type: 'run.interrupted', runId: run.id, reason };
    const appended = appendEngineEvent(deps.db, interrupted, deps.bus);
    syncRunLifecycle(deps.db, run.id, terminalStatusOf(appended.event) ?? 'interrupted');
    return 'interrupted';
  }

  if (missing.length === 0) return 'held';
  for (const { nodeId, input } of missing) {
    const row = deps.alarms.arm(input);
    appendEngineEvent(
      deps.db,
      {
        type: 'node.retryScheduled',
        runId: run.id,
        nodeId,
        attemptId: input.ref['attemptId']!,
        // From the ARMED ROW, never the local computation — the same rule
        // `armRetry` follows, so the log records when the alarm really fires.
        nextAttemptAt: row.dueAt,
      },
      deps.bus,
    );
  }
  return 'rearmed';
}

export async function reconcileOnBoot(deps: ReconcileDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    resumed: [],
    interrupted: [],
    deferred: [],
    resynced: [],
    finalized: [],
    held: [],
    rearmed: [],
  };

  for (const run of listRuns(deps.db, { status: 'running' })) {
    const events = loadEngineEvents(deps.db, run.id);

    // #443 — the LOG is authoritative over the projection for terminality: a
    // recorded terminal fact stands, so the row is merely stale (a crash between
    // the terminal append and its lifecycle sync). Deliberately does NOT consult
    // the projection — a reducer change re-folds this log, and trusting a re-fold
    // that contradicts the log's own terminal is what RE-EXECUTES a finished run's
    // side effects. Hoisted above `buildEngine` because the log needs no doc, so an
    // unresolvable version cannot strand a finished run (or the ones after it in
    // this loop). See `terminalFactFromLog` for the rule and its cost.
    const terminal = terminalFactFromLog(events);
    if (terminal !== null) {
      syncRunLifecycle(deps.db, run.id, terminal);
      report.resynced.push(run.id);
      continue;
    }

    const engine = buildEngine(deps.resolveDoc(run.pipelineVersionId));
    const state = engine.projectRunState(events);

    // Defensive, and unreachable today: a `running` row whose log has no
    // `run.started` (the projection is then the `pending` seed). `updateRun`'s
    // only non-test callers derive the status from real state, so a row cannot
    // reach `running` before its `run.started` is durable. Kept because the
    // alternative is appending `run.resumed` to a log with no `run.started` — the
    // terminal check above no longer covers this, as `pending` is not a terminal
    // fact. Deleting it measurably corrupts: the run falls through to the resume
    // path, which appends that orphan `run.resumed` AND reports the run
    // `finalized` though it never finished. A re-sync, not an assertion: this
    // loop has no per-run try/catch, so a throw would strand every run after it.
    // Pinned by the two `run.started`-less tests in `reconcile.test.ts`, which
    // fail if this branch is removed — so it cannot bit-rot silently.
    if (state.status === 'pending') {
      syncRunLifecycle(deps.db, run.id, state.status);
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
      const appended = appendEngineEvent(deps.db, interrupted, deps.bus);
      // Fold the PARSED event, not the raw one — see `appendEngineEvent`.
      syncRunLifecycle(deps.db, run.id, engine.reduce(state, appended.event).state.status);
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

    // A run HELD on a retry (F2b) re-derives NOTHING here — `onResumed` skips
    // `retry_pending` deliberately, and `settle` cannot finish a run whose node
    // is non-terminal. Without this branch such a run falls through and is
    // reported `finalized` ("now terminalized"), which is simply false: it is
    // waiting on its alarm. It would also collect a fresh, pointless
    // `run.resumed` on EVERY boot.
    //
    // Gated on there being no commands, so a run that ALSO has a live idempotent
    // node still resumes normally — its held node is recovered by the alarm
    // regardless.
    const heldNodes = Object.keys(next.nodes)
      .sort()
      .filter((id) => next.nodes[id]!.status === 'retry_pending');
    if (commands.length === 0 && heldNodes.length > 0) {
      const verdict = recoverHeld(deps, run, next, heldNodes);
      report[verdict].push(run.id);
      if (verdict === 'rearmed') report.held.push(run.id);
      continue;
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
    syncRunLifecycle(deps.db, run.id, next.status);
    await pump(
      {
        db: deps.db,
        resolveDoc: deps.resolveDoc,
        executor: deps.executor ?? refuseToExecute,
        alarms: deps.alarms,
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
