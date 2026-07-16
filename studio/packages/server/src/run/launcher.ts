import type { FireOutcome, FireResult, Trigger } from '@autonomy-studio/shared';
import { countActiveRunsForTrigger, createRun } from '../repo/runs.js';
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
 * The launcher is per-app (a `createRunLauncher()` factory injected into
 * `buildApp`, mirroring `createSupervisor`/`createExecutor`), so its in-flight
 * set + per-trigger queues never leak across app instances (test isolation,
 * multi-tenant).
 */

// The fire outcome/result wire shape is the shared `FireResultSchema` SSOT
// (`@autonomy-studio/shared`) — re-exported here so existing importers (the
// scheduler, tests) keep resolving `FireResult`/`FireOutcome` from `launcher.js`
// while the web client validates the same `202` body against that one schema.
export type { FireOutcome, FireResult };

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
   */
  fire(trigger: Trigger): FireResult;
  /** Resolve once every in-flight AND queued run has reached quiescence — for
   * tests and (optionally) graceful shutdown. */
  whenIdle(): Promise<void>;
  /** Stop accepting new fires and drop every queued (not-yet-started) fire.
   * In-flight background runs are left to settle (or be recovered by the boot
   * reconciler if the process dies first). Idempotent. */
  stop(): void;
}

export interface RunLauncherDeps extends DriveDeps {
  /** Per-trigger `queue` depth cap; defaults to `DEFAULT_MAX_QUEUE_DEPTH`. */
  maxQueueDepth?: number;
}

/**
 * Default per-trigger cap on `queue`-policy fires waiting for the slot. A burst
 * beyond this (a flappy webhook, a runaway manual loop) skips with a reason
 * rather than growing the in-memory queue unboundedly. Generous enough that
 * normal bursts queue fine; a config-driven bound can come with P4b/c.
 */
export const DEFAULT_MAX_QUEUE_DEPTH = 1000;

