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
  /** Minimal logger seam; optional for tests. Lives on the DRIVER boundary, not
   * just the launcher's, because every drive entry point reports the same faults. */
  log?: DriveLog;
}

/** Run-lifecycle statuses that are terminal (the run stops advancing). */
const TERMINAL_RUN: ReadonlySet<RunLifecycleStatus> = new Set<RunLifecycleStatus>([
  'success',
  'failure',
  'interrupted',
]);

/**
 * A belt-and-suspenders bound on driver iterations, and NOT the general liveness
 * guarantee it once claimed to be. The old claim ("the reducer already
 * GUARANTEES termination … so a validated doc can never reach this") was false
 * three ways: `validateDoc` never required a container `maxRounds` (only a
 * back-edge `maxBounces`), it bound nothing on the way in (#444 gated the WRITE
 * path afterwards, but rows written before that gate are still unvalidated, so
 * a doc here is still not "validated"), and this bounds the COMMAND-QUEUE pump,
 * which is the wrong layer for either shape that actually breaks liveness. A
 * deadlocked doc drains
 * the queue and never comes back here; a spinning reducer never returns control
 * to this loop at all.
 *
 * What it does bound: an unforeseen reducer bug that keeps EMITTING commands,
 * which it fails SAFELY (a `capped` terminal) rather than spinning a headless
 * server. Deadlock/spin defences live in the reducer itself — see
 * `malformed-doc.test.ts`.
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

/** Minimal logger seam (Fastify's `log` satisfies it); optional for tests. */
export interface DriveLog {
  error(obj: unknown, msg?: string): void;
}

/** What `terminalizeInterrupted` needs — no executor, no alarms, no lock. */
export type TerminalizeDeps = Pick<DriverDeps, 'db' | 'resolveDoc' | 'bus' | 'log'>;

/**
 * `TERMINAL_RUN` is the engine's SSOT for run-lifecycle-terminal, typed over the
 * narrower `RunLifecycleStatus`; a DB row's `status` is the wider `RunStatus`, so
 * widen the set's element type for this membership check.
 */
const isTerminalRow = (status: string): boolean =>
  (TERMINAL_RUN as ReadonlySet<string>).has(status);

/**
 * Terminalize a run whose background drive threw UNEXPECTEDLY (the driver maps
 * every EXPECTED activity failure to a terminal event itself, so reaching
 * here is a bug/bad-doc, not a normal failure). Keep the append-log the
 * authoritative source of truth (the P6 monitor tails it):
 *   - NO events (the fault was before `run.started`, e.g. a bad doc) → there
 *     is no event-sourced lifecycle to preserve; the row is pure provenance,
 *     so a direct lifecycle patch to `interrupted` is correct.
 *   - a non-terminal log (the fault was mid-pump, after `run.started`) →
 *     APPEND a `run.interrupted` event FIRST (this needs no doc, so the
 *     terminal fact is durable in the log even if the doc is now unresolvable),
 *     THEN sync the row: from a proper fold when the doc resolves (as the boot
 *     reconciler does), or by a direct patch if `resolveDoc` throws. Either
 *     way the row and the log agree on `interrupted` — never diverge.
 * A run reaching here CAN already have a terminal LOG (#443) — this used to
 * claim it could not, which was WRONG: `pump` appends `run.finished` and only
 * THEN folds it and syncs the row, so a throw in either step leaves the terminal
 * fact durable while the row is still `running`, and `startRun` throws, landing
 * here. Appending `run.interrupted` on top would bury a run's real terminal fact
 * under a false one — and since #443 makes the LOG authoritative for
 * terminality, the boot reconciler would then resync a SUCCEEDED run to
 * `interrupted`. So a terminal log means: append NOTHING, just sync the row to
 * what the log already says. `isTerminalRow` stays too, so a concurrently
 * terminalized row is never clobbered.
 *
 * This is the one producer that could append a terminal event AFTER an accepted
 * terminal event — the exact invariant `terminalFactFromLog` rests on. Keep it
 * that way.
 */
export function terminalizeInterrupted(deps: TerminalizeDeps, runId: string): void {
  const { db } = deps;
  const patchRow = (): void => {
    const run = getRun(db, runId);
    if (run !== null && !isTerminalRow(run.status)) {
      updateRun(db, runId, { status: 'interrupted', finishedAt: Date.now() });
    }
  };
  let events: EngineEvent[];
  let run: ReturnType<typeof getRun>;
  try {
    events = loadEngineEvents(db, runId);
    run = getRun(db, runId);
  } catch (cleanupErr) {
    deps.log?.error({ err: cleanupErr, runId }, 'run interrupt-cleanup read failed');
    return;
  }
  if (run === null || isTerminalRow(run.status)) return;
  if (events.length === 0) {
    patchRow();
    return;
  }
  // The LOG already records a terminal fact: the run really did finish, and the
  // throw was in the fold/sync AFTER the durable append. Sync the row from that
  // fact — never append a contradicting terminal over it (#443).
  const terminal = terminalFactFromLog(events);
  if (terminal !== null) {
    syncRunLifecycle(db, runId, terminal);
    return;
  }
  // Non-terminal log: record the terminal fact in the LOG first (no doc
  // needed), so the log stays authoritative even if the fold below can't run.
  const interrupted: EngineEvent = { type: 'run.interrupted', runId, reason: 'drive_failed' };
  let appended: ReturnType<typeof appendEngineEvent>;
  try {
    appended = appendEngineEvent(db, interrupted, deps.bus);
  } catch (appendErr) {
    // Couldn't even append — best-effort patch so no zombie row lingers.
    deps.log?.error({ err: appendErr, runId }, 'run interrupt append failed');
    patchRow();
    return;
  }
  try {
    const engine = buildEngine(deps.resolveDoc(run.pipelineVersionId));
    // Fold the PARSED event, not the raw one — see `appendEngineEvent`.
    const state = engine.reduce(engine.projectRunState(events), appended.event).state;
    syncRunLifecycle(db, runId, state.status);
  } catch (foldErr) {
    // The doc is unresolvable (e.g. its version was deleted). The
    // `run.interrupted` event is ALREADY durable in the log; just make the row
    // agree via a direct patch — log and row still converge on `interrupted`.
    deps.log?.error({ err: foldErr, runId }, 'run interrupt fold failed; row patched directly');
    patchRow();
  }
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
    try {
      await drive(deps, runId);
    } catch (err) {
      // The SAME handling the launcher gives an unexpectedly-thrown drive, and
      // shared with it rather than re-implemented: without this, an identical
      // fault is a visible needs-attention run when the LAUNCHER drives and a
      // SILENT HANG when the alarm does — the run stays `running`, its alarm row
      // is now spent, and the throw stops at the clock's floating `afterCommit`
      // catch as one log line. That asymmetry between two entry points doing the
      // same job is what produced B1; it does not get to survive B1's fix.
      deps.log?.error({ err, runId }, 'retry drive failed');
      terminalizeInterrupted(deps, runId);
    }
  });
}

/** `driveRun`'s critical section — already under the run's lock. */
async function drive(deps: DriveDeps, runId: string): Promise<void> {
  {
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
  }
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
