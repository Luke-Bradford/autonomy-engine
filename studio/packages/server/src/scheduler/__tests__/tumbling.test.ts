import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_VERSION,
  type NewPipelineVersion,
  type Node,
  type Trigger,
  type TriggerMode,
  type WindowConfig,
} from '@autonomy-studio/shared';
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
  type WindowKey,
} from '../../repo/tumbling-windows.js';
import type { Db } from '../../repo/types.js';
import { createRunEventBus } from '../../run/event-bus.js';
import { type FireContext, type FireResult } from '../../run/launcher.js';
import { createAlarmClock } from '../alarms.js';
import {
  buildWindowDueRef,
  createTumblingService,
  firstWindowEndingAfter,
  isTumblable,
  isWindowRefFresh,
  WINDOW_DUE_KIND,
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

    // Fired once, afterCommit, with `${trigger.scheduledTime}` = windowEnd and
    // (#5 S10) the config epoch frozen in for the epoch-scoped link join.
    const fl = launcher as ReturnType<typeof fakeLauncher>;
    expect(fl.fires.map((t) => t.id)).toEqual([trigger.id]);
    expect(fl.contexts).toEqual([
      { scheduledTime: iso(W0_END), windowEpoch: windowConfigEpoch(CONFIG) },
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
    // Launcher refuses everything (full queue) — the backlog persists; only
    // the truncation signal is under test.
    const launcher = fakeLauncher(
      Array.from({ length: 30 }, () => ({ outcome: 'skipped' as const, reason: 'queue is full' })),
    );
    const service = createTumblingService({ db, arm: () => undefined, launcher, log });
    service.reconcile();

    expect(warns.some((m) => typeof m === 'string' && m.includes('truncated'))).toBe(true);
    // Nothing dropped: every window is still durably `waiting` for later passes.
    expect(listWindowStates(db, { triggerId: trigger.id, status: 'waiting' })).toHaveLength(26);
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

  it('boot reconcile leaves a STALE-epoch waiting window inert', () => {
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

    expect(launcher.fires).toHaveLength(0);
    expect(getWindowState(db, key)?.status).toBe('waiting');
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
    expect(launcher.contexts[0]).toEqual({
      scheduledTime: iso(W0_END),
      windowEpoch: windowConfigEpoch(BF10),
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

  it('an epoch edit mid-drain backfills the NEW epoch fresh; old-epoch windows stay inert', () => {
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
    // Old-epoch waiting windows still exist, untouched (inert debris — S11's).
    const oldWaiting = listWindowStates(db, {
      triggerId: trigger.id,
      configEpoch: oldEpoch,
      status: 'waiting',
    });
    expect(oldWaiting.length).toBeGreaterThan(0);
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
    expect(findUnlinkedRunForWindow(db, trigger.id, 'epA', iso(W0_END))).toBeNull();
    // Wrong epoch → NOT matched (the old-epoch-at-shared-boundary hazard).
    mkRun('epB');
    expect(findUnlinkedRunForWindow(db, trigger.id, 'epA', iso(W0_END))).toBeNull();
    // Right epoch → matched.
    const match = mkRun('epA');
    expect(findUnlinkedRunForWindow(db, trigger.id, 'epA', iso(W0_END))).toBe(match.id);
  });
});
