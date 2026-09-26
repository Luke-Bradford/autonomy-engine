import type {
  CancelSource,
  EngineEvent,
  PipelineVersion,
  Run,
  RunOutcome,
} from '@autonomy-studio/shared';
import { callDetaches, resolveDocNode } from '@autonomy-studio/shared';
import {
  assertJsonReplaySafe,
  MAX_CALL_DEPTH,
  projectChildRunOutputs,
  TERMINAL_RUN_EVENT,
  TERMINAL_RUN_ROW_STATUS,
} from '@autonomy-studio/shared';
import { getPipeline, isPipelineArchived } from '../repo/pipelines.js';
import { getPipelineIdForVersion } from '../repo/pipeline-versions.js';
import { createRun, getRun } from '../repo/runs.js';
import type { Db } from '../repo/types.js';
import type { RunEventBus } from './event-bus.js';
import {
  buildEngine,
  driveRun,
  startRun,
  terminalizeInterrupted,
  type DriveDeps,
  type ExecutorCommand,
} from './driver.js';
import type { RunDrives } from './drives.js';

/** The one command this module answers. The executor narrows before calling in,
 * so a non-`startChild` command is not representable here. */
export type StartChildCommand = Extract<ExecutorCommand, { type: 'startChild' }>;
import { loadEngineEvents, terminalFactFromLog } from './events.js';
import { foldOutOfBand, publishThenDrive } from './out-of-band.js';

/**
 * #796 (P3b) — `call_pipeline` CHILD EXECUTION: the spawn seam the reducer has
 * been emitting `startChild` into since P3a, plus the reactor that carries a
 * finished child's result back to its parent.
 *
 * ## Why the parent does not simply `await` the child
 *
 * The obvious shape — the executor's `startChild` branch drives the child and
 * yields `call.returned` when it returns — is wrong, and wrong in a way that
 * only shows up in production. `startRun`/`driveRun` return at QUIESCENCE, not
 * at terminal: a child holding a timer, an external wait, or merely a node with
 * a retry policy parks on a durable alarm and its drive returns with the run
 * still live. An awaiting parent would then have nothing terminal to report.
 * Worse, at boot the awaited shape DEADLOCKS: the boot reconciler re-emits
 * `startChild` for a `waiting` call node, the parent's reconcile would block on
 * a child only the alarm clock can finish, and the alarm clock does not start
 * until boot reconcile has completed.
 *
 * So the seam is asynchronous, exactly like every other park in this engine:
 * the executor announces the spawn (`call.started`), kicks the child, and
 * returns leaving the call node `waiting`. The child's terminalization — from
 * its own drive, from an alarm, from a webhook callback, from anywhere — is
 * observed by the REACTOR below, which appends the parent's `call.returned` and
 * re-drives it. That is the shape #796 words as "whoever observes the child
 * reaching a terminal state appends the parent's `call.returned`", and it is
 * the same cross-run bus tap the launcher already uses to drain its admission
 * queue (`launcher.ts` `subscribeTerminalDrain`).
 *
 * ## Identity, and why there is no new column
 *
 * The child's `runs.id` IS the reducer's deterministic `childRunId`. That makes
 * "already spawned?" a primary-key lookup, crash-safe by construction: a replay
 * of the same `startChild` finds the row it created last time instead of
 * spawning a second child. It is also the id the reducer re-derives and checks
 * on `call.returned`, so the spawn seam and the fold cannot disagree about
 * which child a result belongs to.
 */

export interface ChildEnsured {
  ok: true;
  run: Run;
  /** The child has already reached a terminal state — adopt its result now
   * rather than announcing and kicking it again. "Again" is exact rather than
   * loose: a child can only be terminal if it was kicked, and `kick` is only
   * reachable past the executor's durable `call.started` append, so this flag
   * never co-occurs with `announced: false` (#1038). */
  terminal: boolean;
  /** The parent's log already carries `call.started` for this child, so a
   * re-emitted `startChild` (a restart) must not announce it a second time. */
  announced: boolean;
}

