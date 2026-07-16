import {
  createEngine,
  resolveRunParams,
  DEFAULT_RETRY_INTERVAL_SECONDS,
  type ArmWakeupInput,
  type Engine,
  type EngineCommand,
  type EngineEvent,
  type PipelineVersion,
  type Run,
  type RunLifecycleStatus,
  type RunState,
  type ScheduledWakeup,
} from '@autonomy-studio/shared';
import { getRun, updateRun } from '../repo/runs.js';
import type { Db } from '../repo/types.js';
import type { RunDrives } from './drives.js';
import type { RunEventBus } from './event-bus.js';
import { appendEngineEvent, loadEngineEvents, terminalFactFromLog } from './events.js';

/**
 * P2d — the run DRIVER: the one impure boundary that turns the pure reducer's
 * COMMANDS into durable side effects and folds the resulting EVENTS back. The
 * engine (`@autonomy-studio/shared`) has no I/O; the driver owns the DB writes
 * and the executor hand-off, so the reducer stays replayable.
 *
 * The loop (per the P2 spec's "commands out, state changes only on events"):
 *   1. the reducer emits commands (`dispatchNode` / `startChild` / `finishRun`);
 *   2. the driver PERFORMS each command, producing durable event(s);
 *   3. each event is APPENDED to `run_events` and then FOLDED — only the fold
 *      changes state — yielding the next batch of commands;
 *   4. repeat until the queue drains or the run reaches a terminal fact.
 * A crash between "command emitted" and "event appended" simply re-emits the
 * command on the next replay (boot reconcile), so no work is lost or doubled.
 *
 * The EXECUTOR (which actually runs an activity via its connector) is injected:
 * P2 tests pass a synchronous STUB; P3 supplies the real `p-limit` worker pool.
 * The driver owns nothing connector-specific — it only sequences reduce↔persist.
 */

/** Resolve a run's immutable pipeline version (its graph + declared params). */
export type DocResolver = (pipelineVersionId: string) => PipelineVersion;

/** The commands an executor performs — `finishRun` is handled by the driver. */
export type ExecutorCommand = Extract<EngineCommand, { type: 'dispatchNode' | 'startChild' }>;

/**
 * Performs a single reducer command, YIELDING the durable events it produces,
 * IN ORDER, as an async stream. For a `dispatchNode` the executor yields
 * `node.dispatched{idempotent}` then a terminal `node.succeeded`/`node.failed`;
 * for a `startChild` it yields a `call.returned`. The driver appends+folds each
 * event AS IT ARRIVES — the executor never touches the DB or state itself.
 *
 * CRASH-SAFETY CONTRACT (load-bearing for the boot reconciler) — and why the
 * return type is a STREAM, not a batch: `node.dispatched{idempotent}` MUST
 * become durable BEFORE the activity's side effect begins. The reconciler
 * recovers a `dispatched` node by its PERSISTED idempotent flag (re-run if
 * idempotent, else freeze the run), but a node left `ready` — the reducer
 * decided a dispatch whose `node.dispatched` never persisted — is re-dispatched
 * blindly, on the premise the side effect never started. That premise holds
 * ONLY if `node.dispatched` is durable first.
 *
 * The `AsyncIterable` return STRUCTURALLY enforces this: the driver's
 * `for await` pulls `node.dispatched`, appends+folds it (durable), and only
 * THEN requests the next event — at which point an async-generator executor
 * resumes past its `yield node.dispatched` and runs the side effect. A crash
 * after a billed LLM call / spawned subprocess but before the terminal event
 * therefore always leaves the node `dispatched` (caught by the idempotent
 * gate), never `ready`. A batch return (`[node.dispatched, terminal]` at once,
 * as the P2 stub did — sound only because it had no real side effect) could not
 * make that ordering guarantee. The executor maps every operational failure to
 * a terminal `node.failed`/`call.returned{failure}` event and must not throw
 * for expected errors; a thrown bug still leaves `node.dispatched` durable.
 */
export interface Executor {
  perform(command: ExecutorCommand, runId: string): AsyncIterable<EngineEvent>;
}