export function createRunLauncher(deps: RunLauncherDeps): RunLauncher {
  const { db } = deps;
  const inFlight = new Set<Promise<void>>();
  /**
   * Per-trigger FIFO of fires waiting for the (single) `queue` slot to free.
   *
   * IN-MEMORY, and bounded to `MAX_QUEUE_DEPTH` per trigger (a full queue skips
   * with a reason rather than growing unboundedly under a burst — e.g. a flappy
   * webhook in P4c). CONSCIOUS TRADEOFF: a queued fire has no run row yet (the
   * row is created only when it drains to the slot), so a process crash/restart
   * silently drops everything still queued. That is acceptable for P4a — a
   * dropped MANUAL queued fire is re-fired by the operator, and a dropped
   * SCHEDULED/webhook fire is re-evaluated on the next tick (P4b/c). The durable
   * close (persist queued fires + a boot-reconciler sweep to recover them) is
   * the same follow-up as the `pending`-orphan window in `launch()`; kept out of
   * this slice so P4a stays scoped to manual fire + concurrency.
   */
  const queues = new Map<string, Trigger[]>();
  /**
   * Per-trigger count of runs this launcher is CURRENTLY driving (promise not
   * yet settled). This is what advances the `queue`: a run's `finally`
   * decrements it and drains, so the next queued fire starts as soon as the
   * previous DRIVE ends — even if that run came to rest non-terminal (a crash
   * mid-dispatch, or a future `waiting` call node), which the DB active-count
   * would still report as occupying the slot and thus stall the queue forever.
   * Admission (`fire`) still uses the DB count (`countActiveRunsForTrigger`)
   * because that is restart-safe (a resumed run counts after a reboot, when
   * this in-memory map is empty); the drain uses the in-memory count because it
   * must reliably fire on promise-settle in THIS process.
   */
  const inFlightByTrigger = new Map<string, number>();
  const maxQueueDepth = deps.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
  let stopped = false;

  function incInFlight(triggerId: string): void {
    inFlightByTrigger.set(triggerId, (inFlightByTrigger.get(triggerId) ?? 0) + 1);
  }
  function decInFlight(triggerId: string): void {
    const n = (inFlightByTrigger.get(triggerId) ?? 1) - 1;
    if (n <= 0) inFlightByTrigger.delete(triggerId);
    else inFlightByTrigger.set(triggerId, n);
  }

  /** Create the run row (durable, `pending`) and drive it in the background. */
  function launch(trigger: Trigger): string {
    // Caller guarantees non-null (fire() throws UnboundTriggerError otherwise).
    const pipelineVersionId = trigger.pipelineVersionId as string;
    // The row is created `pending`, then `startRun` (below) flips it to
    // `running` via `run.started`. Both land in this same tick, but they are no
    // longer CONSECUTIVE synchronous writes: F2c routes the drive through
    // `drives.serialize`, so `startRun`'s synchronous prefix (the `run.started`
    // append + lifecycle sync) now runs one MICROTASK after this `createRun`
    // rather than immediately after it. Microtasks drain before any I/O, so the
    // window is unchanged in kind and still sub-tick — but the old comment's
    // "there is no `await` between them" is no longer literally true, and this
    // one says what is.
    //
    // A hard crash (SIGKILL/power-loss) in that window could orphan a `pending`
    // row with no event log that the boot reconciler (which sweeps `running`
    // rows) would not clear, wedging a single-slot trigger's concurrency gate.
    // Operator-recoverable (delete the run row / re-fire); a reconciler
    // `pending`-orphan sweep is the durable close and is left to a follow-up so
    // this slice stays scoped to manual fire + concurrency.
    const run = createRun(db, {
      ownerId: trigger.ownerId,
      pipelineVersionId,
      triggerId: trigger.id,
      parentRunId: null,
      params: trigger.params,
    });

    incInFlight(trigger.id);
    // Under the run's DRIVE LOCK (F2c) — the launcher is one of the two things
    // that can pump a run, the retry alarm is the other, and `executor.ts`'s
    // "within a single run the driver's `pump` is sequential" invariant is now
    // this lock rather than an accident of there having been only one caller.
    //
    // The lock spans the CATCH too, not just `startRun`: the cleanup APPENDS
    // (`run.interrupted`) and reads the log to decide whether to, so leaving it
    // outside would reopen the same divergence one level down — an alarm's drive
    // could interleave between the failed pump and the interrupt that describes
    // it. A fresh run's chain is empty, so this costs a microtask and no waiting.
    const p = deps.drives.serialize(run.id, async () => {
      try {
        await startRun(deps, run);
      } catch (err) {
        deps.log?.error({ err, runId: run.id, triggerId: trigger.id }, 'run drive failed');
        terminalizeInterrupted(deps, run.id);
      }
    });

    inFlight.add(p);
    void p.finally(() => {
      inFlight.delete(p);
      decInFlight(trigger.id);
      drainQueue(trigger.id);
    });
    return run.id;
  }

  /** When a `queue`-policy run's DRIVE ends, start the next queued fire if this
   * launcher is no longer driving one for the trigger. Gated on the in-memory
   * in-flight count (not the DB count) so a run that rests non-terminal still
   * advances the queue. A no-op for other policies (they never enqueue). */
  function drainQueue(triggerId: string): void {
    if (stopped) return;
    const q = queues.get(triggerId);
    if (q === undefined || q.length === 0) return;
    if ((inFlightByTrigger.get(triggerId) ?? 0) > 0) return;
    const next = q.shift()!;
    if (q.length === 0) queues.delete(triggerId);
    launch(next);
  }

  function fire(trigger: Trigger): FireResult {
    if (trigger.pipelineVersionId === null) {
      throw new UnboundTriggerError(trigger.id);
    }
    if (stopped) {
      return { outcome: 'skipped', reason: 'launcher is shutting down' };
    }

    const active = countActiveRunsForTrigger(db, trigger.id);
    const { policy, max } = trigger.concurrency;

    if (policy === 'skip_if_running') {
      if (active > 0)
        return { outcome: 'skipped', reason: 'a run is already active for this trigger' };
      return { outcome: 'started', runId: launch(trigger) };
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
      return { outcome: 'started', runId: launch(trigger) };
    }

    // `queue`: single-slot, FIFO. Start now if idle, else enqueue (bounded).
    if (active > 0) {
      const q = queues.get(trigger.id) ?? [];
      if (q.length >= maxQueueDepth) {
        return { outcome: 'skipped', reason: `queue is full (max ${maxQueueDepth} pending)` };
      }
      q.push(trigger);
      queues.set(trigger.id, q);
      return { outcome: 'queued' };
    }
    return { outcome: 'started', runId: launch(trigger) };
  }

  async function whenIdle(): Promise<void> {
    // A settling run's `finally` decrements the in-flight count and drains its
    // queue — reliably launching the next queued fire (adding a new in-flight
    // run) BEFORE this `allSettled` resolves, since that `finally` is registered
    // in `launch()`, ahead of this `allSettled`. So `inFlight` is never empty
    // while a queue still holds work: looping until `inFlight` drains awaits
    // every in-flight AND queued run to quiescence.
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }

  function stop(): void {
    stopped = true;
    queues.clear();
  }

  return { fire, whenIdle, stop };
}
