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
import { createTrigger, updateTrigger } from '../../repo/triggers.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { armWakeup, getWakeup, listPendingWakeups } from '../../repo/scheduled-wakeups.js';
import { createRun, updateRun } from '../../repo/runs.js';
import {
  createWindow,
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

    // Fired once, afterCommit, with `${trigger.scheduledTime}` = windowEnd.
    const fl = launcher as ReturnType<typeof fakeLauncher>;
    expect(fl.fires.map((t) => t.id)).toEqual([trigger.id]);
    expect(fl.contexts).toEqual([{ scheduledTime: iso(W0_END) }]);

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
    });
    const orphan = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv,
      triggerId: trigger.id,
      parentRunId: null,
      params: {},
      triggerContext: { triggerId: trigger.id, scheduledTime: iso(W0_END), body: null },
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
    });
    const orphan = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pv,
      triggerId: trigger.id,
      parentRunId: null,
      params: {},
      triggerContext: { triggerId: trigger.id, scheduledTime: iso(W0_END), body: null },
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

  it('boot reconcile re-materializes a stranded waiting window (fires once)', () => {
    const { db } = freshDb();
    const pv = seedVersion(db);
    const trigger = seedTumbling(db, { pipelineVersionId: pv });
    const key = keyFor(trigger, T0);
    createWindow(db, {
      ...key,
      windowEnd: iso(W0_END),
      geometry: { frequency: 'minute', interval: 15, startTime: CONFIG.startTime },
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
