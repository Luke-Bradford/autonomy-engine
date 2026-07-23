import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  SubstituteError,
  TERMINAL_RUN_EVENT,
  windowSizeSeconds,
  type ScheduledWakeup,
  type Trigger,
  type WindowConfig,
} from '@autonomy-studio/shared';
import { getParsedTrigger, listParsedTriggers } from '../repo/triggers.js';
import { getRun } from '../repo/runs.js';
import { armWakeup, deleteWakeup, listPendingWakeups } from '../repo/scheduled-wakeups.js';
import {
  advanceBackfillCursor,
  completeWindow,
  createWindow,
  findUnlinkedRunForWindow,
  getBackfillCursor,
  getWindowState,
  getWindowStateByRunId,
  linkWindowRun,
  listWindowStates,
  listWindowTriggerIds,
  retryDueWindow,
  retryWindow,
  supersedeWindow,
  type TumblingWindowStateRow,
  type WindowKey,
} from '../repo/tumbling-windows.js';
import type { Db } from '../repo/types.js';
import type { RunEventBus } from '../run/event-bus.js';
import {
  ArchivedPipelineError,
  UnboundTriggerError,
  type FireContext,
  type FireResult,
} from '../run/launcher.js';
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
 * FUTURE — the skipped-past windows are #5 S10 backfill's job (below).
 *
 * ## #5 S10 — bounded BACKFILL (opt-in via `window.maxBackfillWindows`)
 *
 * When a tumbling trigger opts in, `sync()` runs a backfill pass: the MOST
 * RECENT `maxBackfillWindows` fully-closed windows of the CURRENT epoch that
 * were missed (downtime, a disabled stretch, a past `startTime` predating the
 * trigger) are created as `origin: 'backfill'` window rows — older missed
 * windows are permanently SKIPPED, with the durable cursor
 * (`tumbling_backfill_cursors`) jumping past them and a WARN naming the count
 * (no-silent-caps). Creation + cursor advance are ONE transaction; the cursor
 * is the exclusive disposition boundary (everything below it is created or
 * deliberately skipped, never revisited), MONOTONIC by the repo write path.
 * Absent `maxBackfillWindows` = no backfill = exact S9 behavior — a conscious
 * deviation from the spec's per-kind catch-up line ("tumbling = bounded
 * backfill"): an UPGRADE must never surprise-fire past windows for an
 * existing trigger, so backfill is opt-in.
 *
 * Backfill NEVER arms wakeup rows — creation is direct, so `window_due` keys
 * keep targeting only future-ending windows and the wakeup-retention floor
 * argument (`repo/scheduled-wakeups.ts`) holds verbatim; idempotency is the
 * cursor + the projection PK, not wakeup-key absence. "Incremental via S1"
 * (the ticket row) is satisfied by the FORWARD chain remaining the S1 outbox.
 *
 * Backfill windows live in WINDOW STATE, not as run rows (the codex-hardened
 * line): materialization is GATED — at most ONE backfill window fires per
 * pass, and only while the trigger has ZERO `running`-status windows (any
 * epoch), so a 1000-window backlog drains serially (settle → next fire)
 * instead of flooding the S6 admission queue. `origin: 'live'` windows keep
 * S9's ungated batch semantics exactly (rehoming LIVE blocking into window
 * state is S11's mandate, not this ticket's). Drain liveness: the completion
 * tap re-materializes the trigger after settling a window; boot `reconcile()`
 * and every forward-window fire continue the sweep. KNOWN HOLE (v1-accepted):
 * if a backfill fire is skipped (queue-full/shutdown) and the forward chain
 * is distant (day windows) or EXHAUSTED (`endTime` passed — no forward fire
 * ever again), nothing kicks the drain until the next trigger write or boot.
 *
 * A window that closed during DOWNTIME while its `window_due` row sat overdue
 * is created by the backfill pass first (sync runs before the boot tick), so
 * the overdue alarm settles `window_already_exists`: for a backfill-enabled
 * trigger, S9's "≤1-late live fire" becomes a backfill window (gated, ordered
 * with its peers) — decided, tested; default triggers keep S9 behavior. The
 * same holds on a RUNNING server: a route-write sync() landing in the small
 * gap between a window's close and its alarm tick creates that on-time window
 * as backfill (the alarm then suppresses) — occasionally an on-time window
 * fires gated rather than ungated-live; single-fire holds either way.
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
 * ## #5 S11a — per-window CONCURRENCY (opt-in via `window.maxConcurrentWindows`)
 *
 * When set (1–50 at the write boundary), materialization is CAPACITY-GATED:
 * one oldest-first scan over BOTH origins fires until `maxConcurrentWindows`
 * windows are `running` trigger-wide (any epoch) — see `materializeCapped`
 * for the three decided semantics (slot held until window-terminal;
 * oldest-first with no origin priority — the documented S10-split reversal;
 * capacity-bounded scan with no truncation warn). The launcher's per-trigger
 * admission (`admissionCapacity`, run/launcher.ts) reads the SAME cap so the
 * materialized runs actually execute in parallel under the mandatory `queue`
 * policy. ABSENT = the exact S9/S10 semantics below — opt-in like backfill,
 * for the same upgrade-never-surprises reason.
 *
 * ## #5 S11c — per-window RETRY (opt-in via `window.retry`)
 *
 * A window whose run terminalizes with a KNOWN failure (`failure`/
 * `interrupted` — never `missing`: the outcome of a vanished run row is
 * unknown, it may have succeeded) re-drives up to `retry.count` times,
 * `retry.intervalInSeconds` apart. The decision lives in `settleIfTerminal`
 * (every settle path funnels through it); the hold is a first-class window
 * status `retry_pending` (`window.retryScheduled` event, `runId` cleared, the
 * due instant STORED in `next_attempt_at_ms`), resolved by the durable
 * `window_retry` alarm (`window.retryDue` → `waiting` → the normal
 * materialize scan fires a fresh run). Alarm suppressions (corrupt/disabled/
 * unbound trigger at fire time) do not strand the window: the OVERDUE HEAL
 * (`driveOverdueRetries` — sync pass 3 + boot reconcile, state-driven) flips
 * any current-epoch `retry_pending` row whose due instant passed. AMENDMENT
 * to S11a's "slot held until window-terminal": a `retry_pending` window holds
 * NO concurrency slot and does not close the S10 backfill gate — between
 * attempts there is no run in flight, and a slot idled for up to 86400s of
 * retry interval would starve healthy windows; the S11a phrase remains true
 * of every LINKED state (a run-level `queued`/parked-`waiting` run still
 * counts). On `retryDue` the window re-enters the oldest-first scan, so a
 * retried (oldest) window takes the next slot — the ADF order.
 *
 * ## #5 S11d — SELF-dependency (opt-in via `window.selfDependency`) + the
 * stale-epoch disposition
 *
 * A trigger with `selfDependency {offsetInSeconds, sizeInSeconds?}` gates
 * each window on its own PAST windows: the dependency interval's same-epoch
 * windows must all be `succeeded` (or dispositioned — see
 * `dependencySatisfied` for the full rule set: pre-grid vacuous, skipped =
 * satisfied via the trigger's own catch-up disposition, `failed` blocks until
 * a retry re-drives). Blocked windows stay `waiting` IN WINDOW STATE — no
 * run row, no alarm — and every materialize scan walks PAST them (keyset
 * cursors, so a blocked front can never starve a ready tail). Liveness rides
 * the existing kicks: a dependency's success is a run-terminal event, so the
 * completion tap re-materializes the trigger; sync pass 3's stranded-waiting
 * probe and boot reconcile cover edits/restarts.
 *
 * The stale-epoch DISPOSITION (`supersedeStaleEpochWindows`) closes S9-S11c's
 * documented debris hole: old-epoch `waiting`/`retry_pending` rows now fold
 * TERMINAL (`window.superseded`) in sync pass 3 + boot reconcile
 * (enabled-agnostic at boot). Old-epoch CURSOR rows remain inert until the
 * trigger's delete CASCADE — they gate nothing.
 *
 * ## Deliberate non-behaviours (v1)
 *
 * - `runWindows` do NOT gate tumbling fires (unlike schedule ticks): a
 *   tumbling window is data-completeness-driven, and a run-window suppression
 *   would silently LOSE the window for a non-backfill trigger. Event/webhook
 *   fires already set this precedent (only schedule gates).
 * - `${trigger.windowStart/End}` (S11b) SHIPPED: `materializeOne` freezes the
 *   window bounds into the fire context; a tumbling trigger's param bindings
 *   (the one legal surface — context-scoped at save) resolve them fire-time.
 * - For a CAP-LESS trigger, LIVE overflow windows DO materialize into the S6
 *   durable admission queue (a `queued` run row each, bounded by the
 *   per-trigger depth cap). This brushes the spec's "blocked/backfill windows
 *   live in window state, not as full runs": BACKFILL bulk honours that line
 *   (the S10 gate above), and a CAPPED trigger now honours it for live
 *   windows too (S11a) — rehoming live blocking stays opt-in so no shipped
 *   trigger changes behavior. Forward-only live flow produces ≤1 new window
 *   per interval, so the cap-less queue depth stays O(pipeline slowness). A
 *   conscious, documented tradeoff — not an accident.
 * - A dependency-blocked OLDEST backfill window holds the serial backfill
 *   drain (see the gate's comment) — deliberate: the gate's whole point is
 *   serial oldest-first order.
 */

export const WINDOW_DUE_KIND = 'window_due';

/** #5 S11c — the per-window retry alarm's kind (the `node_retry` naming). */
export const WINDOW_RETRY_KIND = 'window_retry';

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

/**
 * #5 S11c — the `window_retry` ref: the window KEY plus the retry ordinal.
 * `attempt` doubles as the freshness handle (the row must still be
 * `retry_pending` at exactly this attempt) AND the dedupe discriminator
 * (`attempt-<n>` — the codex-hardened rule: without it, attempt-2's alarm
 * would collide with attempt-1's already-`fired` row and silently never arm).
 * The retry POLICY deliberately does not ride the ref (it is a BOUND, not
 * freshness — the fire re-checks nothing about it: a policy edit mid-interval
 * never cancels an already-committed `window.retryScheduled` decision).
 */
export const WindowRetryRefSchema = z.object({
  triggerId: z.string().min(1),
  epoch: z.string().min(1),
  windowStart: z.string().datetime(),
  attempt: z.string().regex(/^\d+$/),
});
export type WindowRetryRef = z.infer<typeof WindowRetryRefSchema>;

/** The canonical `window_retry` ref — typed so the settle path (which arms via
 * the repo `armWakeup`, inside its own transaction, without the clock's
 * arm-time validation) is compile-time safe. */
export function buildWindowRetryRef(key: WindowKey, attempt: number): WindowRetryRef {
  return {
    triggerId: key.triggerId,
    epoch: key.configEpoch,
    windowStart: key.windowStart,
    attempt: String(attempt),
  };
}

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
 * #5 S11c — the SETTLE-decision guard: window-configured, enabled-AGNOSTIC.
 * The retry decision must survive a PAUSE: a run failing while its trigger is
 * disabled forfeits nothing (the window holds `retry_pending`; the alarm
 * suppresses while disabled and the overdue heal re-drives on re-enable) —
 * symmetric with a window already held when the disable lands. Only losing
 * the policy SOURCE folds terminal: a deleted/corrupt row, or a mode change
 * away from `tumbling` (the trigger renounced windowing). Everything that
 * FIRES still gates on `isTumblable` — this guard never materializes a run.
 */
export function isWindowConfigured(t: Trigger): t is TumblingTrigger {
  return t.mode === 'tumbling' && t.window !== null;
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

/** Fixed window size in ms — total for every schema-valid config (the
 * frequencies are all fixed-duration UTC units; that is WHY month/week are
 * excluded from `WindowFrequencySchema`). Delegates to the shared
 * `windowSizeSeconds` (#5 S11d) so the frequency→duration map has ONE home
 * (the write-boundary span caps use the same numbers). */
export function windowSizeMs(config: WindowConfig): number {
  return windowSizeSeconds(config) * 1000;
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
 * SKIPS the missed windows rather than replaying them (the S10 backfill pass
 * is what re-covers them, bounded, for opted-in triggers).
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
  /** #5 S11c — the `window_retry` alarm handler — register with the clock. */
  retryHandler: WakeupHandler;
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
   * the completion tap, the boot reconcile, and the link-heal — the tap reads
   * the run ROW (by tap time the terminal status is durably synced), so all
   * paths derive the same fact from the same source. Returns without
   * appending when the run is still live (`completeWindow`'s/`retryWindow`'s
   * `running` guards make a double call safe).
   *
   * #5 S11c — the RETRY DECISION lives here (the one place every settle path
   * funnels through). A KNOWN failure (`failure`/`interrupted`) retries —
   * `running → retry_pending` + the `window_retry` alarm, one transaction —
   * when ALL hold:
   * - `trigger` is available and carries `window.retry` (a `null` trigger =
   *   the row was corrupt/missing at settle time, or its mode moved off
   *   `tumbling` — the policy SOURCE is gone, so the window folds terminal
   *   exactly as pre-S11c: never manufacture a retry from an unreadable row.
   *   Callers derive it via `isWindowConfigured`, NOT `isTumblable`: a
   *   DISABLED trigger keeps its retry — see the guard's doc);
   * - the window belongs to the CURRENT epoch (an old-epoch window folds
   *   terminal: its retry alarm would be refused as `epoch_stale` and the
   *   overdue heal only drives current-epoch rows, so a retry here would
   *   strand it `retry_pending` forever — stale-epoch disposition stays
   *   S11d's);
   * - budget remains (`attempt < retry.count`, read from the projection row).
   * `missing` NEVER retries: the run row is gone, so the outcome is UNKNOWN —
   * it may have SUCCEEDED, and a retry would manufacture duplicate side
   * effects from an absent fact.
   */
  function settleIfTerminal(key: WindowKey, runId: string, trigger: TumblingTrigger | null): void {
    const run = getRun(db, runId);
    if (run === null) {
      // The linked run row is GONE — an absent fact folded CLOSED as failure
      // (never silently dropped; the #473 discipline).
      completeWindow(db, key, { status: 'failed', runId, runStatus: 'missing' });
      return;
    }
    if (run.status === 'success') {
      completeWindow(db, key, { status: 'succeeded', runId });
      return;
    }
    if (run.status !== 'failure' && run.status !== 'interrupted') {
      return; // pending/queued/running/waiting → still live; the tap completes it later.
    }
    const runStatus = run.status;
    const retry = trigger?.window.retry;
    if (
      retry !== undefined &&
      trigger !== null &&
      key.configEpoch === windowConfigEpoch(trigger.window)
    ) {
      const row = getWindowState(db, key);
      if (row !== null && row.status === 'running' && row.attempt < retry.count) {
        const attempt = row.attempt + 1;
        // Clamped to 9999-12-31T23:59:59.999Z (the last instant whose ISO
        // form keeps a 4-digit year — Zod's `.datetime()` rejects the
        // expanded `+275760-…` form, and ECMAScript overflows entirely past
        // ±8.64e15): the stored shape is read-lenient (the write caps are
        // boundary-only), so a hand-edited interval can push the stamp past
        // either limit — unclamped, `retryWindow`'s event append would THROW
        // on every settle, sticking the window in `running` forever (slot
        // held, backfill gate closed). Clamping keeps the stored value's
        // meaning ("retry absurdly far out") without the wedge.
        const nextAttemptAtMs = Math.min(
          now() + retry.intervalInSeconds * 1000,
          253_402_300_799_999,
        );
        db.transaction((tx) => {
          // Guarded flip first; arm ONLY when it wins (a lost race must not
          // commit an alarm row for a decision that didn't happen).
          if (!retryWindow(tx, key, { runId, runStatus, attempt, nextAttemptAtMs })) return;
          armWakeup(tx, {
            kind: WINDOW_RETRY_KIND,
            ref: buildWindowRetryRef(key, attempt),
            dueAt: nextAttemptAtMs,
            discriminator: `attempt-${attempt}`,
          });
        });
        return;
      }
    }
    completeWindow(db, key, { status: 'failed', runId, runStatus });
  }

  /**
   * Materialize ONE waiting window: LINK an existing unlinked run when one
   * matches the epoch-scoped join (the crash heal — never a second fire),
   * else FIRE through the launcher and link the created (started OR queued)
   * run. Returns `'stop'` on a TRIGGER-level refusal (unbound/binding/skip —
   * every later window would refuse identically this pass), `'continue'`
   * otherwise.
   */
  /**
   * #5 S11d — is `row`'s self-dependency satisfied? A window with
   * `window.selfDependency` materializes only after every same-epoch window
   * intersecting `[start + offset, start + offset + size)` reaches
   * `succeeded` — with the DISPOSITION rule: a dependency window the trigger
   * itself permanently dispositioned counts as satisfied. Concretely, per
   * grid position of the interval:
   *
   * - row exists → satisfied iff `succeeded` or `superseded` (a geometry
   *   edit's disposition — the same class as a skip; matters after a REVERT,
   *   when superseded rows are current-epoch again). `failed` blocks until a
   *   retry re-drives it (ADF's rerun-wait semantic — visible in window
   *   state, never silent); `waiting`/`running`/`retry_pending` block until
   *   they resolve.
   * - no row → satisfied iff the trigger already dispositioned that window:
   *   for a backfill-opted trigger, `startMs < cursor` (the cursor is the
   *   EXCLUSIVE disposition boundary — everything below it is created or
   *   deliberately skipped; `null` cursor = nothing dispositioned yet, the
   *   pending backfill pass will create it); for a forward-only trigger, the
   *   window CLOSED (`endMs <= now`) — the ≤1-late chain creates rows
   *   strictly in window order, so a closed no-row window is exactly a
   *   permanently-skipped one, and a dependent's row cannot even exist while
   *   its dependency's overdue fire is still pending.
   * - pre-grid positions (`k < 0` — the span reaches before window 0) are
   *   vacuously satisfied: no such window can ever exist (without this the
   *   chain would deadlock at its own origin).
   *
   * The no-row check is ARITHMETIC (grid count vs rows found, then one
   * boundary test on the LARGEST missing position — vacuity is monotone:
   * older ⇒ more dispositioned), so a stored-lenient giant span costs one
   * bounded range query, not an O(span) grid walk.
   */
  function dependencySatisfied(trigger: TumblingTrigger, row: TumblingWindowStateRow): boolean {
    const dep = trigger.window.selfDependency;
    if (dep === undefined) return true;
    const size = windowSizeMs(trigger.window);
    const start0 = Date.parse(trigger.window.startTime);
    const wStart = Date.parse(row.windowStart);
    const iStart = wStart + dep.offsetInSeconds * 1000;
    const iEnd = iStart + (dep.sizeInSeconds !== undefined ? dep.sizeInSeconds * 1000 : size);
    // Grid positions intersecting [iStart, iEnd): smallest k whose END is
    // after iStart (floor handles the aligned case exactly), largest k whose
    // START is before iEnd — both clamped to the grid (k >= 0).
    const kLo = Math.max(0, Math.floor((iStart - start0) / size));
    const kHi = Math.ceil((iEnd - start0) / size) - 1;
    if (kHi < kLo) return true; // wholly pre-grid
    // Range bounds CLAMPED into the representable ISO range (epoch 0 …
    // 9999-12-31, the S11c `nextAttemptAtMs` clamp's rationale): the stored
    // shape is read-lenient, so a hand-edited giant offset/size can push a
    // bound past the ECMAScript Date range, where `toISOString()` THROWS —
    // which would turn "gate honors a weird stored value" into a logged
    // error on every pass. No real row lives outside the clamp, so the
    // query's meaning is unchanged.
    const clampMs = (ms: number) => Math.min(Math.max(ms, 0), 253_402_300_799_999);
    const rows = listWindowStates(db, {
      triggerId: trigger.id,
      configEpoch: row.configEpoch,
      windowStartGte: new Date(clampMs(start0 + kLo * size)).toISOString(),
      windowStartLte: new Date(clampMs(start0 + kHi * size)).toISOString(),
    });
    for (const r of rows) {
      if (r.status !== 'succeeded' && r.status !== 'superseded') return false;
    }
    if (rows.length >= kHi - kLo + 1) return true; // every position has a row
    // The largest missing position decides for all of them (monotone).
    const have = new Set(rows.map((r) => Date.parse(r.windowStart)));
    let k = kHi;
    while (have.has(start0 + k * size)) k -= 1;
    if (trigger.window.maxBackfillWindows !== undefined) {
      const cursor = getBackfillCursor(db, trigger.id, row.configEpoch);
      return cursor !== null && start0 + k * size < cursor;
    }
    return start0 + (k + 1) * size <= now();
  }

  function materializeOne(
    trigger: TumblingTrigger,
    row: TumblingWindowStateRow,
  ): 'continue' | 'blocked' | 'stop' {
    const key = keyOf(row);
    // LINK-BEFORE-FIRE (single-fire under crash): an unlinked run whose
    // frozen `triggerContext.scheduledTime` is this window's end AND whose
    // frozen `windowEpoch` is this window's epoch is THIS window's run from a
    // fire whose link never committed.
    const existingRunId = findUnlinkedRunForWindow(
      db,
      trigger.id,
      row.configEpoch,
      row.windowEnd,
      row.windowStart,
    );
    if (existingRunId !== null) {
      if (linkWindowRun(db, key, existingRunId, 'reconcile')) {
        settleIfTerminal(key, existingRunId, trigger);
      }
      return 'continue';
    }
    // #5 S11d — the dependency gate, AFTER the link-heal (a crash-orphaned
    // run already consumed the dependency at its original fire — healing the
    // link is recording a fact, not admitting new work) and BEFORE the fire.
    // A blocked window stays `waiting` IN WINDOW STATE — no run row (the
    // codex-hardened "blocked windows live in window state, NOT as full
    // runs") — and the scans walk PAST it (`'blocked'` ≠ `'stop'`): with a
    // multi-window offset, a younger window's dependency can be met while an
    // older one's is not (ADF: windows run when THEIR deps are met).
    if (!dependencySatisfied(trigger, row)) {
      log.debug(
        { triggerId: trigger.id, windowStart: row.windowStart },
        'tumbling: window dependency-blocked; stays waiting',
      );
      return 'blocked';
    }
    let result: FireResult;
    try {
      result = launcher.fire(trigger, {
        scheduledTime: row.windowEnd,
        windowEpoch: row.configEpoch,
        // #5 S11b — the user-facing `${trigger.windowStart/End}` facts, frozen
        // into the run's context so the trigger's param bindings resolve them.
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
      });
    } catch (err) {
      if (err instanceof UnboundTriggerError) {
        log.debug({ triggerId: trigger.id }, 'tumbling: skip — trigger became unbound');
        return 'stop';
      }
      // #3 G5a — the bound pipeline is archived; stop materializing this
      // window's fire. Operator-visible (`warn`, the `SubstituteError`
      // severity): an enabled trigger bound to a permanently-archived pipeline
      // (the re-enable edge case) would otherwise stop producing runs silently —
      // NOT a self-healing race like the unbound case above.
      if (err instanceof ArchivedPipelineError) {
        log.warn({ triggerId: trigger.id }, 'tumbling: skip — pipeline archived');
        return 'stop';
      }
      if (err instanceof SubstituteError) {
        // A trigger param binding that cannot resolve — operator-visible
        // (the schedule-tick severity rationale): the trigger's windows stop
        // materializing with no run to look at.
        log.warn(
          { err, triggerId: trigger.id },
          'tumbling: skip — trigger param binding could not be resolved',
        );
        return 'stop';
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
      return 'stop';
    }
    if (result.runId === undefined) {
      // Unreachable post-S9 (`started` and `queued` both report runId) —
      // fail LOUD if a future launcher change breaks the contract.
      log.error(
        { triggerId: trigger.id, windowStart: row.windowStart, outcome: result.outcome },
        'tumbling: fire returned no runId; window stays waiting',
      );
      return 'stop';
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
    return 'continue';
  }

  /**
   * #5 S11a — the CAPPED unified materialize: when the trigger opts into
   * `maxConcurrentWindows`, ONE oldest-first (`windowStart` asc) scan over the
   * current epoch's waiting unlinked windows — BOTH origins — fires until the
   * cap is reached. Capacity = windows with status `running`, trigger-wide,
   * ANY epoch (an old-epoch run still consumes real work — the S10 gate's
   * rationale, kept). Three decided semantics, each pinned by test:
   *
   * - **The window SLOT is held while a run is LINKED** (until window-terminal
   *   or a retry hold). A window stays `running` while its run is queued at
   *   run level OR parked `waiting` on a timer/dependency — a DELIBERATE
   *   divergence from the run-level slot release (S4): the cap bounds
   *   windows-in-flight, ADF's `maxConcurrency` semantic. #5 S11c AMENDED the
   *   original "until window-terminal" phrasing: a `retry_pending` window
   *   (non-terminal, but NO run in flight) releases the slot — see the module
   *   header's S11c section.
   * - **Live queues BEHIND backfill (oldest-first, no origin priority)** — a
   *   conscious REVERSAL of S10's two-scan split (which existed to keep an
   *   ungated live window from starving behind the backfill batch bound; under
   *   a cap nothing is ungated, so windows drain strictly oldest-first, the
   *   ADF order). Alternative considered and REJECTED: reserving one slot for
   *   the newest live window — it would break oldest-first for no operational
   *   gain (the backlog is bounded by `maxBackfillWindows` ≤ 1000 and drains
   *   at cap parallelism). Opt-in, so no shipped trigger changes ordering.
   * - **The scan is bounded by CAPACITY, not `MATERIALIZE_BATCH`,** and the
   *   truncation WARN does not apply: excess waiting windows are the DESIGNED
   *   steady state under a cap ("blocked windows live in window state"), not a
   *   stranding anomaly — warning on every completion-tap pass of a healthy
   *   bulk drain would be noise, the inverse no-silent-caps failure.
   *
   * Termination (#5 S11d re-argued): the scan is a KEYSET walk — the cursor
   * strictly advances past every processed row, so the loop ends at the key
   * space's edge regardless of outcome. The keyset replaced the original
   * fixed-front refetch ("every `'continue'` row has left the waiting set")
   * because a dependency-`'blocked'` row does NOT leave the set — a
   * fixed-front refetch would rescan the same blocked front forever (a
   * genuine infinite loop) and never reach a ready row behind it (with a
   * multi-window offset, younger windows can be ready while older ones are
   * blocked). `'stop'` still bails the pass. No over-cap EXECUTION is
   * possible even around a crash orphan: the LAUNCHER counts the orphan's
   * run (`countActiveRunsForTrigger`), so fires past it come back run-level
   * `queued` — at worst one extra window links a QUEUED run for a pass. The
   * scan usually link-heals the orphan first (its window tends to be the
   * oldest waiting row), but `backfillPass` can create OLDER windows in the
   * same sync, deferring the heal to a later pass — the launcher gate, not
   * heal order, is what carries the no-over-cap guarantee.
   */
  function materializeCapped(trigger: TumblingTrigger, cap: number): void {
    const epoch = windowConfigEpoch(trigger.window);
    let cursor: string | undefined;
    for (;;) {
      if (stopped) return;
      const running = listWindowStates(db, {
        triggerId: trigger.id,
        status: 'running',
        limit: cap,
      }).length;
      if (running >= cap) {
        log.debug(
          { triggerId: trigger.id, cap },
          'tumbling: materialize gated — window concurrency cap reached',
        );
        return;
      }
      // Page bound = free capacity (each page fires at most that many, so the
      // cap cannot overshoot within a page); blocked rows in the page consume
      // cursor, not capacity, and the next iteration recounts + walks on.
      // Recounting per iteration also covers link-heals of already-terminal
      // orphans, which settle without consuming capacity (the pre-S11d
      // refetch's under-fill rationale, kept).
      const waiting = listWindowStates(db, {
        triggerId: trigger.id,
        configEpoch: epoch,
        status: 'waiting',
        unlinked: true,
        windowStartGt: cursor,
        limit: cap - running,
      });
      if (waiting.length === 0) return;
      for (const row of waiting) {
        cursor = row.windowStart;
        if (materializeOne(trigger, row) === 'stop') return;
      }
    }
  }

  /**
   * Materialize the unlinked `waiting` windows of `trigger`'s CURRENT epoch,
   * oldest first. #5 S11a: a trigger with `window.maxConcurrentWindows` takes
   * the CAPPED unified path above; ABSENT keeps the exact S9/S10 semantics
   * below — TWO origin-scoped scans (#5 S10): `'live'` windows keep S9's
   * ungated batch semantics exactly; then AT MOST ONE `'backfill'` window
   * fires, and only when the trigger has ZERO `running`-status windows (ANY
   * epoch — an old-epoch run still consumes real capacity), so a bulk backlog
   * drains serially instead of flooding the admission queue. The split keeps
   * a 1000-row backfill backlog from starving the live window behind the
   * batch bound (they no longer share one oldest-first scan).
   */
  function materializeWindows(trigger: TumblingTrigger): void {
    if (stopped) return;
    const cap = trigger.window.maxConcurrentWindows;
    if (cap !== undefined) {
      materializeCapped(trigger, cap);
      return;
    }
    const epoch = windowConfigEpoch(trigger.window);
    // #5 S11d — a KEYSET walk (`windowStartGt` cursor) bounded by FIRES, not
    // fetched rows: a dependency-blocked row stays in the waiting set, so the
    // old fixed-front fetch would rescan (and, past `MATERIALIZE_BATCH`
    // blocked rows, permanently starve) the ready tail behind it. Blocked
    // rows consume cursor only; `MATERIALIZE_BATCH` still bounds the work a
    // single pass admits.
    let fired = 0;
    let cursor: string | undefined;
    live: for (;;) {
      // Between-page stop check (review WARNING, PR #645): blocked rows keep
      // the walk alive without touching the launcher, so a large blocked
      // front would otherwise page — and fire ready tails — past a `stop()`
      // landing mid-pass. Same check as `materializeCapped`'s loop head.
      if (stopped) return;
      const waiting = listWindowStates(db, {
        triggerId: trigger.id,
        configEpoch: epoch,
        status: 'waiting',
        unlinked: true,
        origin: 'live',
        windowStartGt: cursor,
        limit: MATERIALIZE_BATCH,
      });
      if (waiting.length === 0) break;
      for (const row of waiting) {
        cursor = row.windowStart;
        if (fired >= MATERIALIZE_BATCH) {
          // Operator-visible: a backlog past the batch bound (e.g. persistent
          // launcher refusals) is NOT dropped — the excess stays `waiting` and
          // the next window fire / boot reconcile continues the sweep — but
          // the truncation itself must be signalled, not silent (the
          // no-silent-caps rule; review WARNING on the first S9 pass). BREAK,
          // not return: the backfill scan below must still run (its gate,
          // not the live bound, decides backfill) — pre-S11d the fixed-front
          // shape fell through here too.
          log.warn(
            { triggerId: trigger.id, batch: MATERIALIZE_BATCH },
            'tumbling: stranded-window sweep truncated at the batch bound — more waiting windows remain, some possibly dependency-blocked (retried next pass/boot)',
          );
          break live;
        }
        const outcome = materializeOne(trigger, row);
        if (outcome === 'stop') return;
        if (outcome === 'continue') fired += 1;
      }
    }
    // The backfill scan. The gate reads pure window state (`running` = linked
    // + unsettled — no run-table join); an unlinked crash orphan does NOT
    // close it, so the link-heal inside `materializeOne` still runs.
    const backfillRows = listWindowStates(db, {
      triggerId: trigger.id,
      configEpoch: epoch,
      status: 'waiting',
      unlinked: true,
      origin: 'backfill',
      limit: 1,
    });
    const backfillRow = backfillRows[0];
    if (backfillRow === undefined) return;
    const holders = listWindowStates(db, { triggerId: trigger.id, status: 'running', limit: 1 });
    if (holders.length > 0) {
      log.debug(
        { triggerId: trigger.id, windowStart: backfillRow.windowStart },
        'tumbling: backfill gated — a window is running; drains on its completion',
      );
      return;
    }
    // #5 S11d — a dependency-`'blocked'` OLDEST backfill window holds the
    // serial drain (deliberate, v1): the drain is strictly oldest-first, and
    // with a self-dependency the oldest window's deps are below it — already
    // dispositioned or drained ahead of it — so a persistent block here means
    // a FAILED dependency, which is designed to hold until a retry re-drives
    // it. Skipping ahead would trade that visible hold for out-of-order
    // backfill under a gate whose whole point is serial order.
    materializeOne(trigger, backfillRow);
  }

  /**
   * #5 S10 — the bounded backfill pass for one opted-in trigger: create the
   * most recent `maxBackfillWindows` missed fully-closed windows of the
   * CURRENT epoch as `origin: 'backfill'` rows and advance the durable cursor
   * to the live edge, atomically. Windows older than the lookback are
   * permanently SKIPPED (cursor jumps past them; WARNed, never silent).
   * Idempotent: the cursor floors the scan and the projection PK dedupes
   * anything the forward chain already created (ANY status counts as
   * dispositioned). NEVER arms wakeup rows — see the module header.
   */
  function backfillPass(trigger: TumblingTrigger): void {
    const config = trigger.window;
    const bound = config.maxBackfillWindows;
    if (bound === undefined) return;
    const epoch = windowConfigEpoch(config);
    const size = windowSizeMs(config);
    const start0 = Date.parse(config.startTime);
    // The live EDGE — the exclusive upper bound for backfill window STARTS:
    // the start of the first window still ending in the future (that one is
    // the forward chain's), or, when `endTime` exhausts the chain, the end of
    // the last FULL window inside the bound (its start + size ≤ endTime ≤ any
    // later instant — the exhausted chain's tail is still backfillable).
    const next = firstWindowEndingAfter(config, now());
    let edgeMs: number;
    if (next !== null) {
      edgeMs = next.startMs;
    } else if (config.endTime !== undefined) {
      edgeMs = start0 + Math.floor((Date.parse(config.endTime) - start0) / size) * size;
    } else {
      // Unreachable: `firstWindowEndingAfter` returns null only under endTime.
      return;
    }
    if (edgeMs <= start0) return; // nothing has fully closed yet
    const cursor = getBackfillCursor(db, trigger.id, epoch);
    const dispositioned = Math.max(cursor ?? start0, start0);
    let lower = Math.max(dispositioned, edgeMs - bound * size);
    // Defensive grid alignment (the cursor is always written as a window
    // boundary; a corrupted value must not shift the whole grid): align UP.
    lower = start0 + Math.ceil((lower - start0) / size) * size;
    if (lower >= edgeMs) return; // fully dispositioned already
    const skipped = Math.max(0, Math.round((lower - dispositioned) / size));
    db.transaction((tx) => {
      for (let startMs = lower; startMs < edgeMs; startMs += size) {
        createWindow(tx, {
          triggerId: trigger.id,
          configEpoch: epoch,
          windowStart: new Date(startMs).toISOString(),
          windowEnd: new Date(startMs + size).toISOString(),
          geometry: {
            frequency: config.frequency,
            interval: config.interval,
            startTime: config.startTime,
          },
          origin: 'backfill',
        });
      }
      advanceBackfillCursor(tx, trigger.id, epoch, edgeMs);
    });
    if (skipped > 0) {
      // No-silent-caps: the lookback bound DROPPED windows — permanently
      // (the cursor is past them; raising `maxBackfillWindows` later recovers
      // nothing — a one-way ratchet, deliberate).
      log.warn(
        { triggerId: trigger.id, skipped, maxBackfillWindows: bound },
        'tumbling: backfill skipped windows beyond the lookback bound (permanently dispositioned)',
      );
    }
  }

  const handler: WakeupHandler = {
    kind: WINDOW_DUE_KIND,
    refSchema: WindowDueRefSchema,
    fire(row: ScheduledWakeup, delivery, tx: Db): WakeupFireResult {
      const ref = WindowDueRefSchema.parse(row.ref);
      const read = getParsedTrigger(tx, ref.triggerId);

      // #637 — a CORRUPT trigger row must settle the chain, not throw: a throw
      // rolls back the fire tx, so the pending row would re-fire + error-log
      // on every tick, forever. Settle + warn; `sync()` re-seeds after repair.
      if (read.status === 'unparseable') {
        log.warn(
          { triggerId: ref.triggerId, err: read.error },
          'tumbling: trigger row unparseable — settling the chain (sync() re-seeds after repair)',
        );
        return { status: 'suppressed', reason: 'trigger_unparseable' };
      }
      const trigger = read.status === 'found' ? read.trigger : null;

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
        origin: 'live',
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

  /**
   * #5 S11c — the `window_retry` alarm handler: the retry interval elapsed,
   * so re-open the window for materialization. Same shape as `window_due`:
   * lenient trigger read (#637 — a corrupt row settles, never throws;
   * `sync()`'s overdue heal re-drives after repair), terminal suppressions
   * for every stale case (the window stays `retry_pending`, healed by the
   * overdue drive once the trigger is current again — or folded terminal by
   * #5 S11d's stale-epoch disposition for old-epoch debris), the durable
   * flip in-tx, and the run-spawning materialize in `afterCommit` only.
   */
  const retryHandler: WakeupHandler = {
    kind: WINDOW_RETRY_KIND,
    refSchema: WindowRetryRefSchema,
    fire(row: ScheduledWakeup, _delivery, tx: Db): WakeupFireResult {
      const ref = WindowRetryRefSchema.parse(row.ref);
      const read = getParsedTrigger(tx, ref.triggerId);
      if (read.status === 'unparseable') {
        log.warn(
          { triggerId: ref.triggerId, err: read.error },
          'tumbling: trigger row unparseable — retry settles (the overdue heal re-drives after repair)',
        );
        return { status: 'suppressed', reason: 'trigger_unparseable' };
      }
      const trigger = read.status === 'found' ? read.trigger : null;
      if (trigger === null || !isTumblable(trigger)) {
        return { status: 'suppressed', reason: 'trigger_not_tumbling' };
      }
      if (trigger.pipelineVersionId === null) {
        return { status: 'suppressed', reason: 'trigger_unbound' };
      }
      if (windowConfigEpoch(trigger.window) !== ref.epoch) {
        // A geometry edit mid-interval: the window is old-epoch debris now —
        // #5 S11d's disposition pass (sync + boot reconcile) folds it
        // terminal (`window.superseded`); this alarm just settles. (The
        // settle-time epoch guard makes this reachable only for an edit
        // landing INSIDE the interval — ~86400s for write-boundary rows;
        // longer for a hand-edited over-cap interval, the same read-lenient
        // tradeoff the cap documents.)
        return { status: 'suppressed', reason: 'epoch_stale' };
      }
      const key: WindowKey = {
        triggerId: ref.triggerId,
        configEpoch: ref.epoch,
        windowStart: ref.windowStart,
      };
      const state = getWindowState(tx, key);
      const attempt = Number(ref.attempt);
      if (state === null || state.status !== 'retry_pending' || state.attempt !== attempt) {
        // Already re-driven (the overdue heal won the race), or moved on —
        // at-least-once delivery settles without a duplicate append.
        return { status: 'suppressed', reason: 'window_not_retry_pending' };
      }
      if (!retryDueWindow(tx, key, attempt)) {
        // Unreachable single-writer (the guard was just checked in this tx) —
        // defensive, same suppression.
        return { status: 'suppressed', reason: 'window_not_retry_pending' };
      }
      return {
        status: 'fired',
        afterCommit: () => {
          materializeWindows(trigger);
        },
      };
    },
  };

  /**
   * #5 S11c — the OVERDUE HEAL: drive `retry_pending` windows of `trigger`'s
   * CURRENT epoch whose stored `nextAttemptAtMs` has passed. The normal path
   * is the `window_retry` alarm; this covers the alarm's terminal
   * suppressions (the trigger was corrupt/disabled/unbound at fire time — the
   * settled row is gone forever, so WITHOUT this the window would be stuck
   * `retry_pending` on a long-lived process until reboot). STATE-driven, not
   * config-driven: a scheduled retry survives policy removal (the
   * `window.retryScheduled` event is a committed durable decision), so
   * eligibility is "has overdue retry_pending rows", never "has a retry
   * policy". Double-drive against a still-pending alarm is safe: the flip is
   * guarded, and the alarm's later delivery suppresses as
   * `window_not_retry_pending`. Returns whether any window was driven (the
   * sync pass uses it to decide whether a materialize kick is owed).
   */
  function driveOverdueRetries(trigger: TumblingTrigger): boolean {
    const epoch = windowConfigEpoch(trigger.window);
    const rows = listWindowStates(db, {
      triggerId: trigger.id,
      configEpoch: epoch,
      status: 'retry_pending',
    });
    let drove = false;
    for (const row of rows) {
      if (row.nextAttemptAtMs === null || row.nextAttemptAtMs > now()) continue;
      if (retryDueWindow(db, keyOf(row), row.attempt)) drove = true;
    }
    return drove;
  }

  /**
   * #5 S11d — the stale-epoch DISPOSITION: fold every old-epoch `waiting` /
   * `retry_pending` row of `trigger` terminal (`window.superseded`). A
   * geometry edit mints a new epoch and re-covers the timeline under it; the
   * old epoch's non-terminal rows are debris no scan will ever drive again
   * (materialize and the overdue heal are current-epoch-scoped) — before this
   * pass they sat inert forever. `running` rows are NOT touched: a live run
   * settles its window through the normal completion path regardless of
   * epoch. TERMINAL AND PERMANENT: a revert does not resurrect a superseded
   * window (projection uniqueness refuses re-creation — the backfill cursor's
   * one-way rule), and post-revert it satisfies dependents vacuously, as a
   * dispositioned window. Runs in `sync()` pass 3 for every eligible trigger
   * (BEFORE the early-continue and the unbound skip — disposition spawns no
   * run, so it is safe unbound, the `driveOverdueRetries` argument) and in
   * boot `reconcile()` enabled-agnostic (a DISABLED tumbling trigger still
   * has a current epoch to compare against — the settle path's
   * `isWindowConfigured` posture; a pause defers nothing here).
   */
  function supersedeStaleEpochWindows(trigger: TumblingTrigger): void {
    const epoch = windowConfigEpoch(trigger.window);
    let count = 0;
    for (const status of ['waiting', 'retry_pending'] as const) {
      // Batched drain, not one unbounded fetch (review NITPICK on PR #645):
      // heavy accumulated debris must never materialize as one giant row
      // array. No cursor needed — every fetched row LEAVES the filter set
      // (superseded, or the guard lost because its status already changed,
      // which equally unmatches the `status` filter), so refetching page 1
      // until empty terminates.
      for (;;) {
        const rows = listWindowStates(db, {
          triggerId: trigger.id,
          configEpochNot: epoch,
          status,
          limit: MATERIALIZE_BATCH,
        });
        if (rows.length === 0) break;
        for (const row of rows) {
          if (supersedeWindow(db, keyOf(row), epoch)) count += 1;
        }
      }
    }
    if (count > 0) {
      // WARN, not debug — windows folded terminal without ever firing is an
      // operator-relevant disposition (the S10 cursor-skip precedent:
      // deliberate loss is signalled, never silent).
      log.warn(
        { triggerId: trigger.id, count },
        'tumbling: superseded stale-epoch windows (geometry-edit debris folded terminal)',
      );
    }
  }

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

    // Pass 3 (#5 S10) — the bounded backfill for every opted-in eligible
    // trigger (ALL of them, seeded-this-pass or not: missed windows accrue
    // whether or not the forward row survived), then a materialize kick so a
    // fresh backlog — or a drain resumed by a re-enable — starts moving
    // without waiting for boot/the next window fire. The kick means sync()
    // can now FIRE runs (at most one gated backfill window per trigger, plus
    // any stranded live windows) — sanctioned: routes already fire runs in
    // request context (manual fire, events), and sync runs post-write, never
    // inside a transaction. #5 S11a: capacity-managed triggers
    // (`maxConcurrentWindows`) get the SAME kick even without backfill — a
    // cap RAISE frees slots with no completion tap coming, and the route
    // write's sync() is what drains the freed capacity promptly. #5 S11c:
    // the overdue-retry heal also runs here for EVERY eligible trigger, and
    // a drive earns the same kick.
    for (const trigger of eligible.values()) {
      const hasBackfill = trigger.window.maxBackfillWindows !== undefined;
      // #5 S11c — the overdue-retry heal runs for EVERY eligible trigger
      // (state-driven — see `driveOverdueRetries`), BEFORE the unbound skip:
      // the flip to `waiting` is safe unbound (the window becomes a normal
      // stranded-waiting row, materialized once bound), and skipping it would
      // strand a retry-only trigger's window until reboot.
      let droveRetries = false;
      try {
        droveRetries = driveOverdueRetries(trigger);
      } catch (err) {
        log.warn({ err, triggerId: trigger.id }, 'tumbling: overdue-retry drive failed — skipping');
      }
      // #5 S11d — the stale-epoch disposition, ALSO before the early-continue
      // below and the unbound skip: the debris a geometry edit leaves is
      // old-epoch, so the current-epoch stranded probe never sees it (a plain
      // no-backfill/no-cap trigger would early-continue right past it), and
      // dispositioning spawns no run (safe unbound, like the drive above).
      try {
        supersedeStaleEpochWindows(trigger);
      } catch (err) {
        log.warn(
          { err, triggerId: trigger.id },
          'tumbling: stale-epoch disposition failed — skipping',
        );
      }
      if (!hasBackfill && trigger.window.maxConcurrentWindows === undefined && !droveRetries) {
        // #5 S11c — one more kick condition: stranded `waiting` windows of the
        // current epoch. Without it, a retry flipped to `waiting` during an
        // UNBOUND stretch (the drive above deliberately runs pre-bind) waits
        // for the next window fire or boot after the REBIND write — up to a
        // full window interval, or reboot for an endTime-exhausted chain.
        // Checking state (not "did this pass flip") also heals the rest of
        // the stranded-waiting class on any trigger write — a deliberate
        // widening of S9/S10's fire/boot-only liveness, same sanction as the
        // pass-3 kick itself (sync runs post-write, never in a tx).
        const stranded = listWindowStates(db, {
          triggerId: trigger.id,
          configEpoch: windowConfigEpoch(trigger.window),
          status: 'waiting',
          unlinked: true,
          limit: 1,
        });
        if (stranded.length === 0) continue;
      }
      // UNBOUND triggers are skipped ENTIRELY (unlike forward seeding, where
      // eligibility deliberately ignores binding): running the pass would
      // accrete waiting rows on every sync with the lookback bound never
      // engaging (each pass only sees the SINCE-LAST-SYNC gap), so a trigger
      // left unbound for a week would violate the `maxBackfillWindows`
      // contract by thousands of rows. Skipping keeps the cursor lagging, so
      // the bounded lookback applies AT BIND TIME — symmetric with the
      // disabled→re-enabled semantics. For a CAP-ONLY trigger (#5 S11a) the
      // skip is simpler but still right: an unbound fire would just throw
      // `UnboundTriggerError` → 'stop', so kicking it is pure wasted work.
      if (trigger.pipelineVersionId === null) continue;
      try {
        // The backfill pass runs strictly for backfill-opted triggers — a
        // cap-only trigger must never accrete backfill rows (pinned by test).
        if (hasBackfill) backfillPass(trigger);
        materializeWindows(trigger);
      } catch (err) {
        log.warn(
          { err, triggerId: trigger.id },
          'tumbling: backfill/materialize pass failed — skipping',
        );
      }
    }
  }

  /** #5 S11c — one lenient trigger read per trigger id (the settle decision
   * needs the retry policy; a corrupt/missing/mode-changed row reads as
   * `null` = policy source gone = terminal fold, the #637 discipline; a
   * DISABLED row still reads — `isWindowConfigured`, see its doc). Memoized
   * per reconcile pass so the `running`-window loop does not re-read per row. */
  function readWindowConfigured(cache: Map<string, TumblingTrigger | null>, triggerId: string) {
    const hit = cache.get(triggerId);
    if (hit !== undefined) return hit;
    const read = getParsedTrigger(db, triggerId);
    const trigger =
      read.status === 'found' && isWindowConfigured(read.trigger) ? read.trigger : null;
    cache.set(triggerId, trigger);
    return trigger;
  }

  function reconcile(): void {
    if (stopped) return;
    const triggerCache = new Map<string, TumblingTrigger | null>();
    // 1 — `running` windows whose run already terminalized (or vanished): the
    // completion tap is in-memory, so a crash between a run's terminal event
    // and the window append loses the transition; re-derive it from the run
    // row (at-least-once, `completeWindow`'s/`retryWindow`'s guards dedupe).
    for (const row of listWindowStates(db, { status: 'running' })) {
      if (row.runId === null) continue; // unreachable: link + flip are one tx
      try {
        settleIfTerminal(keyOf(row), row.runId, readWindowConfigured(triggerCache, row.triggerId));
      } catch (err) {
        log.error(
          { err, triggerId: row.triggerId, windowStart: row.windowStart },
          'tumbling: reconcile failed to settle window',
        );
      }
    }
    // 1.5 (#5 S11c) — drive overdue `retry_pending` windows (an alarm
    // suppressed while the trigger was broken is a settled row, gone forever;
    // boot is the backstop the suppression paths lean on). The flip lands the
    // windows in `waiting`, so step 2's stranded scan below picks them up.
    for (const triggerId of listWindowTriggerIds(db, { status: 'retry_pending' })) {
      const trigger = readWindowConfigured(triggerCache, triggerId);
      // Corrupt/missing/mode-changed OR still disabled — inert until
      // repaired/re-enabled (the flip would go nowhere useful while disabled;
      // sync() drives it the moment the trigger is eligible again).
      if (trigger === null || !trigger.enabled) continue;
      try {
        driveOverdueRetries(trigger);
      } catch (err) {
        log.error({ err, triggerId }, 'tumbling: reconcile failed to drive overdue retries');
      }
    }
    // 1.75 (#5 S11d) — the stale-epoch disposition at boot, ENABLED-AGNOSTIC
    // (`readWindowConfigured` reads disabled rows too): a disabled tumbling
    // trigger still has a current epoch to compare against, and folding its
    // old-epoch debris terminal spawns nothing — so a pause defers nothing
    // here, symmetric with the settle path. Covers debris `sync()` never
    // reaches (its pass runs for ENABLED triggers only). Trigger set via
    // DISTINCT projection, not a row fetch — the debris this step exists to
    // fold is exactly what would make a row fetch unbounded (review NITPICK,
    // PR #645).
    for (const triggerId of new Set([
      ...listWindowTriggerIds(db, { status: 'waiting' }),
      ...listWindowTriggerIds(db, { status: 'retry_pending' }),
    ])) {
      const trigger = readWindowConfigured(triggerCache, triggerId);
      if (trigger === null) continue; // corrupt/missing/mode-changed — no epoch to compare
      try {
        supersedeStaleEpochWindows(trigger);
      } catch (err) {
        log.error({ err, triggerId }, 'tumbling: reconcile failed to disposition stale windows');
      }
    }
    // 2 — stranded `waiting` windows of still-current triggers (crash between
    // the window tx and the fire, or a skipped fire): link-before-fire, then
    // fire. A stale-epoch or no-longer-eligible trigger's windows stay inert.
    for (const triggerId of listWindowTriggerIds(db, { status: 'waiting', unlinked: true })) {
      // #637 — `reconcile()` is called BARE at boot, so a poison trigger row
      // must skip-and-warn (the `listParsedTriggers` per-row discipline), not
      // throw: a throw here aborted server boot and starved every other
      // trigger's reconcile. The stranded window stays `waiting` (inert, not
      // lost) until the row is repaired.
      const read = getParsedTrigger(db, triggerId);
      if (read.status === 'unparseable') {
        log.warn(
          { triggerId, err: read.error },
          'tumbling: reconcile skipped an unparseable trigger row (stranded windows stay inert)',
        );
        continue;
      }
      const trigger = read.status === 'found' ? read.trigger : null;
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
          // #637 — lenient read, BEFORE the settle since #5 S11c's retry
          // decision needs the policy: the settle (derived from the RUN row)
          // must land even when the trigger row is corrupt — a `null` trigger
          // folds terminal (policy unknown), never throws; only the drain
          // kick below is additionally skipped, with a warn instead of the
          // per-terminal-run error spam a throw produced here.
          const read = getParsedTrigger(db, row.triggerId);
          const parsed = read.status === 'found' ? read.trigger : null;
          // Settle sees the ENABLED-agnostic guard (a pause must not forfeit
          // the retry); the drain kick below keeps the full `isTumblable`.
          settleIfTerminal(
            keyOf(row),
            runId,
            parsed !== null && isWindowConfigured(parsed) ? parsed : null,
          );
          // #5 S10 — drain continuation: the settle just released the
          // materialization gate (the window is no longer `running`), so the
          // trigger's next backfill window fires now — this tap is what makes
          // a bulk backlog drain serially instead of waiting for boot.
          if (read.status === 'unparseable') {
            log.warn(
              { triggerId: row.triggerId, err: read.error },
              'tumbling: completion tap skipped the drain kick — trigger row unparseable',
            );
            return;
          }
          if (parsed !== null && isTumblable(parsed) && parsed.pipelineVersionId !== null) {
            materializeWindows(parsed);
          }
        } catch (err) {
          log.error({ err, runId }, 'tumbling: window completion tap failed');
        }
      });
    });
  }

  function stop(): void {
    stopped = true;
  }

  return { handler, retryHandler, sync, reconcile, subscribeCompletion, stop };
}
