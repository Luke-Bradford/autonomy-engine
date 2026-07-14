import {
  createEngine,
  resolveRunParams,
  type Engine,
  type EngineCommand,
  type EngineEvent,
  type PipelineVersion,
  type Run,
  type RunLifecycleStatus,
  type RunState,
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

export interface DriverDeps {
  db: Db;
  resolveDoc: DocResolver;
  executor: Executor;
  /** P6 — the live-monitor bus. When present, every event this driver appends is
   * published to it (after the durable append) so a watching WS client tails the
   * run in real time. Optional: P2/P3 driver tests run without a bus unchanged. */
  bus?: RunEventBus;
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
 * Project the DB run's current lifecycle status/finishedAt from the reduced
 * `RunState`. Only touches `runs` when something actually changed (idempotent);
 * `finishedAt` is stamped ONCE, the first time the run reaches a terminal
 * status, and never moved. `RunLifecycleStatus` is a subset of the DB's
 * `RunStatus`, so the mapping is identity.
 */
export function syncRunLifecycle(db: Db, runId: string, state: RunState): void {
  const existing = getRun(db, runId);
  if (existing === null) return;
  const status = state.status;
  const finishedAt = TERMINAL_RUN.has(status)
    ? (existing.finishedAt ?? Date.now())
    : existing.finishedAt;
  if (existing.status === status && existing.finishedAt === finishedAt) return;
  updateRun(db, runId, { status, finishedAt });
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
      appendEngineEvent(deps.db, capped, deps.bus);
      state = engine.reduce(state, capped).state;
      syncRunLifecycle(deps.db, state.runId, state);
      break;
    }

    const command = queue.shift()!;
    // `finishRun` is the driver's OWN command — a single `run.finished` event
    // (a sync array, which `for await` iterates too). `dispatchNode`/`startChild`
    // go to the executor, which STREAMS its events so `node.dispatched` is folded
    // (durable) before the side effect runs — see the `Executor` contract doc.
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
        : deps.executor.perform(command, state.runId);

    let terminal = false;
    for await (const event of source) {
      appendEngineEvent(deps.db, event, deps.bus);
      const result = engine.reduce(state, event);
      state = result.state;
      syncRunLifecycle(deps.db, state.runId, state);
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
    params: resolvedParams,
  };
  appendEngineEvent(deps.db, started, deps.bus);
  const result = engine.reduce(engine.seedState(), started);
  syncRunLifecycle(deps.db, run.id, result.state);
  return pump(deps, engine, result.state, result.commands);
}

export { TERMINAL_RUN };
