import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_VERSION,
  type NewPipelineVersion,
  type Node,
  type Trigger,
  type TriggerMode,
  type WindowConfig,
} from '@autonomy-studio/shared';
import { triggers } from '../../db/schema.js';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createTrigger, deleteTrigger, updateTrigger } from '../../repo/triggers.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { armWakeup, getWakeup, listPendingWakeups } from '../../repo/scheduled-wakeups.js';
import { createRun, updateRun } from '../../repo/runs.js';
import {
  advanceBackfillCursor,
  createWindow,
  findUnlinkedRunForWindow,
  getBackfillCursor,
  getWindowState,
  linkWindowRun,
  listWindowEvents,
  listWindowStates,
  rebuildWindowStatus,
  completeWindow,
  retryDueWindow,
  retryWindow,
  supersedeWindow,
  type WindowKey,
} from '../../repo/tumbling-windows.js';
import type { Db } from '../../repo/types.js';
import { createRunEventBus } from '../../run/event-bus.js';
import { type FireContext, type FireResult } from '../../run/launcher.js';
import { createAlarmClock, type WakeupHandler } from '../alarms.js';
import {
  buildWindowDueRef,
  buildWindowRetryRef,
  createTumblingService,
  firstWindowEndingAfter,
  isTumblable,
  isWindowRefFresh,
  WINDOW_DUE_KIND,
  WINDOW_RETRY_KIND,
  windowConfigEpoch,
  windowSizeMs,
  type TumblingLauncher,
} from '../tumbling.js';
import { silentLog } from './testLog.js';

/**
 * #5 S9 — the tumbling-window service, against a real DB, the real alarm
 * clock, real transactions, real `scheduled_wakeups` / `window_events` /
 * `tumbling_window_state` rows. Nothing mocked but the clock (`now`) and the
 * launcher (the run-spawning seam the handler must reach only via
 * `afterCommit`).
 */

// The anchor: windows are [T0 + k*15min, T0 + (k+1)*15min).
const T0 = Date.parse('2026-07-01T00:00:00.000Z');
const MIN15 = 15 * 60_000;
const W0_END = T0 + MIN15;

const CONFIG: WindowConfig = {
  frequency: 'minute',
  interval: 15,
  startTime: '2026-07-01T00:00:00.000Z',
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function seedVersion(db: Db): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const node: Node = { id: 'a', type: 'test_activity', config: {}, position: { x: 0, y: 0 } };
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: [node],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input).id;
}

function seedTumbling(
  db: Db,
  opts: {
    pipelineVersionId: string | null;
    window?: WindowConfig | null;
    mode?: TriggerMode;
    enabled?: boolean;
  } = { pipelineVersionId: null },
): Trigger {
  return createTrigger(db, {
    ownerId: 'local',
    name: 'TW',
    pipelineVersionId: opts.pipelineVersionId,
    params: {},
    mode: opts.mode ?? 'tumbling',
    schedule: null,
    recurrence: null,
    webhook: null,
    event: null,
    window: opts.window === undefined ? CONFIG : opts.window,
    concurrency: { policy: 'queue' },
    runWindows: null,
    enabled: opts.enabled ?? true,
  });
}

/** A launcher double recording fires; outcome per call is scriptable. */
function fakeLauncher(
  outcomes: FireResult[] = [],
): TumblingLauncher & { fires: Trigger[]; contexts: (FireContext | undefined)[] } {
  const fires: Trigger[] = [];
  const contexts: (FireContext | undefined)[] = [];
  let n = 0;
  return {
    fires,
    contexts,
    fire: vi.fn((t: Trigger, fc?: FireContext): FireResult => {
      fires.push(t);
      contexts.push(fc);
      const scripted = outcomes[n];
      n += 1;
      return scripted ?? { outcome: 'started', runId: `run-${n}` };
    }),
  };
}

function harness(db: Db, now: () => number, launcher: TumblingLauncher = fakeLauncher()) {
  const service = createTumblingService({
    db,
    arm: () => undefined, // sync() tests build their own service with the clock's arm
    launcher,
    log: silentLog(),
    now,
  });
  const clock = createAlarmClock({ db, handlers: [service.handler], log: silentLog(), now });
  return { clock, service, launcher };
}

/** Arm a window_due row for `trigger`'s window ending at `endMs`, as sync()/a
 * prior fire would (the single ref constructor). */
function armWindow(db: Db, trigger: Trigger, startMs: number, endMs: number) {
  if (!isTumblable(trigger)) throw new Error('fixture must be tumblable');
  return armWakeup(db, {
    kind: WINDOW_DUE_KIND,
    ref: buildWindowDueRef(trigger, {
      startMs,
      endMs,
      startIso: iso(startMs),
      endIso: iso(endMs),
    }),
    dueAt: endMs,
    discriminator: `window-${startMs}`,
  });
}

function pendingWindows(db: Db) {
  return listPendingWakeups(db).filter((w) => w.kind === WINDOW_DUE_KIND);
}

function keyFor(trigger: Trigger, startMs: number): WindowKey {
  if (!isTumblable(trigger)) throw new Error('fixture must be tumblable');
  return {
    triggerId: trigger.id,
    configEpoch: windowConfigEpoch(trigger.window),
    windowStart: iso(startMs),
  };
}

/** #637 — corrupt a trigger row IN PLACE, past the write API (which re-parses):
 * an out-of-enum concurrency policy is valid JSON with no CHECK constraint, so
 * the row persists but `TriggerSchema.parse` rejects it — the hand-edit/legacy
 * drift vector the ticket names. */
function corruptTriggerRow(db: Db, id: string): void {
  db.update(triggers)
    .set({ concurrency: { policy: 'nope' } as unknown as Trigger['concurrency'] })
    .where(eq(triggers.id, id))
    .run();
}

describe('window math', () => {
  it('windowSizeMs multiplies the fixed unit by interval', () => {
    expect(windowSizeMs(CONFIG)).toBe(MIN15);
    expect(windowSizeMs({ ...CONFIG, frequency: 'hour', interval: 2 })).toBe(7_200_000);
    expect(windowSizeMs({ ...CONFIG, frequency: 'day', interval: 1 })).toBe(86_400_000);
  });

  it('firstWindowEndingAfter returns the window CONTAINING the instant', () => {
    const w = firstWindowEndingAfter(CONFIG, T0 + 5 * 60_000);
    expect(w).toEqual({ startMs: T0, endMs: W0_END, startIso: iso(T0), endIso: iso(W0_END) });
  });

  it('an instant exactly ON a boundary belongs to the window STARTING there', () => {
    // afterMs == W0_END: window 0's end is not strictly after → window 1.
    const w = firstWindowEndingAfter(CONFIG, W0_END);
    expect(w?.startMs).toBe(W0_END);
    expect(w?.endMs).toBe(W0_END + MIN15);
  });

  it('a future startTime yields window 0', () => {
    const w = firstWindowEndingAfter(CONFIG, T0 - 3_600_000);
    expect(w?.startMs).toBe(T0);
    expect(w?.endMs).toBe(W0_END);
  });

  it('endTime bounds the chain — a PARTIAL trailing window never fires', () => {
    // endTime 20min after T0: window 0 (ends +15min) fits; window 1 (ends
    // +30min) exceeds → null.
    const bounded = { ...CONFIG, endTime: iso(T0 + 20 * 60_000) };
    expect(firstWindowEndingAfter(bounded, T0 + 1)?.endMs).toBe(W0_END);
    expect(firstWindowEndingAfter(bounded, W0_END)).toBeNull();
  });

  it('skips missed windows: a late instant maps to the CURRENT window (no backfill)', () => {
    const late = T0 + 10 * MIN15 + 1;
    const w = firstWindowEndingAfter(CONFIG, late);
    expect(w?.startMs).toBe(T0 + 10 * MIN15);
  });
});

describe('windowConfigEpoch — the pinned geometry tuple', () => {
  it('is deterministic and geometry-sensitive', () => {
    expect(windowConfigEpoch(CONFIG)).toBe(windowConfigEpoch({ ...CONFIG }));
    expect(windowConfigEpoch(CONFIG)).not.toBe(windowConfigEpoch({ ...CONFIG, interval: 30 }));
    expect(windowConfigEpoch(CONFIG)).not.toBe(windowConfigEpoch({ ...CONFIG, frequency: 'hour' }));
    expect(windowConfigEpoch(CONFIG)).not.toBe(
      windowConfigEpoch({ ...CONFIG, startTime: '2026-07-02T00:00:00.000Z' }),
    );
  });

  it('an endTime edit does NOT change the epoch (bound, not identity)', () => {
    // A benign endTime extension must never re-key — and so re-fire —
    // already-fired windows.
    expect(windowConfigEpoch({ ...CONFIG, endTime: iso(T0 + MIN15) })).toBe(
      windowConfigEpoch(CONFIG),
    );
  });

  it('but an endTime edit DOES stale the armed ref (freshness, not identity)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    if (!isTumblable(trigger)) throw new Error('unreachable');
    const ref = buildWindowDueRef(trigger, {
      startMs: T0,
      endMs: W0_END,
      startIso: iso(T0),
      endIso: iso(W0_END),
    });
    expect(isWindowRefFresh(trigger, ref)).toBe(true);
    const edited = updateTrigger(db, trigger.id, {
      window: { ...CONFIG, endTime: iso(T0 + 40 * 60_000) },
    });
    if (edited === null || !isTumblable(edited)) throw new Error('unreachable');
    expect(isWindowRefFresh(edited, ref)).toBe(false);
  });
});

describe('window_due handler — fire + continue the chain', () => {
  it('creates the window (event + waiting projection), arms the next, then materializes', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const row = armWindow(db, trigger, T0, W0_END);

    const { clock, launcher } = harness(db, () => W0_END);
    clock.tick();

    // Fired once, afterCommit, with `${trigger.scheduledTime}` = windowEnd,
    // (#5 S10) the config epoch frozen in for the epoch-scoped link join, and
    // (#5 S11b) the user-facing window bounds for `${trigger.windowStart/End}`.
    const fl = launcher as ReturnType<typeof fakeLauncher>;
    expect(fl.fires.map((t) => t.id)).toEqual([trigger.id]);
    expect(fl.contexts).toEqual([
      {
        scheduledTime: iso(W0_END),
        windowEpoch: windowConfigEpoch(CONFIG),
        windowStart: iso(T0),
        windowEnd: iso(W0_END),
      },
    ]);

    // The row settled fired; the chain armed window 1 in the same tx.
    expect(getWakeup(db, row.id)?.status).toBe('fired');
    const pending = pendingWindows(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dueAt).toBe(W0_END + MIN15);

    // The window is projected `running`, linked to the fired run, and the
    // event log carries created + runCreated in order.
    const key = keyFor(trigger, T0);
    const state = getWindowState(db, key);
    expect(state?.status).toBe('running');
    expect(state?.runId).toBe('run-1');
    expect(state?.windowEnd).toBe(iso(W0_END));
    expect(listWindowEvents(db, key).map((e) => e.type)).toEqual([
      'window.created',
      'window.runCreated',
    ]);
    // Projection == fold (the rebuild authority).
    expect(rebuildWindowStatus(db, key)).toBe('running');
  });

  it('window.created snapshots the full geometry (self-sufficient after a config edit)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    armWindow(db, trigger, T0, W0_END);
    const { clock } = harness(db, () => W0_END);
    clock.tick();

    const [created] = listWindowEvents(db, keyFor(trigger, T0));
    expect(created).toEqual({
      type: 'window.created',
      payload: {
        windowEnd: iso(W0_END),
        frequency: 'minute',
        interval: 15,
        startTime: CONFIG.startTime,
        origin: 'live',
      },
    });
  });

  it('links a QUEUED fire by its (now-reported) runId', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    armWindow(db, trigger, T0, W0_END);

    const launcher = fakeLauncher([{ outcome: 'queued', runId: 'run-q' }]);
    const { clock } = harness(db, () => W0_END, launcher);
    clock.tick();

    const state = getWindowState(db, keyFor(trigger, T0));
    expect(state?.status).toBe('running');
    expect(state?.runId).toBe('run-q');
  });

  it('a SKIPPED fire leaves the window waiting + unlinked (healed later, never dropped)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    armWindow(db, trigger, T0, W0_END);

    const launcher = fakeLauncher([{ outcome: 'skipped', reason: 'queue is full' }]);
    const { clock } = harness(db, () => W0_END, launcher);
    clock.tick();

    const state = getWindowState(db, keyFor(trigger, T0));
    expect(state?.status).toBe('waiting');
    expect(state?.runId).toBeNull();
    // The chain still advanced — a skip never stalls future windows.
    expect(pendingWindows(db)).toHaveLength(1);
  });

  it('the NEXT window fire retries a stranded earlier window FIRST (oldest-first)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    armWindow(db, trigger, T0, W0_END);

    // Window 0's fire skips (full queue); window 1's fire then materializes
    // BOTH: window 0 first, then window 1.
    const launcher = fakeLauncher([
      { outcome: 'skipped', reason: 'queue is full' },
      { outcome: 'started', runId: 'run-w0' },
      { outcome: 'started', runId: 'run-w1' },
    ]);
    const { clock } = harness(db, () => W0_END, launcher);
    clock.tick(); // window 0 → skip

    // Advance to window 1's due and re-harness the clock at the later instant.
    const w1End = W0_END + MIN15;
    const clock2 = createAlarmClock({
      db,
      handlers: [
        createTumblingService({
          db,
          arm: () => undefined,
          launcher,
          log: silentLog(),
          now: () => w1End,
        }).handler,
      ],
      log: silentLog(),
      now: () => w1End,
    });
    clock2.tick(); // window 1 fires → materializes stranded w0, then w1

    expect(getWindowState(db, keyFor(trigger, T0))?.runId).toBe('run-w0');
    expect(getWindowState(db, keyFor(trigger, W0_END))?.runId).toBe('run-w1');
    expect(launcher.contexts.map((c) => c?.scheduledTime)).toEqual([
      iso(W0_END),
      iso(W0_END), // stranded window 0 retried first…
      iso(w1End), // …then the fresh window 1
    ]);
  });

  it('≤1 late + NO BACKFILL: an overdue row fires once; the next armed window is CURRENT', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    armWindow(db, trigger, T0, W0_END);

    // The server slept for ~10 windows.
    const lateNow = T0 + 10 * MIN15 + 5_000;
    const { clock, launcher } = harness(db, () => lateNow);
    clock.tick();

    // The overdue window 0 still fired (its data span is long complete)…
    expect((launcher as ReturnType<typeof fakeLauncher>).fires).toHaveLength(1);
    // …and the chain jumped to the window containing `now` — windows 1..9 are
    // NOT armed (S10 backfill's job, not this chain's).
    const pending = pendingWindows(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dueAt).toBe(T0 + 11 * MIN15);
  });

  it('ends the chain when endTime exhausts (no next armed)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const bounded = { ...CONFIG, endTime: iso(T0 + 20 * 60_000) };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: bounded });
    armWindow(db, trigger, T0, W0_END);

    const { clock, launcher } = harness(db, () => W0_END);
    clock.tick();

    // Window 0 fired; window 1 would end past endTime → chain over.
    expect((launcher as ReturnType<typeof fakeLauncher>).fires).toHaveLength(1);
    expect(pendingWindows(db)).toHaveLength(0);
  });

  it('does NOT double-create on at-least-once redelivery', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    armWindow(db, trigger, T0, W0_END);

    const { clock, launcher } = harness(db, () => W0_END);
    clock.tick();
    clock.tick();

    expect((launcher as ReturnType<typeof fakeLauncher>).fires).toHaveLength(1);
    expect(listWindowEvents(db, keyFor(trigger, T0)).length).toBe(2); // created + runCreated
  });

  it('suppresses window_already_exists (an endTime-edit re-arm of a fired window) — chain still advances', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    // The window already exists (fired under a previous ref).
    createWindow(db, {
      ...keyFor(trigger, T0),
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin: 'live',
    });
    const row = armWindow(db, trigger, T0, W0_END);

    const { clock, launcher } = harness(db, () => W0_END);
    clock.tick();

    expect(getWakeup(db, row.id)?.status).toBe('suppressed');
    expect((launcher as ReturnType<typeof fakeLauncher>).fires).toHaveLength(0);
    expect(pendingWindows(db)).toHaveLength(1); // next window armed regardless
    expect(listWindowEvents(db, keyFor(trigger, T0)).map((e) => e.type)).toEqual([
      'window.created', // only the pre-existing one — no duplicate
    ]);
  });

  it.each([
    ['disabled', (db: Db, t: Trigger) => updateTrigger(db, t.id, { enabled: false })],
    [
      'config removed',
      (db: Db, t: Trigger) => updateTrigger(db, t.id, { window: null, enabled: false }),
    ],
  ])('suppresses trigger_not_tumbling when %s', (_label, mutate) => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const row = armWindow(db, trigger, T0, W0_END);
    mutate(db, trigger);

    const { clock, launcher } = harness(db, () => W0_END);
    clock.tick();

    expect(getWakeup(db, row.id)?.status).toBe('suppressed');
    expect((launcher as ReturnType<typeof fakeLauncher>).fires).toHaveLength(0);
    expect(pendingWindows(db)).toHaveLength(0); // terminal: no re-arm
    expect(getWindowState(db, keyFor(trigger, T0))).toBeNull(); // no window created
  });

  it('suppresses trigger_unbound (belt to the launcher guard)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const row = armWindow(db, trigger, T0, W0_END);
    updateTrigger(db, trigger.id, { pipelineVersionId: null, enabled: false });
    updateTrigger(db, trigger.id, { enabled: true }); // enabled but unbound (route would refuse; repo-level state)

    const { clock, launcher } = harness(db, () => W0_END);
    clock.tick();

    expect(getWakeup(db, row.id)?.status).toBe('suppressed');
    expect((launcher as ReturnType<typeof fakeLauncher>).fires).toHaveLength(0);
  });

  it('suppresses ref_stale on a geometry edit (new epoch; sync seeds the new chain)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const row = armWindow(db, trigger, T0, W0_END);
    updateTrigger(db, trigger.id, { window: { ...CONFIG, interval: 30 } });

    const { clock, launcher } = harness(db, () => W0_END);
    clock.tick();

    expect(getWakeup(db, row.id)?.status).toBe('suppressed');
    expect((launcher as ReturnType<typeof fakeLauncher>).fires).toHaveLength(0);
    expect(pendingWindows(db)).toHaveLength(0);
  });

  // #637 — a poison (unparseable) trigger row must SETTLE the chain, never
  // throw: a handler throw rolls back the fire tx, so the pending row would
  // re-fire + error-log on every tick, forever (`sync()` re-seeds after repair).
  it('unparseable trigger row → suppressed trigger_unparseable, NO re-arm, NO throw (#637)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const row = armWindow(db, trigger, T0, W0_END);
    corruptTriggerRow(db, trigger.id);

    // Direct fire pins the suppression REASON (the clock only debug-logs it)…
    const launcher = fakeLauncher();
    const { service } = harness(db, () => W0_END, launcher);
    const result = service.handler.fire(
      row,
      { scheduledFor: W0_END, firedAt: W0_END, latenessMs: 0 },
      db,
    );
    expect(result).toMatchObject({ status: 'suppressed', reason: 'trigger_unparseable' });
    expect(launcher.fires).toHaveLength(0);
    expect(pendingWindows(db).filter((w) => w.id !== row.id)).toHaveLength(0); // no re-arm
    expect(getWindowState(db, keyFor(trigger, T0))).toBeNull(); // no window created

    // …and the REAL clock settles the row durably (not pending-forever).
    const { clock } = harness(db, () => W0_END, launcher);
    expect(() => clock.tick()).not.toThrow();
    expect(getWakeup(db, row.id)?.status).toBe('suppressed');
    clock.tick(); // settled — nothing re-delivers
    expect(launcher.fires).toHaveLength(0);
  });
});

