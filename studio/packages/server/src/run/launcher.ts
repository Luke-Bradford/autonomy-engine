import type {
  FireOutcome,
  FireResult,
  Run,
  Trigger,
  TriggerContext,
} from '@autonomy-studio/shared';
import { resolveTriggerBindings } from '@autonomy-studio/shared';
import {
  admitQueuedRun,
  countActiveRunsForTrigger,
  countQueuedRunsForTrigger,
  createRun,
  listRuns,
  nextQueuedRunForTrigger,
} from '../repo/runs.js';
import { startRun, terminalizeInterrupted, type DriveDeps, type DriveLog } from './driver.js';

/**
 * P4a — the run LAUNCHER: the one place a trigger becomes a run. Manual fire
 * (`POST /api/triggers/:id/fire`), the P4b scheduler, and P4c webhooks all
 * funnel through `fire()`, so the two load-bearing rules live HERE, not in any
 * one caller:
 *
 *   1. **"unbound never fires."** A trigger with `pipelineVersionId === null`
 *      is refused (throws `UnboundTriggerError`) — the PRIMARY guarantee the
 *      architecture requires of the scheduler. The write-API's
 *      `assertBindableIfEnabled` is only defense-in-depth on top of this.
 *   2. **Concurrency admission.** Per the trigger's policy, a fire is either
 *      started immediately, queued, or skipped — gated on the count of the
 *      trigger's currently-active (non-terminal) runs, read from the DB so the
 *      gate stays correct across a restart (see `countActiveRunsForTrigger`).
 *
 * A started run DRIVES IN THE BACKGROUND: `fire()` returns as soon as the run
 * row is durably created (status `pending`), and the reduce↔persist pump runs
 * on the event loop. That is what makes "fire → watch it run live" (P6) work —
 * the caller does not block on the whole run. Background drive errors are
 * caught and the run is terminalized `interrupted` (the driver already maps
 * EXPECTED activity failures to terminal events itself, so reaching the catch
 * means an unexpected fault — a bad doc or a bug — not a normal failure).
 *
 * #5 S6a — the `queue` policy's overflow is DURABLE: instead of an in-memory
 * FIFO (which a crash silently dropped), an overflow fire becomes a `runs` row
 * with `status = 'queued'` + a `queued_at` FIFO key + the frozen fire-time
 * `trigger_context`. The launcher drains oldest-first when a slot frees, gating
 * the drain on the DB active-count (`countActiveRunsForTrigger`, restart-safe)
 * rather than an in-memory counter — so a queued fire survives a restart and is
 * recovered by `recoverQueued()` at boot. Admission re-stamps `started_at` and
 * flips the row to `pending` before driving it (see `admitQueuedRun`).
 *
 * The launcher is per-app (a `createRunLauncher()` factory injected into
 * `buildApp`, mirroring `createSupervisor`/`createExecutor`), so its in-flight
 * set never leaks across app instances (test isolation, multi-tenant). The queue
 * itself is now in the DB, shared by construction — `recoverQueued()` is how a
 * fresh app instance picks up rows a previous one enqueued.
 */

// The fire outcome/result wire shape is the shared `FireResultSchema` SSOT
// (`@autonomy-studio/shared`) — re-exported here so existing importers (the
// scheduler, tests) keep resolving `FireResult`/`FireOutcome` from `launcher.js`
// while the web client validates the same `202` body against that one schema.
export type { FireOutcome, FireResult };

/**
 * The fire-time context a caller supplies (#5 S12) — the raw facts the durable
 * `run.triggerContext` seed is built from. `scheduledTime` is the INTENDED
 * scheduled occurrence (ISO-8601 UTC) for a `schedule` fire; `body` is the
 * webhook/event/run-now payload. Both are optional: a manual fire supplies
 * neither and the run's trigger context carries `triggerId` alone. All fields are
 * OPTIONAL so every existing caller (manual/webhook fire) keeps compiling — they
 * pass nothing and the launcher still records `triggerId`.
 */
