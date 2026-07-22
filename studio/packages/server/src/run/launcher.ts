import type {
  FireOutcome,
  FireResult,
  Run,
  Trigger,
  TriggerContext,
} from '@autonomy-studio/shared';
import {
  assertJsonReplaySafe,
  resolveTriggerBindings,
  TERMINAL_RUN_EVENT,
} from '@autonomy-studio/shared';
import {
  admitQueuedRun,
  countActiveRunsForPipeline,
  countActiveRunsForTrigger,
  countQueuedRunsForTrigger,
  createRun,
  getRun,
  listRuns,
  nextQueuedRunForTrigger,
  queuedTriggerCandidatesForPipeline,
} from '../repo/runs.js';
import { getPipelineIdForVersion } from '../repo/pipeline-versions.js';
import { getPipeline } from '../repo/pipelines.js';
import { getTrigger } from '../repo/triggers.js';
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
 *   2. **Concurrency admission — BOTH-MUST-PASS (#5 S6b).** Per the trigger's
 *      policy AND the pipeline's `concurrency` cap, a fire is either started
 *      immediately, queued, or skipped — gated on DB counts
 *      (`countActiveRunsForTrigger` + `countActiveRunsForPipeline`) so the
 *      gate stays correct across a restart. Per-pipeline overflow QUEUES
 *      (durable), whatever the trigger policy; the trigger-level skip rules
 *      apply first.
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

/**
 * The `reason` on the TRANSIENT shutdown skip `fire()` returns while the
 * launcher is stopping. Exported as the SSOT the delivery-ledger seam
 * (`routes/fire-through-ledger.ts`) compares against: a shutdown skip must
 * RELEASE a claimed idempotency key, never finalize it — recording a durable
 * `skipped` for a purely transient condition would serve the sender's
 * post-restart retry of the same key as `duplicate` and silently lose the
 * event.
 */
export const SHUTDOWN_SKIP_REASON = 'launcher is shutting down';

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
   * #5 S6a/S6b — drain any durably `queued` fires this launcher instance has
   * not yet picked up: for each PIPELINE with queued rows, kick a fair drain
   * (admitting across its triggers, least-recently-admitted first, up to BOTH
   * live capacities; any remaining waiters follow on settle). Called ONCE at
   * boot, AFTER the boot reconciler (which resumes `running` rows) so the
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

/**
 * The ONE validity rule for a `parallel` trigger's concurrency cap, shared by the
 * admission path (`fire`) and the queue drain (`drainPipelineQueue` via
 * `admissionCapacity`) so both read a `max` the same way. Returns the
 * positive-integer cap, or `null` for a missing/invalid one (a row written before
 * `ConcurrencySchema`'s refinement existed, or restored from an older export).
 * Each caller FAILS CLOSED on `null` in its own way — `fire` skips the fire;
 * the drain falls back to a single slot so already-`queued` rows still drain
 * rather than strand — but neither ever coerces a bad cap to `NaN` (an
 * `active >= NaN` / `active < NaN` comparison is always false, which would admit
 * unbounded or strand the queue).
 */
function validParallelMax(max: number | undefined): number | null {
  return max !== undefined && Number.isInteger(max) && max >= 1 ? max : null;
}

export function createRunLauncher(deps: RunLauncherDeps): RunLauncher {
  const { db } = deps;
  const inFlight = new Set<Promise<void>>();
  const maxQueueDepth = deps.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
  let stopped = false;

  /**
   * Drive an already-created `pending` run in the background (the shared tail of
   * an immediate `launch()` and a queue `drainPipelineQueue()` admission). The run row
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
   * The settle `finally` drains the run's PIPELINE queue on the DB counts
   * (`drainPipelineQueue`, #5 S6b), so the NEXT queued fire — from ANY of the
   * pipeline's triggers — is admitted as soon as this drive
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
      // #5 S6b — the drain is PIPELINE-scoped: this run's settle may free a
      // pipeline slot another trigger's queued fire is waiting on, so keying
      // the drain by triggerId would strand cross-trigger waiters.
      const pipelineId = getPipelineIdForVersion(db, run.pipelineVersionId);
      if (pipelineId !== null) drainPipelineQueue(pipelineId);
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
      // #5 S9 — persist the frozen fire-time context on STARTED rows too (the
      // queued path always did). Durable BEFORE the drive's `run.triggerContext`
      // event (which lands a microtask later), so a crash in that window still
      // leaves a run↔fire join on the row — the tumbling reconcile's
      // link-before-fire check (`findUnlinkedRunForWindow`) depends on it.
      triggerContext,
    });
    driveRun(run, triggerContext);
    return run.id;
  }

  /**
   * #631 — the trigger's LIVE admission capacity for a queue drain: how many
   * concurrent runs its CURRENT policy allows. `parallel` → its validated cap
   * (fail-closed to a single slot on a missing/invalid cap, logged so the
   * corrupted row stays diagnosable); `queue` / `skip_if_running` / a deleted
   * (null) trigger → 1 (both non-parallel policies are single-slot; an orphaned
   * row still drains FIFO one-at-a-time). Read fresh from the DB on every drain so
   * a `queue`→`parallel` policy edit takes effect on rows already queued. */
  function admissionCapacity(trigger: Trigger | null): number {
    if (trigger === null || trigger.concurrency.policy !== 'parallel') return 1;
    const max = validParallelMax(trigger.concurrency.max);
    if (max === null) {
      deps.log?.warn?.(
        { triggerId: trigger.id, concurrency: trigger.concurrency },
        'parallel trigger has no valid concurrency max; draining queue single-slot (fail-closed)',
      );
      return 1;
    }
    return max;
  }

  /**
   * #5 S6b — the pipeline's LIVE admission capacity: `concurrency` on the
   * MUTABLE `pipelines` row (max concurrent runs across ALL its triggers, plus
   * any trigger-less `call_pipeline` child bound to one of its versions).
   * `null` = uncapped → `Infinity`. Read fresh on
   * every fire/drain (#631's precedent), so an operator edit applies to rows
   * already queued. The stored cap is READ-lenient (`PipelineSchema`), so an
   * out-of-band-corrupted value must FAIL CLOSED here: a non-positive-integer
   * cap degrades to a SINGLE slot (logged) — admission keeps moving one at a
   * time rather than refusing everything (`Infinity` would fail OPEN) or
   * comparing against `NaN` (which admits unbounded — see `validParallelMax`).
   * A MISSING pipeline row fails closed the same way: it is unreachable
   * through FK integrity (every fire/drain resolves the pipeline via an
   * existing version row, and `pipelines → pipeline_versions` CASCADE is
   * blocked by `pipeline_versions → runs` RESTRICT while any run row exists),
   * but if a corrupted DB ever presents it, an ABSENT row is an absent fact —
   * not evidence of "uncapped" — so it must not fail OPEN to `Infinity`.
   */
  function pipelineCapacity(pipelineId: string): number {
    const pipeline = getPipeline(db, pipelineId);
    if (pipeline === null) {
      deps.log?.warn?.(
        { pipelineId },
        'pipeline row missing during admission; failing closed to a single slot',
      );
      return 1;
    }
    if (pipeline.concurrency === null) return Infinity;
    const cap = pipeline.concurrency;
    if (!Number.isInteger(cap) || cap < 1) {
      deps.log?.warn?.(
        { pipelineId, concurrency: cap },
        'pipeline has an invalid concurrency cap; failing closed to a single slot',
      );
      return 1;
    }
    return cap;
  }

  /** Both-must-pass, pipeline half: is there a FREE pipeline slot? Skips the
   * count query entirely for the (common) uncapped pipeline. */
  function pipelineHasRoom(pipelineId: string): boolean {
    const cap = pipelineCapacity(pipelineId);
    if (cap === Infinity) return true;
    return countActiveRunsForPipeline(db, pipelineId) < cap;
  }

  /**
   * #5 S6a/S6b / #631 — when a run's drive ends, a terminal event publishes
   * (#629), or at boot via `recoverQueued`, admit the PIPELINE's durably-`queued`
   * fires while BOTH gates have room (both-must-pass, the same rule `fire()`
   * applies): a free pipeline slot AND the candidate trigger's own free slot.
   * Every capacity is read FRESH per admission (#631): the trigger's from its
   * CURRENT policy (`admissionCapacity` — a `queue`→`parallel` edit applies to
   * rows already queued; conscious non-goal: FIFO across that transition window
   * is not preserved, since a NEW fire under the edited `parallel` policy gates
   * on `active >= cap` alone and can start ahead of an older still-`queued` row
   * — `parallel` offers no ordering guarantee. The same holds for a `parallel`
   * trigger's own pipeline-overflow rows: a later fire that finds pipeline room
   * starts ahead of them by design), and the pipeline's from its mutable row
   * (`pipelineCapacity`).
   *
   * FAIRNESS (the spec's "per-trigger round-robin (no monopoly)"): candidates
   * come from `queuedTriggerCandidatesForPipeline` ordered least-recently-
   * ADMITTED first (never-served first, then oldest `queuedAt`, then
   * `triggerId`) — a durable round-robin derived from re-stamped `started_at`,
   * no in-memory rotation pointer, restart-safe. Within a trigger the order
   * stays strict `queuedAt` FIFO (`nextQueuedRunForTrigger`). A trigger at its
   * OWN capacity is skipped, never allowed to stall other triggers' waiters.
   * One admission per outer iteration, so the pipeline count is re-read before
   * each next admit and the cap is honoured mid-drain.
   *
   * Gated on DB counts, NOT in-memory state — restart-safe under S4's
   * lease/slot split (`waiting` released its slot; `queued` is pre-admission).
   * Each admission flips its row `queued → pending` SYNCHRONOUSLY
   * (`admitQueuedRun`, idempotent via its `status = 'queued'` guard), so the
   * next iteration's counts already reflect it. A run stuck at `running` after
   * its drive ended (hung activity) legitimately holds its slot until the boot
   * reconciler sweeps it — the durable waiters keep (S6a's recoverability).
   *
   * KNOWN FOLLOW-UP (later #5 S6 slice): the `waiting_concurrency` re-admission
   * gate — a RESUMED parked run re-checking both caps rather than transiently
   * exceeding them (the spec's "by default" opt-in).
   *
   * A no-op when capacity is full or the queue is empty. */
  function drainPipelineQueue(pipelineId: string): void {
    if (stopped) return;
    for (;;) {
      if (!pipelineHasRoom(pipelineId)) return;
      const candidates = queuedTriggerCandidatesForPipeline(db, pipelineId);
      let admitted = false;
      for (const candidate of candidates) {
        const triggerCapacity = admissionCapacity(getTrigger(db, candidate.triggerId));
        if (countActiveRunsForTrigger(db, candidate.triggerId) >= triggerCapacity) continue;
        // PIPELINE-scoped pick: a trigger rebound to another pipeline mid-queue
        // can hold a globally-older FOREIGN-pipeline row — admitting that here
        // would drive it under THIS pipeline's gate, breaching the other's cap.
        const next = nextQueuedRunForTrigger(db, candidate.triggerId, pipelineId);
        if (next === null) continue;
        // A concurrent/duplicate drain that lost the race gets `null` — try the
        // next candidate rather than aborting the whole drain.
        const row = admitQueuedRun(db, next.id);
        if (row === null) continue;
        // The frozen fire-time context rides the row (`trigger_context`) so a
        // delayed admission still seeds `${trigger.scheduledTime}` with the
        // occurrence that fired it.
        driveRun(row, row.triggerContext ?? undefined);
        admitted = true;
        break;
      }
      if (!admitted) return;
    }
  }

  function fire(trigger: Trigger, fireContext?: FireContext): FireResult {
    if (trigger.pipelineVersionId === null) {
      throw new UnboundTriggerError(trigger.id);
    }
    if (stopped) {
      return { outcome: 'skipped', reason: SHUTDOWN_SKIP_REASON };
    }

    // #547 boundary 3 (#5 S8) — refuse a non-finite number ANYWHERE in the fire
    // body BEFORE it is frozen into the durable `run.triggerContext`:
    // `JSON.parse('{"x":1e999}')` is valid JSON yielding `Infinity`, which
    // `JSON.stringify` would persist as `null` — the live folded RunState and
    // the replayed log silently disagreeing. One seat for every feeder (webhook
    // raw body, events payload); throws `SubstituteError`, which every fire
    // caller already maps (manual → 400, webhook/events → record-skip). NOTE
    // the walker's depth bound (`MAX_CONFIG_DEPTH`, 64) rides this refusal: a
    // deeper body is not itself a replay hazard, but what cannot be safely
    // traversed cannot be verified, and unverifiable fails closed — a
    // deliberate, documented behaviour change for a >64-level webhook body
    // (see `deriveBody` in routes/webhooks.ts).
    assertJsonReplaySafe('trigger body', fireContext?.body ?? null);

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

    // #5 S6b — the per-PIPELINE half of both-must-pass admission. Resolved via
    // the trigger's bound version (a run row only carries `pipelineVersionId`;
    // the version row carries the pipeline identity). A version whose row is
    // GONE resolves `null` → the gate is bypassed (uncapped): such a fire can
    // never run anyway — the drive's doc-resolve failure path (#508 territory)
    // owns that fault, and refusing it HERE would mask it as a capacity skip.
    const pipelineId = getPipelineIdForVersion(db, trigger.pipelineVersionId);
    const pipelineFull = pipelineId !== null && !pipelineHasRoom(pipelineId);

    /** Per-pipeline overflow QUEUES (spec: "max concurrent runs across all its
     * triggers; overflow queues") for EVERY trigger policy — a durable `queued`
     * row on the same S6a substrate, bounded by the per-trigger depth cap. */
    function enqueue(): FireResult {
      const queuedCount = countQueuedRunsForTrigger(db, trigger.id);
      if (queuedCount >= maxQueueDepth) {
        return { outcome: 'skipped', reason: `queue is full (max ${maxQueueDepth} pending)` };
      }
      const queued = createRun(db, {
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
      // #5 S9 — report the durable row's id (it always existed; `queued` just
      // went unreported pre-S9). The tumbling completion chain links a QUEUED
      // run to its window by this id — without it a queued window run could
      // never terminalize its window.
      return { outcome: 'queued', runId: queued.id };
    }

    if (policy === 'skip_if_running') {
      // The trigger-level SKIP applies before queueing (spec). A queued row is
      // an OUTSTANDING fire: without counting it, pipeline-overflow queueing
      // would let this policy stack multiple outstanding fires.
      if (active > 0)
        return { outcome: 'skipped', reason: 'a run is already active for this trigger' };
      if (countQueuedRunsForTrigger(db, trigger.id) > 0)
        return { outcome: 'skipped', reason: 'a fire is already queued for this trigger' };
      if (pipelineFull) return enqueue();
      return { outcome: 'started', runId: launch(trigger, triggerContext, mergedParams) };
    }

    if (policy === 'parallel') {
      // `max` is guaranteed present + positive for `parallel` by
      // ConcurrencySchema. Defense-in-depth against a row written before that
      // refinement existed (or restored from an older export): a missing/invalid
      // cap must FAIL CLOSED (skip), never coerce to NaN and let `active >= NaN`
      // admit every fire unbounded. `validParallelMax` is the shared validity rule
      // the queue drain reads too (#631).
      const cap = validParallelMax(max);
      if (cap === null) {
        return {
          outcome: 'skipped',
          reason: 'parallel trigger has no valid concurrency max (misconfigured)',
        };
      }
      if (active >= cap) {
        return { outcome: 'skipped', reason: `parallel cap of ${cap} reached` };
      }
      // Trigger cap clear but pipeline full → QUEUE (the one path a `parallel`
      // trigger enqueues). Conscious non-goal, mirroring #631's transition
      // window: a LATER fire that finds pipeline room starts ahead of these
      // rows — `parallel` offers no ordering guarantee.
      if (pipelineFull) return enqueue();
      return { outcome: 'started', runId: launch(trigger, triggerContext, mergedParams) };
    }

    // `queue`: single-slot, FIFO. Start now ONLY if the slot is free AND nothing
    // is already queued ahead AND the pipeline has room — else enqueue a durable
    // `queued` row (bounded). Checking the queue depth as well as the active
    // count keeps FIFO across the boot window: a fire that arrives while queued
    // rows still await draining must fall in BEHIND them, not jump the slot.
    if (active > 0 || countQueuedRunsForTrigger(db, trigger.id) > 0 || pipelineFull) {
      return enqueue();
    }
    return { outcome: 'started', runId: launch(trigger, triggerContext, mergedParams) };
  }

  function recoverQueued(): void {
    if (stopped) return;
    // Kick a drain for each PIPELINE that has durable `queued` rows this instance
    // has not yet picked up (a previous process enqueued them, or this one did
    // before a crash). One drain admits fairly across the pipeline's triggers up
    // to BOTH live capacities (#631/S6b); any remaining waiters cascade on settle
    // via `driveRun`'s `finally`. Run once at boot, AFTER the reconciler has
    // resumed `running` rows so the per-drain DB active-count already reflects
    // them (no double-admit).
    const pipelineIds = new Set<string>();
    for (const run of listRuns(db, { status: 'queued' })) {
      const pipelineId = getPipelineIdForVersion(db, run.pipelineVersionId);
      if (pipelineId !== null) pipelineIds.add(pipelineId);
    }
    for (const pipelineId of pipelineIds) drainPipelineQueue(pipelineId);
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

  /**
   * #629 — drain the durable admission queue on ANY run terminalization, not just
   * the launcher-driven ones. `driveRun`'s `finally` covers a run THIS launcher
   * drove; a run whose slot-freeing terminalization happens elsewhere (a
   * retry-alarm or external-wait resume of a previously-parked run pumps it to
   * terminal OUTSIDE `driveRun`) never reaches that `finally`, so a fire that
   * queued during that run's `running` window would sit `queued` with the slot
   * free until the next launcher-driven settle for the trigger or the next boot's
   * `recoverQueued`. Subscribing to the run-event bus closes that latency cliff:
   * every terminal event (`run.finished`/`run.interrupted`, whoever drove it)
   * kicks a drain of that run's trigger queue.
   *
   * DEFERRED to a microtask, deliberately: the terminal event is PUBLISHED before
   * `syncRunLifecycle` flips `runs.status` (both the driver's `driveFinishRun` and
   * `terminalizeInterrupted` append+publish first, sync second). A synchronous
   * drain here would read the finishing run as still `running` and admit nothing;
   * one microtask later its status is durably terminal, so the DB active-count the
   * drain gates on is correct. (The alarm path already publishes post-commit, so
   * it too is settled by the time this runs — a microtask is uniformly safe.)
   *
   * The whole body runs in a DETACHED microtask, so a fault here is NOT isolated
   * by the bus's `onListenerError` (which only wraps the synchronous publish call)
   * — hence the local try/catch. The drain reads are best-effort: a
   * drain that fails (a DB blip) must be logged, never crash the process as an
   * unhandled rejection. `drainPipelineQueue` re-checks `stopped` itself.
   *
   * For a run THIS launcher drove, this drains REDUNDANTLY with `driveRun`'s
   * `finally` (which already ran, synchronously). That is harmless — the drain
   * + `admitQueuedRun`'s `status = 'queued'` guard are idempotent, so the second
   * drain finds capacity full or the queue empty and admits nothing — and is the
   * accepted cost of a bus tap over a targeted callback: ONE hook covers every
   * terminalization source without the launcher having to be threaded into the
   * alarm handlers + external-wait completer that terminalize out of band.
   */
  function subscribeTerminalDrain(bus: NonNullable<RunLauncherDeps['bus']>): () => void {
    return bus.subscribeAll((event) => {
      if (!(TERMINAL_RUN_EVENT as ReadonlySet<string>).has(event.type)) return;
      const runId = event.runId;
      queueMicrotask(() => {
        try {
          if (stopped) return;
          const run = getRun(db, runId);
          if (run === null) return;
          // #5 S6b — drain by the run's PIPELINE, not its trigger: even a
          // trigger-less run (a `call_pipeline` child) occupies a pipeline slot,
          // so its terminalization can free capacity a queued fire from any of
          // the pipeline's triggers is waiting on.
          const pipelineId = getPipelineIdForVersion(db, run.pipelineVersionId);
          if (pipelineId !== null) drainPipelineQueue(pipelineId);
        } catch (err) {
          deps.log?.error?.({ err, runId }, 'queue drain on run terminalization failed');
        }
      });
    });
  }

  // Subscribe only when a bus is wired (production always is; many driver tests
  // construct a launcher without one — they keep the pre-#629 behaviour).
  const unsubscribeTerminalDrain = deps.bus ? subscribeTerminalDrain(deps.bus) : undefined;

  function stop(): void {
    // #5 S6a — only halt accepting/draining. Durable `queued` rows are NOT
    // cleared (there is no in-memory queue to clear anymore); they persist and a
    // later `recoverQueued()` picks them up. In-flight drives settle on their own.
    stopped = true;
    // #629 — drop the bus subscription so a terminal event after shutdown neither
    // drains nor keeps this instance reachable (idempotent; safe if never set).
    unsubscribeTerminalDrain?.();
  }

  return { fire, whenIdle, recoverQueued, stop };
}
