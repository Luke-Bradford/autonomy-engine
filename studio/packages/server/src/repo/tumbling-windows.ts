import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  WindowEventSchema,
  WindowStatusSchema,
  foldWindowStatus,
  type WindowEvent,
  type WindowOrigin,
  type WindowStatus,
} from '@autonomy-studio/shared';
import { runs, tumblingBackfillCursors, tumblingWindowState, windowEvents } from '../db/schema.js';
import type { Db } from './types.js';

/**
 * #5 S9 — the tumbling-window EVENT LOG + STATE PROJECTION repository.
 *
 * The spec's codex-hardened contract: "Tumbling state = projection, not
 * truth. Window lifecycle is domain events; the `tumbling_window_state` table
 * is a materialized projection with uniqueness." Every mutation here appends
 * the domain event AND applies its projection write IN ONE TRANSACTION
 * (nesting as a SAVEPOINT when the caller — the alarm handler — already holds
 * one), so the projection can lag the log only by a crash, and
 * `rebuildWindowStatus` (fold of the log) is always the authority.
 *
 * Projection transitions are STATUS-GUARDED (`WHERE status = ...`), mirroring
 * `admitQueuedRun`'s `status='queued'` guard: a duplicate/late writer loses
 * the guard and appends NOTHING (the event append is inside the same guarded
 * branch), keeping the log free of untruthful duplicates.
 */

/** The codex-hardened window key: `(triggerId, configEpoch, windowStart)`.
 * `interval` participates via the epoch (a hash over the geometry tuple —
 * `windowConfigEpoch` in `scheduler/tumbling.ts`). */
export interface WindowKey {
  triggerId: string;
  configEpoch: string;
  /** UTC ISO, inclusive start of `[windowStart, windowEnd)`. */
  windowStart: string;
}

export interface TumblingWindowStateRow extends WindowKey {
  windowEnd: string;
  status: WindowStatus;
  runId: string | null;
  /** #5 S10 — `'live'` (forward chain) vs `'backfill'` (the bounded backfill
   * pass); drives the materialization gate in `scheduler/tumbling.ts`. */
  origin: WindowOrigin;
  /** #5 S11c — retries consumed (0 = never re-driven). Monotonic via the
   * guarded `running → retry_pending` flip; equals the count of
   * `window.retryScheduled` events in the log (pinned by test). */
  attempt: number;
  /** #5 S11c — the STORED due instant (epoch ms) of a pending retry; NULL
   * outside `retry_pending`. The sync/reconcile overdue heal reads it. */
  nextAttemptAtMs: number | null;
  updatedAt: number;
}

function keyWhere(key: WindowKey) {
  return and(
    eq(tumblingWindowState.triggerId, key.triggerId),
    eq(tumblingWindowState.configEpoch, key.configEpoch),
    eq(tumblingWindowState.windowStart, key.windowStart),
  );
}

function appendEvent(db: Db, key: WindowKey, event: WindowEvent): void {
  // Validate through the shared union so a malformed payload can never enter
  // the durable log (the same boundary discipline `appendEngineEvent` applies
  // to the run log).
  const parsed = WindowEventSchema.parse(event);
  db.insert(windowEvents)
    .values({
      triggerId: key.triggerId,
      configEpoch: key.configEpoch,
      windowStart: key.windowStart,
      type: parsed.type,
      payload: parsed.payload,
      createdAt: Date.now(),
    })
    .run();
}

/**
 * CREATE a window: append `window.created` + insert the `waiting` projection
 * row, atomically. Returns `true` if created, `false` if the window already
 * exists (ANY status) — the single-fire no-op for a duplicate delivery or an
 * endTime-edit re-arm of an already-fired window. The projection PK is the
 * guard; the partial UNIQUE index on `window.created` events is the
 * defense-in-depth backstop beneath it.
 */