export interface ChildRuns {
  ensure(
    command: StartChildCommand,
    parentRunId: string,
  ): ChildEnsured | { ok: false; reason: string };
  // `reason` above is operator-facing: the executor puts it on the parent's
  // durable `call.returned` (#796). See `ensureOrThrow`'s `refuse`.
  /** Start (or resume) the child's drive in the BACKGROUND. Never awaited by the
   * parent — see the module doc. */
  kick(run: Run): void;
  /** The `call.returned` payload for a child that has already terminalized. */
  result(childRunId: string): { outcome: RunOutcome; outputs: Record<string, unknown> };
}

/** The refusal text for a spawn that THREW rather than refused. */
const SPAWN_THREW_REASON = 'the child run could not be created — the server log has the cause';

export interface ChildRunsDeps extends DriveDeps {
  db: Db;
  drives: RunDrives;
}

/** How many `call_pipeline` hops separate `runId` from its root, walking the
 * `parentRunId` chain. Bounded by `limit + 1` reads so a corrupt cycle cannot
 * spin (a self-FK cycle is not creatable — a child's id is a hash of its
 * parent's — but this walk must not depend on that to terminate). */
function callDepth(db: Db, runId: string, limit: number): number {
  let depth = 0;
  let cursor: string | null = runId;
  while (cursor !== null && depth <= limit) {
    const row: Run | null = getRun(db, cursor);
    if (row === null) break;
    if (row.parentRunId === null) break;
    depth += 1;
    cursor = row.parentRunId;
  }
  return depth;
}