describe('single-fire under crash: link-before-fire reconcile', () => {
  it('LINKS an existing unlinked run instead of firing a second one', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });

    // The crash shape: window created (waiting) + the fire's run row committed
    // (frozen triggerContext.scheduledTime = windowEnd) — but the link never
    // landed.
    const key = keyFor(trigger, T0);
    createWindow(db, {
      ...key,
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin: 'live',
    });
    const orphan = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv,
      triggerId: trigger.id,
      parentRunId: null,
      params: {},
      triggerContext: {
        triggerId: trigger.id,
        scheduledTime: iso(W0_END),
        body: null,
        windowEpoch: windowConfigEpoch(CONFIG),
      },
    });

    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
    });
    service.reconcile();

    // No second fire; the orphan is linked via 'reconcile'.
    expect(launcher.fires).toHaveLength(0);
    const state = getWindowState(db, key);
    expect(state?.status).toBe('running');
    expect(state?.runId).toBe(orphan.id);
    const events = listWindowEvents(db, key);
    expect(events[1]).toEqual({
      type: 'window.runCreated',
      payload: { runId: orphan.id, via: 'reconcile' },
    });
  });

  it('a linked-at-reconcile run that ALREADY terminalized completes the window immediately', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const key = keyFor(trigger, T0);
    createWindow(db, {
      ...key,
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin: 'live',
    });
    const orphan = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv,
      triggerId: trigger.id,
      parentRunId: null,
      params: {},
      triggerContext: {
        triggerId: trigger.id,
        scheduledTime: iso(W0_END),
        body: null,
        windowEpoch: windowConfigEpoch(CONFIG),
      },
    });
    updateRun(db, orphan.id, { status: 'success', finishedAt: W0_END + 1 });

    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher: fakeLauncher(),
      log: silentLog(),
    });
    service.reconcile();

    expect(getWindowState(db, key)?.status).toBe('succeeded');
    expect(rebuildWindowStatus(db, key)).toBe('succeeded');
  });

  it('an OLD epoch’s linked run never satisfies a NEW epoch’s window at a shared boundary', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    if (!isTumblable(trigger)) throw new Error('unreachable');
    const oldKey = keyFor(trigger, T0);

    // Old epoch: window [T0, T0+15) fired and LINKED its run.
    createWindow(db, {
      ...oldKey,
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin: 'live',
    });
    const oldRun = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv,
      triggerId: trigger.id,
      parentRunId: null,
      params: {},
      triggerContext: { triggerId: trigger.id, scheduledTime: iso(W0_END), body: null },
    });
    linkWindowRun(db, oldKey, oldRun.id, 'fire');

    // Geometry edit: 5-minute windows share the boundary instant T0+15min.
    const edited = updateTrigger(db, trigger.id, { window: { ...CONFIG, interval: 5 } });
    if (edited === null || !isTumblable(edited)) throw new Error('unreachable');
    const newEpoch = windowConfigEpoch(edited.window);
    const newKey = {
      triggerId: trigger.id,
      configEpoch: newEpoch,
      windowStart: iso(T0 + 10 * 60_000),
    };
    createWindow(db, {
      ...newKey,
      windowEnd: iso(W0_END), // same instant as the old window's end
      geometry: { frequency: 'minute', interval: 5, startTime: CONFIG.startTime },
      origin: 'live',
    });

    const launcher = fakeLauncher([{ outcome: 'started', runId: 'run-new' }]);
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
    });
    service.reconcile();

    // The old (already-linked) run was NOT reused — a fresh fire materialized
    // the new window.
    expect(launcher.fires).toHaveLength(1);
    expect(getWindowState(db, newKey)?.runId).toBe('run-new');
    expect(getWindowState(db, oldKey)?.runId).toBe(oldRun.id);
  });
});

describe('completion: bus tap + boot reconcile', () => {
  function linkedWindow(db: Db, trigger: Trigger, pv: string) {
    const key = keyFor(trigger, T0);
    createWindow(db, {
      ...key,
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin: 'live',
    });
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv,
      triggerId: trigger.id,
      parentRunId: null,
      params: {},
      triggerContext: { triggerId: trigger.id, scheduledTime: iso(W0_END), body: null },
    });
    linkWindowRun(db, key, run.id, 'fire');
    return { key, run };
  }

  it('the tap completes a window when its run finishes (success)', async () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const { key, run } = linkedWindow(db, trigger, pv);
    updateRun(db, run.id, { status: 'success', finishedAt: W0_END + 1 });

    const bus = createRunEventBus();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher: fakeLauncher(),
      log: silentLog(),
    });
    const unsubscribe = service.subscribeCompletion(bus);
    bus.publish({
      id: 'evt1',
      runId: run.id,
      seq: 9,
      type: 'run.finished',
      payload: { outcome: 'success' },
      ts: W0_END + 1,
    });
    await Promise.resolve(); // the tap defers one microtask

    expect(getWindowState(db, key)?.status).toBe('succeeded');
    expect(rebuildWindowStatus(db, key)).toBe('succeeded');
    unsubscribe();
  });

  it('the tap folds failure and interrupted runs to window.failed', async () => {
    for (const runStatus of ['failure', 'interrupted'] as const) {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv });
      const { key, run } = linkedWindow(db, trigger, pv);
      updateRun(db, run.id, { status: runStatus, finishedAt: W0_END + 1 });

      const bus = createRunEventBus();
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
      });
      service.subscribeCompletion(bus);
      bus.publish({
        id: 'evt1',
        runId: run.id,
        seq: 9,
        type: runStatus === 'failure' ? 'run.finished' : 'run.interrupted',
        payload: {},
        ts: W0_END + 1,
      });
      await Promise.resolve();

      const state = getWindowState(db, key);
      expect(state?.status).toBe('failed');
      const events = listWindowEvents(db, key);
      expect(events[2]).toEqual({
        type: 'window.failed',
        payload: { runId: run.id, runStatus },
      });
    }
  });

  it('the tap ignores a still-live run and non-window runs', async () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const { key, run } = linkedWindow(db, trigger, pv); // run still `pending`

    const bus = createRunEventBus();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher: fakeLauncher(),
      log: silentLog(),
    });
    service.subscribeCompletion(bus);
    // A terminal event for a run that is (per the DB) not terminal yet — the
    // tap trusts the ROW, so the window stays running (reconcile later heals).
    bus.publish({
      id: 'evt1',
      runId: run.id,
      seq: 9,
      type: 'run.finished',
      payload: { outcome: 'success' },
      ts: 1,
    });
    // And a terminal event for an unrelated run — no window, no-op.
    bus.publish({
      id: 'evt2',
      runId: 'run-unrelated',
      seq: 1,
      type: 'run.finished',
      payload: { outcome: 'success' },
      ts: 1,
    });
    await Promise.resolve();

    expect(getWindowState(db, key)?.status).toBe('running');
  });

  it('boot reconcile settles a running window whose run terminalized while down (missed tap)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const { key, run } = linkedWindow(db, trigger, pv);
    updateRun(db, run.id, { status: 'failure', finishedAt: W0_END + 1 });

    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher: fakeLauncher(),
      log: silentLog(),
    });
    service.reconcile();

    expect(getWindowState(db, key)?.status).toBe('failed');
    expect(rebuildWindowStatus(db, key)).toBe('failed');
  });

  it('boot reconcile folds a VANISHED run closed as failed{missing}', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const key = keyFor(trigger, T0);
    createWindow(db, {
      ...key,
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin: 'live',
    });
    // Link to a run id that has no row (deleted out-of-band / corrupted).
    linkWindowRun(db, key, 'run-gone', 'fire');

    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher: fakeLauncher(),
      log: silentLog(),
    });
    service.reconcile();

    const state = getWindowState(db, key);
    expect(state?.status).toBe('failed');
    const events = listWindowEvents(db, key);
    expect(events[2]).toEqual({
      type: 'window.failed',
      payload: { runId: 'run-gone', runStatus: 'missing' },
    });
  });

  it('a stranded-window sweep past the batch bound WARNS instead of truncating silently', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    if (!isTumblable(trigger)) throw new Error('unreachable');
    const epoch = windowConfigEpoch(trigger.window);
    // One more stranded window than one pass retries (MATERIALIZE_BATCH = 25).
    for (let k = 0; k < 26; k += 1) {
      createWindow(db, {
        triggerId: trigger.id,
        configEpoch: epoch,
        windowStart: iso(T0 + k * MIN15),
        windowEnd: iso(T0 + (k + 1) * MIN15),
        geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
        origin: 'live',
      });
    }

    const warns: unknown[] = [];
    const log = {
      error: () => undefined,
      warn: (_obj: unknown, msg?: string) => {
        warns.push(msg);
      },
      debug: () => undefined,
    };
    // #5 S11d re-shaped the bound: the keyset scan is bounded by FIRES (a
    // dependency-blocked row consumes cursor, not budget), so the truncation
    // warn now signals "the pass admitted its full batch and more remains" —
    // the launcher admits everything and the 26th window is the excess. (A
    // launcher-refusal backlog signals through its own per-skip warn.)
    const launcher = fakeLauncher();
    const service = createTumblingService({ db, arm: () => undefined, launcher, log });
    service.reconcile();

    expect(warns.some((m) => typeof m === 'string' && m.includes('truncated'))).toBe(true);
    // Nothing dropped: the batch fired; the excess window is still durably
    // `waiting` for later passes.
    expect(launcher.fires).toHaveLength(25);
    expect(listWindowStates(db, { triggerId: trigger.id, status: 'waiting' })).toHaveLength(1);
  });

  it('boot reconcile re-materializes a stranded waiting window (fires once)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const key = keyFor(trigger, T0);
    createWindow(db, {
      ...key,
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin: 'live',
    });

    const launcher = fakeLauncher([{ outcome: 'started', runId: 'run-heal' }]);
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
    });
    service.reconcile();

    expect(launcher.fires).toHaveLength(1);
    expect(getWindowState(db, key)?.runId).toBe('run-heal');
  });

  it('boot reconcile DISPOSITIONS a stale-epoch waiting window (superseded, never fired — #5 S11d)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const key = keyFor(trigger, T0); // key under the ORIGINAL geometry
    createWindow(db, {
      ...key,
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin: 'live',
    });
    updateTrigger(db, trigger.id, { window: { ...CONFIG, interval: 30 } }); // new epoch

    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
    });
    service.reconcile();

    // Pre-S11d the row stayed `waiting` forever (documented inert debris);
    // the disposition pass now folds it terminal — still never fired.
    expect(launcher.fires).toHaveLength(0);
    expect(getWindowState(db, key)?.status).toBe('superseded');
  });

  // #637 — `reconcile()` is called BARE at boot (`index.ts`), so a poison
  // trigger row with a stranded waiting window used to throw out of the whole
  // scan: one corrupt row ABORTED SERVER BOOT and starved every other
  // trigger's reconcile. It must skip-and-warn instead (`listParsedTriggers`'
  // per-row discipline), still healing the healthy triggers.
  it('boot reconcile SURVIVES a poison trigger row and still heals the healthy one (#637)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const poison = seedTumbling(db, { pipelineVersionId: pv });
    const healthy = seedTumbling(db, { pipelineVersionId: pv });
    // Both triggers have a stranded waiting window (crash between window tx and fire).
    for (const t of [poison, healthy]) {
      createWindow(db, {
        ...keyFor(t, T0),
        windowEnd: iso(W0_END),
        geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
        origin: 'live',
      });
    }
    corruptTriggerRow(db, poison.id);

    const warns: unknown[] = [];
    const log = {
      error: () => undefined,
      warn: (_obj: unknown, msg?: string) => warns.push(msg),
      debug: () => undefined,
    };
    const launcher = fakeLauncher([{ outcome: 'started', runId: 'run-heal' }]);
    const service = createTumblingService({ db, arm: () => undefined, launcher, log });
    expect(() => service.reconcile()).not.toThrow();

    // The healthy trigger's stranded window still healed…
    expect(getWindowState(db, keyFor(healthy, T0))?.runId).toBe('run-heal');
    // …the poison one was skipped (inert, not lost) and the corruption reported.
    expect(getWindowState(db, keyFor(poison, T0))?.status).toBe('waiting');
    expect(warns.length).toBeGreaterThan(0);
  });

  it('the completion tap tolerates a poison trigger row: settles the window, skips the drain (#637)', async () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const { key, run } = linkedWindow(db, trigger, pv);
    updateRun(db, run.id, { status: 'success', finishedAt: W0_END + 1 });
    corruptTriggerRow(db, trigger.id);

    // The pre-fix tap also settled (the throw came AFTER `settleIfTerminal`,
    // caught by the tap's own try/catch) — what the fix changes is the
    // reporting: a deliberate per-skip WARN, not caught-error spam. Collect
    // both channels so the test pins that distinction.
    const warns: unknown[] = [];
    const errors: unknown[] = [];
    const log = {
      error: (_obj: unknown, msg?: string) => errors.push(msg),
      warn: (_obj: unknown, msg?: string) => warns.push(msg),
      debug: () => undefined,
    };
    const bus = createRunEventBus();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher: fakeLauncher(),
      log,
    });
    service.subscribeCompletion(bus);
    bus.publish({
      id: 'evt1',
      runId: run.id,
      seq: 9,
      type: 'run.finished',
      payload: { outcome: 'success' },
      ts: W0_END + 1,
    });
    await Promise.resolve();

    // The settle (derived from the RUN row) still lands; only the
    // materialize-drain kick — which needs the trigger — is skipped, and the
    // skip is a WARN naming the corruption, not a caught-throw error.
    expect(getWindowState(db, key)?.status).toBe('succeeded');
    expect(warns.some((m) => typeof m === 'string' && m.includes('unparseable'))).toBe(true);
    expect(errors).toHaveLength(0);
  });
});