export function createWindow(
  db: Db,
  input: WindowKey & {
    windowEnd: string;
    geometry: { frequency: 'minute' | 'hour' | 'day'; interval: number; startTime: string };
    /** #5 S10 — REQUIRED, no repo-level default: the caller must state how the
     * window became known ('live' = forward chain, 'backfill' = the bounded
     * backfill pass) — a manufactured default here would silently mis-gate. */
    origin: WindowOrigin;
  },
): boolean {
  return db.transaction((tx) => {
    const inserted = tx
      .insert(tumblingWindowState)
      .values({
        triggerId: input.triggerId,
        configEpoch: input.configEpoch,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        status: 'waiting',
        runId: null,
        origin: input.origin,
        updatedAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) return false;
    appendEvent(tx, input, {
      type: 'window.created',
      payload: { windowEnd: input.windowEnd, ...input.geometry, origin: input.origin },
    });
    return true;
  });
}

/**
 * LINK a materialized run to its window: guarded flip `waiting → running` +
 * append `window.runCreated`, atomically. Returns `false` (and appends
 * nothing) if the window is not `waiting` or already linked — the idempotent
 * loser of a materialize/reconcile race. `via: 'reconcile'` records the
 * crash-heal path (an existing run linked instead of fired — see
 * `scheduler/tumbling.ts`'s single-fire reconcile).
 */
export function linkWindowRun(
  db: Db,
  key: WindowKey,
  runId: string,
  via: 'fire' | 'reconcile',
): boolean {
  return db.transaction((tx) => {
    const updated = tx
      .update(tumblingWindowState)
      .set({ status: 'running', runId, updatedAt: Date.now() })
      .where(and(keyWhere(key), eq(tumblingWindowState.status, 'waiting')))
      .run();
    if (updated.changes === 0) return false;
    appendEvent(tx, key, { type: 'window.runCreated', payload: { runId, via } });
    return true;
  });
}

/**
 * #5 S11c — RETRY a window from its run's KNOWN failure: guarded flip
 * `running → retry_pending` + append `window.retryScheduled`, atomically.
 * `attempt` increments, `runId` CLEARS (no run is in flight during the
 * interval — the completion tap must not resolve the consumed run to this
 * window again), and `nextAttemptAtMs` stores the due instant (the
 * `window_retry` alarm's `dueAt` mirrors it — never recomputed). Returns
 * `false` (appending nothing) unless the window is currently `running` — the
 * same at-least-once idempotency `completeWindow` has, so the tap and the
 * boot reconcile can both attempt the same retry and exactly one wins.
 * `runStatus` excludes `missing` at the type level: an unknown outcome never
 * retries (see the event schema).
 */
export function retryWindow(
  db: Db,
  key: WindowKey,
  input: {
    runId: string;
    runStatus: 'failure' | 'interrupted';
    attempt: number;
    nextAttemptAtMs: number;
  },
): boolean {
  return db.transaction((tx) => {
    const updated = tx
      .update(tumblingWindowState)
      .set({
        status: 'retry_pending',
        runId: null,
        attempt: input.attempt,
        nextAttemptAtMs: input.nextAttemptAtMs,
        updatedAt: Date.now(),
      })
      .where(and(keyWhere(key), eq(tumblingWindowState.status, 'running')))
      .run();
    if (updated.changes === 0) return false;
    appendEvent(tx, key, {
      type: 'window.retryScheduled',
      payload: {
        runId: input.runId,
        runStatus: input.runStatus,
        attempt: input.attempt,
        nextAttemptAt: new Date(input.nextAttemptAtMs).toISOString(),
      },
    });
    return true;
  });
}

/**
 * #5 S11c — the retry interval elapsed (`window_retry` fired, or the
 * sync/reconcile overdue heal drove it): guarded flip `retry_pending →
 * waiting` + append `window.retryDue`, atomically. The window re-enters the
 * materialize scan; `attempt` is kept (the budget check reads it at the NEXT
 * settle). Returns `false` (appending nothing) unless currently
 * `retry_pending` — a duplicate delivery/heal race loses the guard, so
 * double-driving is safe.
 */
export function retryDueWindow(db: Db, key: WindowKey, attempt: number): boolean {
  return db.transaction((tx) => {
    const updated = tx
      .update(tumblingWindowState)
      .set({ status: 'waiting', nextAttemptAtMs: null, updatedAt: Date.now() })
      .where(and(keyWhere(key), eq(tumblingWindowState.status, 'retry_pending')))
      .run();
    if (updated.changes === 0) return false;
    appendEvent(tx, key, { type: 'window.retryDue', payload: { attempt } });
    return true;
  });
}

/** The terminal fact `completeWindow` folds a run's outcome into. */
export type WindowTerminal =
  | { status: 'succeeded'; runId: string }
  | { status: 'failed'; runId: string | null; runStatus: 'failure' | 'interrupted' | 'missing' };

/**
 * COMPLETE a window from its run's terminal fact: guarded flip `running →
 * succeeded|failed` + append the matching event, atomically. Returns `false`
 * (appending nothing) unless the window is currently `running` — so the bus
 * tap and the boot reconcile can both attempt the same completion and exactly
 * one wins.
 */
export function completeWindow(db: Db, key: WindowKey, terminal: WindowTerminal): boolean {
  return db.transaction((tx) => {
    const updated = tx
      .update(tumblingWindowState)
      .set({ status: terminal.status, updatedAt: Date.now() })
      .where(and(keyWhere(key), eq(tumblingWindowState.status, 'running')))
      .run();
    if (updated.changes === 0) return false;
    appendEvent(
      tx,
      key,
      terminal.status === 'succeeded'
        ? { type: 'window.succeeded', payload: { runId: terminal.runId } }
        : {
            type: 'window.failed',
            payload: { runId: terminal.runId, runStatus: terminal.runStatus },
          },
    );
    return true;
  });
}

export function getWindowState(db: Db, key: WindowKey): TumblingWindowStateRow | null {
  const row = db.select().from(tumblingWindowState).where(keyWhere(key)).get();
  return row ?? null;
}

/** The completion tap's lookup: which window (if any) does this run serve? */
export function getWindowStateByRunId(db: Db, runId: string): TumblingWindowStateRow | null {
  const row = db
    .select()
    .from(tumblingWindowState)
    .where(eq(tumblingWindowState.runId, runId))
    .get();
  return row ?? null;
}

export interface ListWindowStatesFilter {
  triggerId?: string;
  configEpoch?: string;
  status?: WindowStatus;
  /** `true` → only rows with `run_id IS NULL` (the stranded-`waiting` scan). */
  unlinked?: boolean;
  /** #5 S10 — the two-scan materialize split: `'live'` (ungated, S9 batch
   * semantics) vs `'backfill'` (one-at-a-time under the gate). */
  origin?: WindowOrigin;
  limit?: number;
}

/** Windows in `windowStart` order (oldest first — the materialize order). */
export function listWindowStates(
  db: Db,
  filter: ListWindowStatesFilter = {},
): TumblingWindowStateRow[] {
  const conditions = [];
  if (filter.triggerId !== undefined)
    conditions.push(eq(tumblingWindowState.triggerId, filter.triggerId));
  if (filter.configEpoch !== undefined)
    conditions.push(eq(tumblingWindowState.configEpoch, filter.configEpoch));
  if (filter.status !== undefined) {
    conditions.push(eq(tumblingWindowState.status, WindowStatusSchema.parse(filter.status)));
  }
  if (filter.unlinked === true) conditions.push(isNull(tumblingWindowState.runId));
  if (filter.origin !== undefined) conditions.push(eq(tumblingWindowState.origin, filter.origin));
  let query = db
    .select()
    .from(tumblingWindowState)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(tumblingWindowState.windowStart))
    .$dynamic();
  if (filter.limit !== undefined) query = query.limit(filter.limit);
  return query.all();
}

