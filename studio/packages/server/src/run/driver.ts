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
import type { RunEventBus } from './event-bus.js';
import { appendEngineEvent, loadEngineEvents } from './events.js';

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
 * The alarm-arming seam the driver needs to perform a `scheduleRetry` (F2c).
 *
 * Structurally satisfied by #5 S1's `AlarmClock.arm`, but declared HERE rather
 * than imported from `scheduler/alarms.ts` for two reasons: that module already
 * imports `run/event-bus.js` (so importing it back would close a cycle), and the
 * driver genuinely needs only this one method — a narrow seam keeps the retry
 * alarm testable with a three-line stub.
 */
export interface RetryAlarms {
  /** Idempotent by `(kind, dedupeKey)`: a replayed arm returns the EXISTING row. */
  arm(input: ArmWakeupInput): ScheduledWakeup;
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
  const now = deps.now ?? (() => Date.now());
  // The policy comes from the run's IMMUTABLE bound version — the same doc the
  // reducer read when it decided eligibility, so the two cannot disagree, and a
  // replay reads the identical value.
  const doc = deps.resolveDoc(state.pipelineVersionId);
  const policy = doc.nodes.find((n) => n.id === command.nodeId)?.policy;
  const intervalSeconds = policy?.retryIntervalSeconds ?? DEFAULT_RETRY_INTERVAL_SECONDS;

  const row = deps.alarms.arm({
    kind: RETRY_WAKEUP_KIND,
    // The per-kind `ref` shape S1 declares for retry. `attemptId` is not
    // decoration: it is the handle the handler's freshness check needs to tell
    // "this alarm is for the attempt still held" from "a stale one".
    ref: { runId: state.runId, nodeId: command.nodeId, attemptId: command.failedAttemptId },
    dueAt: now() + intervalSeconds * 1000,
    // Spec #5's spike headline: omit the attempt and attempt-2's retry collides
    // with attempt-1's already-`fired` row, so — arming being an idempotent
    // upsert-if-absent — it SILENTLY NEVER ARMS. The spec spells this
    // `attempt-<n>`; the whole attemptId is used instead because it already
    // encodes n (as `nodeId#n`) and needs no parsing back apart. Same
    // discrimination, one less thing to get wrong.
    discriminator: `attempt-${command.failedAttemptId}`,
  });

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
    // client actually SEES the retry — the event's whole purpose), folds the
    // PARSED event, and syncs the row. `armRetry` runs while building the array,
    // which is what keeps the arm strictly BEFORE the append.
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
 * Start a fresh run: resolve its params (secrets stripped), append `run.started`
 * and drive it to quiescence. Refuses a run that already has a log — starting is
 * for a `pending` run; a crashed run is resumed by the boot reconciler instead.
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