/**
 * The alarm seam the driver needs to perform a `scheduleRetry` (F2c), and that
 * the boot reconciler needs to tell a healthy HOLD from a stranded one.
 *
 * Structurally satisfied by #5 S1's `AlarmClock.arm` + the wakeup repo's
 * `getWakeupByKey`, but declared HERE rather than imported from
 * `scheduler/alarms.ts` for two reasons: that module already imports
 * `run/event-bus.js` (so importing it back would close a cycle), and the driver
 * genuinely needs only these two methods — a narrow seam keeps the retry alarm
 * testable with a small stub.
 *
 * `find` and `arm` MUST be backed by the SAME store. That is not a nicety: the
 * reconciler's whole B2 check is "arm wrote nothing, therefore re-arm", so a
 * `find` that reads a different store than `arm` writes would report every held
 * run stranded — and a test whose stub split them would pass against a broken
 * reconciler. Pairing them on one interface is what makes that impossible to
 * wire wrong.
 */
export interface RetryAlarms {
  /** Idempotent by `(kind, dedupeKey)`: a replayed arm returns the EXISTING row. */
  arm(input: ArmWakeupInput): ScheduledWakeup;
  /**
   * The row `arm(input)` would return, or `null` if none is armed. Keyed by the
   * SAME derived `(kind, dedupeKey)` as `arm`, from the same input — never a
   * hand-spelled key — so the two cannot disagree about identity.
   *
   * Returns the row WHATEVER its status: a spent (`fired`/`suppressed`/
   * `cancelled`) row is not a live alarm, and `arm` will not replace it, so the
   * caller must be able to see the difference. Collapsing that to a boolean here
   * would hide the one case that is neither healthy nor re-armable.
   */
  find(input: ArmWakeupInput): ScheduledWakeup | null;
}

/**
 * The `kind` under which a node's retry alarm is armed. Matches the handler
 * registered in `scheduler/retry-alarm.ts` — the clock refuses to arm a kind
 * with no handler, so these two cannot silently drift apart.
 */
export const RETRY_WAKEUP_KIND = 'node_retry';

export interface DriverDeps {
  db: Db;
  resolveDoc: DocResolver;
  executor: Executor;
  /**
   * F2c — the durable-alarm seam. REQUIRED, not optional, and deliberately so:
   * the reducer can emit `scheduleRetry` for any doc that sets `policy.retry`,
   * and a driver that cannot serve it would leave the node `retry_pending`
   * forever with NO recovery path (§A.5 — a held run's only recovery IS its
   * alarm row). Making it required moves that from a runtime hang to a compile
   * error at every construction site.
   */
  alarms: RetryAlarms;
  /** P6 — the live-monitor bus. When present, every event this driver appends is
   * published to it (after the durable append) so a watching WS client tails the
   * run in real time. Optional: P2/P3 driver tests run without a bus unchanged. */
  bus?: RunEventBus;
  /** Clock seam (epoch ms) for a retry's `dueAt`; defaults to the wall clock,
   * mirroring `AlarmClockDeps.now`. The REDUCER never reads a clock — this is
   * the impure half of D4's split, and the time it produces is STORED. */
  now?: () => number;
}

/** Run-lifecycle statuses that are terminal (the run stops advancing). */
const TERMINAL_RUN: ReadonlySet<RunLifecycleStatus> = new Set<RunLifecycleStatus>([
  'success',
  'failure',
  'interrupted',
]);

/**
 * A belt-and-suspenders bound on driver iterations. The reducer already
 * GUARANTEES termination (every back-edge/container has a bounce/round cap, and
 * `validateDoc` requires them), so a validated doc can never reach this. It
 * exists only so an unforeseen reducer bug fails a run SAFELY (a `capped`
 * terminal) instead of spinning this loop forever in a headless server.
 */
const MAX_DRIVER_STEPS = 1_000_000;

/** Build the pure engine for a run from its immutable pipeline version's graph. */
export function buildEngine(pv: PipelineVersion): Engine {
  return createEngine({ nodes: pv.nodes, edges: pv.edges, containers: pv.containers });
}

/**
 * Sync the DB run's lifecycle status/finishedAt to `status`. Only touches `runs`
 * when something actually changed (idempotent); `finishedAt` is stamped ONCE, the
 * first time the run reaches a terminal status, and never moved.
 * `RunLifecycleStatus` is a subset of the DB's `RunStatus`, so the mapping is
 * identity.
 *
 * Takes the STATUS, not a `RunState`: a row's lifecycle is not always sourced
 * from a projection. #443 makes the run's LOG authoritative over the projection
 * for terminality, so the reconciler syncs a finished row straight from the log's
 * `run.finished` without folding at all — passing a whole `RunState` here would
 * imply a projection is required, which is exactly the coupling #443 removes.
 * Every caller only ever had `state.status` to give.
 */