export interface FireContext {
  scheduledTime?: string;
  body?: unknown;
  /**
   * The RUN-NOW param override layer (#5 S12b) — the TOP of the precedence stack
   * (pipeline-default < trigger-binding < run-now override). Supplied by the
   * manual-fire endpoint's `{ params }` body; absent for a schedule/webhook fire.
   * Merged OVER the trigger's fire-time-resolved bindings and frozen into the
   * run's params at admission, so a queued fire launches with the same override
   * layer the operator submitted.
   */
  runNowParams?: Record<string, unknown>;
}

/** Thrown by `fire()` when a trigger has no bound pipeline version. */
export class UnboundTriggerError extends Error {
  constructor(public readonly triggerId: string) {
    super(`trigger '${triggerId}' has no bound pipeline version — an unbound trigger never fires`);
    this.name = 'UnboundTriggerError';
  }
}

/**
 * The logger seam, re-exported from `driver.ts` where it now lives: the drive
 * boundary owns it, because `driveRun` reports the same faults this does.
 */
export type LauncherLog = DriveLog;

export interface RunLauncher {
  /**
   * Admit (or refuse) a fire for `trigger`, per its concurrency policy. Started
   * runs drive in the background. Synchronous: the run row is created (and so
   * durably counts against the concurrency gate) before this returns.
   * @throws {UnboundTriggerError} if `trigger.pipelineVersionId` is null.
   * @param fireContext optional fire-time facts (#5 S12) — the scheduled time
   *   and/or payload that seed the run's durable `run.triggerContext`.
   */
  fire(trigger: Trigger, fireContext?: FireContext): FireResult;
  /** Resolve once every in-flight AND queued run has reached quiescence — for
   * tests and (optionally) graceful shutdown. */
  whenIdle(): Promise<void>;
  /**
   * #5 S6a — drain any durably `queued` fires this launcher instance has not yet
   * picked up: for each trigger with queued rows, kick a drain (admitting its
   * oldest queued run if its slot is free; the rest follow on settle). Called
   * ONCE at boot, AFTER the boot reconciler (which resumes `running` rows) so the
   * drain's DB active-count already reflects any resumed run — no double-admit.
   * Idempotent and safe to call when the queue is empty (a no-op).
   */
  recoverQueued(): void;
  /** Stop accepting new fires and stop draining the queue. In-flight background
   * runs are left to settle. #5 S6a — queued rows are DURABLE and are NOT
   * dropped: they persist and are recovered by a later `recoverQueued()` (this
   * instance's or a fresh app's), unlike the old in-memory queue this cleared.
   * Idempotent. */
  stop(): void;
}

export interface RunLauncherDeps extends DriveDeps {
  /** Per-trigger `queue` depth cap; defaults to `DEFAULT_MAX_QUEUE_DEPTH`. */
  maxQueueDepth?: number;
}

/**
 * Default per-trigger cap on `queue`-policy fires waiting for the slot. A burst
 * beyond this (a flappy webhook, a runaway manual loop) skips with a reason
 * rather than growing the durable queue unboundedly. Generous enough that normal
 * bursts queue fine; a config-driven bound can come with P4b/c.
 */
export const DEFAULT_MAX_QUEUE_DEPTH = 1000;