export function createChildRuns(deps: ChildRunsDeps): ChildRuns {
  const { db } = deps;

  /**
   * TOTAL by construction: the seam's whole contract (A9/#516) is that a child
   * that cannot be spawned becomes a typed `call.returned{failure}` for that ONE
   * call node, never a throw. A throw here would escape the executor's
   * `startChild` generator into the pump's stream-error path, which terminalizes
   * the WHOLE PARENT RUN as `interrupted` — a strictly bigger blast radius than
   * the design intends, and one that repeats on every boot because the
   * reconciler re-emits `startChild` for a `waiting` call node.
   *
   * Guarding the two obviously-throwing calls (`resolveDoc`, `assertJsonReplaySafe`)
   * and leaving `getPipeline`/`isPipelineArchived`/`createRun` bare made the
   * contract true only for the failures that had been thought of: `createRun`
   * runs `NewRunSchema.parse` and throws a `ZodError`, and any of the row reads
   * can throw on a corrupt row. So the catch is around the WHOLE body.
   */
  function ensure(
    command: StartChildCommand,
    parentRunId: string,
  ): ChildEnsured | { ok: false; reason: string } {
    try {
      return ensureOrThrow(command, parentRunId);
    } catch (err) {
      deps.log?.error?.(
        { err, runId: parentRunId, childRunId: command.childRunId },
        'call_pipeline child spawn threw — refusing the call node rather than the run',
      );
      // A thrown message is arbitrary internal text; the durable event gets a
      // fixed one and the log above keeps the cause.
      return { ok: false, reason: SPAWN_THREW_REASON };
    }
  }

  function ensureOrThrow(
    command: StartChildCommand,
    parentRunId: string,
  ): ChildEnsured | { ok: false; reason: string } {
    // Every refusal is LOGGED here AND carried into the event: the executor puts
    // `reason` on `call.returned{failure}` (#796), which is how the run page can
    // say WHY a call node failed rather than only that it did. So `reason` is
    // OPERATOR-FACING, durable text; `detail`, when given, is the precise cause
    // and goes to the log only.
    const refuse = (reason: string, detail?: string): { ok: false; reason: string } => {
      deps.log?.warn?.(
        { runId: parentRunId, childRunId: command.childRunId, reason, detail },
        'call_pipeline child refused',
      );
      return { ok: false, reason };
    };
    // SECURITY. A missing version, an orphaned one and ANOTHER OWNER'S one all
    // read the same in the durable log, so a parent run is not an existence
    // oracle for version ids its owner cannot see.
    const notFound = (detail: string) =>
      refuse(`child pipeline version '${command.pipelineVersionId}' was not found`, detail);
    const parent = getRun(db, parentRunId);
    if (parent === null) return refuse('parent run row is gone');

    // Adopt FIRST: a child that already exists has already passed every check
    // below, and re-running them on a replay could refuse a child that is
    // mid-flight (an archive, or a retention sweep that shortened the ancestor
    // chain, between the spawn and the restart) — turning a healthy run into a
    // failure for a reason that post-dates it.
    const existing = getRun(db, command.childRunId);
    if (existing !== null) {
      return {
        ok: true,
        run: existing,
        terminal: TERMINAL_RUN_ROW_STATUS.has(existing.status),
        announced: hasAnnouncement(parentRunId, command.childRunId),
      };
    }

    // The runtime depth bound. The save-time DFS (`validateCallGraph`) shares
    // MAX_CALL_DEPTH but is not a bound on its own: it follows LITERAL targets
    // only, so a `${}` target, a cross-owner callee or a missing one is skipped
    // (#1011). `callDepth` counts the PARENT's hops; the child is one deeper.
    const depth = callDepth(db, parentRunId, MAX_CALL_DEPTH) + 1;
    if (depth > MAX_CALL_DEPTH) {
      return refuse(`call_pipeline depth ${depth} exceeds the maximum ${MAX_CALL_DEPTH}`);
    }

    // A9/#516 — a gone or unparseable child version is classified HERE, as a
    // typed refusal. Letting `resolveDoc`'s throw escape would surface on EVERY
    // boot (the reconciler re-emits `startChild` for a `waiting` call node) and
    // re-file the parent `failed` forever.
    try {
      deps.resolveDoc(command.pipelineVersionId);
    } catch {
      return notFound('the version cannot be resolved');
    }

    const pipelineId = getPipelineIdForVersion(db, command.pipelineVersionId);
    if (pipelineId === null) {
      return notFound('the version has no pipeline');
    }
    // SECURITY. `validateCallGraph` resolves callees through an OWNER-SCOPED
    // resolver and silently SKIPS one it cannot see, so a cross-owner target
    // passes save-time validation; `resolveDoc` is owner-agnostic. Without this
    // check a call node would execute another owner's pipeline under the
    // caller's identity — and with the caller's connections' secrets in scope.
    const pipeline = getPipeline(db, pipelineId);
    if (pipeline === null || pipeline.ownerId !== parent.ownerId) {
      return notFound('the child pipeline belongs to a different owner');
    }
    // #3 G5a — the same dispatch guard `fire()` applies. An archived pipeline
    // must not become runnable through the back door of a call node.
    if (isPipelineArchived(db, pipelineId)) {
      return refuse('child pipeline is archived');
    }
    // The child's params are `substitute`d values from the parent's run state,
    // so unlike a trigger body they are not caller-supplied — but they land in
    // the same JSON column and are re-read on every replay, so they are held to
    // the same replay-safety rule `fire()` holds a trigger body to.
    try {
      assertJsonReplaySafe('call_pipeline params', command.params);
    } catch (err) {
      // The one thrown message allowed into the durable `reason`: it is
      // PATH-ONLY by `jsonReplaySafetyErrors`'s contract (never the value), and
      // the path is what tells the author which param to fix.
      return refuse(err instanceof Error ? err.message : String(err));
    }

    const run = createRun(
      db,
      {
        ownerId: parent.ownerId,
        pipelineVersionId: command.pipelineVersionId,
        triggerId: null,
        parentRunId,
        params: command.params,
      },
      command.childRunId,
    );
    return { ok: true, run, terminal: false, announced: false };
  }

  function hasAnnouncement(parentRunId: string, childRunId: string): boolean {
    return loadEngineEvents(db, parentRunId).some(
      (e) => e.type === 'call.started' && e.childRunId === childRunId,
    );
  }

  /**
   * CX3 (#1320, spec D8) — a child about to START whose parent is already being
   * cancelled, or already over, starts with that cancel pending, so `startRun`
   * folds it first and the child finishes `cancelled` without doing any work.
   *
   * This is the one child a parent's propagation cannot reach. `ensure` creates
   * the child's row BEFORE the parent's `call.started` is appended, and
   * `cancelLiveChildren` skips a child the parent has not announced (an
   * unannounced child was never kicked, and a detached one must not be buried).
   * By the time `kick` runs the announcement is durable, so the parent's log is
   * complete enough to decide.
   *
   * Never throws: a parent log that cannot be read leaves the child to start as
   * it would have, the reversible act, rather than terminalizing it in `kick`'s
   * catch.
   */
  function requestCancelFromParent(run: Run): void {
    if (run.parentRunId === null || deps.cancels === undefined) return;
    const parentRunId = run.parentRunId;
    try {
      const parentEvents = loadEngineEvents(db, parentRunId);
      const source: CancelSource | null = parentEvents.some((e) => e.type === 'run.cancelRequested')
        ? { kind: 'parent_cancelled', parentRunId }
        : terminalFactFromLog(parentEvents) !== null
          ? { kind: 'parent_terminal', parentRunId }
          : null;
      if (source === null) return;
      if (!parentCancelReachesChild(deps, parentRunId, parentEvents, run.id)) return;
      deps.cancels.request(run.id, source);
    } catch (err) {
      deps.log?.error?.({ err, runId: run.id }, 'reading the parent of a starting child failed');
    }
  }

  function kick(run: Run): void {
    // Deliberately NOT awaited: see the module doc. Failures are contained here
    // rather than surfacing as an unhandled rejection — the parent learns of them
    // through the child's terminal state, which is the only channel that also
    // works across a restart.
    void deps.drives
      .serialize(run.id, async (): Promise<'settled' | 'resume'> => {
        // Decided UNDER the lock, so two kicks for one child (a re-emitted
        // `startChild` racing the first) cannot both see an empty log and both
        // call `startRun` — the second would throw "already has an event log"
        // and this function's catch would terminalize a perfectly healthy run.
        const events = loadEngineEvents(db, run.id);
        if (terminalFactFromLog(events) !== null) return 'settled';
        // #1041 — the ROW can be terminal while the LOG is not, and only for a
        // child that never started: `terminalizeInterrupted`'s no-events branch
        // (the orphan sweep's primitive, and this function's own catch below)
        // patches the row and appends nothing, so the log check above cannot see
        // it. Without this, a kick already queued on this `pLimit(1)` when the
        // sweep took the lock would fall into the empty-log branch and start a
        // run that has been declared over — resurrecting it as `running` while
        // still carrying the sweep's `finishedAt`, since `syncRunLifecycle` only
        // ever carries an existing one forward. This is the SAME predicate
        // `ensure` applies before it ever issues a kick, re-checked here under
        // the lock; it narrows nothing, because `ensure` never hands a
        // row-terminal child to `kick` in the first place.
        const row = getRun(db, run.id);
        if (row === null || TERMINAL_RUN_ROW_STATUS.has(row.status)) return 'settled';
        if (events.length === 0) {
          requestCancelFromParent(run);
          await startRun(deps, run);
          return 'settled';
        }
        // A child whose log is already seeded is being ADOPTED after a crash.
        // `startRun` refuses a non-empty log, so this needs `driveRun` — which
        // takes THIS RUN'S LOCK ITSELF, and `drives.serialize` is a `pLimit(1)`
        // that is NOT reentrant. Calling it from in here would deadlock the
        // child forever. So the lock is released first and `driveRun` re-takes
        // it; that is safe rather than merely tolerable, because `driveRun`
        // re-projects from the log under its own lock and re-checks terminal —
        // it is the sanctioned "something happened out of band, take this run
        // further" entry point precisely for callers in this position.
        return 'resume';
      })
      .then((next) => (next === 'resume' ? driveRun(deps, run.id) : undefined))
      .catch((err: unknown) => {
        deps.log?.error?.({ err, runId: run.id }, 'call_pipeline child drive failed');
        try {
          terminalizeInterrupted(deps, run.id);
        } catch (cleanupErr) {
          deps.log?.error?.({ err: cleanupErr, runId: run.id }, 'child interrupt-cleanup failed');
        }
      });
  }

  /**
   * TOTAL for the same reason `ensure` is — the executor calls this on the
   * adopt-an-already-terminal-child path, inside the same generator. A corrupt
   * child log must fail the call node, not interrupt the parent run.
   *
   * `failure` is the fail-safe answer when the log cannot be read at all: an
   * unreadable child must never resolve as success.
   */
  function result(childRunId: string): { outcome: RunOutcome; outputs: Record<string, unknown> } {
    let events;
    let run;
    try {
      events = loadEngineEvents(db, childRunId);
      run = getRun(db, childRunId);
    } catch (err) {
      deps.log?.error?.({ err, runId: childRunId }, 'child log unreadable — reporting failure');
      return { outcome: 'failure', outputs: {} };
    }
    // The LOG decides what a run ended as (#443), never a re-fold — so the
    // OUTCOME comes from `terminalFactFromLog`, and only the OUTPUTS come from a
    // projection. An `interrupted` child is a FAILURE to its parent, which is the
    // fail-safe direction (an unfinished child must never read as success) and
    // leaves the child's own row carrying the more precise status.
    //
    // CX3 (#1320) — a `cancelled` child is passed through as `cancelled`. The
    // reducer still fails the call node (`NodeRunStatus` has no `cancelled`), but
    // under the parent's OWN cancel it must count as work that cancel stopped
    // (D3): flattened to `failure`, a parent whose cancel reached its child would
    // finish `failure` instead of `cancelled`.
    const fact = terminalFactFromLog(events);
    const outcome: RunOutcome =
      fact === 'success' ? 'success' : fact === 'cancelled' ? 'cancelled' : 'failure';
    if (run === null || run === undefined) return { outcome, outputs: {} };
    let outputs: Record<string, unknown> = {};
    try {
      const doc = deps.resolveDoc(run.pipelineVersionId);
      const engine = buildEngine(doc);
      outputs = projectChildRunOutputs(doc, engine.projectRunState(events));
    } catch (err) {
      // A child whose version has since gone unresolvable still has an OUTCOME
      // (the log holds it); only its outputs are unrecoverable. Reporting the
      // outcome with `{}` beats failing the parent for a reason unrelated to
      // what its child actually did.
      deps.log?.error?.({ err, runId: childRunId }, 'child output projection failed');
    }
    return { outcome, outputs };
  }

  return { ensure, kick, result };
}