export function syncRunLifecycle(db: Db, runId: string, status: RunLifecycleStatus): void {
  const existing = getRun(db, runId);
  if (existing === null) return;
  const finishedAt = TERMINAL_RUN.has(status)
    ? (existing.finishedAt ?? Date.now())
    : existing.finishedAt;
  if (existing.status === status && existing.finishedAt === finishedAt) return;
  updateRun(db, runId, { status, finishedAt });
}

/**
 * The `ArmWakeupInput` for a node's retry alarm — the SSOT for that alarm's
 * IDENTITY, shared by the two callers that must agree on it: `armRetry` (which
 * arms it) and the boot reconciler (which asks whether it exists). A second
 * hand-rolled copy of this shape in the reconciler would make the B2 check
 * silently vacuous the first time either drifted — it would look up a key nothing
 * ever armed, find nothing, and re-arm a healthy hold on every boot.
 *
 * `dueAt` is `now + the node's retryIntervalSeconds`, read from the run's
 * IMMUTABLE bound version — the same doc the reducer read when it decided
 * eligibility, so the two cannot disagree and a replay reads the identical value.
 */
export function retryArmInput(
  deps: Pick<DriverDeps, 'resolveDoc' | 'now'>,
  args: { runId: string; pipelineVersionId: string; nodeId: string; failedAttemptId: string },
): ArmWakeupInput {
  const now = deps.now ?? (() => Date.now());
  const doc = deps.resolveDoc(args.pipelineVersionId);
  const policy = doc.nodes.find((n) => n.id === args.nodeId)?.policy;
  const intervalSeconds = policy?.retryIntervalSeconds ?? DEFAULT_RETRY_INTERVAL_SECONDS;
  return {
    kind: RETRY_WAKEUP_KIND,
    // The per-kind `ref` shape S1 declares for retry. `attemptId` is not
    // decoration: it is the handle the handler's freshness check needs to tell
    // "this alarm is for the attempt still held" from "a stale one".
    ref: { runId: args.runId, nodeId: args.nodeId, attemptId: args.failedAttemptId },
    dueAt: now() + intervalSeconds * 1000,
    // Spec #5's spike headline — "omit the attempt and attempt-2's retry collides
    // with attempt-1's already-`fired` row, so it SILENTLY NEVER ARMS" — is
    // VACUOUS FOR THIS KIND, and saying so is the point of this comment. The
    // dedupe key is `kind:serializeRef(ref):discriminator` and retry's `ref`
    // ALREADY carries `attemptId`, so the two attempts' keys differ whatever the
    // discriminator holds; the collision it is credited with preventing cannot
    // happen here. The spike's finding is real for kinds whose `ref` does NOT
    // carry the occurrence (`round-<r>`, `tick-<epoch>`). Kept — a redundant
    // discriminator costs nothing and S1 requires the field — but credited
    // honestly, because the next author of a kind reads this to decide theirs.
    discriminator: `attempt-${args.failedAttemptId}`,
  };
}

/**
 * Perform a `scheduleRetry` (F2c): ARM the durable alarm, then hand back the
 * `node.retryScheduled` event recording when the retry is due. The impure half
 * of D4's split — the reducer decided ELIGIBLE, this decides WHEN.
 *
 * **The order is the whole design, and it is asymmetric.** Arming first means a
 * crash before the append leaves an armed alarm that still fires, re-dispatches
 * the node, and only loses a log line. The reverse — append, then arm — would on
 * a crash leave a log that PROMISES a retry with no alarm to deliver it, and a
 * node held forever: `onResumed` re-derives nothing for `retry_pending` and the
 * boot reconciler does not select it (§A.5). One order costs observability, the
 * other hangs the run.
 *
 * `nextAttemptAt` is read back from the ARMED ROW rather than the value computed
 * here. `arm` is idempotent by `(kind, dedupeKey)`, so a replayed command returns
 * the ORIGINAL row — logging the row's `dueAt` records the time the alarm will
 * actually fire, where logging the local computation would record a fresh,
 * fictional one. Same reason `run.started.startedAt` is stamped from the run row.
 */
