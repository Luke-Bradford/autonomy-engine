import {
  terminalStatusOf,
  type ArmWakeupInput,
  type Engine,
  type EngineEvent,
  type PipelineVersion,
  type Run,
  type RunState,
} from '@autonomy-studio/shared';
import { listRuns } from '../repo/runs.js';
import type { Db } from '../repo/types.js';
import {
  buildEngine,
  DocUnresolvableError,
  pump,
  retryArmInput,
  syncRunLifecycle,
  type DocResolver,
  type Executor,
  type RetryAlarms,
} from './driver.js';
import type { RunEventBus } from './event-bus.js';
import {
  appendAndFold,
  appendEngineEvent,
  loadEngineEvents,
  terminalFactFromLog,
} from './events.js';
import { recordRunDiagnostics } from '../repo/run-diagnostics.js';

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
 * A violation of one of THIS loop's own invariants, as opposed to a fault in the
 * run being reconciled. The per-run catch in `reconcileOnBoot` re-throws it.
 *
 * #479 gave that loop a per-run try/catch so one bad run cannot strand the rest.
 * That guard must not also swallow `refuseToExecute` (below), whose entire
 * purpose is to be unmissable: demoted to a `failed` entry it would surface only
 * as one string inside a `fastify.log.info` at boot, which is not what an
 * assertion is for. A sentinel keeps both properties — faults degrade one run,
 * invariant violations still take the process down.
 *
 * Same shape as the scheduler's `StaleWakeupError` (`scheduler/alarms.ts`): a
 * sentinel that lets a per-item catch tell an expected outcome from a real fault.
 * Sets `name` for the same reason that one does — this class exists to be
 * UNMISSABLE when it fires, and an unnamed subclass prints as a bare `Error`.
 *
 * EXPORTED for its tests, unlike `StaleWakeupError`. That is a real (small) cost,
 * paid deliberately: this class and the re-throw that reads it are the entire
 * justification for the per-run catch being broad, and a guard defended only by a
 * comment is one a future reader deletes as ceremony. Its tests must be able to
 * construct one, and `refuseToExecute`'s own path is not reachable from a natural
 * fixture (see that const). Also honest as API: a caller of `reconcileOnBoot`
 * genuinely can observe this — it is the one throw that escapes.
 */
export class ReconcileInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconcileInvariantError';
  }
}

/**
 * The executor the finalize path passes to `pump` when NO real executor is
 * available: a run being finalized has only a `finishRun` command (the driver's
 * own), so the executor must never be invoked. This throws if it somehow is —
 * fail-loud rather than silently mis-driving a run.
 *
 * EXPORTED for the same reason as `ReconcileInvariantError`, and with the same
 * reluctance: the CLASS it throws is load-bearing (a plain `Error` would be
 * absorbed into `failed` by the per-run catch), its path is not reachable from a
 * natural fixture, and an untested guard gets deleted as ceremony.
 */