export interface ChildReturnReactorDeps extends ChildRunsDeps {
  bus: RunEventBus;
  childRuns: ChildRuns;
}

/**
 * The other half of the seam: when ANY run terminalizes, if it is a
 * `call_pipeline` child, append its parent's `call.returned` and re-drive the
 * parent.
 *
 * A global bus tap rather than a callback threaded into each terminalization
 * source, for the reason the launcher's identical tap gives: a child can
 * terminalize from its own drive, from a retry alarm, from an external-wait
 * completer or from the boot reconciler, and ONE hook covers all of them.
 *
 * The call node is identified from the PARENT's log — the `call.started` whose
 * `childRunId` matches — which is why that event is appended before the child
 * is ever kicked. No `callNodeId` column is needed, and the pairing cannot
 * drift from what the reducer will check.
 *
 * Restart-safe without this reactor being durable: if the process dies between
 * a child terminalizing and the parent's `call.returned`, boot reconcile
 * re-emits `startChild` for the still-`waiting` call node, `ensure` adopts the
 * terminal child, and the executor yields `call.returned` directly.
 *
 * And if `returnToParent` merely THROWS — a transient DB fault inside its
 * transaction — the parent is not stranded until the next restart either. A
 * parent whose only in-flight node is a `waiting` call node is NOT a durable
 * park (`reconcile.ts`'s `hasDurableParkNode` excludes it): its row stays
 * `running` with a stamped `leaseUntil` (measured, not assumed —
 * `child.test.ts` probed `{status:'running', lease: non-null}` with a child
 * genuinely in flight). Once its drive ends, nothing refreshes that lease, so
 * it expires and S7's lease-expiry reclaim sweeps it like any other run whose
 * worker went away. The `waiting`-row/`leaseUntil: null` case that reclaim
 * skips is a different state this one never enters.
 */
