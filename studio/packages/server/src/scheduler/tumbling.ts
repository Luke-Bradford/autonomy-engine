import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  SubstituteError,
  TERMINAL_RUN_EVENT,
  type ScheduledWakeup,
  type Trigger,
  type WindowConfig,
} from '@autonomy-studio/shared';
import { getTrigger, listParsedTriggers } from '../repo/triggers.js';
import { getRun } from '../repo/runs.js';
import { armWakeup, deleteWakeup, listPendingWakeups } from '../repo/scheduled-wakeups.js';
import {
  completeWindow,
  createWindow,
  findUnlinkedRunForWindow,
  getWindowStateByRunId,
  linkWindowRun,
  listWindowStates,
  type WindowKey,
} from '../repo/tumbling-windows.js';
import type { Db } from '../repo/types.js';
import type { RunEventBus } from '../run/event-bus.js';
import { UnboundTriggerError, type FireContext, type FireResult } from '../run/launcher.js';
import type { WakeupFireResult, WakeupHandler } from './alarms.js';
import type { SchedulerLog } from './scheduler.js';

/**
 * #5 S9 — the tumbling-window trigger service: window-domain EVENTS +
 * projection + config-versioned window key + single-fire. ONE module owns the
 * whole window lifecycle (the `lease.ts` precedent — the pieces share the
 * epoch/key scheme and the materialize path): the `window_due` alarm handler,
 * the reconciler (`sync`), the run-terminal completion tap, and the boot
 * reconcile.
 *
 * ## The chain (mirrors `schedule-tick.ts`)
 *
 * `sync()` SEEDS one durable `window_due` row per eligible tumbling trigger —
 * the first window whose END is still ahead (`dueAt = windowEnd`: a window
 * fires when it CLOSES, its data span complete). The handler, inside the
 * clock's transaction: re-checks freshness, arms the NEXT window (atomic with
 * the settle), appends `window.created` + the `waiting` projection row
 * (`repo/tumbling-windows.ts` — the event and its projection write are one
 * transaction), and — post-commit only — MATERIALIZES the window through the
 * launcher. One pending row per trigger, so ≤1-late/no-backfill is STRUCTURAL
 * exactly as it is for schedule ticks: during downtime one row goes overdue,
 * boot fires it once, and the re-arm targets the next window ending in the
 * FUTURE — the skipped-past windows are #5 S10 backfill's job (with #463's
 * per-kind catch-up policy), deliberately NOT this ticket's.
 *
 * ## Identity: the config-versioned window key
 *
 * A window is `(triggerId, configEpoch, windowStart)` — the codex-hardened
 * key. `configEpoch` hashes the GEOMETRY tuple `(frequency, interval,
 * startTime)` (`windowConfigEpoch`): editing the geometry mints a new epoch
 * (the spec's "editing a tumbling trigger mints a new config epoch"), while
 * reverting to an identical config resumes the old epoch — idempotent, the
 * projection's uniqueness still refuses a re-fire. `endTime` is deliberately
 * NOT in the epoch (it bounds WHICH windows fire, not what they ARE — an
 * extension must not re-key already-fired windows); it rides the alarm REF
 * instead, so an `endTime` edit stales the pending row (`ref_stale`) and
 * `sync()` re-seeds under the new bound — the exact S5b-2 bounds-in-ref
 * discipline `schedule-tick.ts` uses.
 *
 * ## Single-fire (three layers)
 *
 * 1. the wakeup outbox's UNIQUE `(kind, dedupeKey)` — one alarm per window;
 * 2. the projection's PK — `createWindow` no-ops (and the handler suppresses)
 *    when the window already exists in ANY status;
 * 3. the partial UNIQUE index on `window.created` events — the hard backstop.
 * Plus the materialize path's LINK-BEFORE-FIRE reconcile: a crash between
 * `launcher.fire` (run row committed) and `linkWindowRun` leaves a `waiting`
 * window WITH a live unlinked run; `findUnlinkedRunForWindow` (the frozen
 * `triggerContext.scheduledTime === windowEnd` join, persisted on started
 * rows since S9) finds it and LINKS instead of firing a second run.
 *
 * ## Liveness for stranded windows
 *
 * A window can strand `waiting` (fire skipped on a full queue / shutdown, or
 * the crash window above). Heals: (a) every later window's materialize pass
 * retries the trigger's stranded windows first (oldest-first, bounded by
 * `MATERIALIZE_BATCH`); (b) boot `reconcile()` sweeps all of them. A trigger
 * whose chain has ENDED (endTime exhausted) heals at (b) only — documented,
 * v1-acceptable (the run-terminal tap needs no liveness help: it is re-derived
 * from the run row, and reconcile covers a crashed tap).
 *
 * ## Deliberate non-behaviours (v1)
 *
 * - `runWindows` do NOT gate tumbling fires (unlike schedule ticks): a
 *   tumbling window is data-completeness-driven, and a run-window suppression
 *   would silently LOSE the window until S10 backfill exists. Event/webhook
 *   fires already set this precedent (only schedule gates).
 * - No `${trigger.windowStart/End}` expression fields — S11 (context-scoped
 *   save-time validation), per the spec's ticket split.
 * - No self-dependency / per-trigger window retry or concurrency — S11.
 * - Overflow windows DO materialize into the S6 durable admission queue (a
 *   `queued` run row each, bounded by the per-trigger depth cap). This brushes
 *   the spec's "blocked/backfill windows live in window state, not as full
 *   runs": that line is about BACKFILL/BLOCKED bulk (S10/S11 — potentially
 *   thousands of windows), where materialize-on-capacity needs the capacity
 *   hook S11 owns. Forward-only S9 produces ≤1 new window per interval, so the
 *   queue depth stays O(pipeline slowness), the cap skips + strand-heal bound
 *   it, and S11 rehomes blocking into window state. A conscious, documented
 *   tradeoff — not an accident.
 */

