import type { Trigger } from '@autonomy-studio/shared';
import { countActiveRunsForTrigger, createRun, getRun, updateRun } from '../repo/runs.js';
import { startRun, type DriverDeps } from './driver.js';

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

/** The outcome of a single `fire()`. */
export type FireOutcome = 'started' | 'queued' | 'skipped';

export interface FireResult {
  outcome: FireOutcome;
  /** The created run's id — present iff `outcome === 'started'`. */
  runId?: string;
  /** Why admission was refused — present iff `outcome === 'skipped'`. */
  reason?: string;
}

/** Thrown by `fire()` when a trigger has no bound pipeline version. */
export class UnboundTriggerError extends Error {
  constructor(public readonly triggerId: string) {
    super(`trigger '${triggerId}' has no bound pipeline version — an unbound trigger never fires`);
    this.name = 'UnboundTriggerError';
  }
}

/** Minimal logger seam (Fastify's `log` satisfies it); optional for tests. */
export interface LauncherLog {
  error(obj: unknown, msg?: string): void;
}

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

export interface RunLauncherDeps extends DriverDeps {
  log?: LauncherLog;
}

const TERMINAL_RUN_STATUSES = new Set(['success', 'failure', 'skipped', 'interrupted']);

export function createRunLauncher(deps: RunLauncherDeps): RunLauncher {
  const { db } = deps;
  const inFlight = new Set<Promise<void>>();
  /** Per-trigger FIFO of fires waiting for the (single) `queue` slot to free. */
  const queues = new Map<string, Trigger[]>();
  let stopped = false;

  /** Create the run row (durable, `pending`) and drive it in the background. */
  function launch(trigger: Trigger): string {
    // Caller guarantees non-null (fire() throws UnboundTriggerError otherwise).
    const pipelineVersionId = trigger.pipelineVersionId as string;
    // The row is created `pending`, then `startRun` (below) flips it to
    // `running` via `run.started` — both are CONSECUTIVE synchronous writes in
    // this same tick (there is no `await` between them: `await startRun(...)`
    // runs startRun's synchronous prefix — the `run.started` append + lifecycle
    // sync — before it suspends). A hard crash (SIGKILL/power-loss) at that
    // exact instruction boundary could orphan a `pending` row with no event log
    // that the boot reconciler (which sweeps `running` rows) would not clear,
    // wedging a single-slot trigger's concurrency gate. The window is sub-tick
    // and operator-recoverable (delete the run row / re-fire); a reconciler
    // `pending`-orphan sweep is the durable close and is left to a follow-up so
    // this slice stays scoped to manual fire + concurrency.
    const run = createRun(db, {
      ownerId: trigger.ownerId,
      pipelineVersionId,
      triggerId: trigger.id,
      parentRunId: null,
      params: trigger.params,
    });

    const p = (async () => {
      try {
        await startRun(deps, run);
      } catch (err) {
        deps.log?.error({ err, runId: run.id, triggerId: trigger.id }, 'run drive failed');
        // Terminalize as `interrupted` ONLY if the run is not already terminal,
        // so an unexpected fault frees the trigger's slot and never leaves a
        // zombie `running`/`pending` row — without clobbering a run that
        // actually finished before the throw.
        const current = getRun(db, run.id);
        if (current !== null && !TERMINAL_RUN_STATUSES.has(current.status)) {
          updateRun(db, run.id, { status: 'interrupted', finishedAt: Date.now() });
        }
      }
    })();

    inFlight.add(p);
    void p.finally(() => {
      inFlight.delete(p);
      drainQueue(trigger.id);
    });
    return run.id;
  }

  /** When a `queue`-policy run settles, start the next queued fire if the slot
   * is now free. A no-op for other policies (they never enqueue). */
  function drainQueue(triggerId: string): void {
    if (stopped) return;
    const q = queues.get(triggerId);
    if (q === undefined || q.length === 0) return;
    if (countActiveRunsForTrigger(db, triggerId) > 0) return;
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
      // `max` is guaranteed present for `parallel` by ConcurrencySchema.
      const cap = max as number;
      if (active >= cap) {
        return { outcome: 'skipped', reason: `parallel cap of ${cap} reached` };
      }
      return { outcome: 'started', runId: launch(trigger) };
    }

    // `queue`: single-slot, FIFO. Start now if idle, else enqueue.
    if (active > 0) {
      const q = queues.get(trigger.id) ?? [];
      q.push(trigger);
      queues.set(trigger.id, q);
      return { outcome: 'queued' };
    }
    return { outcome: 'started', runId: launch(trigger) };
  }

  async function whenIdle(): Promise<void> {
    // Each settling run's `finally` drains its queue (possibly adding a new
    // in-flight run) BEFORE `allSettled` resolves — the `finally` is registered
    // in `launch()` (during `fire()`), ahead of this `allSettled` — so the loop
    // re-checks and never returns with work still pending.
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