/** One window's events in append (`seq`) order — the rebuild scan. */
export function listWindowEvents(db: Db, key: WindowKey): WindowEvent[] {
  const rows = db
    .select()
    .from(windowEvents)
    .where(
      and(
        eq(windowEvents.triggerId, key.triggerId),
        eq(windowEvents.configEpoch, key.configEpoch),
        eq(windowEvents.windowStart, key.windowStart),
      ),
    )
    .orderBy(asc(windowEvents.seq))
    .all();
  return rows.map((row) => WindowEventSchema.parse({ type: row.type, payload: row.payload }));
}

/**
 * The projection-rebuild authority: fold one window's event log to its status
 * (`null` = window unknown). The rebuild test pins
 * `getWindowState(...).status === rebuildWindowStatus(...)` for every
 * lifecycle path — the "projection, not truth" guarantee made executable.
 */
export function rebuildWindowStatus(db: Db, key: WindowKey): WindowStatus | null {
  return foldWindowStatus(listWindowEvents(db, key));
}

/**
 * #5 S9 single-fire reconcile (finding 3): an UNLINKED run for `triggerId`
 * whose frozen `triggerContext.scheduledTime` equals `windowEnd` AND whose
 * frozen `triggerContext.windowEpoch` equals `configEpoch` — the durable
 * run↔window join for the crash window between `launcher.fire` (run row
 * committed) and `linkWindowRun` (link committed). Excludes runs already
 * linked to ANY window. Oldest first, so a pathological double-fire heals
 * deterministically.
 *
 * S10 RE-VERIFY — RESOLVED: the epoch is now IN the join. S9's temporal
 * argument ("a stray unlinked run's frozen `scheduledTime` is past by the
 * time another epoch can produce a colliding window") broke the moment S10
 * backfill started creating PAST windows, so every window fire now freezes
 * `windowEpoch` into the run's `triggerContext` and the join matches it
 * STRICTLY. Strict on purpose: a NULL-tolerant match could LINK an old-epoch
 * orphan onto a backfilled window that shares its boundary instant — silent
 * corruption (the window would fold the WRONG run's outcome). The cost is
 * one narrow at-least-once case: a run fired by pre-S10 code whose link
 * crashed exactly at the upgrade boundary carries no `windowEpoch`, is never
 * link-healed, and its window fires a second run — duplicate execution, never
 * a wrong link.
 *
 * S11c RE-SHAPE: "unlinked" is now an EVENT-LOG fact, not a projection-column
 * fact. Retry clears the projection's `run_id` (the consumed attempt has no
 * current window), so the old exclusion — `NOT EXISTS(… s.run_id = runs.id)`
 * — would hand a consumed FAILED attempt back as a "crash orphan" and
 * link-heal it onto its own window: a stale outcome folded as fresh, the
 * retry budget burned with nothing re-executed. Every link since S9 appends
 * `window.runCreated` in the same tx (`linkWindowRun`), so the log's
 * runCreated set is the complete ever-linked set — the durable authority.
 * The subquery is scoped to THIS window's key columns (served by
 * `window_events_window_idx`, not a full log scan) — equivalent, not weaker:
 * candidates are already fixed to `(triggerId, windowEpoch, scheduledTime ==
 * windowEnd)`, every linked run's frozen `scheduledTime` equals its own
 * window's end, and in a fixed grid one `(epoch, windowEnd)` names exactly
 * one `windowStart` — so the only window whose `runCreated` events could
 * ever name a candidate run is this one.
 */
