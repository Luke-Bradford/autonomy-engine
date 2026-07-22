import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  WindowEventSchema,
  WindowStatusSchema,
  foldWindowStatus,
  type WindowEvent,
  type WindowStatus,
} from '@autonomy-studio/shared';
import { runs, tumblingWindowState, windowEvents } from '../db/schema.js';
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
        updatedAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
    if (inserted.changes === 0) return false;
    appendEvent(tx, input, {
      type: 'window.created',
      payload: { windowEnd: input.windowEnd, ...input.geometry },
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
 * whose frozen `triggerContext.scheduledTime` equals `windowEnd` — the
 * durable run↔window join for the crash window between `launcher.fire` (run
 * row committed) and `linkWindowRun` (link committed). Excludes runs already
 * linked to ANY window (an epoch edit can make two epochs share a boundary
 * instant, and the old epoch's run must never satisfy the new epoch's heal).
 * Oldest first, so a pathological double-fire heals deterministically.
 *
 * S10 RE-VERIFY POINT: an UNLINKED old-epoch run at a shared boundary would
 * satisfy this join too. Unreachable in forward-only S9 (every window's end is
 * strictly future at creation, while a stray unlinked run's frozen
 * `scheduledTime` is past by the time another epoch can produce a colliding
 * window) — but S10 backfill arms PAST windows and breaks that temporal
 * argument. The fix belongs to S10: persist the window key (epoch) in
 * `triggerContext` for window fires and add it to this join. (`triggerContext`
 * carries no epoch field today, so the join cannot be epoch-scoped yet.)
 */
export function findUnlinkedRunForWindow(
  db: Db,
  triggerId: string,
  windowEnd: string,
): string | null {
  const row = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.triggerId, triggerId),
        sql`json_extract(${runs.triggerContext}, '$.scheduledTime') = ${windowEnd}`,
        sql`NOT EXISTS (SELECT 1 FROM ${tumblingWindowState} s WHERE s.run_id = ${runs.id})`,
      ),
    )
    .orderBy(asc(runs.startedAt), asc(runs.id))
    .limit(1)
    .get();
  return row?.id ?? null;
}