export const WINDOW_DUE_KIND = 'window_due';

/** How many stranded `waiting` windows one materialize pass retries. Bounds
 * the work a single alarm fire / boot does; the next fire (or boot) continues.
 * Forward-only S9 rarely strands more than a handful (crash/skip races only). */
const MATERIALIZE_BATCH = 25;

/**
 * S1's typed `ref` for `window_due`, validated at ARM time. Carries the window
 * occurrence (`windowStart`/`windowEnd`) AND the full config the row was armed
 * under — epoch for identity, the geometry tuple for diagnosability, `endTime`
 * for bounds-freshness (see the header: an `endTime` edit must stale the row).
 * All values are strings (`WakeupRefSchema` is a record of strings); absent
 * `endTime` is OMITTED, never `undefined` (`serializeRef` keys off
 * `Object.keys` — the `buildScheduleTickRef` discipline).
 */
export const WindowDueRefSchema = z.object({
  triggerId: z.string().min(1),
  epoch: z.string().min(1),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  frequency: z.string().min(1),
  interval: z.string().regex(/^\d+$/),
  startTime: z.string().datetime(),
  endTime: z.string().datetime().optional(),
});
export type WindowDueRef = z.infer<typeof WindowDueRefSchema>;

/** A tumbling trigger `isTumblable` has proven carries a window config. */
export type TumblingTrigger = Trigger & { window: WindowConfig };

/** Eligibility for the window chain: enabled, `tumbling` mode, config present.
 * Binding is deliberately NOT checked (eligibility ≠ firing; the handler and
 * launcher both re-check) — the `isSchedulable` discipline. A TYPE GUARD so
 * callers read `trigger.window` without a cast. */
export function isTumblable(t: Trigger): t is TumblingTrigger {
  return t.enabled && t.mode === 'tumbling' && t.window !== null;
}