describe('sync() — seed / keep / drop', () => {
  function syncHarness(db: Db, now: () => number) {
    const launcher = fakeLauncher();
    // sync() arms through the CLOCK's arm (ref validated at seed time).
    const service = createTumblingService({
      db,
      arm: (input) => clock.arm(input),
      launcher,
      log: silentLog(),
      now,
    });
    const clock = createAlarmClock({ db, handlers: [service.handler], log: silentLog(), now });
    return { service, clock, launcher };
  }

  it('seeds the window CONTAINING now for an eligible trigger (once — idempotent)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    seedTumbling(db, { pipelineVersionId: pv });
    const { service } = syncHarness(db, () => T0 + 5 * 60_000);

    service.sync();
    service.sync();

    const pending = pendingWindows(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dueAt).toBe(W0_END);
  });

  it('seeds window 0 for a FUTURE startTime and nothing for an exhausted endTime', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    seedTumbling(db, { pipelineVersionId: pv }); // T0 in the past of `now` below
    seedTumbling(db, {
      pipelineVersionId: pv,
      window: { ...CONFIG, endTime: iso(T0 + MIN15) }, // exhausted by `now`
    });
    const { service } = syncHarness(db, () => T0 + 20 * 60_000);

    service.sync();

    const pending = pendingWindows(db);
    expect(pending).toHaveLength(1); // only the unbounded trigger seeded
    expect(pending[0]?.dueAt).toBe(T0 + 2 * MIN15);
  });

  it('ignores disabled / non-tumbling / windowless triggers', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    seedTumbling(db, { pipelineVersionId: pv, enabled: false });
    seedTumbling(db, { pipelineVersionId: pv, mode: 'manual', window: null });
    seedTumbling(db, { pipelineVersionId: pv, window: null, enabled: false });
    const { service } = syncHarness(db, () => T0);

    service.sync();

    expect(pendingWindows(db)).toHaveLength(0);
  });

  it('drops a stale row on a geometry edit and seeds the new epoch chain', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const { service } = syncHarness(db, () => T0 + 5 * 60_000);
    service.sync();
    expect(pendingWindows(db)).toHaveLength(1);

    updateTrigger(db, trigger.id, { window: { ...CONFIG, interval: 30 } });
    service.sync();

    const pending = pendingWindows(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dueAt).toBe(T0 + 30 * 60_000); // the NEW geometry's window
    expect(pending[0]?.ref).toMatchObject({ interval: '30' });
  });

  it('drops the row when the trigger is disabled (DELETE frees the key for re-enable)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const { service } = syncHarness(db, () => T0 + 5 * 60_000);
    service.sync();

    updateTrigger(db, trigger.id, { enabled: false });
    service.sync();
    expect(pendingWindows(db)).toHaveLength(0);

    // Re-enable within the SAME window: the same occurrence re-arms (delete,
    // not cancel, freed the (kind, dedupeKey)).
    updateTrigger(db, trigger.id, { enabled: true });
    service.sync();
    const pending = pendingWindows(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dueAt).toBe(W0_END);
  });
});

describe('repo guards (the projection’s status machine)', () => {
  it('createWindow is a no-op (false) for an existing window', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const input = {
      ...keyFor(trigger, T0),
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute' as const, interval: 15, startTime: CONFIG.startTime },
      origin: 'live' as const,
    };
    expect(createWindow(db, input)).toBe(true);
    expect(createWindow(db, input)).toBe(false);
    expect(listWindowEvents(db, input).map((e) => e.type)).toEqual(['window.created']);
  });

  it('linkWindowRun requires waiting; completeWindow requires running — and neither appends on a lost guard', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const key = keyFor(trigger, T0);
    const input = {
      ...key,
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute' as const, interval: 15, startTime: CONFIG.startTime },
      origin: 'live' as const,
    };
    // complete before create/link: no row, guard lost.
    expect(completeWindow(db, key, { status: 'succeeded', runId: 'r' })).toBe(false);
    createWindow(db, input);
    expect(completeWindow(db, key, { status: 'succeeded', runId: 'r' })).toBe(false); // waiting ≠ running
    expect(linkWindowRun(db, key, 'r1', 'fire')).toBe(true);
    expect(linkWindowRun(db, key, 'r2', 'fire')).toBe(false); // already linked
    expect(completeWindow(db, key, { status: 'succeeded', runId: 'r1' })).toBe(true);
    expect(completeWindow(db, key, { status: 'failed', runId: 'r1', runStatus: 'failure' })).toBe(
      false, // already terminal
    );
    // The log carries exactly the transitions that WON their guard.
    expect(listWindowEvents(db, key).map((e) => e.type)).toEqual([
      'window.created',
      'window.runCreated',
      'window.succeeded',
    ]);
    expect(rebuildWindowStatus(db, key)).toBe('succeeded');
    expect(getWindowState(db, key)?.status).toBe('succeeded');
  });

  it('listWindowStates filters by trigger/epoch/status/unlinked and orders oldest-first', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    if (!isTumblable(trigger)) throw new Error('unreachable');
    const epoch = windowConfigEpoch(trigger.window);
    for (const k of [2, 0, 1]) {
      createWindow(db, {
        triggerId: trigger.id,
        configEpoch: epoch,
        windowStart: iso(T0 + k * MIN15),
        windowEnd: iso(T0 + (k + 1) * MIN15),
        geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
        origin: 'live',
      });
    }
    linkWindowRun(
      db,
      { triggerId: trigger.id, configEpoch: epoch, windowStart: iso(T0 + MIN15) },
      'r1',
      'fire',
    );

    const waiting = listWindowStates(db, {
      triggerId: trigger.id,
      configEpoch: epoch,
      status: 'waiting',
      unlinked: true,
    });
    expect(waiting.map((w) => w.windowStart)).toEqual([iso(T0), iso(T0 + 2 * MIN15)]);
  });
});