export function subscribeChildReturns(deps: ChildReturnReactorDeps): () => void {
  let stopped = false;
  const unsubscribe = deps.bus.subscribeAll((event) => {
    if (!(TERMINAL_RUN_EVENT as ReadonlySet<string>).has(event.type)) return;
    const endedRunId = event.runId;
    // Publish is synchronous inside the driver's fold; do the work after it, so
    // this never re-enters a pump mid-turn (the launcher's tap defers the same
    // way, for the same reason).
    queueMicrotask(() => {
      if (stopped) return;
      void returnToParent(deps, endedRunId).catch((err: unknown) => {
        deps.log?.error?.({ err, runId: endedRunId }, 'call_pipeline child return failed');
      });
      // CX3 (#1320, spec D8, #1056's live path) — the same terminal, read as a
      // PARENT's: a live non-detached child of a run that is over can deliver
      // its result to nobody, so it stops spending. A parent cancelled earlier
      // already asked (`onCancelFolded`); asking again records nothing.
      try {
        deps.cancels?.cancelChildren(endedRunId, {
          kind: 'parent_terminal',
          parentRunId: endedRunId,
        });
      } catch (err) {
        deps.log?.error?.(
          { err, runId: endedRunId },
          'cancelling the child runs of an ended run failed',
        );
      }
    });
  });
  return () => {
    stopped = true;
    unsubscribe();
  };
}