/**
 * The config EPOCH: sha256 over the pinned geometry tuple `(frequency,
 * interval, startTime)` — an explicitly enumerated field list, NEVER a
 * whole-object hash (a hash over the full config would re-key — and re-fire —
 * every window on a benign `endTime` extension, and re-epoch every trigger on
 * any future additive config field). Truncated to 16 hex chars (64 bits):
 * collision-irrelevant at per-trigger config-edit cardinality.
 *
 * The hash is over the VERBATIM `startTime` string, not its parsed instant —
 * so a semantically-identical rewrite (`…T00:00:00Z` → `…T00:00:00.000Z`)
 * mints a new epoch and re-covers the same wall-clock windows under new keys.
 * Deliberate, spec-consistent ("editing a tumbling trigger mints a new config
 * epoch" — an `interval` edit re-covers instants the same way), and the
 * projection dedupes nothing across epochs by design; noted so the class of
 * "false edit" is a known property, not a surprise.
 */
export function windowConfigEpoch(config: WindowConfig): string {
  return createHash('sha256')
    .update(`${config.frequency}|${config.interval}|${config.startTime}`)
    .digest('hex')
    .slice(0, 16);
}

const SIZE_MS: Record<WindowConfig['frequency'], number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** Fixed window size in ms — total for every schema-valid config (the
 * frequencies are all fixed-duration UTC units; that is WHY month/week are
 * excluded from `WindowFrequencySchema`). */
export function windowSizeMs(config: WindowConfig): number {
  return SIZE_MS[config.frequency] * config.interval;
}

export interface WindowOccurrence {
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
}

/**
 * The first window whose END is strictly after `afterMs` — the window
 * CONTAINING `afterMs` (or window 0 for a future `startTime`), bounded by
 * `endTime` (`null` = chain exhausted; a PARTIAL trailing window — `endTime`
 * landing mid-window — never fires, its data span would be incomplete). The
 * single occurrence calculator seed + re-arm share, so the two can never
 * disagree — and the structural no-backfill: asking with a late `afterMs`
 * SKIPS the missed windows (S10's job) rather than replaying them.
 */