// A compile-time-ish sanity: the service type surface used by index.ts.
describe('service surface', () => {
  it('stop() makes sync/reconcile no-ops', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    seedTumbling(db, { pipelineVersionId: pv });
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => {
        throw new Error('must not arm after stop');
      },
      launcher,
      log: silentLog(),
      now: () => T0 + 1,
    });
    service.stop();
    service.sync();
    service.reconcile();
    expect(launcher.fires).toHaveLength(0);
    expect(pendingWindows(db)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #5 S10 — bounded backfill (maxBackfillWindows + durable cursor)
// ---------------------------------------------------------------------------

describe('#5 S10 — backfill pass (sync)', () => {
  function backfillHarness(db: Db, now: () => number, launcher = fakeLauncher()) {
    const log = silentLog();
    const service = createTumblingService({
      db,
      arm: (input) => clock.arm(input),
      launcher,
      log,
      now,
    });
    const clock = createAlarmClock({ db, handlers: [service.handler], log: silentLog(), now });
    return { service, clock, launcher, log };
  }

  const BF10: WindowConfig = { ...CONFIG, maxBackfillWindows: 10 };

  it('creates the missed windows oldest-first as origin=backfill, fires exactly ONE, cursor at the edge', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: BF10 });
    // now = T0+65min: W0..W3 (ends 15..60) are closed; W4 [60,75) is current.
    const now = T0 + 65 * 60_000;
    const { service, launcher } = backfillHarness(db, () => now);

    service.sync();

    const rows = listWindowStates(db, { triggerId: trigger.id });
    expect(rows.map((r) => r.windowStart)).toEqual([
      iso(T0),
      iso(T0 + MIN15),
      iso(T0 + 2 * MIN15),
      iso(T0 + 3 * MIN15),
    ]);
    expect(rows.every((r) => r.origin === 'backfill')).toBe(true);
    // Exactly ONE fired (the oldest), linked; the rest wait under the gate.
    expect(launcher.fires).toHaveLength(1);
    // #5 S11b — a BACKFILL fire carries the same window bounds as a live one
    // (both origins share `materializeOne`).
    expect(launcher.contexts[0]).toEqual({
      scheduledTime: iso(W0_END),
      windowEpoch: windowConfigEpoch(BF10),
      windowStart: iso(T0),
      windowEnd: iso(W0_END),
    });
    expect(getWindowState(db, keyFor(trigger, T0))?.status).toBe('running');
    expect(listWindowStates(db, { triggerId: trigger.id, status: 'waiting' })).toHaveLength(3);
    // Durable cursor at the live edge.
    expect(getBackfillCursor(db, trigger.id, windowConfigEpoch(BF10))).toBe(T0 + 60 * 60_000);
    // The forward chain is seeded for the CURRENT window only — backfill armed
    // NO wakeup rows for past windows (the retention re-verify, executable).
    const pending = pendingWindows(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dueAt).toBe(T0 + 75 * 60_000);
  });

  it('skips windows beyond the lookback permanently (cursor jump + WARN; raising the bound later recovers nothing)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const bf2: WindowConfig = { ...CONFIG, maxBackfillWindows: 2 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: bf2 });
    const now = T0 + 65 * 60_000;
    const { service, log } = backfillHarness(db, () => now);

    service.sync();

    // Only the MOST RECENT 2 closed windows (W2, W3); W0/W1 skipped, warned.
    expect(listWindowStates(db, { triggerId: trigger.id }).map((r) => r.windowStart)).toEqual([
      iso(T0 + 2 * MIN15),
      iso(T0 + 3 * MIN15),
    ]);
    expect(
      log.warn.mock.calls.some(
        ([obj, msg]) =>
          typeof msg === 'string' &&
          msg.includes('lookback') &&
          (obj as { skipped?: number }).skipped === 2,
      ),
    ).toBe(true);

    // The ratchet: raising the bound does NOT resurrect the skipped windows —
    // the cursor already dispositioned them.
    updateTrigger(db, trigger.id, { window: { ...bf2, maxBackfillWindows: 10 } });
    service.sync();
    expect(listWindowStates(db, { triggerId: trigger.id })).toHaveLength(2);
  });

  it('is idempotent: a second sync creates nothing and fires nothing (gate closed by the running window)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: BF10 });
    const now = T0 + 65 * 60_000;
    const { service, launcher } = backfillHarness(db, () => now);

    service.sync();
    const afterFirst = listWindowStates(db, { triggerId: trigger.id }).length;
    service.sync();

    expect(listWindowStates(db, { triggerId: trigger.id })).toHaveLength(afterFirst);
    expect(launcher.fires).toHaveLength(1); // still just the first fire
  });

  it('absent maxBackfillWindows → no backfill rows, no cursor (exact S9)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv }); // plain CONFIG
    const { service, launcher } = backfillHarness(db, () => T0 + 65 * 60_000);

    service.sync();

    expect(listWindowStates(db, { triggerId: trigger.id })).toHaveLength(0);
    expect(getBackfillCursor(db, trigger.id, windowConfigEpoch(CONFIG))).toBeNull();
    expect(launcher.fires).toHaveLength(0);
  });

  it('never duplicates a window the forward chain already owns (projection dedup; origin stays live)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: BF10 });
    // The forward chain already created + fired W2.
    const w2 = keyFor(trigger, T0 + 2 * MIN15);
    createWindow(db, {
      ...w2,
      windowEnd: iso(T0 + 3 * MIN15),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin: 'live',
    });
    const { service } = backfillHarness(db, () => T0 + 65 * 60_000);

    service.sync();

    const rows = listWindowStates(db, { triggerId: trigger.id });
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.windowStart === w2.windowStart)?.origin).toBe('live');
    // ONE window.created per key — the partial UNIQUE index never tripped.
    expect(listWindowEvents(db, w2).filter((e) => e.type === 'window.created')).toHaveLength(1);
  });

  it('an EXHAUSTED chain (endTime passed) still backfills its tail and fires it', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const bounded: WindowConfig = {
      ...CONFIG,
      endTime: iso(T0 + 30 * 60_000),
      maxBackfillWindows: 10,
    };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: bounded });
    const { service, launcher } = backfillHarness(db, () => T0 + 65 * 60_000);

    service.sync();

    // W0, W1 (ends 15, 30 ≤ endTime) — created; NO forward row (exhausted).
    expect(listWindowStates(db, { triggerId: trigger.id }).map((r) => r.windowStart)).toEqual([
      iso(T0),
      iso(T0 + MIN15),
    ]);
    expect(pendingWindows(db)).toHaveLength(0);
    // The oldest fired despite the dead forward chain (the sync kick).
    expect(launcher.fires).toHaveLength(1);
  });

  it('an UNBOUND trigger is skipped entirely — the lookback applies at BIND time', () => {
    // Running the pass unbound would accrete rows every sync with the bound
    // never engaging (each pass only sees the since-last-sync gap) — the
    // reviewed accumulation hazard. Skip keeps the cursor lagging so binding
    // gets the same bounded lookback a re-enable does.
    const { db } = freshDb();
    const pv = seedVersion(db);
    const bf2: WindowConfig = { ...CONFIG, maxBackfillWindows: 2 };
    const trigger = seedTumbling(db, { pipelineVersionId: null, window: bf2 });
    const { service, launcher } = backfillHarness(db, () => T0 + 65 * 60_000);

    service.sync();
    expect(listWindowStates(db, { triggerId: trigger.id })).toHaveLength(0);
    expect(getBackfillCursor(db, trigger.id, windowConfigEpoch(bf2))).toBeNull();
    expect(launcher.fires).toHaveLength(0);

    // Bind → the NEXT sync backfills, bounded by the lookback (2 of 4 missed).
    updateTrigger(db, trigger.id, { pipelineVersionId: pv });
    service.sync();
    expect(listWindowStates(db, { triggerId: trigger.id })).toHaveLength(2);
  });

  it('a mid-window endTime clips the exhausted-chain edge to the last FULL window', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    // endTime T0+20min on 15-min windows: W0 [0,15) is full; [15,30) is
    // partial past the bound and must never exist.
    const clipped: WindowConfig = {
      ...CONFIG,
      endTime: iso(T0 + 20 * 60_000),
      maxBackfillWindows: 10,
    };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: clipped });
    const { service } = backfillHarness(db, () => T0 + 65 * 60_000);

    service.sync();

    expect(listWindowStates(db, { triggerId: trigger.id }).map((r) => r.windowStart)).toEqual([
      iso(T0),
    ]);
  });

  it('deleting a trigger mid-drain CASCADEs its windows AND its cursor; a later sync is a no-op', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: BF10 });
    const { service } = backfillHarness(db, () => T0 + 65 * 60_000);
    service.sync();
    const epoch = windowConfigEpoch(BF10);
    expect(listWindowStates(db, { triggerId: trigger.id }).length).toBeGreaterThan(0);
    expect(getBackfillCursor(db, trigger.id, epoch)).not.toBeNull();

    expect(deleteTrigger(db, trigger.id)).toBe(true);

    expect(listWindowStates(db, { triggerId: trigger.id })).toHaveLength(0);
    expect(getBackfillCursor(db, trigger.id, epoch)).toBeNull();
    service.sync(); // must not throw or resurrect anything
    expect(listWindowStates(db, { triggerId: trigger.id })).toHaveLength(0);
  });

  it('an epoch edit mid-drain backfills the NEW epoch fresh; old-epoch waiting windows are superseded (#5 S11d)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: BF10 });
    const now = T0 + 65 * 60_000;
    const { service } = backfillHarness(db, () => now);
    service.sync();
    const oldEpoch = windowConfigEpoch(BF10);
    expect(listWindowStates(db, { triggerId: trigger.id, configEpoch: oldEpoch })).toHaveLength(4);

    // Geometry edit → new epoch (30-min windows): W0'..W1' closed by now(65).
    const edited: WindowConfig = { ...BF10, interval: 30 };
    updateTrigger(db, trigger.id, { window: edited });
    service.sync();

    const newEpoch = windowConfigEpoch(edited);
    const newRows = listWindowStates(db, { triggerId: trigger.id, configEpoch: newEpoch });
    expect(newRows.map((r) => r.windowStart)).toEqual([iso(T0), iso(T0 + 30 * 60_000)]);
    // #5 S11d — the old epoch's waiting windows are DISPOSITIONED (terminal
    // `superseded`), no longer inert debris; a running one (mid-drain) is
    // untouched — its live run settles it through the normal path.
    const oldRows = listWindowStates(db, { triggerId: trigger.id, configEpoch: oldEpoch });
    expect(oldRows.filter((r) => r.status === 'waiting')).toHaveLength(0);
    expect(oldRows.some((r) => r.status === 'superseded')).toBe(true);
  });

  it('disable → re-enable resumes the drain from the cursor (windows missed while disabled backfill)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: BF10 });
    let now = T0 + 65 * 60_000;
    const { service } = backfillHarness(db, () => now);
    service.sync(); // W0..W3 dispositioned, cursor at 60min

    updateTrigger(db, trigger.id, { enabled: false });
    service.sync(); // drops the pending row; backfill skips the disabled trigger

    now = T0 + 95 * 60_000; // W4 [60,75) + W5 [75,90) closed while disabled
    updateTrigger(db, trigger.id, { enabled: true });
    service.sync();

    const rows = listWindowStates(db, { triggerId: trigger.id });
    expect(rows.map((r) => r.windowStart)).toContain(iso(T0 + 60 * 60_000));
    expect(rows.map((r) => r.windowStart)).toContain(iso(T0 + 75 * 60_000));
    expect(getBackfillCursor(db, trigger.id, windowConfigEpoch(BF10))).toBe(T0 + 90 * 60_000);
  });

  it('the boot-overdue race: a window closed during downtime becomes a BACKFILL window; the overdue alarm suppresses', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: BF10 });
    // The pre-downtime pending row: W3 [45,60), due at 60min.
    const row = armWindow(db, trigger, T0 + 3 * MIN15, T0 + 60 * 60_000);
    const now = T0 + 65 * 60_000; // boot after downtime
    const { service, clock } = backfillHarness(db, () => now);

    service.sync(); // the boot order: sync (backfill) BEFORE the boot tick
    clock.tick();

    // W3 was created by the backfill pass; the overdue alarm suppressed.
    expect(getWindowState(db, keyFor(trigger, T0 + 3 * MIN15))?.origin).toBe('backfill');
    expect(getWakeup(db, row.id)?.status).toBe('suppressed');
    // The stronger single-fire fact: exactly ONE window.created for W3.
    expect(
      listWindowEvents(db, keyFor(trigger, T0 + 3 * MIN15)).filter(
        (e) => e.type === 'window.created',
      ),
    ).toHaveLength(1);
    // The chain re-armed the CURRENT window in the same handler tx.
    const pending = pendingWindows(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.dueAt).toBe(T0 + 75 * 60_000);
  });
});

describe('#5 S10 — gated drain (completion tap + boot reconcile)', () => {
  it('the completion tap kicks the next backfill window after a settle', async () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const bf: WindowConfig = { ...CONFIG, maxBackfillWindows: 10 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: bf });
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 65 * 60_000,
    });
    service.sync(); // creates W0..W3; fires W0 (fake 'run-1' — no run row)
    expect(launcher.fires).toHaveLength(1);
    const w0 = keyFor(trigger, T0);
    expect(getWindowState(db, w0)?.status).toBe('running');

    const bus = createRunEventBus();
    const unsubscribe = service.subscribeCompletion(bus);
    bus.publish({
      id: 'evt-s10',
      runId: 'run-1',
      seq: 1,
      type: 'run.finished',
      payload: { outcome: 'success' },
      ts: T0 + 66 * 60_000,
    });
    await Promise.resolve(); // the tap defers one microtask

    // The tap settled W0 (its run row is GONE → folded closed as
    // failed{missing} — the absent-fact discipline) AND the settle released
    // the gate, so the kick fired the NEXT backfill window (W1).
    expect(getWindowState(db, w0)?.status).toBe('failed');
    expect(launcher.fires).toHaveLength(2);
    expect(getWindowState(db, keyFor(trigger, T0 + MIN15))?.status).toBe('running');
    unsubscribe();
  });

  it('boot reconcile fires exactly ONE gated backfill window — even on an EXHAUSTED chain', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    // endTime long passed: NO forward chain exists, so boot reconcile is the
    // ONLY drain kick left (the documented liveness slot) — the literal
    // exhausted-chain boot-drain case.
    const bf: WindowConfig = {
      ...CONFIG,
      endTime: iso(T0 + 45 * 60_000),
      maxBackfillWindows: 10,
    };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: bf });
    // Backfill rows exist but nothing has fired (e.g. the sync kick crashed).
    for (let k = 0; k < 3; k += 1) {
      createWindow(db, {
        ...keyFor(trigger, T0 + k * MIN15),
        windowEnd: iso(T0 + (k + 1) * MIN15),
        geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
        origin: 'backfill',
      });
    }
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 65 * 60_000,
    });

    service.reconcile();

    expect(launcher.fires).toHaveLength(1);
    expect(getWindowState(db, keyFor(trigger, T0))?.status).toBe('running');
    expect(listWindowStates(db, { triggerId: trigger.id, status: 'waiting' })).toHaveLength(2);
  });

  it('a crashed BACKFILL fire link-heals through the gated scan (epoch-matched orphan, no second run)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const bf: WindowConfig = { ...CONFIG, maxBackfillWindows: 10 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: bf });
    // The crash shape for a backfill window: row created + the fire's run row
    // committed (frozen scheduledTime == windowEnd, windowEpoch == epoch) —
    // link never landed.
    const key = keyFor(trigger, T0);
    createWindow(db, {
      ...key,
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin: 'backfill',
    });
    const orphan = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv,
      triggerId: trigger.id,
      parentRunId: null,
      params: {},
      triggerContext: {
        triggerId: trigger.id,
        scheduledTime: iso(W0_END),
        body: null,
        windowEpoch: windowConfigEpoch(bf),
      },
    });
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 65 * 60_000,
    });

    service.reconcile();

    expect(launcher.fires).toHaveLength(0); // linked, never re-fired
    const state = getWindowState(db, key);
    expect(state?.status).toBe('running');
    expect(state?.runId).toBe(orphan.id);
  });

  it('backfill defers to a RUNNING window (any origin); live windows still fire past the gate', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const bf: WindowConfig = { ...CONFIG, maxBackfillWindows: 10 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: bf });
    // A RUNNING window holds the gate.
    const held = keyFor(trigger, T0 + 5 * MIN15);
    createWindow(db, {
      ...held,
      windowEnd: iso(T0 + 6 * MIN15),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin: 'live',
    });
    linkWindowRun(db, held, 'busy-run', 'fire');
    // One stranded LIVE window + one backfill window, both waiting.
    createWindow(db, {
      ...keyFor(trigger, T0 + 4 * MIN15),
      windowEnd: iso(T0 + 5 * MIN15),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin: 'live',
    });
    createWindow(db, {
      ...keyFor(trigger, T0),
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin: 'backfill',
    });
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 95 * 60_000,
    });

    service.reconcile();

    // The stranded LIVE window fired (ungated — S9 semantics preserved); the
    // backfill window stayed waiting behind the busy gate.
    expect(launcher.contexts.map((c) => c?.scheduledTime)).toEqual([iso(T0 + 5 * MIN15)]);
    expect(getWindowState(db, keyFor(trigger, T0))?.status).toBe('waiting');
  });
});