export function createRunLauncher(deps: RunLauncherDeps): RunLauncher {
  const { db } = deps;
  const inFlight = new Set<Promise<void>>();
  const maxQueueDepth = deps.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
  let stopped = false;

  /**
   * Drive an already-created `pending` run in the background (the shared tail of
   * an immediate `launch()` and a queue `drainQueue()` admission). The run row
   * exists (`pending`, empty log) before this is called; `startRun` flips it to
   * `running` via `run.started`.
   *
   * Under the run's DRIVE LOCK (F2c) — the launcher is one of the two things that
   * can pump a run, the retry alarm is the other, and `executor.ts`'s "within a
   * single run the driver's `pump` is sequential" invariant is now this lock. The
   * lock spans the CATCH too, not just `startRun`: the cleanup APPENDS
   * (`run.interrupted`) and reads the log to decide whether to, so leaving it
   * outside would reopen the same divergence — an alarm's drive could interleave
   * between the failed pump and the interrupt that describes it. A fresh run's
   * chain is empty, so this costs a microtask and no waiting.
   *
   * The settle `finally` drains the trigger's durable queue on the DB count
   * (`drainQueue`), so the NEXT queued fire is admitted as soon as this drive
   * ends — whether it ended terminal, `interrupted`, or parked `waiting` (all of
   * which free the slot; only `pending`/`running` still occupy it).
   */
  function driveRun(run: Run, triggerContext: TriggerContext | undefined): void {
    const p = deps.drives.serialize(run.id, async () => {
      try {
        await startRun(deps, run, triggerContext);
      } catch (err) {
        deps.log?.error({ err, runId: run.id, triggerId: run.triggerId }, 'run drive failed');
        terminalizeInterrupted(deps, run.id);
      }
    });

    inFlight.add(p);
    void p.finally(() => {
      inFlight.delete(p);
      // Every launcher-created run carries a `triggerId`, but the row type is
      // nullable; guard so a trigger-less row (never produced here) can't drain.
      if (run.triggerId !== null) drainQueue(run.triggerId);
    });
  }

  /** Create the run row (durable, `pending`) and drive it in the background.
   * `params` is the fire-time-resolved override layer (#5 S12b), frozen by
   * `fire()` at admission and stored as the run's params.
   *
   * The row is created `pending`, then `startRun` flips it to `running` via
   * `run.started` one MICROTASK later (F2c routes the drive through
   * `drives.serialize`). Microtasks drain before any I/O, so the window is
   * sub-tick. A hard crash (SIGKILL/power-loss) in it could orphan a `pending`
   * row with no event log that the boot reconciler (which sweeps `running` rows)
   * would not clear — operator-recoverable; a reconciler `pending`-orphan sweep
   * is the durable close, a separate follow-up. */
  function launch(
    trigger: Trigger,
    triggerContext: TriggerContext,
    params: Record<string, unknown>,
  ): string {
    // Caller guarantees non-null (fire() throws UnboundTriggerError otherwise).
    const pipelineVersionId = trigger.pipelineVersionId as string;
    const run = createRun(db, {
      ownerId: trigger.ownerId,
      pipelineVersionId,
      triggerId: trigger.id,
      parentRunId: null,
      // #5 S12b — the run-now/binding-resolved override layer (NOT the raw
      // `trigger.params`), so `startRun`'s `resolveRunParams(pv, run.params)`
      // applies pipeline-default < this merged layer.
      params,
    });
    driveRun(run, triggerContext);
    return run.id;
  }

  /**
   * #5 S6a — when a `queue`-policy run's DRIVE ends, admit the trigger's oldest
   * durably-`queued` fire IF its slot is now free. Gated on the DB active-count
   * (`countActiveRunsForTrigger` = `pending`/`running`), NOT an in-memory counter.
   * That is the correct single-slot definition under S4's lease/slot split: a run
   * is durably `running` ⇒ it OCCUPIES the slot, so we must not admit past it.
   *
   * The normal cases all resolve cleanly: a launcher-driven run's pump runs to
   * TERMINAL within its drive promise (DB count → 0 → admit the next), and a run
   * that PARKS settles its drive at `waiting` (∉ active → count 0 → admit). The
   * one case this leaves is a run stuck at `running` after its drive ended — a
   * genuinely HUNG/crashed activity (executor dispatched a node but never yielded
   * a terminal). Such a run legitimately holds its slot; the durable `queued`
   * fire waits (it is a row, not a lost in-memory entry) until the boot reconciler
   * sweeps the stuck run to `interrupted` and `recoverQueued` admits the waiter —
   * a recoverability the old in-memory queue lacked (it drained on drive-end but
   * then lost every queued fire on the restart that fault required).
   *
   * KNOWN FOLLOW-UPS (later #5 S6 slices): (a) draining on ANY run's
   * terminalization (#629) — a run terminalized OUTSIDE the launcher (a
   * retry-alarm or external-wait resume of a previously-parked run) does not pass
   * back through this `finally`, so a fire that queued during that resumed run's
   * `running` window drains only on the next launcher-driven settle for the
   * trigger or on the next boot's `recoverQueued`; a bus hook on `run.finished`
   * closes that. (b) the `waiting_concurrency` re-admission gate so a resumed run
   * re-checks capacity rather than transiently exceeding it.
   *
   * Neither is a regression vs pre-S6a `main`: this DB-gated drain never
   * double-admits past the single slot (where `main`'s in-memory gate silently
   * could, by excluding an alarm-resumed run), and `recoverQueued` bounds the
   * worst case to "until next boot" — where `main` simply LOST every queued fire.
   * The (a) gap is a latency cliff to close, not a correctness regression.
   *
   * A no-op when the slot is occupied or the queue is empty. */
  function drainQueue(triggerId: string): void {
    if (stopped) return;
    if (countActiveRunsForTrigger(db, triggerId) > 0) return;
    const next = nextQueuedRunForTrigger(db, triggerId);
    if (next === null) return;
    // Flip `queued → pending` + re-stamp `started_at` atomically (the UPDATE's
    // `status = 'queued'` guard makes it idempotent — a concurrent/duplicate
    // drain that lost the race gets `null` and does nothing).
    const admitted = admitQueuedRun(db, next.id);
    if (admitted === null) return;
    // The frozen fire-time context rides the row (`trigger_context`); pass it so
    // a delayed admission still seeds `${trigger.scheduledTime}` with the
    // occurrence that fired it. `null` (a run with no fire-time facts) → the
    // driver's "no trigger context" path.
    driveRun(admitted, admitted.triggerContext ?? undefined);
  }

  function fire(trigger: Trigger, fireContext?: FireContext): FireResult {
    if (trigger.pipelineVersionId === null) {
      throw new UnboundTriggerError(trigger.id);
    }
    if (stopped) {
      return { outcome: 'skipped', reason: 'launcher is shutting down' };
    }

    // #5 S12 — freeze the run's durable trigger context at ADMISSION time. Every
    // launched run (immediate OR later-drained from the queue) carries the SAME
    // triggerId + the fire-time facts of THIS fire, so `${trigger.scheduledTime}`
    // is the occurrence that admitted it. A run with no fire-time facts still
    // records `triggerId` (nulls elsewhere).
    const triggerContext: TriggerContext = {
      triggerId: trigger.id,
      scheduledTime: fireContext?.scheduledTime ?? null,
      body: fireContext?.body ?? null,
    };

    // #5 S12b — resolve the trigger's expression-valued param bindings against
    // THIS fire's context, then merge the run-now override ON TOP. Precedence
    // pipeline-default < trigger-binding < run-now collapses to
    // `resolveRunParams(pv, mergedParams)` in `startRun`. Frozen here at
    // admission so a queued fire launches with the same values. A binding that
    // cannot resolve (a bad expression, or `${trigger.body.x}` on a null body)
    // THROWS `SubstituteError` — the caller maps it (manual → 400, schedule /
    // webhook → skip-and-log); it is refused BEFORE any run row is created.
    const mergedParams: Record<string, unknown> = {
      ...resolveTriggerBindings(trigger.params, triggerContext),
      ...(fireContext?.runNowParams ?? {}),
    };

    const active = countActiveRunsForTrigger(db, trigger.id);
    const { policy, max } = trigger.concurrency;

    if (policy === 'skip_if_running') {
      if (active > 0)
        return { outcome: 'skipped', reason: 'a run is already active for this trigger' };
      return { outcome: 'started', runId: launch(trigger, triggerContext, mergedParams) };
    }

    if (policy === 'parallel') {
      // `max` is guaranteed present + positive for `parallel` by
      // ConcurrencySchema. Defense-in-depth against a row written before that
      // refinement existed (or restored from an older export): a missing/invalid
      // cap must FAIL CLOSED (skip), never coerce to NaN and let `active >= NaN`
      // admit every fire unbounded.
      if (max === undefined || !Number.isInteger(max) || max < 1) {
        return {
          outcome: 'skipped',
          reason: 'parallel trigger has no valid concurrency max (misconfigured)',
        };
      }
      if (active >= max) {
        return { outcome: 'skipped', reason: `parallel cap of ${max} reached` };
      }
      return { outcome: 'started', runId: launch(trigger, triggerContext, mergedParams) };
    }

    // `queue`: single-slot, FIFO. Start now ONLY if the slot is free AND nothing
    // is already queued ahead — else enqueue a durable `queued` row (bounded).
    // Checking the queue depth as well as the active count keeps FIFO across the
    // boot window: a fire that arrives while queued rows still await draining
    // must fall in BEHIND them, not jump the slot.
    const queuedCount = countQueuedRunsForTrigger(db, trigger.id);
    if (active > 0 || queuedCount > 0) {
      if (queuedCount >= maxQueueDepth) {
        return { outcome: 'skipped', reason: `queue is full (max ${maxQueueDepth} pending)` };
      }
      // Durable enqueue: a real `runs` row (`status = 'queued'`) that survives a
      // restart, carrying its FIFO key + frozen fire-time context + params. No
      // drive yet — `drainQueue` admits it when the slot frees.
      createRun(db, {
        // Non-null: fire() threw UnboundTriggerError above if it were null.
        pipelineVersionId: trigger.pipelineVersionId as string,
        ownerId: trigger.ownerId,
        triggerId: trigger.id,
        parentRunId: null,
        params: mergedParams,
        status: 'queued',
        queuedAt: Date.now(),
        triggerContext,
      });
      return { outcome: 'queued' };
    }
    return { outcome: 'started', runId: launch(trigger, triggerContext, mergedParams) };
  }

  function recoverQueued(): void {
    if (stopped) return;
    // Kick a drain for each trigger that has durable `queued` rows this instance
    // has not yet picked up (a previous process enqueued them, or this one did
    // before a crash). One drain admits the trigger's OLDEST queued run if its
    // slot is free; the rest cascade on settle via `driveRun`'s `finally`. Run
    // once at boot, AFTER the reconciler has resumed `running` rows so the
    // per-drain DB active-count already reflects them (no double-admit).
    const triggerIds = new Set<string>();
    for (const run of listRuns(db, { status: 'queued' })) {
      if (run.triggerId !== null) triggerIds.add(run.triggerId);
    }
    for (const triggerId of triggerIds) drainQueue(triggerId);
  }

  async function whenIdle(): Promise<void> {
    // A settling run's `finally` drains its trigger's durable queue — reliably
    // admitting the next queued fire (adding a new in-flight run) BEFORE this
    // `allSettled` resolves, since that `finally` is registered in `driveRun()`,
    // ahead of this `allSettled`. So `inFlight` is never empty while the queue
    // still holds a drainable fire: looping until `inFlight` drains awaits every
    // in-flight AND queued run to quiescence.
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }

  function stop(): void {
    // #5 S6a — only halt accepting/draining. Durable `queued` rows are NOT
    // cleared (there is no in-memory queue to clear anymore); they persist and a
    // later `recoverQueued()` picks them up. In-flight drives settle on their own.
    stopped = true;
  }

  return { fire, whenIdle, recoverQueued, stop };
}