export function firstWindowEndingAfter(
  config: WindowConfig,
  afterMs: number,
): WindowOccurrence | null {
  const start0 = Date.parse(config.startTime);
  const size = windowSizeMs(config);
  const k = afterMs < start0 ? 0 : Math.floor((afterMs - start0) / size);
  const startMs = start0 + k * size;
  const endMs = startMs + size;
  if (config.endTime !== undefined && endMs > Date.parse(config.endTime)) return null;
  return {
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

/** The canonical `window_due` ref — the SINGLE constructor seed + re-arm use.
 * Precondition: `trigger` is tumblable (both call sites narrow via
 * `isTumblable`). */
export function buildWindowDueRef(
  trigger: TumblingTrigger,
  occurrence: WindowOccurrence,
): WindowDueRef {
  const config = trigger.window;
  const ref: WindowDueRef = {
    triggerId: trigger.id,
    epoch: windowConfigEpoch(config),
    windowStart: occurrence.startIso,
    windowEnd: occurrence.endIso,
    frequency: config.frequency,
    interval: String(config.interval),
    startTime: config.startTime,
  };
  if (config.endTime !== undefined) ref.endTime = config.endTime;
  return ref;
}

/**
 * Is a stored ref still current for `trigger`? The CONFIG half only (epoch +
 * `endTime` bound) — the occurrence half (`windowStart`/`windowEnd`) is the
 * row's identity, not its freshness. A geometry edit changes the epoch; an
 * `endTime`-only edit changes only `endTime`; both read as stale, and both
 * are re-seeded by `sync()` under the new config. The single predicate the
 * reconciler and the fire path share (they must agree, or one would fire a
 * row the other would drop).
 */
export function isWindowRefFresh(trigger: TumblingTrigger, ref: WindowDueRef): boolean {
  const config = trigger.window;
  return windowConfigEpoch(config) === ref.epoch && config.endTime === ref.endTime;
}

/** The run-spawning seam (lazy closure over the app launcher — the
 * `ScheduleTickLauncher` pattern, typed to `FireResult` so a mis-shaped
 * injected launcher is a compile-time error). */
export interface TumblingLauncher {
  fire(trigger: Trigger, fireContext?: FireContext): FireResult;
}

export interface TumblingDeps {
  db: Db;
  /** The alarm clock's `arm` — seeding validates kind + ref at the call site. */
  arm: (input: {
    kind: string;
    ref: Record<string, string>;
    dueAt: number;
    discriminator: string;
  }) => unknown;
  launcher: TumblingLauncher;
  /** REQUIRED (#470): every fault path reports through `log` — an absent
   * logger must not be manufactured as a benign no-op. */
  log: SchedulerLog;
  /** Clock seam (epoch ms); defaults to the wall clock. */
  now?: () => number;
}

export interface TumblingService {
  /** The `window_due` alarm handler — register with the clock. */
  handler: WakeupHandler;
  /** Reconcile durable `window_due` rows against the DB (seed/keep/drop) —
   * idempotent; boot + after every trigger write (`scheduler.sync()`'s
   * composite calls it). */
  sync(): void;
  /**
   * Boot reconcile: settle `running` windows whose run already terminalized
   * (a crashed completion tap), then re-materialize stranded `waiting`
   * windows (link-before-fire). Run AFTER the run-level boot reconcile +
   * `recoverQueued` (so run statuses and DB admission counts are settled) and
   * BEFORE the boot tick — the load-bearing order `index.ts` documents.
   */
  reconcile(): void;
  /** Wire the run-terminal completion tap. Returns the unsubscribe. */
  subscribeCompletion(bus: RunEventBus): () => void;
  /** Stop syncing/materializing (idempotent; the clock owns firing). */
  stop(): void;
}

export function createTumblingService(deps: TumblingDeps): TumblingService {
  const { db, arm, launcher, log } = deps;
  const now = deps.now ?? (() => Date.now());
  let stopped = false;

  function keyOf(row: { triggerId: string; configEpoch: string; windowStart: string }): WindowKey {
    return {
      triggerId: row.triggerId,
      configEpoch: row.configEpoch,
      windowStart: row.windowStart,
    };
  }

  /**
   * Fold a run's CURRENT terminal status (if any) into its window. Shared by
   * the completion tap and the boot reconcile — the tap reads the run ROW (by
   * tap time the terminal status is durably synced), so both paths derive the
   * same fact from the same source. Returns without appending when the run is
   * still live (`completeWindow`'s `running` guard makes a double call safe).
   */
  function settleIfTerminal(key: WindowKey, runId: string): void {
    const run = getRun(db, runId);
    if (run === null) {
      // The linked run row is GONE — an absent fact folded CLOSED as failure
      // (never silently dropped; the #473 discipline).
      completeWindow(db, key, { status: 'failed', runId, runStatus: 'missing' });
      return;
    }
    if (run.status === 'success') {
      completeWindow(db, key, { status: 'succeeded', runId });
    } else if (run.status === 'failure') {
      completeWindow(db, key, { status: 'failed', runId, runStatus: 'failure' });
    } else if (run.status === 'interrupted') {
      // Interrupted IS terminal for the window (finding 6): S11's per-trigger
      // retry policy is what will re-drive a failed window, not a hold-open.
      completeWindow(db, key, { status: 'failed', runId, runStatus: 'interrupted' });
    }
    // pending/queued/running/waiting → still live; the tap completes it later.
  }

  /**
   * Materialize every unlinked `waiting` window of `trigger`'s CURRENT epoch,
   * oldest first (bounded): LINK an existing unlinked run when one matches
   * (the crash heal — never a second fire), else FIRE through the launcher
   * and link the created (started OR queued) run. Stops at the first
   * trigger-level refusal (unbound/binding/skip) — later windows would refuse
   * identically this pass.
   */
  function materializeWindows(trigger: TumblingTrigger): void {
    if (stopped) return;
    const epoch = windowConfigEpoch(trigger.window);
    // Fetch ONE past the batch bound so a full batch is distinguishable from a
    // truncated one — a silent cap would read as "swept everything" when it
    // didn't (the no-silent-caps rule; review WARNING on the first S9 pass).
    const waiting = listWindowStates(db, {
      triggerId: trigger.id,
      configEpoch: epoch,
      status: 'waiting',
      unlinked: true,
      limit: MATERIALIZE_BATCH + 1,
    });
    if (waiting.length > MATERIALIZE_BATCH) {
      // Operator-visible: a backlog past the batch bound (e.g. persistent
      // launcher refusals) is NOT dropped — the excess stays `waiting` and the
      // next window fire / boot reconcile continues the sweep — but the
      // truncation itself must be signalled, not silent.
      log.warn(
        { triggerId: trigger.id, batch: MATERIALIZE_BATCH },
        'tumbling: stranded-window sweep truncated at the batch bound — more waiting windows remain (retried next pass/boot)',
      );
      waiting.length = MATERIALIZE_BATCH;
    }
    for (const row of waiting) {
      const key = keyOf(row);
      // LINK-BEFORE-FIRE (single-fire under crash): an unlinked run whose
      // frozen `triggerContext.scheduledTime` is this window's end is THIS
      // window's run from a fire whose link never committed.
      const existingRunId = findUnlinkedRunForWindow(db, trigger.id, row.windowEnd);
      if (existingRunId !== null) {
        if (linkWindowRun(db, key, existingRunId, 'reconcile')) {
          settleIfTerminal(key, existingRunId);
        }
        continue;
      }
      let result: FireResult;
      try {
        result = launcher.fire(trigger, { scheduledTime: row.windowEnd });
      } catch (err) {
        if (err instanceof UnboundTriggerError) {
          log.debug({ triggerId: trigger.id }, 'tumbling: skip — trigger became unbound');
          return;
        }
        if (err instanceof SubstituteError) {
          // A trigger param binding that cannot resolve — operator-visible
          // (the schedule-tick severity rationale): the trigger's windows stop
          // materializing with no run to look at.
          log.warn(
            { err, triggerId: trigger.id },
            'tumbling: skip — trigger param binding could not be resolved',
          );
          return;
        }
        throw err;
      }
      if (result.outcome === 'skipped') {
        // Queue-full or shutdown. The window STAYS `waiting` — healed by the
        // next window's materialize pass or boot reconcile (the header's
        // liveness story), never dropped.
        log.warn(
          { triggerId: trigger.id, windowStart: row.windowStart, reason: result.reason },
          'tumbling: window fire skipped; window stays waiting',
        );
        return;
      }
      if (result.runId === undefined) {
        // Unreachable post-S9 (`started` and `queued` both report runId) —
        // fail LOUD if a future launcher change breaks the contract.
        log.error(
          { triggerId: trigger.id, windowStart: row.windowStart, outcome: result.outcome },
          'tumbling: fire returned no runId; window stays waiting',
        );
        return;
      }
      if (!linkWindowRun(db, key, result.runId, 'fire')) {
        // The window lost its `waiting` guard between the scan and this link —
        // a concurrent linker won (their run serves the window) and the run
        // fired HERE is an orphan. Unreachable in-process (materialize is
        // synchronous end-to-end), so fail LOUD like the runId-contract branch
        // above rather than silently strand a live run.
        log.error(
          { triggerId: trigger.id, windowStart: row.windowStart, runId: result.runId },
          'tumbling: fired run could not be linked (window no longer waiting) — orphaned run',
        );
      }
    }
  }

  const handler: WakeupHandler = {
    kind: WINDOW_DUE_KIND,
    refSchema: WindowDueRefSchema,
    fire(row: ScheduledWakeup, delivery, tx: Db): WakeupFireResult {
      const ref = WindowDueRefSchema.parse(row.ref);
      const trigger = getTrigger(tx, ref.triggerId);

      // Terminal suppressions (the schedule-tick discipline): settle, never
      // re-arm, never throw — `sync()` seeds a new chain when warranted.
      if (trigger === null || !isTumblable(trigger)) {
        return { status: 'suppressed', reason: 'trigger_not_tumbling' };
      }
      if (trigger.pipelineVersionId === null) {
        return { status: 'suppressed', reason: 'trigger_unbound' };
      }
      if (!isWindowRefFresh(trigger, ref)) {
        return { status: 'suppressed', reason: 'ref_stale' };
      }

      // Continue the chain BEFORE the fire decision (schedule-tick's rule):
      // armed in-tx, atomic with the settle (`armWakeup` nests as a
      // SAVEPOINT). `firstWindowEndingAfter(firedAt)` skips windows the
      // downtime missed — structural no-backfill — and returns null when
      // `endTime` exhausts the chain.
      const next = firstWindowEndingAfter(trigger.window, delivery.firedAt);
      if (next !== null) {
        armWakeup(tx, {
          kind: WINDOW_DUE_KIND,
          ref: buildWindowDueRef(trigger, next),
          dueAt: next.endMs,
          discriminator: `window-${next.startMs}`,
        });
      }

      // SINGLE-FIRE: create the window (event + `waiting` projection row, one
      // transaction). An already-existing window — a duplicate delivery, or an
      // `endTime`-edit re-arm of a window that fired under the previous ref —
      // is a suppression, NOT a second fire.
      const epoch = windowConfigEpoch(trigger.window);
      const created = createWindow(tx, {
        triggerId: trigger.id,
        configEpoch: epoch,
        windowStart: ref.windowStart,
        windowEnd: ref.windowEnd,
        geometry: {
          frequency: trigger.window.frequency,
          interval: trigger.window.interval,
          startTime: trigger.window.startTime,
        },
      });
      if (!created) {
        return { status: 'suppressed', reason: 'window_already_exists' };
      }

      // MATERIALIZE post-commit only (`launcher.fire` spawns a run — the
      // clock's contract forbids that inside the fire tx). The pass also
      // retries any earlier stranded windows, oldest first, so this window
      // materializes behind them in order.
      return {
        status: 'fired',
        afterCommit: () => {
          materializeWindows(trigger);
        },
      };
    },
  };

  function seed(trigger: TumblingTrigger): void {
    // Plain upsert-if-absent arm — the `created===false` guard (#465's trap
    // shape) is deliberately absent, resting on a temporal argument: a SETTLED
    // `window_due` row's window always ENDED at or before its settle time,
    // while seed/re-arm only ever target a window ending strictly after
    // `now()`, so under a monotonic wall clock the same `(kind, dedupeKey)`
    // can never recur. (A backwards clock jump could collide once; the chain
    // then self-heals at the next sync after the clock re-passes the end.)
    const next = firstWindowEndingAfter(trigger.window, now());
    // Exhausted (endTime passed, or a partial trailing window): nothing to arm.
    if (next === null) return;
    arm({
      kind: WINDOW_DUE_KIND,
      ref: buildWindowDueRef(trigger, next),
      dueAt: next.endMs,
      discriminator: `window-${next.startMs}`,
    });
  }

  function sync(): void {
    if (stopped) return;
    // The same two-pass, non-transactional reconcile as `scheduler.ts` — and
    // benign for the same reason: boot runs sync() before the clock ticks, so
    // a crash between drop and re-seed only costs the crash's own downtime.
    let all;
    try {
      all = listParsedTriggers(db, (triggerId, err) =>
        log.warn({ err, triggerId }, 'tumbling: skipping unparseable trigger row'),
      );
    } catch (err) {
      log.error({ err }, 'tumbling: failed to list triggers on sync');
      return;
    }

    const eligible = new Map<string, TumblingTrigger>();
    for (const t of all) {
      if (isTumblable(t)) eligible.set(t.id, t);
    }

    // Pass 1 — drop dead/stale rows; remember valid holders. DELETE (not
    // cancel) frees the `(kind, dedupeKey)` so a disable→re-enable within one
    // window can re-arm the SAME window (`scheduler.ts`'s reasoning).
    const keep = new Set<string>();
    for (const row of listPendingWakeups(db)) {
      if (row.kind !== WINDOW_DUE_KIND) continue;
      const parsed = WindowDueRefSchema.safeParse(row.ref);
      if (!parsed.success) {
        log.warn(
          { wakeupId: row.id, err: parsed.error },
          'tumbling: deleting unparseable window_due ref',
        );
        deleteWakeup(db, row.id);
        continue;
      }
      const trigger = eligible.get(parsed.data.triggerId);
      if (trigger === undefined || !isWindowRefFresh(trigger, parsed.data)) {
        deleteWakeup(db, row.id);
      } else {
        keep.add(trigger.id);
      }
    }

    // Pass 2 — seed newly-eligible triggers (one pending row per trigger).
    for (const [id, trigger] of eligible) {
      if (keep.has(id)) continue;
      try {
        seed(trigger);
      } catch (err) {
        // One poison trigger must never dark-out the whole reconcile.
        log.warn({ err, triggerId: id }, 'tumbling: failed to seed window chain — skipping');
      }
    }
  }

  function reconcile(): void {
    if (stopped) return;
    // 1 — `running` windows whose run already terminalized (or vanished): the
    // completion tap is in-memory, so a crash between a run's terminal event
    // and the window append loses the transition; re-derive it from the run
    // row (at-least-once, `completeWindow`'s guard dedupes).
    for (const row of listWindowStates(db, { status: 'running' })) {
      if (row.runId === null) continue; // unreachable: link + flip are one tx
      try {
        settleIfTerminal(keyOf(row), row.runId);
      } catch (err) {
        log.error(
          { err, triggerId: row.triggerId, windowStart: row.windowStart },
          'tumbling: reconcile failed to settle window',
        );
      }
    }
    // 2 — stranded `waiting` windows of still-current triggers (crash between
    // the window tx and the fire, or a skipped fire): link-before-fire, then
    // fire. A stale-epoch or no-longer-eligible trigger's windows stay inert.
    const strandedTriggerIds = new Set(
      listWindowStates(db, { status: 'waiting', unlinked: true }).map((r) => r.triggerId),
    );
    for (const triggerId of strandedTriggerIds) {
      const trigger = getTrigger(db, triggerId);
      if (trigger === null || !isTumblable(trigger) || trigger.pipelineVersionId === null) {
        continue;
      }
      try {
        materializeWindows(trigger);
      } catch (err) {
        log.error({ err, triggerId }, 'tumbling: reconcile failed to materialize windows');
      }
    }
  }

  function subscribeCompletion(bus: RunEventBus): () => void {
    return bus.subscribeAll((event) => {
      if (!(TERMINAL_RUN_EVENT as ReadonlySet<string>).has(event.type)) return;
      const runId = event.runId;
      // Deferred + guarded exactly like the launcher's #629 drain tap: the
      // microtask runs after the publishing frame (the run row's terminal
      // status is durably synced by then), and a fault here must be logged,
      // never an unhandled rejection.
      queueMicrotask(() => {
        try {
          if (stopped) return;
          const row = getWindowStateByRunId(db, runId);
          if (row === null || row.status !== 'running') return;
          settleIfTerminal(keyOf(row), runId);
        } catch (err) {
          log.error({ err, runId }, 'tumbling: window completion tap failed');
        }
      });
    });
  }

  function stop(): void {
    stopped = true;
  }

  return { handler, sync, reconcile, subscribeCompletion, stop };
}