describe('#5 S11a — per-window concurrency (capped unified materialize)', () => {
  /** Geometry helper: a `waiting` window row [T0+k*15m, T0+(k+1)*15m). */
  function seedWindow(
    db: Db,
    trigger: Trigger,
    k: number,
    origin: 'live' | 'backfill' = 'live',
  ): WindowKey {
    const key = keyFor(trigger, T0 + k * MIN15);
    createWindow(db, {
      ...key,
      windowEnd: iso(T0 + (k + 1) * MIN15),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin,
    });
    return key;
  }

  it('cap=1: a capacity-blocked LIVE window stays waiting IN WINDOW STATE — no run row (the rehoming pin)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const capped: WindowConfig = { ...CONFIG, maxConcurrentWindows: 1 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: capped });
    // W0 holds the one slot (a REAL live run — a fake id would fold
    // failed{missing} in reconcile step 1 and free the slot); W1 is waiting.
    const busy = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv,
      triggerId: trigger.id,
      parentRunId: null,
      params: {},
    });
    updateRun(db, busy.id, { status: 'running' });
    const w0 = seedWindow(db, trigger, 0);
    linkWindowRun(db, w0, busy.id, 'fire');
    seedWindow(db, trigger, 1);
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 65 * 60_000,
    });

    service.reconcile();

    // Pre-S11a the live window fired ungated (a queued run row); under the cap
    // it WAITS in window state with no launcher fire at all.
    expect(launcher.fires).toHaveLength(0);
    expect(getWindowState(db, keyFor(trigger, T0 + MIN15))?.status).toBe('waiting');
  });

  it('cap=2: fires up to the free slots, oldest first; the excess waits', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const capped: WindowConfig = { ...CONFIG, maxConcurrentWindows: 2 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: capped });
    seedWindow(db, trigger, 2);
    seedWindow(db, trigger, 0);
    seedWindow(db, trigger, 1);
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 65 * 60_000,
    });

    service.reconcile();

    // Two oldest fired (W0, W1 — windowStart order, not insert order); W2 waits.
    expect(launcher.contexts.map((c) => c?.scheduledTime)).toEqual([
      iso(W0_END),
      iso(T0 + 2 * MIN15),
    ]);
    expect(getWindowState(db, keyFor(trigger, T0 + 2 * MIN15))?.status).toBe('waiting');
  });

  it('unified oldest-first: a NEW live window queues BEHIND a backfill backlog (the documented S10-split reversal)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const capped: WindowConfig = { ...CONFIG, maxBackfillWindows: 10, maxConcurrentWindows: 2 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: capped });
    seedWindow(db, trigger, 0, 'backfill');
    seedWindow(db, trigger, 1, 'backfill');
    seedWindow(db, trigger, 4, 'live'); // the fresh live window — YOUNGEST
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 95 * 60_000,
    });

    service.reconcile();

    // Both slots go to the OLDER backfill windows; the live window waits its
    // turn (ADF drains windows oldest-first up to maxConcurrency — under a cap
    // the S10 live-priority split no longer applies, a conscious reversal).
    expect(launcher.contexts.map((c) => c?.scheduledTime)).toEqual([
      iso(W0_END),
      iso(T0 + 2 * MIN15),
    ]);
    expect(getWindowState(db, keyFor(trigger, T0 + 4 * MIN15))?.status).toBe('waiting');
  });

  it('an ANY-epoch running window consumes capacity (old-epoch runs are real work)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const capped: WindowConfig = { ...CONFIG, maxConcurrentWindows: 1 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: capped });
    // A running window under a DIFFERENT (old) epoch.
    const oldKey: WindowKey = {
      triggerId: trigger.id,
      configEpoch: 'old-epoch',
      windowStart: iso(T0),
    };
    createWindow(db, {
      ...oldKey,
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute', interval: 30, startTime: CONFIG.startTime },
      origin: 'live',
    });
    const oldRun = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv,
      triggerId: trigger.id,
      parentRunId: null,
      params: {},
    });
    updateRun(db, oldRun.id, { status: 'running' });
    linkWindowRun(db, oldKey, oldRun.id, 'fire');
    seedWindow(db, trigger, 1); // current-epoch waiting
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 65 * 60_000,
    });

    service.reconcile();

    expect(launcher.fires).toHaveLength(0);
    expect(getWindowState(db, keyFor(trigger, T0 + MIN15))?.status).toBe('waiting');
  });

  it('a QUEUED window run consumes a slot (window `running` covers a run-level-queued run)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const capped: WindowConfig = { ...CONFIG, maxConcurrentWindows: 1 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: capped });
    seedWindow(db, trigger, 0);
    seedWindow(db, trigger, 1);
    // The launcher reports `queued` (pipeline-cap pressure) — the window still
    // links and holds its slot until window-terminal.
    const launcher = fakeLauncher([{ outcome: 'queued', runId: 'queued-run' }]);
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 65 * 60_000,
    });

    service.reconcile();

    expect(launcher.fires).toHaveLength(1);
    expect(getWindowState(db, keyFor(trigger, T0))?.status).toBe('running');
    expect(getWindowState(db, keyFor(trigger, T0 + MIN15))?.status).toBe('waiting');
  });

  it('a window whose run is PARKED `waiting` still holds its slot (held until window-terminal — the deliberate divergence from run-slot release)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const capped: WindowConfig = { ...CONFIG, maxConcurrentWindows: 1 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: capped });
    const parked = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv,
      triggerId: trigger.id,
      parentRunId: null,
      params: {},
    });
    updateRun(db, parked.id, { status: 'waiting' });
    const w0 = seedWindow(db, trigger, 0);
    linkWindowRun(db, w0, parked.id, 'fire');
    seedWindow(db, trigger, 1);
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 65 * 60_000,
    });

    service.reconcile();

    // The parked run released its RUN-level admission slot (S4), but the WINDOW
    // slot is held until the window terminalizes — cap semantics are per
    // window-in-flight, the ADF-faithful reading.
    expect(launcher.fires).toHaveLength(0);
    expect(getWindowState(db, keyFor(trigger, T0 + MIN15))?.status).toBe('waiting');
  });

  it('the completion tap frees a slot and drains the next waiting window', async () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const capped: WindowConfig = { ...CONFIG, maxConcurrentWindows: 1 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: capped });
    const w0 = seedWindow(db, trigger, 0);
    linkWindowRun(db, w0, 'run-w0', 'fire');
    seedWindow(db, trigger, 1);
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 65 * 60_000,
    });
    const bus = createRunEventBus();
    const unsubscribe = service.subscribeCompletion(bus);

    bus.publish({
      id: 'evt-s11',
      runId: 'run-w0',
      seq: 1,
      type: 'run.finished',
      payload: { outcome: 'success' },
      ts: T0 + 66 * 60_000,
    });
    await Promise.resolve(); // the tap defers one microtask

    // W0 settled (run row gone → failed{missing}) → slot freed → W1 fired.
    expect(getWindowState(db, w0)?.status).toBe('failed');
    expect(launcher.fires).toHaveLength(1);
    expect(getWindowState(db, keyFor(trigger, T0 + MIN15))?.status).toBe('running');
    unsubscribe();
  });

  it('the capped scan is bounded by CAPACITY, not MATERIALIZE_BATCH — and never warns about designed waiting', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const capped: WindowConfig = { ...CONFIG, maxConcurrentWindows: 30 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: capped });
    // 35 waiting windows: more than MATERIALIZE_BATCH (25) and more than cap.
    for (let k = 0; k < 35; k += 1) seedWindow(db, trigger, k);
    const launcher = fakeLauncher();
    const log = silentLog();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log,
      now: () => T0 + 24 * 60 * 60_000,
    });

    service.reconcile();

    // All 30 slots fill in ONE pass (a batch-bound scan would stop at 25 and
    // idle 5 slots until the next kick); the 5 excess windows wait silently —
    // waiting-in-state is the designed steady state under a cap, not a
    // truncation to warn about.
    expect(launcher.fires).toHaveLength(30);
    expect(listWindowStates(db, { triggerId: trigger.id, status: 'waiting' })).toHaveLength(5);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('sync() kicks a cap-only trigger (cap-raise liveness) without ever creating backfill rows', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const capped: WindowConfig = { ...CONFIG, maxConcurrentWindows: 2 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: capped });
    seedWindow(db, trigger, 0);
    seedWindow(db, trigger, 1);
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 65 * 60_000,
    });

    service.sync();

    // Both stranded windows fired on the sync kick (previously only backfill
    // triggers were kicked), and NO backfill pass ran: no cursor, no
    // backfill-origin rows for windows the forward chain never created.
    expect(launcher.fires).toHaveLength(2);
    expect(getBackfillCursor(db, trigger.id, windowConfigEpoch(capped))).toBeNull();
    expect(listWindowStates(db, { triggerId: trigger.id, origin: 'backfill' })).toHaveLength(0);
  });

  it('an UNBOUND cap-only trigger is not kicked by sync() (mirrors the backfill unbound skip)', () => {
    const { db } = freshDb();
    const capped: WindowConfig = { ...CONFIG, maxConcurrentWindows: 2 };
    const trigger = seedTumbling(db, { pipelineVersionId: null, window: capped });
    seedWindow(db, trigger, 0);
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 65 * 60_000,
    });

    service.sync();

    expect(launcher.fires).toHaveLength(0);
  });

  it('link-heal still runs under the cap: a crash orphan is linked, then counted against capacity', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const capped: WindowConfig = { ...CONFIG, maxConcurrentWindows: 1 };
    const trigger = seedTumbling(db, { pipelineVersionId: pv, window: capped });
    // The crash shape: W0's fire committed a run (frozen context matches) but
    // the link never landed; W1 waits behind it.
    seedWindow(db, trigger, 0);
    const orphan = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv,
      triggerId: trigger.id,
      parentRunId: null,
      params: {},
      triggerContext: {
        triggerId: trigger.id,
        scheduledTime: iso(W0_END),
        body: null,
        windowEpoch: windowConfigEpoch(capped),
      },
    });
    seedWindow(db, trigger, 1);
    const launcher = fakeLauncher();
    const service = createTumblingService({
      db,
      arm: () => undefined,
      launcher,
      log: silentLog(),
      now: () => T0 + 65 * 60_000,
    });

    service.reconcile();

    // W0 link-healed (no second fire) and now holds the one slot; W1 waits —
    // no over-cap execution even through the heal path.
    expect(launcher.fires).toHaveLength(0);
    const w0 = getWindowState(db, keyFor(trigger, T0));
    expect(w0?.status).toBe('running');
    expect(w0?.runId).toBe(orphan.id);
    expect(getWindowState(db, keyFor(trigger, T0 + MIN15))?.status).toBe('waiting');
  });
});

describe('#5 S10 — repo: cursor + epoch-scoped join', () => {
  it('advanceBackfillCursor is monotonic (a backwards move loses)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });

    advanceBackfillCursor(db, trigger.id, 'ep1', 5000);
    expect(getBackfillCursor(db, trigger.id, 'ep1')).toBe(5000);
    advanceBackfillCursor(db, trigger.id, 'ep1', 3000); // backwards — must lose
    expect(getBackfillCursor(db, trigger.id, 'ep1')).toBe(5000);
    advanceBackfillCursor(db, trigger.id, 'ep1', 9000);
    expect(getBackfillCursor(db, trigger.id, 'ep1')).toBe(9000);
    // Epoch-scoped: another epoch has its own row.
    expect(getBackfillCursor(db, trigger.id, 'ep2')).toBeNull();
  });

  it('findUnlinkedRunForWindow matches STRICTLY on windowEpoch', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const mkRun = (windowEpoch?: string) =>
      createRun(db, {
        ownerId: 'local',
        pipelineVersionId: pv,
        triggerId: trigger.id,
        parentRunId: null,
        params: {},
        triggerContext: {
          triggerId: trigger.id,
          scheduledTime: iso(W0_END),
          body: null,
          ...(windowEpoch !== undefined ? { windowEpoch } : {}),
        },
      });

    // Absent epoch (a pre-S10 orphan) → NOT matched (documented at-least-once).
    mkRun();
    expect(findUnlinkedRunForWindow(db, trigger.id, 'epA', iso(W0_END), iso(T0))).toBeNull();
    // Wrong epoch → NOT matched (the old-epoch-at-shared-boundary hazard).
    mkRun('epB');
    expect(findUnlinkedRunForWindow(db, trigger.id, 'epA', iso(W0_END), iso(T0))).toBeNull();
    // Right epoch → matched.
    const match = mkRun('epA');
    expect(findUnlinkedRunForWindow(db, trigger.id, 'epA', iso(W0_END), iso(T0))).toBe(match.id);
  });
});