/**
 * #796 item 2 — did this child's PARENT detach from it (`call.wait: false`)?
 * A detached child owes its parent nothing and its parent owes it nothing: no
 * `call.returned` goes back, and the parent terminalizing does not make the
 * child's work undeliverable (#1053's premise), because nothing was ever going
 * to be delivered.
 *
 * Decided from the parent's BOUND DOC, not from its log's `call.detached`, and
 * the log alone is not enough. The executor kicks the child BEFORE it yields
 * `call.detached` (see the executor for why that order), so there are two
 * windows where the log does not yet say "detached" but the child is running:
 * a small child finishing before the detach is appended, and the parent
 * terminalizing on another branch, which drops the detach unappended. In both,
 * `call.started` is in the log and names the call node, and the doc says what
 * that node does.
 *
 * The log's `call.detached` is still read first. It needs no doc, so a parent
 * whose version cannot be resolved (`parentDoc: null`) is still answered
 * correctly whenever the detach did land.
 */
export function isDetachedChild(
  parentEvents: readonly EngineEvent[],
  parentDoc: Pick<PipelineVersion, 'nodes'> | null,
  childRunId: string,
): boolean {
  let callNodeId: string | undefined;
  for (const e of parentEvents) {
    if (e.type === 'call.detached' && e.childRunId === childRunId) return true;
    if (e.type === 'call.started' && e.childRunId === childRunId) callNodeId = e.callNodeId;
  }
  if (callNodeId === undefined || parentDoc === null) return false;
  const node = resolveDocNode(parentDoc.nodes, callNodeId);
  return node?.call !== undefined && callDetaches(node.call);
}

/**
 * #796 item 2 — did the parent DETACH from `childRunId`? See `isDetachedChild`
 * for why the bound doc is consulted and not only the log.
 *
 * `null` is UNDECIDABLE: the parent announced this child, its log has no
 * `call.detached`, and there is no doc to ask. Every caller resolves that the
 * way #1053's asymmetry does — toward the reversible act. The running scan
 * resumes rather than freezes, the sweep leaves a never-started child `pending`
 * rather than burying work that may have been asked for, and a parent's cancel
 * (CX3) leaves the child running rather than stopping work that may be the point.
 */