function armRetry(
  deps: DriverDeps,
  state: RunState,
  command: Extract<EngineCommand, { type: 'scheduleRetry' }>,
): EngineEvent {
  const row = deps.alarms.arm(
    retryArmInput(deps, {
      runId: state.runId,
      pipelineVersionId: state.pipelineVersionId,
      nodeId: command.nodeId,
      failedAttemptId: command.failedAttemptId,
    }),
  );

  return {
    type: 'node.retryScheduled',
    runId: state.runId,
    nodeId: command.nodeId,
    attemptId: command.failedAttemptId,
    nextAttemptAt: row.dueAt,
  };
}

/**
 * The reduce↔persist fixpoint. Drains `commands` (and everything they cascade),
 * appending every produced event and folding it. Stops when the queue empties
 * or the run reaches a terminal fact. Returns the final projected state.
 *
 * `finishRun` is the DRIVER's own command (it appends `run.finished` + persists
 * the terminal `runs.status`); `dispatchNode`/`startChild` go to the executor.
 */
export async function pump(
  deps: DriverDeps,
  engine: Engine,
  initialState: RunState,
  commands: EngineCommand[],
): Promise<RunState> {
  let state = initialState;
  const queue: EngineCommand[] = [...commands];
  let steps = 0;

  while (queue.length > 0) {
    if (++steps > MAX_DRIVER_STEPS) {
      // Fail-safe: terminalize rather than hang. See MAX_DRIVER_STEPS.
      const capped: EngineEvent = {
        type: 'run.finished',
        runId: state.runId,
        outcome: 'failure',
        reason: 'capped',
      };
      state = engine.reduce(state, appendEngineEvent(deps.db, capped, deps.bus).event).state;
      syncRunLifecycle(deps.db, state.runId, state.status);
      break;
    }

    const command = queue.shift()!;
    // `finishRun` and `scheduleRetry` are the driver's OWN commands, each a
    // single event (a sync array, which `for await` iterates too).
    // `dispatchNode`/`startChild` go to the executor, which STREAMS its events so
    // `node.dispatched` is folded (durable) before the side effect runs — see the
    // `Executor` contract doc.
    //
    // `scheduleRetry` routes through this same `source` rather than appending on
    // its own: the loop below is what publishes to the P6 bus (so a watching
    // client's raw event feed sees the retry as it is scheduled — note the
    // monitor's per-node summary does not fold it yet), folds the PARSED event,
    // and syncs the row. `armRetry` runs while building the array, which is what
    // keeps the arm strictly BEFORE the append.
    const source: Iterable<EngineEvent> | AsyncIterable<EngineEvent> =
      command.type === 'finishRun'
        ? [
            {
              type: 'run.finished',
              runId: state.runId,
              outcome: command.outcome,
              reason: command.reason,
            },
          ]
        : command.type === 'scheduleRetry'
          ? [armRetry(deps, state, command)]
          : deps.executor.perform(command, state.runId);

    let terminal = false;
    for await (const event of source) {
      // Fold the PARSED event, never the raw input: they differ wherever the
      // schema has a `.default()`, and `node.failed.kind` — the field F2b's
      // retry-eligibility keys off — is exactly that. See `appendEngineEvent`.
      const appended = appendEngineEvent(deps.db, event, deps.bus);
      const result = engine.reduce(state, appended.event);
      state = result.state;
      syncRunLifecycle(deps.db, state.runId, state.status);
      queue.push(...result.commands);
      if (TERMINAL_RUN.has(state.status)) {
        terminal = true;
        break;
      }
    }
    if (terminal) break;
  }

  return state;
}

/**
 * The deps a DRIVE ENTRY POINT needs: the driver boundary plus the per-run lock.
 *
 * Separate from `DriverDeps` because the two answer different questions.
 * `DriverDeps` is "what `pump` needs to perform commands"; this is "what is
 * allowed to START a pump". Only the entry points carry it — the launcher and
 * the retry alarm — which is the list `executor.ts`'s sequential-pump invariant
 * actually depends on. The boot reconciler pumps too and deliberately does NOT
 * carry it; see `reconcile.ts`'s header for why it cannot race.
 */
export interface DriveDeps extends DriverDeps {
  drives: RunDrives;
}