export const refuseToExecute: Executor = {
  // Throws synchronously ON CALL (not merely on iteration): the finalize path
  // carries only `finishRun` — the driver's own command — so this is never
  // invoked; if a bug ever routed a dispatch/startChild here, fail loud.
  //
  // REACHABLE, despite the `needsExecutor` gate at the call site: that gate
  // inspects only the run's INITIAL commands, while `pump` drains a QUEUE that
  // grows as it reduces. A `finishRun` whose fold emits a `dispatchNode` arrives
  // here. That is a driver-invariant violation, so it throws the sentinel and
  // #479's per-run catch re-throws it rather than filing it under `failed`.
  perform(): AsyncIterable<EngineEvent> {
    throw new ReconcileInvariantError(
      'reconcile finalize path must not dispatch — expected only finishRun',
    );
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
  /**
   * Runs frozen `interrupted`, for one of THREE reasons — the bucket has three
   * producers and they are not the same story:
   *   - a non-idempotent activity was in flight at crash time
   *     (`non_idempotent_in_flight:<nodes>`); or
   *   - a held node's retry alarm was SPENT, so nothing can ever advance the run
   *     (`retry_alarm_spent:<nodes>` — see `recoverHeld`). Nothing was in flight
   *     here; the alarm came and went; or
   *   - the run's pipeline version is GONE (`doc_unresolvable:<pvId>` — #508, see
   *     `terminalizeUnresolvable`). Versions are immutable, so it never returns;
   *     the run can never be driven again, so it is frozen rather than left to
   *     re-`failed` on every boot forever.
   * The `run.interrupted.reason` distinguishes them; an operator reading a boot
   * report needs to know which.
   */
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
   * Runs alive on a durable NODE alarm with nothing to resume — "genuinely WAITING,
   * will advance on its own." Two shapes: a node HELD on a retry (F2b's
   * `retry_pending`, whose alarm may have been re-armed — those are in `rearmed`
   * too), and a node PARKED on a wait (#4 A6's `wait_pending`, whose alarm is never
   * re-armed here since it is always live). A hold that could not be made true again
   * is `interrupted` instead, never reported here. Reported so such a run is visibly
   * waiting rather than silently indistinguishable from a stuck one.
   */
  held: string[];
  /**
   * The subset of `held` whose alarm row was MISSING and has been re-armed. Non-
   * empty means a crash landed in the HOLD→ARM window — worth seeing in a boot
   * report rather than inferring from the log.
   */
  rearmed: string[];
  /**
   * #479 — runs whose reconcile THREW, with the reason. The fault degraded that
   * one run; every other run in the scan still reconciled.
   *
   * Carries the reason, not just the id, because this report IS the fault's only
   * channel: `reconcileOnBoot` returns it and `index.ts` logs it verbatim
   * (`fastify.log.info({ reconcileReport }, 'boot reconcile complete')`). A bare
   * `string[]` would drop the one fact an operator needs. (This is also why
   * there is no optional `log?` on `ReconcileDeps` — an optional logger is
   * droppable, a returned-and-logged report is not.)
   *
   * EXCLUSIVITY — exact, because it is easy to state too strongly:
   *   - Exclusive of the VERDICT buckets (`resumed`/`finalized`/`resynced`/
   *     `interrupted`/`deferred`). Each is pushed at a `continue` or at the loop
   *     tail — i.e. only once that run's reconcile has SUCCEEDED.
   *   - NOT exclusive of `held`/`rearmed`. Those are pushed BEFORE the loop
   *     falls through to `pump`, and they record work already durably committed
   *     (`recoverHeld` armed the alarm row and appended `node.retryScheduled`).
   *     A run in both is reporting the truth: the hold was recovered, the resume
   *     was not. Un-pushing it would erase a committed fact.
   *
   * SCOPE: only TRANSIENT faults reach here now. The faulted run is left
   * `running`, to be retried on the next boot — a transient fault (a DB blip, an
   * executor throw) is expected to clear, and terminalizing a healthy run on a
   * passing error is fail-open in the other direction. The PERMANENT half — a
   * pipeline version that is GONE — is #508: `resolveDoc` throws the typed
   * `DocUnresolvableError`, and `reconcileOne` terminalizes it `interrupted`
   * (`doc_unresolvable:<pvId>`) BEFORE it can reach this catch, so it no longer
   * re-`failed`s forever. A NON-`DocUnresolvableError` throw is, by the resolver's
   * contract, transient — hence lands here.
   */
  failed: Array<{ runId: string; reason: string }>;
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
  engine: Engine,
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
  const missing: { nodeId: string; failedAttemptId: string; input: ArmWakeupInput }[] = [];

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
      missing.push({ nodeId, failedAttemptId, input });
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
    // Synced from a FOLD, like the sibling interrupt path above — not from a
    // `terminalStatusOf(...) ?? 'interrupted'` default. That default is
    // unreachable today, but `types.ts` documents that forgetting to add an event
    // to `TERMINAL_RUN_EVENT_TYPES` is not a compile error and is #443's own
    // failure mode: the `??` would keep THIS function looking right while
    // `terminalFactFromLog` silently stopped seeing the fact. Folding fails loud.
    const folded = appendAndFold(deps.db, deps.bus, engine, state, interrupted);
    syncRunLifecycle(deps.db, run.id, folded.state.status);
    return 'interrupted';
  }

  if (missing.length === 0) return 'held';
  for (const { nodeId, failedAttemptId, input } of missing) {
    const row = deps.alarms.arm(input);
    appendEngineEvent(
      deps.db,
      {
        type: 'node.retryScheduled',
        runId: run.id,
        nodeId,
        attemptId: failedAttemptId,
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
    failed: [],
  };

  for (const run of listRuns(deps.db, { status: 'running' })) {
    // #479 — the per-run fault boundary. Boot reconcile IS the recovery path, so
    // it is the worst place for an all-or-nothing failure mode: without this, ONE
    // run whose reconcile threw (originally an unresolvable version — now that
    // permanent case is terminalized by #508 before it reaches here, but a
    // transient DB fault or an executor throw from `pump` still can) threw out of
    // the whole function and every run after it in the scan was never resumed,
    // interrupted, or re-synced.
    //
    // Wraps the WHOLE body, not just the `resolveDoc` call that motivated the
    // ticket: the property wanted is "a fault degrades THAT run", and a catch
    // around one known throw site leaves every other one able to strand the loop.
    // The cost of the breadth — that it could mask a genuine bug — is paid by the
    // sentinel re-throw below plus `failed` carrying the reason into the boot log.
    //
    // Partial side effects are survivable and were checked, not assumed: a throw
    // from `pump` AFTER its events are appended leaves exactly the durable state
    // it leaves today, because the append and the sync are separate statements
    // either way. Today that ALSO crashes boot. The log is the SSOT and the
    // projection is re-derived on the next boot, so catching is strictly better.
    try {
      // AWAITED inside the try — `reconcileOne` is async, so an unawaited call
      // would reject OUTSIDE this catch and crash boot as an unhandled rejection,
      // reinstating the exact fault #479 is closing.
      await reconcileOne(deps, report, run);
    } catch (err) {
      if (err instanceof ReconcileInvariantError) throw err;
      report.failed.push({
        runId: run.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}

/**
 * #508 — terminalize a run whose pipeline version can NEVER be resolved.
 *
 * DOC-FREE by necessity: the version is gone, so there is no engine to fold
 * through — the interrupt is recorded as a durable FACT in the log and the row is
 * synced from `terminalStatusOf` (#443's SSOT for the fact an event records),
 * never from a projection. This is the same primitive `terminalizeInterrupted`'s
 * `foldErr → patchRow` branch reaches when a drive's doc turns out unresolvable
 * (`driver.ts`) — inlined here because the call-site precondition is STRONGER:
 * the `terminalFactFromLog` fast path above has PROVEN the log non-terminal, so
 * this needs none of that function's re-load / terminal re-check / try-to-fold
 * dance (which would only re-call the resolver to have it throw again into its
 * own catch). It deliberately does NOT reuse `recoverHeld`'s `appendAndFold`
 * either: that path HAS an engine and records fold-diagnostics (#497); with no
 * doc there is no fold, and so no diagnostics to record.
 *
 * The reason follows the `interrupted` bucket's `<label>:<detail>` convention
 * (`non_idempotent_in_flight:` / `retry_alarm_spent:`).
 */
function terminalizeUnresolvable(deps: ReconcileDeps, run: Run): void {
  const interrupted: EngineEvent = {
    type: 'run.interrupted',
    runId: run.id,
    reason: `doc_unresolvable:${run.pipelineVersionId}`,
  };
  appendEngineEvent(deps.db, interrupted, deps.bus);
  // `terminalStatusOf`, not a `?? 'interrupted'` default: if `run.interrupted`
  // ever drops out of `TERMINAL_RUN_EVENT_TYPES` (#443's silent-drift mode — the
  // one direction the type system does NOT catch), fail LOUD via the sentinel
  // rather than paper over it. The event is already durable, so the next boot's
  // `terminalFactFromLog` would miss it too and the run would re-reconcile — an
  // invariant violation, exactly what `ReconcileInvariantError` exists to surface.
  const status = terminalStatusOf(interrupted);
  if (status === null) {
    throw new ReconcileInvariantError(
      'run.interrupted must record a terminal fact — TERMINAL_RUN_EVENT_TYPES drift (#443)',
    );
  }
  syncRunLifecycle(deps.db, run.id, status);
}

/**
 * One run's reconcile — the unit #479's fault boundary wraps. Extracted from the
 * loop so that boundary is a `try` around a call rather than a `try` wrapping
 * 130 lines; each of the loop body's `continue`s is a `return` here.
 *
 * Throws on any per-run fault; the caller records it into `report.failed` and
 * carries on with the next run. Its OWN invariant violations throw
 * `ReconcileInvariantError`, which the caller re-throws — see that class.
 */
async function reconcileOne(deps: ReconcileDeps, report: ReconcileReport, run: Run): Promise<void> {
  const events = loadEngineEvents(deps.db, run.id);

  // #443 — the LOG is authoritative over the projection for terminality: a
  // recorded terminal fact stands, so the row is merely stale (a crash between
  // the terminal append and its lifecycle sync). Deliberately does NOT consult
  // the projection — a reducer change re-folds this log, and trusting a re-fold
  // that contradicts the log's own terminal is what RE-EXECUTES a finished run's
  // side effects. Hoisted above `buildEngine` because the log needs no doc: a
  // finished run whose version is gone still resyncs correctly here, rather than
  // reaching `resolveDoc` and being reported `failed`. See `terminalFactFromLog`
  // for the rule and its cost.
  const terminal = terminalFactFromLog(events);
  if (terminal !== null) {
    syncRunLifecycle(deps.db, run.id, terminal);
    report.resynced.push(run.id);
    return;
  }

  // #508/#515 — the doc is resolved HERE, and a PERMANENT resolve failure is
  // terminalized rather than left to re-`failed` on every boot forever. A
  // `DocUnresolvableError` means the immutable version can never be driven again:
  // either the row is GONE (#508) or it is PRESENT but no longer PARSES
  // (`DocUnparseableError`, #515) — both permanent, since the row never changes
  // and the schema is fixed for the process. So freeze the run
  // `interrupted`/needs-attention, freeing its concurrency slot. Any OTHER throw
  // is transient (a DB blip) — rethrow it to #479's per-run catch, which files it
  // under `failed` and leaves the run `running` for the next boot (terminalizing a
  // healthy run on a passing blip is fail-open the other way). This scopes to the
  // `resolveDoc` call ONLY: a resolvable-but-otherwise-unbuildable version is a
  // different, out-of-scope class and still falls through to `failed`. The verdict
  // is derived from the resolver's TYPE (#491's derive-don't-guess), not inferred
  // from a bare catch.
  //
  // ORDERING: this sits ABOVE the `pending` resync below (which needs the doc to
  // project). So a `running` row with NO `run.started` AND a gone version — both
  // conditions unreachable via the real callers — terminalizes `interrupted`
  // here rather than resyncing to `pending`. Harmless: both are truthful terminal
  // verdicts for a dead run, and the two `run.started`-less pins use a RESOLVABLE
  // doc, so they still exercise the `pending` branch.
  let doc: PipelineVersion;
  try {
    doc = deps.resolveDoc(run.pipelineVersionId);
  } catch (err) {
    if (err instanceof DocUnresolvableError) {
      terminalizeUnresolvable(deps, run);
      report.interrupted.push(run.id);
      return;
    }
    throw err;
  }
  const engine = buildEngine(doc);
  const state = engine.projectRunState(events);

  // Defensive, and unreachable today: a `running` row whose log has no
  // `run.started` (the projection is then the `pending` seed). `updateRun`'s
  // only non-test callers derive the status from real state, so a row cannot
  // reach `running` before its `run.started` is durable. Kept because the
  // alternative is appending `run.resumed` to a log with no `run.started` — the
  // terminal check above no longer covers this, as `pending` is not a terminal
  // fact. Deleting it measurably corrupts: the run falls through to the resume
  // path, which appends that orphan `run.resumed` AND reports the run
  // `finalized` though it never finished.
  //
  // A re-sync, not an assertion: `pending` is a LEGITIMATE state, so syncing the
  // row to it is the truthful verdict. Throwing instead would file a healthy row
  // under `failed`.
  //
  // Pinned by the two `run.started`-less tests in `reconcile.test.ts`, which
  // fail if this branch is removed — so it cannot bit-rot silently.
  if (state.status === 'pending') {
    syncRunLifecycle(deps.db, run.id, state.status);
    report.resynced.push(run.id);
    return;
  }

  const inFlight = dispatchedNodes(state);
  const notProvablyIdempotent = inFlight.filter(
    ({ id, attemptId }) => idempotentFlagFor(events, id, attemptId) !== true,
  );

  if (notProvablyIdempotent.length > 0) {
    const reason = `non_idempotent_in_flight:${notProvablyIdempotent.map((n) => n.id).join(',')}`;
    const interrupted: EngineEvent = { type: 'run.interrupted', runId: run.id, reason };
    // Fold the PARSED event, not the raw one — see `appendEngineEvent`.
    const folded = appendAndFold(deps.db, deps.bus, engine, state, interrupted);
    syncRunLifecycle(deps.db, run.id, folded.state.status);
    report.interrupted.push(run.id);
    return;
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
  // #497 — HELD per event, to be recorded against the `seq` each is appended at
  // below. This site folds BEFORE it appends (it must know the commands to
  // decide whether it can honour them), so it is the one place `appendAndFold`
  // cannot serve; the diagnostics are paired to their event by index instead.
  //
  // Not an optional nicety here: since #491 this fold is where a run whose doc
  // STALLS derives `finishRun{failure,'stalled'}` afresh (see the finalize
  // bucket below), so this list holds the `stalledEntities` report naming WHICH
  // entities wedged the run. Dropping it would leave boot-reconcile — one of the
  // only two stall paths — still answering "why?" with nothing.
  const foldDiagnostics: string[][] = [];
  for (const ev of reconcileEvents) {
    const result = engine.reduce(next, ev);
    next = result.state;
    commands.push(...result.commands);
    foldDiagnostics.push(result.diagnostics);
  }

  // A run HELD on a retry (F2b) re-derives NOTHING above — `onResumed` skips
  // `retry_pending` deliberately, and `settle` cannot finish a run whose node
  // is non-terminal. So its alarm row is checked HERE, and — this is the part
  // that is easy to get wrong — checked UNCONDITIONALLY, whatever else the run
  // has to do.
  //
  // The obvious gate ("only when the run has no other commands, since a run
  // with live work resumes anyway and its held node is recovered by the alarm
  // regardless") is the EXACT false premise B2 exists to kill: if the alarm row
  // is missing there IS no alarm, and this is the only thing that can tell.
  // Worse, the two conditions are POSITIVELY CORRELATED, so the gate would skip
  // precisely the likeliest B2 case — `pump` drains `scheduleRetry` at the
  // QUEUE TAIL, so the HOLD→ARM window IS the interval in which the sibling
  // `dispatchNode` commands are draining. A crash there leaves a held node with
  // no alarm AND a sibling still `dispatched`. Measured under the gated version:
  // the sibling resumes and succeeds, the held node waits forever on an alarm
  // that does not exist, the run rests `running` for the rest of the process's
  // life, and the report calls it `resumed`.
  const heldNodes = Object.keys(next.nodes)
    .sort()
    .filter((id) => next.nodes[id]!.status === 'retry_pending');
  if (heldNodes.length > 0) {
    const verdict = recoverHeld(deps, engine, run, next, heldNodes);
    if (verdict === 'interrupted') {
      // Frozen: no alarm will ever resolve the hold, so do NOT also resume the
      // live nodes — the run is over.
      report.interrupted.push(run.id);
      return;
    }
    report.held.push(run.id);
    if (verdict === 'rearmed') report.rearmed.push(run.id);
    // `commands.length === 0` means the hold is the ONLY thing keeping this run
    // alive — there is nothing to resume, so stop here rather than append a
    // `run.resumed` that re-derives nothing. Otherwise fall through: the live
    // nodes resume normally and the run is reported `resumed` AS WELL AS held.
    if (commands.length === 0) return;
  }

  // A run PARKED on a wait (#4 A6) re-derives NOTHING above either — `onResumed`
  // skips `wait_pending` (like `retry_pending`), and `settle` cannot finish a run
  // whose node is non-terminal — so it reaches here with no commands. UNLIKE a
  // retry hold it needs NO re-arm: a `wait_pending` node's alarm was armed BEFORE
  // the `timer.waitScheduled` that parked it, so it always has a live row and the
  // clock's boot tick fires it. But it must be caught HERE, not left to fall
  // through: the finalize path below appends a spurious `run.resumed` (a no-op fold
  // for a parked node) and MISreports a still-running parked run as `finalized`
  // (`commands` is empty, so `needsExecutor` is false). Report it `held` — alive on
  // a durable node alarm, nothing to resume, the same disposition as a retry hold —
  // and stop, leaving its row untouched. Reached only when the wait is the ONLY
  // live work: a run with a parked wait AND a ready sibling has `commands`, resumes
  // normally, and its wait alarm fires independently.
  if (commands.length === 0 && Object.values(next.nodes).some((n) => n.status === 'wait_pending')) {
    report.held.push(run.id);
    return;
  }

  // `finishRun` is the driver's OWN command (no executor); `dispatchNode`/
  // `startChild` need one. A run whose only command is a `finishRun` can be
  // FINALIZED with no executor; one with live work to re-run needs the
  // executor — without it we DEFER, appending nothing we cannot follow
  // through on.
  //
  // TWO shapes reach the finalize path, not one: a run whose `finishRun` was
  // DROPPED by a crash (the historical case), and — since #491 — a run whose
  // doc STALLS, where `settle` derives `finishRun{failure,'stalled'}` afresh.
  // The second is why this bucket matters beyond crash recovery: a run wedged
  // by a pre-#444 doc is released at the next boot instead of holding its
  // concurrency slot until an operator intervenes.
  const needsExecutor = commands.some((c) => c.type !== 'finishRun');
  if (needsExecutor && deps.executor === undefined) {
    report.deferred.push(run.id);
    return;
  }

  // The append the fold above was provisional on. Recording each event's
  // diagnostics HERE — against the `seq` this append just assigned, on the same
  // `db` handle — is what keeps #497's rule intact through the inversion: the
  // DEFERRED path (above) folds and appends nothing, so it correctly records
  // nothing. No `log` seam: `ReconcileDeps` deliberately carries no logger (a
  // returned report is not droppable, an optional logger is), so a failed insert
  // is dropped here rather than reported — acceptable for an explanation, never
  // for a decision.
  for (const [i, ev] of reconcileEvents.entries()) {
    const { record } = appendEngineEvent(deps.db, ev, deps.bus);
    recordRunDiagnostics(deps.db, run.id, record.seq, 'fold', foldDiagnostics[i]!);
  }
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