export function findUnlinkedRunForWindow(
  db: Db,
  triggerId: string,
  configEpoch: string,
  windowEnd: string,
  windowStart: string,
): string | null {
  const row = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.triggerId, triggerId),
        sql`json_extract(${runs.triggerContext}, '$.scheduledTime') = ${windowEnd}`,
        sql`json_extract(${runs.triggerContext}, '$.windowEpoch') = ${configEpoch}`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${windowEvents} e
          WHERE e.trigger_id = ${triggerId}
            AND e.config_epoch = ${configEpoch}
            AND e.window_start = ${windowStart}
            AND e.type = 'window.runCreated'
            AND json_extract(e.payload, '$.runId') = ${runs.id}
        )`,
      ),
    )
    .orderBy(asc(runs.startedAt), asc(runs.id))
    .limit(1)
    .get();
  return row?.id ?? null;
}

/**
 * #5 S10 — the durable backfill cursor for `(triggerId, configEpoch)`:
 * the EXCLUSIVE disposition boundary (epoch ms). Every window of the epoch
 * with `startMs < cursor` is dispositioned — created, or deliberately skipped
 * past the `maxBackfillWindows` lookback — and must never be re-created.
 * `null` = no backfill pass has run for this epoch yet.
 */
export function getBackfillCursor(db: Db, triggerId: string, configEpoch: string): number | null {
  const row = db
    .select({ cursorMs: tumblingBackfillCursors.cursorMs })
    .from(tumblingBackfillCursors)
    .where(
      and(
        eq(tumblingBackfillCursors.triggerId, triggerId),
        eq(tumblingBackfillCursors.configEpoch, configEpoch),
      ),
    )
    .get();
  return row?.cursorMs ?? null;
}

/**
 * Advance the backfill cursor — MONOTONIC by construction (`MAX(cursor_ms,
 * excluded)`): a backwards move would un-disposition skipped windows and
 * resurrect them, so a stale caller (e.g. a backwards clock jump making a
 * later pass compute an earlier edge) silently loses to the stored value
 * rather than rewinding it.
 */
export function advanceBackfillCursor(
  db: Db,
  triggerId: string,
  configEpoch: string,
  cursorMs: number,
): void {
  db.insert(tumblingBackfillCursors)
    .values({ triggerId, configEpoch, cursorMs, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: [tumblingBackfillCursors.triggerId, tumblingBackfillCursors.configEpoch],
      set: {
        cursorMs: sql`MAX(${tumblingBackfillCursors.cursorMs}, excluded.cursor_ms)`,
        updatedAt: Date.now(),
      },
    })
    .run();
}
