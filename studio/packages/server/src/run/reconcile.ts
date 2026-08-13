import {
  terminalStatusOf,
  type ArmWakeupInput,
  type Engine,
  type EngineEvent,
  type PipelineVersion,
  TERMINAL_RUN_ROW_STATUS,
  type Run,
  type RunState,
} from '@autonomy-studio/shared';
import { isDeterministicRowCorruption } from '../repo/row-corruption.js';
import { getParsedRun, getRun, listParsedRuns } from '../repo/runs.js';
import type { Db } from '../repo/types.js';
import {
  buildEngine,
  DocUnresolvableError,
  pump,
  retryArmInput,
  syncRunLifecycle,
  terminalizeInterrupted,
  type DocResolver,
  type Executor,
  type RetryAlarms,
} from './driver.js';
import type { RunEventBus } from './event-bus.js';
import type { RunDrives } from './drives.js';
import {
  appendAndFold,
  appendEngineEvent,
  hasRunStartedFact,
  loadEngineEvents,
  RunLogUnparseableError,
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
 * ## The lock contract (#5 S7 — the formalization)
 *
 * The per-run reconcile policy (`reconcileOne`) has exactly TWO sanctioned
 * entry points, distinguished by how they satisfy F2c's "exactly one drive per
 * run":
 *
 *  - **Boot** (`reconcileOnBoot`): takes the drive lock per run, like every
 *    other caller. It used to pump WITHOUT it, on the argument that at boot it
 *    was provably the only pump source — `buildApp` awaits it BEFORE the alarm
 *    clock's interval starts and before the launcher or scheduler exist. #796
 *    falsified that premise: reconciling a parent with a `waiting`
 *    `call_pipeline` node re-emits `startChild`, which SPAWNS a child drive
 *    (`run/child.ts`) while this loop is still scanning — and that child, or the
 *    reactor that returns its result to the parent, is a second pump source
 *    inside boot. The boot ORDERING is still load-bearing for a different reason
 *    (with the alarm interval started first, a 1s tick would fire an alarm into a
 *    run this loop is mid-`pump` on — exactly B1), so it is still stated at the
 *    call site; the lock is what makes the child case safe rather than the
 *    ordering. Taking it costs nothing when nothing contends.
 *  - **Lease reclaim** (#5 S7, `scheduler/lease.ts`): the LIVE-app caller. It
 *    MUST — and does — wrap `reconcileOne` in `drives.serialize(runId, …)`,
 *    re-reading the run row under the lock before acting. `reconcileOne`
 *    re-loads the log and re-projects on entry, which is the other half of the
 *    F2c mechanism (a lock around a stale snapshot serializes nothing).
 *
 * Any future caller joins the second contract: take the lock, re-check under
 * it. There is no third mode.
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
  /**
   * #796 — the per-run DRIVE LOCK. Boot reconcile takes it per run because a
   * reconciled parent can spawn a `call_pipeline` child mid-scan, making this
   * loop no longer the only pump source (see the lock contract above).
   *
   * OPTIONAL for the same reason `executor` is, and with the same shape of
   * contract: a child can only be spawned by an executor that HAS the
   * `childRuns` seam, and a reconcile wired without a lock is wired without one
   * of those too (every test executor here is a stub). Production always passes
   * it. If you wire a real executor, wire this — the pairing is the requirement
   * the type cannot state.
   */
  drives?: RunDrives;
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
  /**
   * #4 A13 — the webhook external-wait token signer `pump` needs to RESUME a `ready`
   * webhook (its `scheduleExternalWait` re-armed via `armExternalWait`). Optional for
   * the same reason as on `DriverDeps`: only a webhook doc needs it, and its absence
   * throws loudly rather than hanging. Threaded through to the pump's driver boundary.
   */
  signExternalWaitToken?: (args: { runId: string; nodeId: string; attemptId: string }) => string;
}

export interface ReconcileReport {
  /** Runs that got `run.resumed` + `node.retryRequested` and were re-driven. */
  resumed: string[];
  /**
   * Runs frozen `interrupted`, for one of FOUR reasons — the bucket has four
   * producers and they are not the same story:
   *   - a non-idempotent activity was in flight at crash time
   *     (`non_idempotent_in_flight:<nodes>`); or
   *   - a held node's retry alarm was SPENT, so nothing can ever advance the run
   *     (`retry_alarm_spent:<nodes>` — see `recoverHeld`). Nothing was in flight
   *     here; the alarm came and went; or
   *   - the run's pipeline version is GONE (`doc_unresolvable:<pvId>` — #508, see
   *     `interruptRun`). Versions are immutable, so it never returns; the run can
   *     never be driven again, so it is frozen rather than left to re-`failed` on
   *     every boot forever; or
   *   - it is a `call_pipeline` CHILD whose parent is already over
   *     (`parent_terminal:<parentRunId>` — #1053). The first three are "nothing
   *     can ADVANCE this run"; this one is "nothing can CONSUME it", and it is
   *     the only one where the run was still perfectly resumable — see the guard
   *     in `reconcileOne` for why it is frozen anyway.
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
   *     `interrupted`/`deferred`/`sweptOrphans`). Each is pushed at a
   *     `continue` or at the loop tail — i.e. only once that run's reconcile has
   *     SUCCEEDED. `sweptOrphans` (#1041, #1048) keeps the property a different
   *     way, and deliberately. Stated exactly, because the loose version of this
   *     sentence claimed more than the code does: `sweepOne` reaches AT MOST one
   *     bucket for a given run, NOT exactly one. Several of its paths report
   *     nothing at all — a `pending` child with a log, an absent or non-terminal
   *     parent — because those are not orphans and there is no verdict to record.
   *     (#1048 narrowed that list: a run whose log HAS `run.started` is no longer
   *     a silent skip, it is delegated to `reconcileOne` and reported by whichever
   *     VERDICT bucket that reaches. Still at most one bucket per run.) What IS
   *     guaranteed is the exclusivity this list is about: an id in `sweptOrphans` is
   *     never also in `failed`, because the two are the arms of ONE decision, and
   *     that decision reads the row back rather than trusting the call (the
   *     terminalize can no-op silently rather than throw). An unreadable row short-
   *     circuits to `corrupt` before either arm is reached.
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
   * contract, transient — hence lands here. The OTHER permanent class — stored-row
   * CORRUPTION — is #646's `corrupt` bucket below, branched on its typed error
   * before this catch files anything, so the transient-only contract stays true.
   *
   * ONE producer does NOT come through that catch, and this doc would otherwise
   * read as exhaustive: the boot sweep's `recordSweep` (#1041, #1048) pushes
   * `orphan_sweep_no_op` DIRECTLY, when it terminalizes an orphan — child or
   * top-level — and the row read back says the patch did not happen. It belongs here rather than in `corrupt` on the
   * same transient/permanent test the rest of this bucket applies — the only way
   * to reach it is a read fault swallowed inside `terminalizeInterrupted` (it
   * logs and returns `void`), and a read fault is the transient class. A row that
   * is permanently unreadable throws on the re-read instead and is filed
   * `corrupt`, so the split holds on both sides.
   */
  failed: Array<{ runId: string; reason: string }>;
  /**
   * #646 — runs whose STORED STATE is unreadable: the run ROW itself no longer
   * parses (`run_row_unparseable:` — the lenient scan skipped it), or its
   * `run_events` LOG no longer replays (`run_log_unparseable:` — the typed
   * `RunLogUnparseableError` from `loadEngineEvents`). PERMANENT (the #515
   * classification: stored bytes parse the same way on every boot), so filing
   * these under `failed` would break its transient-only contract and re-`failed`
   * the run on every boot forever — the exact misfiling this bucket closes.
   *
   * The run is deliberately left AS-IS, not terminalized: a terminal fact minted
   * from an unreadable log would be manufactured, not derived (#443 — the log is
   * authoritative, and here it cannot even be read; for a corrupt ROW there is
   * not even a `Run` to append against), and it would foreclose repair-then-
   * resume. The CONSCIOUS COST: unlike #508's `doc_unresolvable` terminalize,
   * an unreadable run left `running` keeps occupying its trigger/pipeline
   * concurrency slot (`ACTIVE_RUN_STATUSES`) until an operator repairs or
   * deletes the row — corruption needs attention, and a silently freed slot
   * would hide it. This bucket in the boot log IS that attention signal.
   */
  corrupt: Array<{ runId: string; reason: string }>;
  /**
   * Runs terminalized by the boot sweep because they NEVER STARTED (no
   * `run.started` in the log) and nothing could ever drive them. TWO producers,
   * and — following the `interrupted` bucket above — they are not the same story:
   *   - #1041, a `call_pipeline` CHILD: non-null `parentRunId`, an EMPTY log, and
   *     a parent already at a terminal ROW status, so no `startChild` can be
   *     re-emitted; and
   *   - #1048, a TOP-LEVEL row (`parentRunId === null`): stranded by a crash
   *     between `createRun`/`admitQueuedRun` and its drive.
   * See `sweepPendingRuns` for how each arises and why its predicate is what it is.
   *
   * A SEPARATE bucket rather than a fourth producer of `interrupted`, because
   * that bucket's contract is not just its count: its docblock rests on
   * `run.interrupted.reason` telling an operator WHICH producer fired.
   *
   * #1048 NARROWED the second half of that argument, which used to read "a swept
   * orphan has no `run.interrupted` event to carry a reason … the bucket name IS
   * the reason here". That is no longer true of every member: a top-level orphan
   * whose log holds `run.triggerContext` alone is non-empty, so
   * `terminalizeInterrupted` appends a real `run.interrupted{reason:
   * 'never_started'}` for it. The bucket still earns its separateness on the
   * FIRST half — an id filed under `interrupted` whose reason an operator cannot
   * read is worse than one filed under a bucket whose name states it — but the
   * reason is now readable for some members and absent for others, and a reader
   * must not assume either.
   */
  sweptOrphans: string[];
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
 * A run parked on a DURABLE node alarm: at least one node is `wait_pending` (#4 A6)
 * or `external_wait_pending` (#4 A13). BOTH are entered by an event appended AFTER
 * the alarm/row arm, so a parked node always has a live alarm and needs no boot
 * re-arm — the same disposition, and the same reason to catch it here rather than
 * let it fall through the finalize path (a spurious `run.resumed` + a `finalized`
 * misreport of a still-running parked run). Deliberately NOT the reducer's
 * `awaitsExternalEvent`, which is a SUPERSET (it also matches
 * `ready`/`dispatched`/`waiting`/`retry_pending`) — the caller must match the parked
 * statuses EXCLUSIVELY, so a run with a still-live `ready` node is resumed normally
 * rather than misreported `held`.
 */
function hasDurableParkNode(state: RunState): boolean {
  return Object.values(state.nodes).some(
    (n) => n.status === 'wait_pending' || n.status === 'external_wait_pending',
  );
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
    // #2 L7 — no `retryAfterSeconds` here: the provider hint lives on the durable
    // `node.failed` event, not in `RunState`, so a crash-before-arm re-arm can't
    // recover it and falls back to `policy.retryIntervalSeconds`. Benign: `find`
    // matches on IDENTITY (`dueAt` is not in the dedupe key), so a healthy hold is
    // still recognised; only the rare re-armed alarm's timing reverts to policy.
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

/** An all-empty report — one per boot scan, or one per S7 lease reclaim. */
export function emptyReconcileReport(): ReconcileReport {
  return {
    resumed: [],
    interrupted: [],
    deferred: [],
    resynced: [],
    finalized: [],
    held: [],
    rearmed: [],
    failed: [],
    corrupt: [],
    sweptOrphans: [],
  };
}

/**
 * The `run_row_unparseable` skip handler BOTH boot scans hand to
 * `listParsedRuns`. Shared rather than written twice: the two scans differ only
 * in which rows they select, and a lenient-parse policy that drifts between them
 * is a policy in name only.
 *
 * Truncated like `RunLogUnparseableError`'s message: a raw ZodError message is
 * its full issues JSON, and this reason is logged in the boot report.
 */
function reportUnparseableRow(report: ReconcileReport): (id: string, err: unknown) => void {
  return (id, err) => {
    report.corrupt.push({ runId: id, reason: unparseableRowReason(err) });
  };
}

/**
 * The `corrupt` reason for a row that will not parse. Shared by all three
 * reporters of one — the two scans' skip handler, `sweepOne`'s parent read (it
 * sits outside any lenient scan) and the fault boundary — so the boot report
 * spells the same fault the same way wherever it was noticed.
 */
function unparseableRowReason(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `run_row_unparseable:${detail.length > 200 ? `${detail.slice(0, 200)}…` : detail}`;
}

/**
 * #479 — the per-run fault boundary, plus the drive lock. ONE implementation
 * shared by both boot scans (`running` reconcile and #1041's orphan sweep):
 * they are the same policy applied to different row sets, and a second copy is
 * a second place for the `ReconcileInvariantError` re-throw or the
 * permanent-vs-transient split to rot.
 *
 * Boot reconcile IS the recovery path, so it is the worst place for an
 * all-or-nothing failure mode: without this, ONE run whose reconcile threw
 * (originally an unresolvable version — now that permanent case is terminalized
 * by #508 before it reaches here, but a transient DB fault or an executor throw
 * from `pump` still can) threw out of the whole function and every run after it
 * in the scan was never resumed, interrupted, or re-synced.
 *
 * Wraps the WHOLE unit of work, not just the `resolveDoc` call that motivated
 * the ticket: the property wanted is "a fault degrades THAT run", and a catch
 * around one known throw site leaves every other one able to strand the loop.
 * The cost of the breadth — that it could mask a genuine bug — is paid by the
 * sentinel re-throw plus `failed` carrying the reason into the boot log.
 *
 * Partial side effects are survivable and were checked, not assumed: a throw
 * from `pump` AFTER its events are appended leaves exactly the durable state it
 * leaves today, because the append and the sync are separate statements either
 * way. Today that ALSO crashes boot. The log is the SSOT and the projection is
 * re-derived on the next boot, so catching is strictly better.
 *
 * `work` is AWAITED inside the try — an unawaited async call would reject
 * OUTSIDE this catch and crash boot as an unhandled rejection, reinstating the
 * exact fault #479 closes.
 */
async function underFaultBoundary(
  deps: ReconcileDeps,
  report: ReconcileReport,
  runId: string,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await (deps.drives === undefined ? work() : deps.drives.serialize(runId, work));
  } catch (err) {
    if (err instanceof ReconcileInvariantError) throw err;
    // #646 — a corrupt LOG is permanent, not transient: file it under `corrupt`
    // (see that bucket's doc), never `failed`, so it does not masquerade as a
    // fault the next boot could clear.
    if (err instanceof RunLogUnparseableError) {
      report.corrupt.push({ runId, reason: `run_log_unparseable:${err.message}` });
      return;
    }
    // The same permanence argument for a corrupt ROW. The scans parse their own
    // rows leniently, so this catches the ones read AFTER the scan — #1041's
    // sweep re-reads the child it just patched, and a row corrupted in that
    // window (or by anything else this boundary wraps) is repair-needing state,
    // not a fault the next boot clears. Everything left is transient by
    // elimination, which is what `failed` promises.
    if (isDeterministicRowCorruption(err)) {
      report.corrupt.push({ runId, reason: unparseableRowReason(err) });
      return;
    }
    report.failed.push({ runId, reason: err instanceof Error ? err.message : String(err) });
  }
}

export async function reconcileOnBoot(deps: ReconcileDeps): Promise<ReconcileReport> {
  const report = emptyReconcileReport();

  // #5 S3 (#619) — `status: 'running'` ONLY, and now DELIBERATELY so: a genuinely
  // PARKED run has status `waiting` (the `run.waiting` producer ran during its
  // drive), and its liveness is its durable NODE alarm — armed BEFORE the park, so
  // always live — which the alarm clock's boot tick fires INDEPENDENTLY of this
  // scan, un-parking it back to `running` and driving it. So a `waiting` run needs
  // no reconcile scan; scanning it would append a redundant `run.resumed`. The one
  // parked-run case that DOES land here is the CRASH-GAP: a crash between the
  // `timer.waitScheduled`/`externalWait.created` fold and the `parkRun` →
  // `run.waiting` append leaves the row `running` with a `wait_pending`/
  // `external_wait_pending` node and no `run.waiting` in the log — caught by the
  // held-park branch in `reconcileOne`, left for its (live) alarm.
  // #646 — the scan is LENIENT per row: `listRuns`'s whole-list parse sits ABOVE
  // the #479 per-run catch, so one corrupt `running` row (invalid stored JSON in
  // `params`/`trigger_context`, or a shape `RunSchema` rejects) aborted SERVER
  // BOOT at `index.ts`'s unguarded await — killing recovery for every run, with
  // the poison row visible nowhere (the strict list routes throw too). A skipped
  // row is reported in `corrupt`, the needs-attention channel.
  for (const run of listParsedRuns(deps.db, { status: 'running' }, reportUnparseableRow(report))) {
    await underFaultBoundary(deps, report, run.id, () => reconcileOne(deps, report, run));
  }

  // AFTER the `running` loop, and the order is load-bearing in both directions.
  // A parent this very boot terminalized (`interrupted`/`resynced`/`finalized`)
  // makes its orphaned child eligible in the SAME boot rather than the next one;
  // and a parent whose LOG was terminal while its row still said `running` has
  // by now been resynced, so the row predicate below reads the repaired truth.
  // It must also stay BEFORE `index.ts`'s `recoverQueued`: the sweep frees
  // per-pipeline admission slots and publishes no event, so nothing else would
  // turn them into admissions until the next boot.
  await sweepPendingRuns(deps, report);

  return report;
}

/**
 * #1041 — terminalize `call_pipeline` child rows that nothing can ever drive.
 *
 * HOW THEY ARISE. `ensure` creates the child `runs` row (`child.ts`) BEFORE the
 * executor yields `call.started` — the arm-before-append handshake, so the log
 * can never name a child that does not exist. If the parent then reaches a
 * terminal fact on ANOTHER branch before that yield is folded, the pump's
 * teardown resolves the queued event `dropped` and breaks the stream: the
 * announcement is never appended and `kick` never runs. A crash between
 * `createRun` and the append lands in the same place. What is left is a row with
 * a non-null `parentRunId`, the `pending` default, an empty log, and a terminal
 * parent that will never re-emit `startChild`.
 *
 * WHY IT IS NOT MERELY UNTIDY. `ACTIVE_RUN_STATUSES` includes `pending`
 * (`repo/runs.ts`), so `countActiveRunsForPipeline` — the per-pipeline half of
 * S6b admission, which its own docblock says covers "a trigger-less
 * `call_pipeline` child" — counts every orphan forever. The leak is monotonic:
 * enough of them and the CHILD pipeline can never be admitted again, with
 * nothing on any surface saying why. (It does NOT leak a trigger slot;
 * `countActiveRunsForTrigger` keys on `triggerId`, which is null for a child.)
 *
 * WHY THE PARENT'S ROW STATUS, when #443 makes the LOG authoritative. It is not
 * a departure from that rule. Exactly two writers put a terminal status on a run
 * row: `syncRunLifecycle`, always from a log fact or a projection of one, and
 * `terminalizeInterrupted`'s `patchRow`, which fires ONLY on an empty log — and
 * a run with an empty log never spawned a child. So for any run that HAS
 * children, row-terminal and log-terminal are the same answer, and one `getRun`
 * beats loading a whole log to re-derive it. The one asymmetric case (log
 * terminal, row still `running`) is repaired by the `running` scan that runs
 * before this one.
 *
 * #1053 added a SECOND reader of "is the parent over" that deliberately reads the
 * LOG instead. Not a contradiction and not drift — the argument is in
 * `parentIsOver`'s docblock, which owns it; the short version is that the last
 * sentence above is this sweep's whole licence for the cheap read, and that
 * licence is not available inside the `running` scan.
 *
 * WHY NO EVENT IS APPENDED. `terminalizeInterrupted`'s no-events branch patches
 * the row and appends nothing, and that is the right primitive here rather than
 * a near-copy of `interruptRun`: a run that never started has no
 * event-sourced lifecycle to preserve, and minting a terminal fact into a log
 * that never held one is manufacturing, not deriving (#443). The `run.interrupted`
 * that `interruptRun` DOES append is for a run that had already
 * started. The report bucket is this sweep's channel instead. A second reason
 * not to append: a terminal event publishes into `subscribeChildReturns`, which
 * would spawn a `returnToParent` microtask per swept child at boot, each one
 * only to no-op against an already-terminal parent.
 *
 * #1048 WIDENED THIS SWEEP FROM CHILDREN TO EVERY `pending` ROW, and replaced
 * the "empty log" test with "no `run.started` in the log". Both halves matter:
 *
 *   - THE PREDICATE. `startRun` appends `run.triggerContext` BEFORE `run.started`
 *     (#5 S12, `driver.ts`), so the crash window has THREE outcomes, not two: an
 *     empty log, a `run.triggerContext`-only log, and a log with `run.started`.
 *     "Non-empty log" conflates the middle one — a run that never started — with
 *     the last. `hasRunStartedFact` is the honest test, and #443 is why it is
 *     asked of the LOG rather than of `runs.status` (the row is the projection a
 *     crash leaves stale; that staleness IS this defect).
 *   - THE SCOPE. A run whose log HAS `run.started` is not an orphan at all: it is
 *     a crash survivor whose ROW sync was lost, indistinguishable from a
 *     `running` row except in the projection. It is handed to `reconcileOne` —
 *     the `running` scan's own unit — so it resyncs / interrupts / resumes by the
 *     SAME rules. Terminalizing it HERE instead would make the verdict depend on
 *     which sub-tick the crash landed in, which is not a semantics anyone chose.
 *     (#1053 — note precisely what that does and does not say. A started CHILD of
 *     a terminal parent IS now frozen, but by `reconcileOne`'s own guard, which
 *     the `running` scan applies identically. The delegation is what makes that
 *     safe: one unit decides, so the sub-tick cannot.)
 *
 * WHY A TOP-LEVEL ORPHAN NEEDS NO PARENT-EQUIVALENT GUARD. For a child, "nothing
 * can drive this" is proven by the terminal parent. For a top-level row the same
 * property is STRUCTURAL, not merely a fact about boot ordering — every path that
 * drives a top-level run is barred from this one by construction:
 *   - `launch` (`launcher.ts`) and `reseed` mint a FRESH row id and drive that;
 *     they can never name a row already in this scan's snapshot (`listParsedRuns`
 *     materialises its ids before the loop).
 *   - the queue drain drives only what `admitQueuedRun` returns, and that UPDATE
 *     is guarded `where status = 'queued'` — a row this sweep has already
 *     terminalized fails the guard and returns `null`.
 *   - the durable-alarm handler and the external-wait service drive a run that
 *     ARMED an alarm/wait, which only a started run can have done — excluded by
 *     the `run.started` test above.
 *   - a drive genuinely in flight is excluded by the drive lock (see `sweepOne`).
 * Boot ordering (`reconcileOnBoot` is awaited before the launcher, the queue
 * drain and the alarm timer exist) makes this belt-and-braces rather than the
 * argument. That distinction is deliberate: #796 falsified an
 * ordering-only "it is provably the only pump source at boot" claim in this very
 * file, so the guard here is written to survive a reordering.
 *
 * DELIBERATE NON-GOALS, so the next reader does not assume wider cover:
 *   - the CHILD branch keeps #1041's EMPTY-log test rather than adopting
 *     `hasRunStartedFact`. Not an inconsistency: a child is started with no
 *     trigger context (`driver.ts` — "a child `call_pipeline` run passes none"),
 *     so a `run.triggerContext`-only log is unreachable for one and the two
 *     predicates coincide. The narrower test is kept because it is the one #1041
 *     proved safe against a concurrent `kick`.
 *   - a child whose parent ROW is missing entirely: left alone. An absent parent
 *     is unreadable state, not a terminal fact, and #646's posture for
 *     unreadable state is to leave it for attention rather than mint a verdict.
 *   - a boot with NO executor: a started-but-unsynced run routed to
 *     `reconcileOne` lands in `deferred` and stays `pending`, so its slot is
 *     freed on the next executor-bearing boot rather than this one.
 */
async function sweepPendingRuns(deps: ReconcileDeps, report: ReconcileReport): Promise<void> {
  for (const run of listParsedRuns(deps.db, { status: 'pending' }, reportUnparseableRow(report))) {
    await underFaultBoundary(deps, report, run.id, () => sweepOne(deps, report, run));
  }
}

/**
 * One orphan candidate, decided and terminalized UNDER the child's drive lock.
 *
 * The lock is what makes this safe against a concurrent `kick` — `child.ts`
 * takes the same lock to decide whether to start a child, and the boot scan
 * above can resume a parent that then drives and spawns children while this
 * sweep is walking its (already-taken) snapshot. Under the lock, either the kick
 * wins and the log is no longer empty, so this returns without touching it; or
 * this wins and the row goes terminal, which `kick` now re-checks before
 * starting anything (its log-only check could not see a row patch that appends
 * no event).
 */
async function sweepOne(deps: ReconcileDeps, report: ReconcileReport, run: Run): Promise<void> {
  const events = loadEngineEvents(deps.db, run.id);

  // #1048 — the run STARTED; only its row sync was lost. Not an orphan: a crash
  // survivor, and `reconcileOne` is the `running` scan's unit for exactly that.
  // It re-reads the log itself (a second load, accepted: the alternative is
  // widening its signature to take events it would otherwise own, and at this
  // scale one extra read per stranded row is not worth that coupling).
  //
  // A CHILD lands here too, terminal parent or not — and #1053 has since ANSWERED
  // what happens to it, in the one place that could answer it symmetrically.
  // `reconcileOne` now freezes a started child whose parent is over, rather than
  // re-dispatching billable activities whose `returnToParent` would no-op against
  // the dead parent. That guard is the `running` scan's too, so the delegation
  // below is exactly what makes the verdict independent of which sub-tick the
  // crash hit — the property this branch was protecting all along. Nothing to do
  // here: hand the row over and let the shared unit decide.
  if (hasRunStartedFact(events)) {
    await reconcileOne(deps, report, run);
    return;
  }

  // #1048 — a TOP-LEVEL row that never started. No parent exists to key the
  // "nothing will ever drive this" test on, and none is needed: every driver of
  // a top-level run is structurally barred from this row (see `sweepPendingRuns`).
  if (run.parentRunId === null) {
    // `never_started` rather than `terminalizeInterrupted`'s `drive_failed`
    // default — no drive existed to fail. Written only when the log is non-empty
    // (a `run.triggerContext`-only strand); an empty log takes that function's
    // row-patch branch, which appends nothing at all.
    terminalizeInterrupted(deps, run.id, 'never_started');
    recordSweep(deps, report, run.id);
    return;
  }
  const parentRunId = run.parentRunId;

  // #1041's CHILD branch, predicate unchanged. The empty-log test rather than
  // `hasRunStartedFact` above: for a child the two coincide (no trigger context),
  // and this is the one proved safe against a concurrent `kick`.
  if (events.length > 0) return;

  // The PARENT row is arbitrary stored state THIS scan never parsed (it selects
  // `pending`, and an orphaning parent is terminal), so this read must classify
  // a parse failure itself. `getParsedRun` rather than `getRun` + a local catch:
  // the classification it applies is the repo's own, and hand-rolling it here is
  // how the two copies drift.
  //
  // NOT "the only reader of that row", which would be an overclaim: a corrupt
  // row whose `status` column still reads `running` is ALSO picked up by the
  // other boot scan, so one such row can appear twice in `corrupt` — once per
  // scan that met it. Noise in a boot report, not a wrong verdict; both entries
  // name the same id and the same repair. Long-standing, and stated rather than
  // deduped because the two scans deliberately share no state.
  //
  // The report is keyed on the PARENT's id — that is the row an operator has to
  // repair, and the one id the fault boundary below could not supply (it knows
  // only the run being swept). A corrupt parent then returns `null` and takes
  // the same "nothing to act on" exit as an absent one.
  //
  // A NON-corruption fault (a locked DB, a closed connection) deliberately
  // propagates to the fault boundary, which files it under `failed` — transient,
  // and cleared by the next boot's re-read. Bucketing it as `corrupt` here would
  // report a healthy row as needing manual repair.
  const parent = getParsedRun(deps.db, parentRunId, (id, err) => {
    report.corrupt.push({ runId: id, reason: unparseableRowReason(err) });
  });
  if (parent === null || !TERMINAL_RUN_ROW_STATUS.has(parent.status)) return;

  // The reason is INERT on this path and is passed only so both producers read
  // the same: the empty-log guard above has already proven `events.length === 0`,
  // which is exactly the condition sending `terminalizeInterrupted` down its
  // row-patch branch — and that branch appends no event, so there is nowhere for
  // a reason to be recorded. Spelled out because "it passes a reason" otherwise
  // reads as "a reason is written here".
  terminalizeInterrupted(deps, run.id, 'never_started');
  recordSweep(deps, report, run.id);
}

/**
 * Report what the ROW actually says after a sweep, not what was attempted.
 *
 * `terminalizeInterrupted` returns void and SWALLOWS a read fault (it logs and
 * returns), and `ReconcileDeps` deliberately carries no logger — so without this
 * re-read a silent no-op would be reported as a sweep that happened.
 *
 * UNGUARDED, unlike `sweepOne`'s parent read: the run being swept IS the id the
 * fault boundary is keyed on, so it already classifies a throw here correctly and
 * under the right id. Only the parent needed a local reader.
 *
 * Shared by both producers (#1048) rather than duplicated per branch — the
 * verify-then-report step is the same obligation whichever predicate reached it,
 * and the `failed` reason stays one string so a boot log stays greppable.
 */
function recordSweep(deps: ReconcileDeps, report: ReconcileReport, runId: string): void {
  const swept = getRun(deps.db, runId);
  if (swept !== null && TERMINAL_RUN_ROW_STATUS.has(swept.status)) {
    report.sweptOrphans.push(runId);
  } else {
    report.failed.push({ runId, reason: 'orphan_sweep_no_op' });
  }
}

/**
 * Freeze a STARTED run `interrupted`, DOC-FREE — the interrupt is recorded as a
 * durable FACT in the log and the row is synced from `terminalStatusOf` (#443's
 * SSOT for the fact an event records), never from a projection.
 *
 * Two callers, both of which have already PROVEN the log non-terminal via the
 * `terminalFactFromLog` fast path in `reconcileOne`:
 *   - #508, a run whose pipeline version can never be resolved
 *     (`doc_unresolvable:<pvId>`) — doc-free by necessity, the version is gone;
 *   - #1053, a `call_pipeline` child whose parent is already over
 *     (`parent_terminal:<parentRunId>`) — doc-free by choice, since resolving a
 *     doc only to fold nothing would be work for a run that is not going to run.
 *
 * This is the same primitive `terminalizeInterrupted`'s `foldErr → patchRow`
 * branch reaches when a drive's doc turns out unresolvable (`driver.ts`) —
 * inlined here because the call-site precondition is STRONGER: the log is known
 * non-terminal, so this needs none of that function's re-load / terminal
 * re-check / try-to-fold dance (which would only re-call the resolver to have it
 * throw again into its own catch). It deliberately does NOT reuse `recoverHeld`'s
 * `appendAndFold` either: that path HAS an engine and records fold-diagnostics
 * (#497); with no doc there is no fold, and so no diagnostics to record.
 *
 * Takes a `runId` + `reason` rather than a `Run` because the two reasons are
 * derived from DIFFERENT fields (the version id, the parent id) and neither
 * caller wants the other's — passing the row would invite a third caller to
 * derive its reason here instead of at the site that knows why.
 *
 * The reason follows the `interrupted` bucket's `<label>:<detail>` convention
 * (`non_idempotent_in_flight:` / `retry_alarm_spent:`).
 */
function interruptRun(deps: ReconcileDeps, runId: string, reason: string): void {
  const interrupted: EngineEvent = { type: 'run.interrupted', runId, reason };
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
  syncRunLifecycle(deps.db, runId, status);
}

/**
 * #1053 — is this child's result still DELIVERABLE, i.e. is its parent still
 * live? Read from the parent's LOG, and both halves of that are deliberate.
 *
 * WHY THE LOG AND NOT THE ROW. `sweepOne` answers a neighbouring question from
 * `runs.status` and argues for it at length; that argument does NOT transfer
 * here, and the difference is not stylistic:
 *   - The QUESTION is different. `sweepOne` asks "can anything ever DRIVE this
 *     child" — a liveness question, whose answer is that no terminal parent will
 *     re-emit `startChild`. This asks "can anything ever CONSUME its result",
 *     and the consumer is `returnToParent` (`child.ts`), which decides by
 *     `terminalFactFromLog(parentEvents)`. Using the identical expression on the
 *     identical source makes this one reader of one fact, rather than a second
 *     reader that can disagree with the first.
 *   - The PRECONDITION is different. `sweepOne`'s row read is sound because it
 *     runs as a strictly LATER scan, after the `running` scan has repaired every
 *     stale row (see its docblock). This guard runs INSIDE that scan, so a
 *     parent in the same snapshot may still be holding a stale `running` row —
 *     and `listParsedRuns` issues no `ORDER BY`, while run ids are content
 *     hashes rather than anything chronological. A row read would therefore make
 *     the child's verdict depend on an order SQLite explicitly does not promise.
 *     It would fail SAFE (a missed freeze is today's resume), but "correct only
 *     for orderings we happened to observe" is not a property worth shipping.
 *   The extra cost is one log load per CHILD run in the scan — top-level runs
 *   never reach here — on a boot path. Cheap enough not to trade the above for.
 *
 * AN UNREADABLE parent log is NOT terminal (#646): it is unreadable state, and
 * minting a terminal verdict for the child from it would freeze a run on an
 * undecidable premise. Reported `corrupt` and keyed on the PARENT — the row an
 * operator has to repair — because the fault boundary would key it on the child
 * it wraps, exactly the correction `sweepOne` makes for a corrupt parent row.
 * An ABSENT parent reads as an empty log, hence non-terminal, hence left alone:
 * the same posture, and the same one `sweepPendingRuns` states as a non-goal.
 *
 * That report is NOT deduped, so one corrupt parent can appear in `corrupt` more
 * than once in a single scan: once per `running` CHILD of it that gets this far,
 * plus once more if the parent's own row is `running` and the scan visits it
 * directly (its `loadEngineEvents` throws into the fault boundary, which files
 * the same reason). Noise in a boot report, not a wrong verdict — every entry
 * names the same id and the same repair. Stated rather than deduped for the
 * reason `sweepOne` gives about its cross-scan twin: the dedupe would have to be
 * report-wide state shared by readers that deliberately share none.
 *
 * A NON-corruption fault (a locked DB) propagates to the fault boundary, which
 * files it `failed` — transient, cleared by the next boot's re-read.
 */
function parentIsOver(deps: ReconcileDeps, report: ReconcileReport, parentRunId: string): boolean {
  let parentEvents: EngineEvent[];
  try {
    parentEvents = loadEngineEvents(deps.db, parentRunId);
  } catch (err) {
    if (err instanceof RunLogUnparseableError) {
      report.corrupt.push({ runId: parentRunId, reason: `run_log_unparseable:${err.message}` });
      return false;
    }
    throw err;
  }
  return terminalFactFromLog(parentEvents) !== null;
}

/**
 * One run's reconcile — the unit #479's fault boundary wraps. Extracted from the
 * loop so that boundary is a `try` around a call rather than a `try` wrapping
 * 130 lines; each of the loop body's `continue`s is a `return` here.
 *
 * Throws on any per-run fault; the caller records it into `report.failed` and
 * carries on with the next run. Its OWN invariant violations throw
 * `ReconcileInvariantError`, which the caller re-throws — see that class.
 *
 * EXPORTED at #5 S7: this is the "boot-reconcile formalization" — the
 * per-activity idempotency policy is ONE function with two sanctioned entry
 * points (see the lock contract in the module header), not a boot loop plus a
 * re-implementation. The lease reclaim (`scheduler/lease.ts`) calls it under
 * the drive lock with a fresh `emptyReconcileReport()` and reads the verdict
 * from the buckets.
 */
export async function reconcileOne(
  deps: ReconcileDeps,
  report: ReconcileReport,
  run: Run,
  /** WHICH sanctioned mechanism is reconciling — recorded on the `run.resumed`
   * + `node.retryRequested` facts so the log says who resumed it. */
  reason: 'boot_reconcile' | 'lease_reclaim' = 'boot_reconcile',
): Promise<void> {
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

  // #1053 — a `call_pipeline` CHILD whose PARENT is already over. Freeze it
  // rather than resume it: nothing can consume the result, so every activity a
  // resume would dispatch is pure cost.
  //
  // WHY THIS IS NOT "reconcile must reproduce the no-crash outcome". Absent a
  // crash this child would run to completion and its result would be discarded
  // by `returnToParent` all the same — there is no cancel primitive crossing a
  // run boundary (`kick` is detached on the CHILD's own drive lock, the only
  // `AbortController` is per-activity/per-run, and `cancelled` is not a legal
  // `RunStatus`). So this DOES diverge from the live path, deliberately, and the
  // reason it is still right is that the two acts are not the same act: the live
  // case is failing to STOP a spend already in flight, which needs a primitive
  // that does not exist; this is DECLINING TO START one, on work already known
  // undeliverable, which is precisely reconcile's job. The same trade is already
  // made twice in this function — `non_idempotent_in_flight` freezes a run that
  // would otherwise have completed, and `retry_alarm_spent` freezes one nothing
  // can advance — so "the reconciler may reach a different outcome than an
  // uncrashed run" is settled policy here, not a new licence.
  //
  // THE COST, NAMED. A child's nodes may have side effects that are meaningful
  // in themselves and not only via the value returned to the parent. Those now
  // do not happen when a crash lands in this window, where absent the crash they
  // would have. That is a real inconsistency and it is accepted rather than
  // hidden: the alternative is to keep paying for every one of them on the
  // strength of the minority that is independently useful, and an operator can
  // see exactly which runs were frozen and why (`parent_terminal:<id>` in the
  // log, `report.interrupted` in the boot log). Making the LIVE path stop too is
  // the other half of this and needs a cancel primitive — #1056, filed not built.
  //
  // POSITION. Below the terminal-fact check above, so a child that already
  // FINISHED resyncs instead of having a second terminal fact minted over its
  // first (#443). Above `resolveDoc`, so a frozen child needs no doc — it works
  // when the version is gone, arms no alarm and re-dispatches no node.
  // Precedented: `interruptRun`'s other caller also sits above the `pending`
  // resync branch below.
  //
  // Being above `resolveDoc` also fixes a PRECEDENCE: a child whose parent is
  // over AND whose own version is gone is frozen `parent_terminal:` rather than
  // `doc_unresolvable:`. Both are truthful, and the order is the useful one —
  // the parent's death is why this run should not run, whereas the missing
  // version is only why it could not.
  //
  // BOTH BOOT PATHS, which #1048 requires: `sweepOne` delegates every started
  // `pending` row here, so a started child reaches this guard whichever sub-tick
  // the crash hit. Its own never-started branch stays as it is, and the two
  // verdicts agree — differing only in whether a terminal FACT is appended,
  // which #443 decides from whether the run started.
  //
  // A THIRD caller is affected and it is not a boot path at all: S7's lease
  // reclaim (`scheduler/lease.ts`) runs this same function on a live server.
  // That composes without special-casing — it already reads `report.interrupted`
  // as "terminal, nothing further needed", and `syncRunLifecycle` releases the
  // lease on any terminal transition — and it is a GAIN: a child orphaned by a
  // parent that died mid-flight is now frozen at reclaim instead of resumed by
  // whichever worker picks it up.
  //
  // The `run.interrupted` append publishes into `subscribeChildReturns`, which
  // spawns a `returnToParent` microtask that no-ops against the (by definition
  // terminal) parent. #1041 cites that cost as one reason NOT to append for a
  // NEVER-started child; here #443 requires the fact, and the no-op is identical
  // to the one every other `interrupted` verdict for a child already produces.
  // WHY `hasRunStartedFact` IS PART OF THE CONDITION and not assumed from the
  // caller. Every `running`-status row reaches this function unconditionally —
  // the started test lives in `sweepOne`, which guards the `pending` rows only.
  // So a CORRUPTED row (status `running`, log with no `run.started`; documented
  // as unreachable via the real callers at the `pending` branch below) would
  // otherwise be given a `run.interrupted` here, which is precisely the
  // "minting a terminal fact into a log that never held one is manufacturing,
  // not deriving" that #443 forbids and that #1041 cites as its reason for
  // patching the row instead.
  //
  // Excluded, such a child falls through to the `pending` resync below and is
  // then met by `sweepPendingRuns` in the SAME boot, whose child branch patches
  // the row and appends nothing — the correct primitive for a run with no
  // event-sourced lifecycle to preserve. So the two paths now partition the case
  // exactly along #443's own line: STARTED gets a durable fact, NEVER-STARTED
  // gets a row patch, and neither manufactures. (That run legitimately appears
  // in `resynced` AND `sweptOrphans`; see the `pending` branch, which already
  // documents that pair.)
  if (
    run.parentRunId !== null &&
    hasRunStartedFact(events) &&
    parentIsOver(deps, report, run.parentRunId)
  ) {
    interruptRun(deps, run.id, `parent_terminal:${run.parentRunId}`);
    report.interrupted.push(run.id);
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
      interruptRun(deps, run.id, `doc_unresolvable:${run.pipelineVersionId}`);
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
  // #1048 — WHAT HAPPENS NEXT, because this branch now has a successor and the
  // two must not be read as contradicting each other. `sweepPendingRuns` runs
  // AFTER this scan and takes its OWN snapshot, so a row this branch writes back
  // to `pending` is picked up by it, found to hold no `run.started`, and — if it
  // is top-level — terminalized in the SAME boot. That is not this branch being
  // overruled. `pending` is the truthful answer to "what does the log project
  // to"; `interrupted` is the truthful answer to "can anything ever drive this",
  // a different question and the one the admission-slot leak turns on. Such a run
  // therefore appears in `resynced` AND in `sweptOrphans` — the one documented
  // case of a single run reaching two verdict buckets in one report. Reachable
  // ONLY through this branch, which the paragraph above marks unreachable via
  // the real callers: it needs a row already at `running` with no `run.started`.
  // So it is a corrupted-row scenario, not a live-traffic one, and the exclusivity
  // rules on `ReconcileReport` should be read with that scope.
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
    { type: 'run.resumed', runId: run.id, reason },
    ...inFlight.map(({ id, attemptId }): EngineEvent => ({
      type: 'node.retryRequested',
      runId: run.id,
      nodeId: id,
      previousAttemptId: attemptId,
      reason,
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

  // A run PARKED on a durable node alarm — a `wait` (#4 A6, `wait_pending`) or a
  // `webhook` (#4 A13, `external_wait_pending`) — re-emits NO dispatch above:
  // `onResumed` skips both parked statuses (like `retry_pending`), and `settle`
  // cannot finish a run whose node is non-terminal. UNLIKE a retry hold it needs NO
  // re-arm: the alarm was armed BEFORE the event that parked the node, so it always
  // has a live row and the clock's boot tick fires it. But it must be caught HERE,
  // not left to fall through: the finalize path below would append a spurious
  // `run.resumed` and MISreport a still-parked run. Report it `held` — alive on a
  // durable node alarm, nothing to EXECUTE — and stop, leaving its row untouched.
  //
  // #5 S3 (#619) — its resume now `settle`s to a lone `parkRun` (the `run.waiting`
  // producer), a DRIVER-OWN command that executes nothing. So exclude it before the
  // "nothing to do" test: a run whose only "work" is to RE-record its park has no
  // executable command and is left for its alarm, exactly as before the producer.
  // (A genuinely parked run's row is `waiting` and is not scanned at all — see the
  // scan comment; this catches only the CRASH-GAP run whose row is still `running`
  // because its `run.waiting` append was lost. Its alarm folds the resolving event
  // against the `running` projection and drives it, no re-park needed.) A parked
  // node AND a ready sibling still has a `dispatchNode` in `liveCommands`, so it
  // resumes normally and re-parks only once the sibling settles.
  const liveCommands = commands.filter((c) => c.type !== 'parkRun');
  if (liveCommands.length === 0 && hasDurableParkNode(next)) {
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
  // Over `liveCommands` (parkRun already filtered): a `parkRun` is driver-own like
  // `finishRun`, so it never NEEDS an executor. It cannot actually reach here — a
  // lone `parkRun` short-circuits at the held-park branch above, and it never
  // co-occurs with a `dispatchNode` (a park requires nothing in flight) — but
  // filtering it keeps that invariant locally obvious rather than load-bearing.
  const needsExecutor = liveCommands.some((c) => c.type !== 'finishRun');
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
      signExternalWaitToken: deps.signExternalWaitToken,
    },
    engine,
    next,
    commands,
  );
  (needsExecutor ? report.resumed : report.finalized).push(run.id);
}