export function detachVerdict(
  parentEvents: readonly EngineEvent[],
  parentDoc: Pick<PipelineVersion, 'nodes'> | null,
  childRunId: string,
): boolean | null {
  if (isDetachedChild(parentEvents, parentDoc, childRunId)) return true;
  if (parentDoc !== null) return false;
  const announced = parentEvents.some(
    (e) => e.type === 'call.started' && e.childRunId === childRunId,
  );
  return announced ? null : false;
}

/**
 * CX3 (#1320, spec D8) — does a cancel of `parentRunId` (its own, or its ending)
 * reach this child? Only when the parent is known NOT to have detached from it:
 * a detached child exists to outlive its parent, and an undecidable one is left
 * running (see `detachVerdict`). The parent's doc is resolved here; a version
 * that cannot be resolved is simply not consulted.
 */
export function parentCancelReachesChild(
  deps: { db: Db; resolveDoc: (pipelineVersionId: string) => PipelineVersion },
  parentRunId: string,
  parentEvents: readonly EngineEvent[],
  childRunId: string,
): boolean {
  let parentDoc: PipelineVersion | null = null;
  const parent = getRun(deps.db, parentRunId);
  if (parent !== null) {
    try {
      parentDoc = deps.resolveDoc(parent.pipelineVersionId);
    } catch {
      parentDoc = null;
    }
  }
  return detachVerdict(parentEvents, parentDoc, childRunId) === false;
}

async function returnToParent(deps: ChildReturnReactorDeps, childRunId: string): Promise<void> {
  const { db } = deps;
  const child = getRun(db, childRunId);
  if (child === null || child.parentRunId === null) return;
  const parentRunId = child.parentRunId;

  const parentEvents = loadEngineEvents(db, parentRunId);
  const announcement = parentEvents.find(
    (e): e is Extract<EngineEvent, { type: 'call.started' }> =>
      e.type === 'call.started' && e.childRunId === childRunId,
  );
  // No announcement means the parent never got as far as recording this child
  // (a crash between `createRun` and the `call.started` append). Its boot
  // reconcile will re-emit `startChild`, adopt the terminal child and resolve
  // the node then — appending a `call.returned` the parent's log cannot attach
  // to a call node would be worse than waiting.
  if (announcement === undefined) return;
  if (terminalFactFromLog(parentEvents) !== null) return; // parent already over

  const parent = getRun(db, parentRunId);
  if (parent === null) return;
  const doc = deps.resolveDoc(parent.pipelineVersionId);
  // #796 item 2 — a detached call takes nothing back. Without this, a child
  // that finishes before its parent's `call.detached` lands would resolve the
  // still-`waiting` node with the CHILD's outcome and outputs.
  if (isDetachedChild(parentEvents, doc, childRunId)) return;

  const { outcome, outputs } = deps.childRuns.result(childRunId);
  const event: EngineEvent = {
    type: 'call.returned',
    runId: parentRunId,
    callNodeId: announcement.callNodeId,
    attemptId: announcement.attemptId,
    childRunId,
    childOutcome: outcome,
    outputs,
  };

  // The out-of-band append (#1021, `out-of-band.ts`): fold inside a transaction
  // with no bus, then publish the committed record and `driveRun` — which takes
  // the parent's drive lock and re-projects. A duplicate delivery is absorbed by the
  // reducer's own guards: `onCallReturned` ignores an event whose call node is
  // no longer `waiting` on that attempt.
  const engine = buildEngine(doc);
  const record = db.transaction(() => {
    const events = loadEngineEvents(db, parentRunId);
    if (terminalFactFromLog(events) !== null) return null;
    const state = engine.projectRunState(events);
    return foldOutOfBand(db, engine, state, [event], deps.log).records[0];
  });
  if (record === null) return;
  await publishThenDrive(deps, [record]);
}