describe('#5 S11c — per-trigger window retry', () => {
  const RETRY_CONFIG: WindowConfig = { ...CONFIG, retry: { count: 2, intervalInSeconds: 60 } };

  /** A linked window whose run has terminalized with `runStatus`. */
  function failedWindow(
    db: Db,
    trigger: Trigger,
    pv: string,
    runStatus: 'failure' | 'interrupted' = 'failure',
  ) {
    if (!isTumblable(trigger)) throw new Error('fixture must be tumblable');
    const key = keyFor(trigger, T0);
    createWindow(db, {
      ...key,
      windowEnd: iso(W0_END),
      geometry: {
        frequency: trigger.window.frequency,
        interval: trigger.window.interval,
        startTime: trigger.window.startTime,
      },
      origin: 'live',
    });
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv,
      triggerId: trigger.id,
      parentRunId: null,
      params: {},
      triggerContext: {
        triggerId: trigger.id,
        scheduledTime: iso(W0_END),
        body: null,
        windowEpoch: key.configEpoch,
      },
    });
    linkWindowRun(db, key, run.id, 'fire');
    updateRun(db, run.id, { status: runStatus, finishedAt: W0_END + 1 });
    return { key, run };
  }

  /** Publish the run-terminal event and let the tap's microtask run. */
  async function tapTerminal(bus: ReturnType<typeof createRunEventBus>, runId: string) {
    bus.publish({
      id: 'evt1',
      runId,
      seq: 9,
      type: 'run.finished',
      payload: {},
      ts: W0_END + 1,
    });
    await Promise.resolve();
  }

  function pendingRetries(db: Db) {
    return listPendingWakeups(db).filter((w) => w.kind === WINDOW_RETRY_KIND);
  }

  describe('repo: retryWindow / retryDueWindow (guarded flips)', () => {
    function waitingWindow(db: Db, trigger: Trigger) {
      const key = keyFor(trigger, T0);
      createWindow(db, {
        ...key,
        windowEnd: iso(W0_END),
        geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
        origin: 'live',
      });
      return key;
    }

    it('retryWindow flips running → retry_pending: attempt+1, runId CLEARED, dueAt stamped, event appended', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const key = waitingWindow(db, trigger);
      linkWindowRun(db, key, 'run-a1', 'fire');

      const due = W0_END + 60_000;
      expect(
        retryWindow(db, key, {
          runId: 'run-a1',
          runStatus: 'failure',
          attempt: 1,
          nextAttemptAtMs: due,
        }),
      ).toBe(true);

      const state = getWindowState(db, key);
      expect(state?.status).toBe('retry_pending');
      expect(state?.attempt).toBe(1);
      expect(state?.runId).toBeNull();
      expect(state?.nextAttemptAtMs).toBe(due);
      const events = listWindowEvents(db, key);
      expect(events[2]).toEqual({
        type: 'window.retryScheduled',
        payload: { runId: 'run-a1', runStatus: 'failure', attempt: 1, nextAttemptAt: iso(due) },
      });
      expect(rebuildWindowStatus(db, key)).toBe('retry_pending');
    });

    it('retryWindow no-ops (appends NOTHING) unless the window is running', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const key = waitingWindow(db, trigger); // waiting, not running
      expect(
        retryWindow(db, key, {
          runId: 'run-x',
          runStatus: 'failure',
          attempt: 1,
          nextAttemptAtMs: W0_END,
        }),
      ).toBe(false);
      expect(getWindowState(db, key)?.status).toBe('waiting');
      expect(listWindowEvents(db, key)).toHaveLength(1); // created only
    });

    it('retryDueWindow flips retry_pending → waiting (dueAt cleared, attempt kept, event appended); no-ops elsewhere', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const key = waitingWindow(db, trigger);
      // Not retry_pending yet — the flip must refuse.
      expect(retryDueWindow(db, key, 1)).toBe(false);
      linkWindowRun(db, key, 'run-a1', 'fire');
      retryWindow(db, key, {
        runId: 'run-a1',
        runStatus: 'failure',
        attempt: 1,
        nextAttemptAtMs: W0_END + 60_000,
      });

      expect(retryDueWindow(db, key, 1)).toBe(true);
      const state = getWindowState(db, key);
      expect(state?.status).toBe('waiting');
      expect(state?.attempt).toBe(1);
      expect(state?.runId).toBeNull();
      expect(state?.nextAttemptAtMs).toBeNull();
      const events = listWindowEvents(db, key);
      expect(events[3]).toEqual({ type: 'window.retryDue', payload: { attempt: 1 } });
      expect(rebuildWindowStatus(db, key)).toBe('waiting');
      // Double-drive is safe: the guard makes the second flip a no-op.
      expect(retryDueWindow(db, key, 1)).toBe(false);
      expect(listWindowEvents(db, key)).toHaveLength(4);
    });

    it('the projection stays fold-consistent and attempt == count(retryScheduled) through a full retry lifecycle', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const key = waitingWindow(db, trigger);
      linkWindowRun(db, key, 'run-a1', 'fire');
      retryWindow(db, key, {
        runId: 'run-a1',
        runStatus: 'failure',
        attempt: 1,
        nextAttemptAtMs: W0_END + 60_000,
      });
      retryDueWindow(db, key, 1);
      linkWindowRun(db, key, 'run-a2', 'fire');
      retryWindow(db, key, {
        runId: 'run-a2',
        runStatus: 'interrupted',
        attempt: 2,
        nextAttemptAtMs: W0_END + 120_000,
      });
      retryDueWindow(db, key, 2);
      linkWindowRun(db, key, 'run-a3', 'fire');
      completeWindow(db, key, { status: 'succeeded', runId: 'run-a3' });

      expect(getWindowState(db, key)?.status).toBe('succeeded');
      expect(rebuildWindowStatus(db, key)).toBe('succeeded');
      const events = listWindowEvents(db, key);
      const retriesInLog = events.filter((e) => e.type === 'window.retryScheduled').length;
      expect(retriesInLog).toBe(2);
      expect(getWindowState(db, key)?.attempt).toBe(retriesInLog);
    });

    it('findUnlinkedRunForWindow NEVER resurrects a consumed prior attempt (the event-log exclusion)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      if (!isTumblable(trigger)) throw new Error('unreachable');
      const key = waitingWindow(db, trigger);
      const mkRun = () =>
        createRun(db, {
          ownerId: 'local',
          pipelineVersionId: pv,
          triggerId: trigger.id,
          parentRunId: null,
          params: {},
          triggerContext: {
            triggerId: trigger.id,
            scheduledTime: iso(W0_END),
            body: null,
            windowEpoch: key.configEpoch,
          },
        });

      // Attempt 1 fired, linked, failed, retry consumed it (runId cleared).
      const a1 = mkRun();
      linkWindowRun(db, key, a1.id, 'fire');
      retryWindow(db, key, {
        runId: a1.id,
        runStatus: 'failure',
        attempt: 1,
        nextAttemptAtMs: W0_END + 60_000,
      });
      retryDueWindow(db, key, 1);
      // The projection no longer references a1 — but the event log does. The
      // join must NOT hand a1 back as a "crash orphan": link-healing the OLD
      // FAILED run would fold a stale outcome and burn the retry budget
      // without ever re-executing.
      expect(
        findUnlinkedRunForWindow(db, trigger.id, key.configEpoch, iso(W0_END), key.windowStart),
      ).toBeNull();

      // A genuine crash orphan (attempt-2 fired, link never committed) IS
      // matched — the heal still works.
      const a2 = mkRun();
      expect(
        findUnlinkedRunForWindow(db, trigger.id, key.configEpoch, iso(W0_END), key.windowStart),
      ).toBe(a2.id);
      // And once a2 links, a later scan matches NOTHING (a1 stays excluded).
      linkWindowRun(db, key, a2.id, 'fire');
      retryWindow(db, key, {
        runId: a2.id,
        runStatus: 'failure',
        attempt: 2,
        nextAttemptAtMs: W0_END + 120_000,
      });
      retryDueWindow(db, key, 2);
      expect(
        findUnlinkedRunForWindow(db, trigger.id, key.configEpoch, iso(W0_END), key.windowStart),
      ).toBeNull();
    });
  });

  describe('settle-time retry decision (tap + reconcile + link-heal share it)', () => {
    it('a failed run with budget → retry_pending + a window_retry alarm (attempt-n discriminator), NOT window.failed', async () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const { key, run } = failedWindow(db, trigger, pv);

      const bus = createRunEventBus();
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
        now: () => W0_END + 1,
      });
      service.subscribeCompletion(bus);
      await tapTerminal(bus, run.id);

      const state = getWindowState(db, key);
      expect(state?.status).toBe('retry_pending');
      expect(state?.attempt).toBe(1);
      expect(state?.nextAttemptAtMs).toBe(W0_END + 1 + 60_000);
      // The alarm: dueAt is the STORED nextAttemptAt; the dedupe discriminator
      // carries the attempt ordinal (the codex-hardened attempt-n rule).
      const alarms = pendingRetries(db);
      expect(alarms).toHaveLength(1);
      expect(alarms[0]?.dueAt).toBe(W0_END + 1 + 60_000);
      expect(alarms[0]?.dedupeKey).toContain('attempt-1');
      // No terminal event in the log.
      expect(listWindowEvents(db, key).map((e) => e.type)).not.toContain('window.failed');
    });

    it('an INTERRUPTED run retries too (a known failure)', async () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const { key, run } = failedWindow(db, trigger, pv, 'interrupted');

      const bus = createRunEventBus();
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
        now: () => W0_END + 1,
      });
      service.subscribeCompletion(bus);
      await tapTerminal(bus, run.id);

      expect(getWindowState(db, key)?.status).toBe('retry_pending');
    });

    it('budget EXHAUSTED → terminal window.failed exactly as before', async () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, {
        pipelineVersionId: pv,
        window: { ...CONFIG, retry: { count: 1, intervalInSeconds: 60 } },
      });
      if (!isTumblable(trigger)) throw new Error('unreachable');
      const { key, run } = failedWindow(db, trigger, pv);
      // Simulate the budget already consumed: attempt = count = 1.
      retryWindow(db, key, {
        runId: run.id,
        runStatus: 'failure',
        attempt: 1,
        nextAttemptAtMs: W0_END + 60_000,
      });
      retryDueWindow(db, key, 1);
      const run2 = createRun(db, {
        ownerId: 'local',
        pipelineVersionId: pv,
        triggerId: trigger.id,
        parentRunId: null,
        params: {},
        triggerContext: {
          triggerId: trigger.id,
          scheduledTime: iso(W0_END),
          body: null,
          windowEpoch: key.configEpoch,
        },
      });
      linkWindowRun(db, key, run2.id, 'fire');
      updateRun(db, run2.id, { status: 'failure', finishedAt: W0_END + 2 });

      const bus = createRunEventBus();
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
        now: () => W0_END + 2,
      });
      service.subscribeCompletion(bus);
      await tapTerminal(bus, run2.id);

      const state = getWindowState(db, key);
      expect(state?.status).toBe('failed');
      expect(pendingRetries(db)).toHaveLength(0);
      const last = listWindowEvents(db, key).at(-1);
      expect(last).toEqual({
        type: 'window.failed',
        payload: { runId: run2.id, runStatus: 'failure' },
      });
    });

    it('a MISSING run never retries — an unknown outcome folds terminal (reconcile path)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      if (!isTumblable(trigger)) throw new Error('unreachable');
      const key = keyFor(trigger, T0);
      createWindow(db, {
        ...key,
        windowEnd: iso(W0_END),
        geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
        origin: 'live',
      });
      linkWindowRun(db, key, 'run-gone', 'fire');

      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
      });
      service.reconcile();

      expect(getWindowState(db, key)?.status).toBe('failed');
      expect(pendingRetries(db)).toHaveLength(0);
    });

    it('NO retry policy → the exact pre-S11c terminal behavior (regression pin)', async () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv }); // plain CONFIG, no retry
      const { key, run } = failedWindow(db, trigger, pv);

      const bus = createRunEventBus();
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
      });
      service.subscribeCompletion(bus);
      await tapTerminal(bus, run.id);

      expect(getWindowState(db, key)?.status).toBe('failed');
      expect(pendingRetries(db)).toHaveLength(0);
    });

    it('an OLD-EPOCH window never retries — settle folds it terminal (no permanently-stuck retry_pending)', async () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const { key, run } = failedWindow(db, trigger, pv);
      // Geometry edit AFTER the run fired: the window's epoch is now stale.
      // A retry decision here would schedule an alarm the handler must refuse
      // (epoch-stale) and the overdue heal only drives CURRENT-epoch rows —
      // the window would hold `retry_pending` forever. Settle must fold it
      // terminal instead (stale-epoch disposition stays S11d's).
      updateTrigger(db, trigger.id, { window: { ...RETRY_CONFIG, interval: 30 } });

      const bus = createRunEventBus();
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
        now: () => W0_END + 1,
      });
      service.subscribeCompletion(bus);
      await tapTerminal(bus, run.id);

      expect(getWindowState(db, key)?.status).toBe('failed');
      expect(pendingRetries(db)).toHaveLength(0);
    });

    it('a CORRUPT trigger row at settle time = policy unknown = terminal (the #637 lenient read; settle still lands)', async () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const { key, run } = failedWindow(db, trigger, pv);
      corruptTriggerRow(db, trigger.id);

      const bus = createRunEventBus();
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
      });
      service.subscribeCompletion(bus);
      await tapTerminal(bus, run.id);

      // Never manufacture a retry from an unreadable row — but the settle
      // itself (derived from the RUN row) must still land.
      expect(getWindowState(db, key)?.status).toBe('failed');
      expect(pendingRetries(db)).toHaveLength(0);
    });
  });

  describe('window_retry alarm handler', () => {
    function retryHarness(db: Db, now: () => number, launcher: TumblingLauncher = fakeLauncher()) {
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher,
        log: silentLog(),
        now,
      });
      const clock = createAlarmClock({
        db,
        handlers: [service.handler, service.retryHandler],
        log: silentLog(),
        now,
      });
      return { clock, service, launcher };
    }

    /** A retry_pending window with its armed alarm, as the settle path leaves it. */
    function retryPendingWindow(db: Db, trigger: Trigger, pv: string, dueMs: number) {
      const { key, run } = failedWindow(db, trigger, pv);
      retryWindow(db, key, {
        runId: run.id,
        runStatus: 'failure',
        attempt: 1,
        nextAttemptAtMs: dueMs,
      });
      const alarm = armWakeup(db, {
        kind: WINDOW_RETRY_KIND,
        ref: buildWindowRetryRef(key, 1),
        dueAt: dueMs,
        discriminator: 'attempt-1',
      });
      return { key, run, alarm };
    }

    it('a due retry re-drives the window: retryDue + a NEW run fired and linked (the old run never re-linked)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const due = W0_END + 60_000;
      const { key, run, alarm } = retryPendingWindow(db, trigger, pv, due);

      const launcher = fakeLauncher([{ outcome: 'started', runId: 'run-a2' }]);
      const { clock } = retryHarness(db, () => due, launcher);
      clock.tick();

      expect(getWakeup(db, alarm.id)?.status).toBe('fired');
      const state = getWindowState(db, key);
      expect(state?.status).toBe('running');
      expect(state?.runId).toBe('run-a2');
      expect(state?.runId).not.toBe(run.id);
      expect(state?.attempt).toBe(1);
      expect(listWindowEvents(db, key).map((e) => e.type)).toEqual([
        'window.created',
        'window.runCreated',
        'window.retryScheduled',
        'window.retryDue',
        'window.runCreated',
      ]);
      expect(rebuildWindowStatus(db, key)).toBe('running');
      // The new fire froze the SAME window context (S11b parity).
      const fl = launcher as ReturnType<typeof fakeLauncher>;
      expect(fl.contexts.at(-1)).toEqual({
        scheduledTime: iso(W0_END),
        windowEpoch: key.configEpoch,
        windowStart: iso(T0),
        windowEnd: iso(W0_END),
      });
    });

    /** Direct fire pins the suppression REASON (the clock only debug-logs
     * it) — the #637 test precedent. */
    function directFire(db: Db, service: { retryHandler: WakeupHandler }, alarmId: string) {
      const row = getWakeup(db, alarmId);
      if (row === null) throw new Error('fixture alarm missing');
      return service.retryHandler.fire(
        row,
        { scheduledFor: row.dueAt, firedAt: row.dueAt, latenessMs: 0 },
        db,
      );
    }

    it('suppresses a STALE delivery (window already re-driven past this attempt)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const due = W0_END + 60_000;
      const { key, alarm } = retryPendingWindow(db, trigger, pv, due);
      // The window moved on before delivery (e.g. the overdue heal drove it).
      retryDueWindow(db, key, 1);

      const { service } = retryHarness(db, () => due);
      const result = directFire(db, service, alarm.id);

      expect(result).toEqual({ status: 'suppressed', reason: 'window_not_retry_pending' });
      // No duplicate retryDue appended.
      const dueEvents = listWindowEvents(db, key).filter((e) => e.type === 'window.retryDue');
      expect(dueEvents).toHaveLength(1);
    });

    it('suppresses on a CORRUPT trigger row (#637 discipline) — the window stays retry_pending, healed after repair', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const due = W0_END + 60_000;
      const { key, alarm } = retryPendingWindow(db, trigger, pv, due);
      corruptTriggerRow(db, trigger.id);

      const { service } = retryHarness(db, () => due);
      const result = directFire(db, service, alarm.id);

      expect(result).toEqual({ status: 'suppressed', reason: 'trigger_unparseable' });
      expect(getWindowState(db, key)?.status).toBe('retry_pending');
    });

    it('suppresses an UNBOUND trigger and an EPOCH-STALE ref', () => {
      // Unbound.
      {
        const { db } = freshDb();
        const pv = seedVersion(db);
        const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
        const due = W0_END + 60_000;
        const { alarm } = retryPendingWindow(db, trigger, pv, due);
        updateTrigger(db, trigger.id, { pipelineVersionId: null });
        const { service } = retryHarness(db, () => due);
        expect(directFire(db, service, alarm.id)).toEqual({
          status: 'suppressed',
          reason: 'trigger_unbound',
        });
      }
      // Epoch-stale (geometry edited mid-interval): the window is now
      // old-epoch debris — inert until S11d's disposition pass, like its
      // waiting siblings.
      {
        const { db } = freshDb();
        const pv = seedVersion(db);
        const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
        const due = W0_END + 60_000;
        const { key, alarm } = retryPendingWindow(db, trigger, pv, due);
        updateTrigger(db, trigger.id, { window: { ...RETRY_CONFIG, interval: 30 } });
        const { service } = retryHarness(db, () => due);
        expect(directFire(db, service, alarm.id)).toEqual({
          status: 'suppressed',
          reason: 'epoch_stale',
        });
        expect(getWindowState(db, key)?.status).toBe('retry_pending');
      }
    });
  });

  describe('overdue heal (sync + reconcile) — a suppressed alarm is not a stuck window', () => {
    it('sync() re-drives an overdue retry_pending window after the trigger heals (state-driven, no backfill/cap needed)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const due = W0_END + 60_000;
      const { key, run } = failedWindow(db, trigger, pv);
      retryWindow(db, key, {
        runId: run.id,
        runStatus: 'failure',
        attempt: 1,
        nextAttemptAtMs: due,
      });
      // The alarm was suppressed while the trigger was broken (settled row,
      // gone forever) — simulated by simply never arming one.

      const launcher = fakeLauncher([{ outcome: 'started', runId: 'run-a2' }]);
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher,
        log: silentLog(),
        now: () => due + 1,
      });
      service.sync();

      const state = getWindowState(db, key);
      expect(state?.status).toBe('running');
      expect(state?.runId).toBe('run-a2');
      expect(listWindowEvents(db, key).map((e) => e.type)).toContain('window.retryDue');
    });

    it('sync() does NOT drive a retry_pending window before its due instant', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const due = W0_END + 60_000;
      const { key, run } = failedWindow(db, trigger, pv);
      retryWindow(db, key, {
        runId: run.id,
        runStatus: 'failure',
        attempt: 1,
        nextAttemptAtMs: due,
      });

      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
        now: () => due - 1,
      });
      service.sync();

      expect(getWindowState(db, key)?.status).toBe('retry_pending');
    });

    it('boot reconcile() re-drives an overdue retry_pending window', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const due = W0_END + 60_000;
      const { key, run } = failedWindow(db, trigger, pv);
      retryWindow(db, key, {
        runId: run.id,
        runStatus: 'failure',
        attempt: 1,
        nextAttemptAtMs: due,
      });

      const launcher = fakeLauncher([{ outcome: 'started', runId: 'run-a2' }]);
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher,
        log: silentLog(),
        now: () => due + 1,
      });
      service.reconcile();

      const state = getWindowState(db, key);
      expect(state?.status).toBe('running');
      expect(state?.runId).toBe('run-a2');
    });
  });

  describe('S11a/S10 interplay', () => {
    it('retry_pending holds NO per-window concurrency slot (no run in flight)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, {
        pipelineVersionId: pv,
        window: { ...RETRY_CONFIG, maxConcurrentWindows: 1 },
      });
      if (!isTumblable(trigger)) throw new Error('unreachable');
      // W0 is mid-retry-interval; W1 is waiting.
      const { key: k0, run } = failedWindow(db, trigger, pv);
      retryWindow(db, k0, {
        runId: run.id,
        runStatus: 'failure',
        attempt: 1,
        nextAttemptAtMs: W0_END + 60_000,
      });
      const k1 = keyFor(trigger, T0 + MIN15);
      createWindow(db, {
        ...k1,
        windowEnd: iso(T0 + 2 * MIN15),
        geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
        origin: 'live',
      });

      const launcher = fakeLauncher([{ outcome: 'started', runId: 'run-w1' }]);
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher,
        log: silentLog(),
        now: () => W0_END + 1, // before W0's retry is due
      });
      service.sync();

      // Under cap=1, W1 fires anyway: the retry_pending W0 does not hold the
      // slot — a long retry interval must not idle capacity.
      expect(getWindowState(db, k1)?.status).toBe('running');
      expect(getWindowState(db, k0)?.status).toBe('retry_pending');
    });

    it('a backfill-origin window retries under the backfill gate (origin preserved)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      if (!isTumblable(trigger)) throw new Error('unreachable');
      const key = keyFor(trigger, T0);
      createWindow(db, {
        ...key,
        windowEnd: iso(W0_END),
        geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
        origin: 'backfill',
      });
      const run = createRun(db, {
        ownerId: 'local',
        pipelineVersionId: pv,
        triggerId: trigger.id,
        parentRunId: null,
        params: {},
        triggerContext: {
          triggerId: trigger.id,
          scheduledTime: iso(W0_END),
          body: null,
          windowEpoch: key.configEpoch,
        },
      });
      linkWindowRun(db, key, run.id, 'fire');
      updateRun(db, run.id, { status: 'failure', finishedAt: W0_END + 1 });
      retryWindow(db, key, {
        runId: run.id,
        runStatus: 'failure',
        attempt: 1,
        nextAttemptAtMs: W0_END + 60_000,
      });
      retryDueWindow(db, key, 1);

      const launcher = fakeLauncher([{ outcome: 'started', runId: 'run-a2' }]);
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher,
        log: silentLog(),
        now: () => W0_END + 60_001,
      });
      service.reconcile();

      const state = getWindowState(db, key);
      expect(state?.status).toBe('running');
      expect(state?.origin).toBe('backfill');
    });

    it('retry_pending does NOT close the S10 backfill gate (a waiting backfill window still fires)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      if (!isTumblable(trigger)) throw new Error('unreachable');
      // W1 is mid-retry-interval (retry_pending); W0 is a waiting BACKFILL
      // window. The gate requires ZERO `running` windows — a retry hold has
      // no run in flight, so it must not count.
      const { key: k1, run } = failedWindow(db, trigger, pv);
      retryWindow(db, k1, {
        runId: run.id,
        runStatus: 'failure',
        attempt: 1,
        nextAttemptAtMs: W0_END + 600_000, // far future — stays retry_pending
      });
      const k0 = keyFor(trigger, T0 - MIN15);
      createWindow(db, {
        ...k0,
        windowEnd: iso(T0),
        geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
        origin: 'backfill',
      });

      const launcher = fakeLauncher([{ outcome: 'started', runId: 'run-bf' }]);
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher,
        log: silentLog(),
        now: () => W0_END + 1, // before the retry is due
      });
      service.reconcile();

      expect(getWindowState(db, k0)?.status).toBe('running');
      expect(getWindowState(db, k1)?.status).toBe('retry_pending');
    });
  });

  describe('disabled-trigger symmetry (a pause never forfeits the retry)', () => {
    it('a run failing while its trigger is DISABLED still holds retry_pending, and heals on re-enable', async () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const { key, run } = failedWindow(db, trigger, pv);
      // The pause lands BEFORE the settle — the retry decision must read the
      // policy anyway (enabled-agnostic): folding terminal here while a
      // disable AFTER retryScheduled survives would make the same operator
      // action destroy or preserve the budget purely by timing.
      updateTrigger(db, trigger.id, { enabled: false });

      const bus = createRunEventBus();
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
        now: () => W0_END + 1,
      });
      service.subscribeCompletion(bus);
      await tapTerminal(bus, run.id);

      expect(getWindowState(db, key)?.status).toBe('retry_pending');
      expect(pendingRetries(db)).toHaveLength(1);

      // Re-enable after the interval: sync()'s state-driven heal re-drives
      // and materializes a fresh run.
      updateTrigger(db, trigger.id, { enabled: true });
      const launcher2 = fakeLauncher([{ outcome: 'started', runId: 'run-a2' }]);
      const service2 = createTumblingService({
        db,
        arm: () => undefined,
        launcher: launcher2,
        log: silentLog(),
        now: () => W0_END + 1 + 60_001,
      });
      service2.sync();

      const state = getWindowState(db, key);
      expect(state?.status).toBe('running');
      expect(state?.runId).toBe('run-a2');
    });

    it('a REBIND write materializes a window the unbound-stretch heal flipped to waiting (no wait for fire/boot)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const due = W0_END + 60_000;
      const { key, run } = failedWindow(db, trigger, pv);
      retryWindow(db, key, {
        runId: run.id,
        runStatus: 'failure',
        attempt: 1,
        nextAttemptAtMs: due,
      });
      // Unbind; the overdue heal still flips the window to waiting (the
      // pre-bind drive), but materialize is skipped while unbound.
      updateTrigger(db, trigger.id, { pipelineVersionId: null });
      const service1 = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
        now: () => due + 1,
      });
      service1.sync();
      expect(getWindowState(db, key)?.status).toBe('waiting');

      // The REBIND write's sync must kick materialize for the stranded row —
      // not leave it waiting for the next window fire or reboot.
      updateTrigger(db, trigger.id, { pipelineVersionId: pv });
      const launcher2 = fakeLauncher([{ outcome: 'started', runId: 'run-a2' }]);
      const service2 = createTumblingService({
        db,
        arm: () => undefined,
        launcher: launcher2,
        log: silentLog(),
        now: () => due + 2,
      });
      service2.sync();

      const state = getWindowState(db, key);
      expect(state?.status).toBe('running');
      expect(state?.runId).toBe('run-a2');
    });

    it('a stored over-cap retry interval cannot wedge the settle (Date-range clamp; window still holds retry_pending)', async () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      // Read-lenient stored shape: an interval far past ECMAScript's max
      // time value. The write boundary caps at 86400, so the row is seeded
      // valid and then hand-edited PAST the boundary (the corruptTriggerRow
      // vector — the exact hand-edit/drift class the leniency exists for).
      // Unclamped, the settle's ISO stamp would THROW on every tap and boot
      // reconcile — the window stuck `running` forever, slot held, backfill
      // gate closed.
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const { key, run } = failedWindow(db, trigger, pv);
      db.update(triggers)
        .set({ window: { ...RETRY_CONFIG, retry: { count: 1, intervalInSeconds: 9e12 } } })
        .where(eq(triggers.id, trigger.id))
        .run();

      const bus = createRunEventBus();
      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
        now: () => W0_END + 1,
      });
      service.subscribeCompletion(bus);
      await tapTerminal(bus, run.id);

      const state = getWindowState(db, key);
      expect(state?.status).toBe('retry_pending');
      // Clamped to the last 4-digit-year instant (Zod-datetime-representable).
      expect(state?.nextAttemptAtMs).toBe(Date.parse('9999-12-31T23:59:59.999Z'));
    });

    it('the retry alarm firing while the trigger is DISABLED suppresses trigger_not_tumbling (window survives)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: RETRY_CONFIG });
      const due = W0_END + 60_000;
      const { key, run } = failedWindow(db, trigger, pv);
      retryWindow(db, key, {
        runId: run.id,
        runStatus: 'failure',
        attempt: 1,
        nextAttemptAtMs: due,
      });
      const alarm = armWakeup(db, {
        kind: WINDOW_RETRY_KIND,
        ref: buildWindowRetryRef(key, 1),
        dueAt: due,
        discriminator: 'attempt-1',
      });
      updateTrigger(db, trigger.id, { enabled: false });

      const service = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
        now: () => due,
      });
      const row = getWakeup(db, alarm.id);
      if (row === null) throw new Error('fixture alarm missing');
      const result = service.retryHandler.fire(
        row,
        { scheduledFor: due, firedAt: due, latenessMs: 0 },
        db,
      );

      expect(result).toEqual({ status: 'suppressed', reason: 'trigger_not_tumbling' });
      // The window is NOT stranded: it stays retry_pending, and the overdue
      // heal drives it once the trigger is re-enabled (previous test).
      expect(getWindowState(db, key)?.status).toBe('retry_pending');
    });
  });
});