/**
 * F2c — drive a run that is ALREADY underway, from the log, under its lock. The
 * ONE entry point for "something happened out of band; take this run further".
 *
 * Why every line of this is load-bearing (all of it measured, none of it
 * theorised — see the joint spec's B1):
 *
 *  - **The lock.** The alarm clock is a SECOND pump source for a run the
 *    launcher may still be driving. Two `pump`s each hold their own in-memory
 *    `RunState` and never re-read the log, so they diverge permanently and both
 *    write: a shared successor got dispatched TWICE under the same `attemptId` —
 *    a real LLM call billed twice — and the run then hung with no `run.finished`.
 *  - **Re-projecting INSIDE the lock.** Serializing alone does not fix it. A
 *    second drive that waits its turn and then pumps a snapshot taken BEFORE the
 *    wait is just as stale as one that never waited. The lock's only purpose is
 *    to make this `loadEngineEvents` a fixed point nothing can append behind.
 *  - **`engine.resume` rather than the caller's commands.** `projectRunState`
 *    discards commands, so a fresh projection alone would silently drop the
 *    dispatch this drive exists to perform. `resume` re-derives it — and re-derives
 *    it from the CURRENT log, which is exactly why the caller's own commands
 *    (computed against a projection this drive may have moved past) are discarded
 *    rather than passed in.
 *  - **The terminal check.** The LOG decides whether a run is over, never a
 *    re-fold (#443). Two alarms due in one tick both queue a drive here; the
 *    first finishes the run, and this is what stops the second from re-driving a
 *    settled run's nodes.
 */
export async function driveRun(deps: DriveDeps, runId: string): Promise<void> {
  await deps.drives.serialize(runId, async () => {
    const events = loadEngineEvents(deps.db, runId);

    // Hoisted above `resolveDoc` for the reason `reconcile.ts` documents: the log
    // needs no doc, so an unresolvable version cannot strand a finished run.
    const terminal = terminalFactFromLog(events);
    if (terminal !== null) {
      syncRunLifecycle(deps.db, runId, terminal);
      return;
    }

    // Gone (deleted mid-flight): there is nothing to drive and nothing to record.
    // Mirrors the retry handler's own `run_not_found` verdict. Without this the
    // throw would land in the alarm clock's floating `afterCommit` catch and the
    // run would silently never drive — a hang reported as a log line.
    const run = getRun(deps.db, runId);
    if (run === null) return;

    // From the run ROW, not the projection: that is what lets the doc resolve
    // before anything is folded.
    const engine = buildEngine(deps.resolveDoc(run.pipelineVersionId));
    const result = engine.resume(engine.projectRunState(events));
    syncRunLifecycle(deps.db, runId, result.state.status);
    await pump(deps, engine, result.state, result.commands);
  });
}

/**
 * Start a fresh run: resolve its params (secrets stripped), append `run.started`
 * and drive it to quiescence. Refuses a run that already has a log — starting is
 * for a `pending` run; a crashed run is resumed by the boot reconciler instead.
 *
 * NOT self-locking: its caller (`launcher.ts`) wraps this AND its failure
 * cleanup in one `drives.serialize`, so the interrupt append cannot interleave
 * with another drive either. A lock taken here would leave that gap open.
 */
export async function startRun(deps: DriverDeps, run: Run): Promise<RunState> {
  if (loadEngineEvents(deps.db, run.id).length > 0) {
    throw new Error(`run '${run.id}' already has an event log — use the boot reconciler to resume`);
  }
  const pv = deps.resolveDoc(run.pipelineVersionId);
  const resolvedParams = resolveRunParams(pv, run.params);
  const engine = buildEngine(pv);

  const started: EngineEvent = {
    type: 'run.started',
    runId: run.id,
    pipelineVersionId: run.pipelineVersionId,
    // Stamped from the run ROW, not a fresh clock: `runs.started_at` already
    // owns "when did this run start", so reading the clock again here would give
    // one named fact two durable answers that silently disagree — by minutes,
    // once #5's scheduler admits queued runs. Logging it as a fact (rather than
    // letting the reducer read a clock) is what keeps `${run.startedAt}`
    // identical on every replay.
    startedAt: new Date(run.startedAt).toISOString(),
    params: resolvedParams,
  };
  const result = engine.reduce(
    engine.seedState(),
    appendEngineEvent(deps.db, started, deps.bus).event,
  );
  syncRunLifecycle(deps.db, run.id, result.state.status);
  return pump(deps, engine, result.state, result.commands);
}

export { TERMINAL_RUN };