describe('#5 S11d — self-dependency + stale-epoch disposition', () => {
  /** Geometry helper: a window row [T0+k*15m, T0+(k+1)*15m) in any status. */
  function seedWindow(
    db: Db,
    trigger: Trigger,
    k: number,
    origin: 'live' | 'backfill' = 'live',
  ): WindowKey {
    const key = keyFor(trigger, T0 + k * MIN15);
    createWindow(db, {
      ...key,
      windowEnd: iso(T0 + (k + 1) * MIN15),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
      origin,
    });
    return key;
  }

  /** Drive a seeded window to a terminal/held status via the guarded repo
   * flips (fake run ids are fine — only `running` windows are re-derived from
   * the run table, and these end elsewhere). */
  function windowInStatus(
    db: Db,
    trigger: Trigger,
    k: number,
    status: 'waiting' | 'succeeded' | 'failed' | 'retry_pending' | 'superseded',
  ): WindowKey {
    const key = seedWindow(db, trigger, k);
    if (status === 'waiting') return key;
    if (status === 'superseded') {
      if (!isTumblable(trigger)) throw new Error('fixture must be tumblable');
      expect(supersedeWindow(db, key, windowConfigEpoch(trigger.window))).toBe(true);
      return key;
    }
    expect(linkWindowRun(db, key, `run-w${k}`, 'fire')).toBe(true);
    if (status === 'succeeded') {
      expect(completeWindow(db, key, { status: 'succeeded', runId: `run-w${k}` })).toBe(true);
    } else if (status === 'failed') {
      expect(
        completeWindow(db, key, { status: 'failed', runId: `run-w${k}`, runStatus: 'failure' }),
      ).toBe(true);
    } else {
      expect(
        retryWindow(db, key, {
          runId: `run-w${k}`,
          runStatus: 'failure',
          attempt: 1,
          nextAttemptAtMs: T0 + 10 * 60 * 60_000,
        }),
      ).toBe(true);
    }
    return key;
  }

  function service(db: Db, launcher = fakeLauncher(), nowMs = T0 + 4 * 60 * 60_000) {
    return {
      launcher,
      service: createTumblingService({
        db,
        arm: () => undefined,
        launcher,
        log: silentLog(),
        now: () => nowMs,
      }),
    };
  }

  // Previous-window dependency: W_k depends on W_{k-1}.
  const DEP_PREV: WindowConfig = { ...CONFIG, selfDependency: { offsetInSeconds: -900 } };
  // Two windows back, one window long: W_k depends on W_{k-2} only.
  const DEP_SKIP: WindowConfig = {
    ...CONFIG,
    selfDependency: { offsetInSeconds: -1800, sizeInSeconds: 900 },
  };

  describe('dependency gate (materialize-time predicate)', () => {
    it('fires when the dependency window succeeded', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: DEP_PREV });
      windowInStatus(db, trigger, 0, 'succeeded');
      seedWindow(db, trigger, 1);
      const { launcher, service: svc } = service(db);

      svc.reconcile();

      expect(launcher.contexts.map((c) => c?.scheduledTime)).toEqual([iso(T0 + 2 * MIN15)]);
      expect(getWindowState(db, keyFor(trigger, T0 + MIN15))?.status).toBe('running');
    });

    it('the first window’s pre-grid dependency is vacuous (grid clamp — no deadlock at the chain origin)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: DEP_PREV });
      seedWindow(db, trigger, 0);
      const { launcher, service: svc } = service(db);

      svc.reconcile();

      expect(launcher.fires).toHaveLength(1);
      expect(getWindowState(db, keyFor(trigger, T0))?.status).toBe('running');
    });

    it('blocks behind a FAILED dependency (ADF’s rerun-wait semantic — no fire, stays waiting in state)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: DEP_PREV });
      windowInStatus(db, trigger, 0, 'failed');
      seedWindow(db, trigger, 1);
      const { launcher, service: svc } = service(db);

      svc.reconcile();

      expect(launcher.fires).toHaveLength(0);
      expect(getWindowState(db, keyFor(trigger, T0 + MIN15))?.status).toBe('waiting');
    });

    it('blocks behind a retry_pending dependency (it may still succeed — wait for the re-drive)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: DEP_PREV });
      windowInStatus(db, trigger, 0, 'retry_pending');
      seedWindow(db, trigger, 1);
      // now BEFORE the stored retry due instant, so the reconcile heal does
      // not re-drive W0 out from under the assertion.
      const { launcher, service: svc } = service(db, fakeLauncher(), T0 + 60 * 60_000);

      svc.reconcile();

      expect(launcher.fires).toHaveLength(0);
      expect(getWindowState(db, keyFor(trigger, T0 + MIN15))?.status).toBe('waiting');
    });

    it('a dependency the chain will still drive blocks; the dependent fires once it succeeds (tap liveness)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: DEP_PREV });
      // W0 waiting, W1 waiting: the scan fires W0 (vacuous pre-grid dep) and
      // W1 blocks behind the now-RUNNING W0.
      seedWindow(db, trigger, 0);
      seedWindow(db, trigger, 1);
      const { launcher, service: svc } = service(db);

      svc.reconcile();

      expect(launcher.fires).toHaveLength(1);
      expect(getWindowState(db, keyFor(trigger, T0))?.status).toBe('running');
      expect(getWindowState(db, keyFor(trigger, T0 + MIN15))?.status).toBe('waiting');

      // W0 succeeds → the settle path’s materialize kick fires W1.
      expect(completeWindow(db, keyFor(trigger, T0), { status: 'succeeded', runId: 'run-1' })).toBe(
        true,
      );
      svc.reconcile();
      expect(launcher.fires).toHaveLength(2);
      expect(getWindowState(db, keyFor(trigger, T0 + MIN15))?.status).toBe('running');
    });

    it('a permanently-skipped no-row dependency is vacuously satisfied (forward-only disposition)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: DEP_SKIP });
      // W2 depends on W0 only — W0 was skipped by the no-backfill policy (no
      // row, long closed). The dependency inherits the trigger’s own
      // disposition of missed windows.
      seedWindow(db, trigger, 2);
      const { launcher, service: svc } = service(db);

      svc.reconcile();

      expect(launcher.fires).toHaveLength(1);
      expect(getWindowState(db, keyFor(trigger, T0 + 2 * MIN15))?.status).toBe('running');
    });

    it('a current-epoch SUPERSEDED dependency satisfies (the revert interaction — dispositioned, not pending)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: DEP_PREV });
      windowInStatus(db, trigger, 0, 'superseded');
      seedWindow(db, trigger, 1);
      const { launcher, service: svc } = service(db);

      svc.reconcile();

      expect(launcher.fires).toHaveLength(1);
      expect(getWindowState(db, keyFor(trigger, T0 + MIN15))?.status).toBe('running');
    });

    it('out-of-order readiness: a blocked older window does not starve a ready younger one', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: DEP_SKIP });
      windowInStatus(db, trigger, 0, 'failed'); // blocks W2
      windowInStatus(db, trigger, 1, 'succeeded'); // satisfies W3
      seedWindow(db, trigger, 2);
      seedWindow(db, trigger, 3);
      const { launcher, service: svc } = service(db);

      svc.reconcile();

      // W2 is dependency-blocked; W3 fires past it (ADF: windows run when
      // THEIR deps are met, not in strict sequence).
      expect(launcher.contexts.map((c) => c?.scheduledTime)).toEqual([iso(T0 + 4 * MIN15)]);
      expect(getWindowState(db, keyFor(trigger, T0 + 2 * MIN15))?.status).toBe('waiting');
      expect(getWindowState(db, keyFor(trigger, T0 + 3 * MIN15))?.status).toBe('running');
    });

    it('a blocked front LARGER than the materialize batch does not starve the ready tail (keyset regression)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      // W_k depends on W_{k-27}: 26 failed deps block W27..W52; W26 succeeded
      // readies W53. The blocked front (26) exceeds MATERIALIZE_BATCH (25) —
      // a fixed-front fetch would rescan the same blocked rows forever and
      // never reach W53.
      const config: WindowConfig = {
        ...CONFIG,
        selfDependency: { offsetInSeconds: -27 * 900, sizeInSeconds: 900 },
      };
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: config });
      for (let k = 0; k < 26; k += 1) windowInStatus(db, trigger, k, 'failed');
      windowInStatus(db, trigger, 26, 'succeeded');
      for (let k = 27; k <= 53; k += 1) seedWindow(db, trigger, k);
      const { launcher, service: svc } = service(db, fakeLauncher(), T0 + 24 * 60 * 60_000);

      svc.reconcile();

      expect(launcher.contexts.map((c) => c?.scheduledTime)).toEqual([iso(T0 + 54 * MIN15)]);
      expect(getWindowState(db, keyFor(trigger, T0 + 53 * MIN15))?.status).toBe('running');
      expect(getWindowState(db, keyFor(trigger, T0 + 27 * MIN15))?.status).toBe('waiting');
    });

    it('capped materialize skips a blocked front and fills capacity from the ready tail (no refetch loop)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const config: WindowConfig = { ...DEP_SKIP, maxConcurrentWindows: 1 };
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: config });
      windowInStatus(db, trigger, 0, 'failed'); // blocks W2
      windowInStatus(db, trigger, 1, 'succeeded'); // readies W3
      seedWindow(db, trigger, 2);
      seedWindow(db, trigger, 3);
      const { launcher, service: svc } = service(db);

      svc.reconcile();

      expect(launcher.contexts.map((c) => c?.scheduledTime)).toEqual([iso(T0 + 4 * MIN15)]);
      expect(getWindowState(db, keyFor(trigger, T0 + 2 * MIN15))?.status).toBe('waiting');
    });

    it('backfill trigger: a no-row dependency below the cursor is dispositioned (fires); above it blocks', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const config: WindowConfig = { ...DEP_SKIP, maxBackfillWindows: 2 };
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: config });
      if (!isTumblable(trigger)) throw new Error('fixture must be tumblable');
      const epoch = windowConfigEpoch(trigger.window);
      seedWindow(db, trigger, 2); // dep = W0 (no row)

      // Cursor NOT past W0’s start → W0 is still the backfill pass’s to
      // create → the dependent waits for it.
      advanceBackfillCursor(db, trigger.id, epoch, T0);
      const first = service(db);
      first.service.reconcile();
      expect(first.launcher.fires).toHaveLength(0);
      expect(getWindowState(db, keyFor(trigger, T0 + 2 * MIN15))?.status).toBe('waiting');

      // Cursor past W0’s start → W0 was deliberately skipped (dispositioned)
      // → vacuously satisfied.
      advanceBackfillCursor(db, trigger.id, epoch, T0 + 1);
      const second = service(db);
      second.service.reconcile();
      expect(second.launcher.fires).toHaveLength(1);
      expect(getWindowState(db, keyFor(trigger, T0 + 2 * MIN15))?.status).toBe('running');
    });

    it('backfill trigger with NO cursor yet: nothing is dispositioned — the dependent waits for the pass', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const config: WindowConfig = { ...DEP_SKIP, maxBackfillWindows: 2 };
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: config });
      seedWindow(db, trigger, 2);
      const { launcher, service: svc } = service(db);

      svc.reconcile();

      expect(launcher.fires).toHaveLength(0);
      expect(getWindowState(db, keyFor(trigger, T0 + 2 * MIN15))?.status).toBe('waiting');
    });

    it('the link-before-fire heal runs even for a blocked window (the dependency was consumed at fire time)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: DEP_PREV });
      if (!isTumblable(trigger)) throw new Error('fixture must be tumblable');
      windowInStatus(db, trigger, 0, 'failed'); // blocks W1
      seedWindow(db, trigger, 1);
      // A crash-orphaned run for W1: fired before W0’s failure landed, link
      // never committed.
      const orphan = createRun(db, {
        ownerId: 'local',
        pipelineVersionId: pv,
        triggerId: trigger.id,
        parentRunId: null,
        params: {},
        triggerContext: {
          triggerId: trigger.id,
          scheduledTime: iso(T0 + 2 * MIN15),
          body: null,
          windowEpoch: windowConfigEpoch(trigger.window),
        },
      });
      updateRun(db, orphan.id, { status: 'running' });
      const { launcher, service: svc } = service(db);

      svc.reconcile();

      // No NEW fire — the orphan was LINKED (heal-first, gate-second).
      expect(launcher.fires).toHaveLength(0);
      const w1 = getWindowState(db, keyFor(trigger, T0 + MIN15));
      expect(w1?.status).toBe('running');
      expect(w1?.runId).toBe(orphan.id);
    });
  });

  describe('stale-epoch disposition (window.superseded)', () => {
    /** An old-epoch window row (geometry that no longer matches the trigger). */
    function seedOldEpochWindow(
      db: Db,
      trigger: Trigger,
      status: 'waiting' | 'retry_pending',
    ): WindowKey {
      const key: WindowKey = {
        triggerId: trigger.id,
        configEpoch: 'old-epoch',
        windowStart: iso(T0),
      };
      createWindow(db, {
        ...key,
        windowEnd: iso(T0 + 30 * 60_000),
        geometry: { frequency: 'minute', interval: 30, startTime: CONFIG.startTime },
        origin: 'live',
      });
      if (status === 'retry_pending') {
        expect(linkWindowRun(db, key, 'run-old', 'fire')).toBe(true);
        expect(
          retryWindow(db, key, {
            runId: 'run-old',
            runStatus: 'failure',
            attempt: 1,
            nextAttemptAtMs: T0 + 10 * 60 * 60_000,
          }),
        ).toBe(true);
      }
      return key;
    }

    it('sync supersedes old-epoch waiting + retry_pending debris — even for a trigger the pass would otherwise skip early', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      // Plain trigger: no backfill, no cap, bound, no current-epoch stranded
      // rows — the exact shape pass 3 early-continues on. Disposition must
      // run BEFORE that continue.
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: CONFIG });
      if (!isTumblable(trigger)) throw new Error('fixture must be tumblable');
      const currentEpoch = windowConfigEpoch(trigger.window);
      const waitingKey = seedOldEpochWindow(db, trigger, 'waiting');
      const svc = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
        now: () => T0 + 60 * 60_000,
      });

      svc.sync();

      const row = getWindowState(db, waitingKey);
      expect(row?.status).toBe('superseded');
      expect(row?.nextAttemptAtMs).toBeNull();
      // The event is durable and the fold agrees with the projection.
      const events = listWindowEvents(db, waitingKey);
      expect(events.at(-1)).toEqual({
        type: 'window.superseded',
        payload: { currentEpoch },
      });
      expect(rebuildWindowStatus(db, waitingKey)).toBe('superseded');
    });

    it('sync supersedes old-epoch retry_pending debris of an UNBOUND trigger (before the unbound skip)', () => {
      const { db } = freshDb();
      const trigger = seedTumbling(db, { pipelineVersionId: null, window: CONFIG });
      const key = seedOldEpochWindow(db, trigger, 'retry_pending');
      const svc = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
        now: () => T0 + 60 * 60_000,
      });

      svc.sync();

      const row = getWindowState(db, key);
      expect(row?.status).toBe('superseded');
      expect(row?.nextAttemptAtMs).toBeNull();
      expect(rebuildWindowStatus(db, key)).toBe('superseded');
    });

    it('current-epoch rows are never superseded; old-epoch RUNNING rows settle via their run instead', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: CONFIG });
      // Current-epoch waiting row (would fire, not supersede).
      const currentKey = keyFor(trigger, T0);
      createWindow(db, {
        ...currentKey,
        windowEnd: iso(T0 + MIN15),
        geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
        origin: 'live',
      });
      // Old-epoch running row with a LIVE run.
      const liveRun = createRun(db, {
        ownerId: 'local',
        pipelineVersionId: pv,
        triggerId: trigger.id,
        parentRunId: null,
        params: {},
      });
      updateRun(db, liveRun.id, { status: 'running' });
      const oldKey: WindowKey = {
        triggerId: trigger.id,
        configEpoch: 'old-epoch',
        windowStart: iso(T0),
      };
      createWindow(db, {
        ...oldKey,
        windowEnd: iso(T0 + 30 * 60_000),
        geometry: { frequency: 'minute', interval: 30, startTime: CONFIG.startTime },
        origin: 'live',
      });
      expect(linkWindowRun(db, oldKey, liveRun.id, 'fire')).toBe(true);
      const svc = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
        now: () => T0 + 60 * 60_000,
      });

      svc.sync();

      expect(getWindowState(db, currentKey)?.status).toBe('running'); // fired, not superseded
      expect(getWindowState(db, oldKey)?.status).toBe('running'); // its live run settles it
    });

    it('boot reconcile supersedes — including for a DISABLED trigger (enabled-agnostic, like the settle path)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: CONFIG, enabled: false });
      const key = seedOldEpochWindow(db, trigger, 'waiting');
      const svc = createTumblingService({
        db,
        arm: () => undefined,
        launcher: fakeLauncher(),
        log: silentLog(),
        now: () => T0 + 60 * 60_000,
      });

      svc.reconcile();

      expect(getWindowState(db, key)?.status).toBe('superseded');
      expect(rebuildWindowStatus(db, key)).toBe('superseded');
    });

    it('supersede is PERMANENT: reverting to the old geometry does not resurrect the window', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: CONFIG });
      if (!isTumblable(trigger)) throw new Error('fixture must be tumblable');
      // A superseded row under the trigger’s CURRENT epoch (i.e. post-revert).
      const key = keyFor(trigger, T0);
      createWindow(db, {
        ...key,
        windowEnd: iso(T0 + MIN15),
        geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
        origin: 'live',
      });
      expect(supersedeWindow(db, key, 'newer-epoch')).toBe(true);
      const { launcher, service: svc } = service(db);

      svc.sync();
      svc.reconcile();

      // Not re-created (projection uniqueness), not re-fired, not
      // re-superseded (current epoch is excluded from the disposition scan).
      expect(launcher.fires).toHaveLength(0);
      expect(getWindowState(db, key)?.status).toBe('superseded');
      expect(
        createWindow(db, {
          ...key,
          windowEnd: iso(T0 + MIN15),
          geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
          origin: 'live',
        }),
      ).toBe(false);
    });

    it('repo guard: supersedeWindow refuses running and terminal rows (appends nothing)', () => {
      const { db } = freshDb();
      const pv = seedVersion(db);
      const trigger = seedTumbling(db, { pipelineVersionId: pv, window: CONFIG });
      const runningKey = keyFor(trigger, T0);
      createWindow(db, {
        ...runningKey,
        windowEnd: iso(T0 + MIN15),
        geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
        origin: 'live',
      });
      expect(linkWindowRun(db, runningKey, 'run-1', 'fire')).toBe(true);
      expect(supersedeWindow(db, runningKey, 'ep-x')).toBe(false);
      expect(getWindowState(db, runningKey)?.status).toBe('running');
      expect(listWindowEvents(db, runningKey).some((e) => e.type === 'window.superseded')).toBe(
        false,
      );

      expect(completeWindow(db, runningKey, { status: 'succeeded', runId: 'run-1' })).toBe(true);
      expect(supersedeWindow(db, runningKey, 'ep-x')).toBe(false);
      expect(getWindowState(db, runningKey)?.status).toBe('succeeded');
    });
  });
});
