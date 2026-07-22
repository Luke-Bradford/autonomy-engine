import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  SubstituteError,
  type Concurrency,
  type Edge,
  type EdgeOn,
  type EngineEvent,
  type NewPipelineVersion,
  type Node,
  type Param,
  type Trigger,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createTrigger, updateTrigger } from '../../repo/triggers.js';
import {
  countActiveRunsForPipeline,
  countActiveRunsForTrigger,
  createRun,
  getRun,
  listRuns,
  updateRun,
} from '../../repo/runs.js';
import { appendEngineEvent, loadEngineEvents } from '../events.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { syncRunLifecycle, type DocResolver, type DriveDeps, type Executor } from '../driver.js';
import { createRunDrives } from '../drives.js';
import { createRunEventBus, type RunEventBus } from '../event-bus.js';
import { createRunLauncher, UnboundTriggerError } from '../launcher.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';

type Db = ReturnType<typeof freshDb>['db'];

/** Find + NARROW the run's durable trigger seed (#5 S12), so a shape regression
 * fails loudly rather than passing under an unchecked union cast. */
function triggerSeed(db: Db, runId: string): Extract<EngineEvent, { type: 'run.triggerContext' }> {
  const seed = loadEngineEvents(db, runId).find((e) => e.type === 'run.triggerContext');
  if (seed?.type !== 'run.triggerContext')
    throw new Error(`no run.triggerContext seed for ${runId}`);
  return seed;
}

let seq = 0;
function node(id: string, extra: Partial<Node> = {}): Node {
  seq += 1;
  // Uncatalogued on purpose — see the same factory in `driver.test.ts`. Keeps the
  // output contract `absent` so a type-agnostic stub's `{}` payload is not failed
  // against a catalog contract F13b/#456 would otherwise lower into a known type.
  return { id, type: 'test_activity', config: {}, position: { x: seq, y: 0 }, ...extra };
}
function edge(from: string, to: string, on: EdgeOn = 'success'): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}

function seedVersion(
  db: Db,
  nodes: Node[] = [node('a')],
  edges: Edge[] = [],
  params: Param[] = [],
): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params,
    outputs: [],
    nodes,
    edges,
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input).id;
}

function seedTrigger(
  db: Db,
  opts: {
    pipelineVersionId: string | null;
    concurrency?: Concurrency;
    enabled?: boolean;
    params?: Record<string, unknown>;
  },
): Trigger {
  return createTrigger(db, {
    ownerId: 'local',
    name: 'T',
    pipelineVersionId: opts.pipelineVersionId,
    params: opts.params ?? {},
    mode: 'manual',
    schedule: null,
    webhook: null,
    concurrency: opts.concurrency ?? { policy: 'skip_if_running' },
    runWindows: null,
    enabled: opts.enabled ?? false,
  });
}

/** The RESOLVED run params, read from the durable `run.started` fact (#5 S12b). */
function startedParams(db: Db, runId: string): Record<string, unknown> {
  const started = loadEngineEvents(db, runId).find((e) => e.type === 'run.started');
  if (started?.type !== 'run.started') throw new Error(`no run.started for ${runId}`);
  return started.params;
}

function strParam(name: string, def: string): Param {
  return { name, type: 'string', required: false, default: def };
}

function deps(db: Db, executorOpts: StubExecutorOptions = {}, bus?: RunEventBus): DriveDeps {
  const resolveDoc: DocResolver = (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
  return {
    db,
    resolveDoc,
    executor: makeStubExecutor(executorOpts),
    alarms: stubAlarms(),
    // #629 — most tests pass no bus (launcher does not subscribe → unchanged);
    // the terminalization-drain tests wire a real bus so the driver's appends
    // publish through it and the launcher's global hook fires.
    bus,
    // The REAL registry, not a stub: it is pure in-memory bookkeeping with no I/O
    // to fake, and the launcher's whole use of it (every drive runs under the
    // run's lock) is only meaningful against the real serialization.
    drives: createRunDrives(),
  };
}

describe('RunLauncher — unbound never fires', () => {
  it('throws UnboundTriggerError for a null-bound trigger and creates no run', () => {
    const { db } = freshDb();
    const trigger = seedTrigger(db, { pipelineVersionId: null });
    const launcher = createRunLauncher(deps(db));

    expect(() => launcher.fire(trigger)).toThrow(UnboundTriggerError);
    expect(listRuns(db, { triggerId: trigger.id })).toHaveLength(0);
  });
});

describe('RunLauncher — a started run drives to completion in the background', () => {
  it('creates a run bound to the trigger + version and drives it to success', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('b')], [edge('a', 'b')]);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId });
    const launcher = createRunLauncher(deps(db));

    const result = launcher.fire(trigger);
    expect(result.outcome).toBe('started');
    expect(result.runId).toBeDefined();

    await launcher.whenIdle();

    const run = getRun(db, result.runId!);
    expect(run?.status).toBe('success');
    expect(run?.triggerId).toBe(trigger.id);
    expect(run?.pipelineVersionId).toBe(pvId);
    // The event log is durable — the source of truth the P6 monitor tails.
    const events = loadEngineEvents(db, result.runId!);
    // #5 S12 — every launcher-fired run leads with the durable trigger seed
    // (carrying at least `triggerId`), then `run.started`.
    expect(events[0]?.type).toBe('run.triggerContext');
    expect(events[1]?.type).toBe('run.started');
    expect(events.at(-1)?.type).toBe('run.finished');
    expect(triggerSeed(db, result.runId!).triggerId).toBe(trigger.id);
  });

  it('threads a fire-time scheduledTime into the run.triggerContext seed (#5 S12)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId });
    const launcher = createRunLauncher(deps(db));

    const result = launcher.fire(trigger, { scheduledTime: '2026-07-17T09:00:00.000Z' });
    await launcher.whenIdle();

    const seed = triggerSeed(db, result.runId!);
    expect(seed.triggerId).toBe(trigger.id);
    expect(seed.scheduledTime).toBe('2026-07-17T09:00:00.000Z');
  });
});

describe('RunLauncher — #5 S4: a parked (waiting) run releases its concurrency slot', () => {
  // Seed a run that is PARKED (`waiting`) for the trigger — the S4 slot-release
  // contract: a run parked on a timer/webhook for hours must not keep occupying
  // its trigger's slot. Pre-S4 `waiting` counted as active and blocked new fires.
  function seedWaitingRun(db: Db, triggerId: string, pvId: string): void {
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId,
      parentRunId: null,
      params: {},
    });
    updateRun(db, run.id, { status: 'waiting' });
  }

  it('skip_if_running: admits a new fire while the only other run is parked', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, {
      pipelineVersionId: pvId,
      concurrency: { policy: 'skip_if_running' },
    });
    seedWaitingRun(db, trigger.id, pvId);
    const launcher = createRunLauncher(deps(db));

    expect(launcher.fire(trigger).outcome).toBe('started');
    await launcher.whenIdle();
  });

  it('parallel(max=1): admits a new fire while the only other run is parked', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, {
      pipelineVersionId: pvId,
      concurrency: { policy: 'parallel', max: 1 },
    });
    seedWaitingRun(db, trigger.id, pvId);
    const launcher = createRunLauncher(deps(db));

    expect(launcher.fire(trigger).outcome).toBe('started');
    await launcher.whenIdle();
  });

  it('queue: starts (does not enqueue) a fire while the only other run is parked', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, {
      pipelineVersionId: pvId,
      concurrency: { policy: 'queue' },
    });
    seedWaitingRun(db, trigger.id, pvId);
    const launcher = createRunLauncher(deps(db));

    // `queue` admission also reads the DB active count — a freed slot starts it now.
    expect(launcher.fire(trigger).outcome).toBe('started');
    await launcher.whenIdle();
  });
});

describe('RunLauncher — skip_if_running', () => {
  it('skips a second fire while one is active, then allows a fire once idle', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, {
      pipelineVersionId: pvId,
      concurrency: { policy: 'skip_if_running' },
    });
    const launcher = createRunLauncher(deps(db));

    const first = launcher.fire(trigger);
    expect(first.outcome).toBe('started');
    const second = launcher.fire(trigger);
    expect(second.outcome).toBe('skipped');

    await launcher.whenIdle();

    const third = launcher.fire(trigger);
    expect(third.outcome).toBe('started');
    await launcher.whenIdle();

    // Two runs total ever created (the skipped fire made none).
    expect(listRuns(db, { triggerId: trigger.id })).toHaveLength(2);
  });
});

describe('RunLauncher — parallel', () => {
  it('admits up to `max` concurrent runs then skips the overflow', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, {
      pipelineVersionId: pvId,
      concurrency: { policy: 'parallel', max: 2 },
    });
    // `hang` comes to rest with the node `dispatched` (no terminal) — the run
    // settles at `running`, so all three fires see overlapping active runs
    // deterministically without the drive completing.
    const launcher = createRunLauncher(deps(db, { nodes: { a: { hang: true } } }));

    expect(launcher.fire(trigger).outcome).toBe('started');
    expect(launcher.fire(trigger).outcome).toBe('started');
    expect(launcher.fire(trigger).outcome).toBe('skipped');

    await launcher.whenIdle();

    // Two admitted runs, both still `running` (dispatched, never finished); the
    // third fire made no run.
    const runs = listRuns(db, { triggerId: trigger.id });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'running')).toBe(true);
    // #5 S4 — end-to-end through the real launcher/pump: a `running` run HOLDS the
    // execution lease (a live drive is executing it).
    expect(runs.every((r) => r.leaseUntil !== null)).toBe(true);
  });

  it('fails closed (skip) for a parallel trigger with no max (legacy/corrupted row)', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const base = seedTrigger(db, {
      pipelineVersionId: pvId,
      concurrency: { policy: 'parallel', max: 2 },
    });
    // A row that bypassed the schema refinement (pre-refinement / older export):
    // parallel with no `max`. Must skip, never admit unbounded via `active >= NaN`.
    const bad = { ...base, concurrency: { policy: 'parallel' } } as unknown as Trigger;
    const launcher = createRunLauncher(deps(db));

    const result = launcher.fire(bad);
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toContain('misconfigured');
    expect(listRuns(db, { triggerId: base.id })).toHaveLength(0);
  });
});

describe('RunLauncher — queue', () => {
  it('queues a fire while active, then drains it to completion once the slot frees', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db));

    const first = launcher.fire(trigger);
    expect(first.outcome).toBe('started');
    const second = launcher.fire(trigger);
    expect(second.outcome).toBe('queued');

    await launcher.whenIdle();

    // Both eventually ran to success (the queued one drained after the first).
    const runs = listRuns(db, { triggerId: trigger.id });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'success')).toBe(true);
  });

  it('a queued fire preserves the fire-time context captured at admission (#5 S12)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db));
    const T1 = '2026-07-17T09:00:00.000Z';
    const T2 = '2026-07-17T10:00:00.000Z';

    launcher.fire(trigger, { scheduledTime: T1 }); // takes the slot
    launcher.fire(trigger, { scheduledTime: T2 }); // queued — must keep ITS T2

    await launcher.whenIdle();

    const scheduled = listRuns(db, { triggerId: trigger.id }).map(
      (r) => triggerSeed(db, r.id).scheduledTime,
    );
    // Both distinct occurrences survived — the queued fire did not inherit the
    // active run's context nor lose its own.
    expect(new Set(scheduled)).toEqual(new Set([T1, T2]));
  });

  it('skips a fire once the queue is at its depth cap (bounded in-memory queue)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    // Cap the queue at 1 waiter and keep the active run in flight (hang) so the
    // slot never frees during the burst.
    const launcher = createRunLauncher({
      ...deps(db, { nodes: { a: { hang: true } } }),
      maxQueueDepth: 1,
    });

    expect(launcher.fire(trigger).outcome).toBe('started'); // takes the slot
    expect(launcher.fire(trigger).outcome).toBe('queued'); // fills the 1-deep queue
    const overflow = launcher.fire(trigger);
    expect(overflow.outcome).toBe('skipped');
    expect(overflow.reason).toContain('queue is full');

    await launcher.whenIdle();
  });
});

describe('RunLauncher — a run stuck at `running` holds its slot (durable queue)', () => {
  it('does NOT admit the queued fire while a hung run still occupies the slot', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    // `hang` comes to rest at `running` (node dispatched, no terminal) — a
    // genuinely stuck/crashed drive. Under S4's lease/slot split a durably
    // `running` run OCCUPIES the slot, so the DB-gated drain must NOT admit past
    // it (that would transiently double-run the single-slot trigger). Unlike the
    // old in-memory queue (which drained on drive-end and lost the waiter on the
    // restart the fault required), the waiter is a DURABLE `queued` row that
    // survives to be admitted once the stuck run is swept + `recoverQueued` runs.
    const launcher = createRunLauncher(deps(db, { nodes: { a: { hang: true } } }));

    expect(launcher.fire(trigger).outcome).toBe('started');
    expect(launcher.fire(trigger).outcome).toBe('queued');

    await launcher.whenIdle();

    const runs = listRuns(db, { triggerId: trigger.id });
    expect(runs).toHaveLength(2);
    // The hung run holds the slot at `running`; its waiter stays `queued` (not
    // drained, not lost) — the durable-queue correctness the in-memory design
    // could not give.
    expect(runs.filter((r) => r.status === 'running')).toHaveLength(1);
    expect(runs.filter((r) => r.status === 'queued')).toHaveLength(1);
  });
});

describe('RunLauncher — durable admission queue (#5 S6a)', () => {
  it('enqueues a durable `queued` run row (status + queuedAt + frozen triggerContext), not an in-memory entry', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    // Hang the active run so the slot never frees during this synchronous check.
    const launcher = createRunLauncher(deps(db, { nodes: { a: { hang: true } } }));
    const T2 = '2026-07-22T10:00:00.000Z';

    expect(launcher.fire(trigger).outcome).toBe('started'); // takes + holds the slot
    const queued = launcher.fire(trigger, { scheduledTime: T2 });
    expect(queued.outcome).toBe('queued');

    // A REAL row exists (durable), distinct from the started run.
    const queuedRuns = listRuns(db, { triggerId: trigger.id }).filter((r) => r.status === 'queued');
    expect(queuedRuns).toHaveLength(1);
    const row = queuedRuns[0]!;
    expect(row.queuedAt).toBeTypeOf('number');
    // The fire-time context is frozen ON THE ROW so a delayed admission still
    // seeds `${trigger.scheduledTime}` with THIS occurrence.
    expect(row.triggerContext).toEqual({ triggerId: trigger.id, scheduledTime: T2, body: null });
    // A queued row has NO event log yet (pre-`run.started`, like `pending`).
    expect(loadEngineEvents(db, row.id)).toHaveLength(0);
  });

  it('a queued fire does NOT count against the trigger admission gate (pre-admission ≠ a slot)', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db, { nodes: { a: { hang: true } } }));

    launcher.fire(trigger); // running (holds slot)
    launcher.fire(trigger); // queued
    // `countActiveRunsForTrigger` (pending+running) sees ONLY the running run.
    expect(countActiveRunsForTrigger(db, trigger.id)).toBe(1);
  });

  it('recoverQueued() admits a durable waiter a PREVIOUS launcher left behind (restart), draining it to success', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });

    // Launcher A hangs its run to hold the slot and leave a durable `queued` row.
    const launcherA = createRunLauncher(deps(db, { nodes: { a: { hang: true } } }));
    const started = launcherA.fire(trigger);
    expect(launcherA.fire(trigger).outcome).toBe('queued');
    await launcherA.whenIdle();
    launcherA.stop(); // #5 S6a — must NOT drop the durable queued row

    // Simulate a restart: the boot reconciler sweeps the stuck `running` run to
    // `interrupted`, freeing the slot. A FRESH launcher (empty in-memory state,
    // NON-hanging executor) recovers the queue exactly as boot does after reconcile.
    updateRun(db, (started as { runId: string }).runId, {
      status: 'interrupted',
      finishedAt: Date.now(),
    });
    const launcherB = createRunLauncher(deps(db));
    launcherB.recoverQueued();
    await launcherB.whenIdle();

    const runs = listRuns(db, { triggerId: trigger.id });
    expect(runs.filter((r) => r.status === 'queued')).toHaveLength(0); // waiter admitted
    expect(runs.filter((r) => r.status === 'success')).toHaveLength(1); // and drove to success
  });

  it('fully drains a multi-deep durable queue (every waiter runs to success)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db));

    launcher.fire(trigger); // takes the slot
    launcher.fire(trigger); // queued
    launcher.fire(trigger); // queued

    await launcher.whenIdle();

    // The whole chain drains (no waiter stranded): every run reached success and
    // none is left `queued`. (Strict oldest-`queuedAt`-first ORDER is asserted
    // deterministically in the repo test, where `queuedAt` is controllable.)
    const runs = listRuns(db, { triggerId: trigger.id });
    expect(runs).toHaveLength(3);
    expect(runs.filter((r) => r.status === 'success')).toHaveLength(3);
  });
});

describe('RunLauncher — drainQueue re-checks LIVE concurrency policy (#631)', () => {
  it('admits up to the live parallel cap when policy is edited queue→parallel while rows are queued', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    // Hang the active run so the single slot stays occupied and the overflow
    // fires become DURABLE `queued` rows while we edit the policy.
    const launcher = createRunLauncher(deps(db, { nodes: { a: { hang: true } } }));

    expect(launcher.fire(trigger).outcome).toBe('started'); // holds the single slot
    expect(launcher.fire(trigger).outcome).toBe('queued');
    expect(launcher.fire(trigger).outcome).toBe('queued');
    expect(launcher.fire(trigger).outcome).toBe('queued'); // 3 durable queued rows

    // Operator widens concurrency while rows are already queued.
    updateTrigger(db, trigger.id, { concurrency: { policy: 'parallel', max: 3 } });

    // A single drain must now admit up to the LIVE cap (3), not trickle one at a
    // time gated on active===0. active=1 (the run holding the slot) → 2 more
    // admitted this drain, the 3rd overflow still waits.
    launcher.recoverQueued();
    await launcher.whenIdle();

    const runs = listRuns(db, { triggerId: trigger.id });
    expect(runs).toHaveLength(4);
    expect(runs.filter((r) => r.status === 'running')).toHaveLength(3); // up to the live cap
    expect(runs.filter((r) => r.status === 'queued')).toHaveLength(1); // the overflow waits
  });

  it('fails CLOSED to single-slot for a misconfigured parallel (no max) — queued rows still fully drain, never stranded', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    // Non-hang executor: each run completes and frees the slot, so the drain
    // cascades on settle.
    const launcher = createRunLauncher(deps(db));

    expect(launcher.fire(trigger).outcome).toBe('started'); // takes the slot (drives a microtask later)
    expect(launcher.fire(trigger).outcome).toBe('queued');
    expect(launcher.fire(trigger).outcome).toBe('queued'); // 2 durable queued rows

    // A corrupted/legacy row: `parallel` with NO `max` (the lenient stored schema
    // permits it on read). The drain must fall back to a single slot — NOT read a
    // NaN cap (`active < NaN` is always false), which would STRAND every queued
    // row forever.
    updateTrigger(db, trigger.id, { concurrency: { policy: 'parallel' } });

    await launcher.whenIdle();

    const runs = listRuns(db, { triggerId: trigger.id });
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === 'success')).toBe(true); // all drained, none stranded
  });
});

describe('RunLauncher — drainQueue on ANY terminalization via the run-event bus (#629)', () => {
  // A microtask flush: the bus hook DEFERS its drain (the terminal event
  // publishes BEFORE `runs.status` is synced), so the drain runs one microtask
  // after the terminalization. The occupier is NOT launcher-driven, so at the
  // moment of terminalization `inFlight` is empty and a bare `whenIdle()` would
  // return before the drain even schedules the admitted run — flush first.
  const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

  // Seed a `running` run the launcher did NOT drive — the stand-in for a
  // previously-parked run that a retry-alarm / external-wait resume is driving to
  // terminal OUTSIDE the launcher's own `driveRun` (so its settle never reaches
  // `driveRun`'s `finally`).
  function seedRunningOccupier(db: Db, triggerId: string, pvId: string): string {
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId,
      parentRunId: null,
      params: {},
    });
    updateRun(db, run.id, { status: 'running' });
    return run.id;
  }

  it('a run.finished published for an out-of-launcher run drains that trigger’s queued waiter', async () => {
    const { db } = freshDb();
    const bus = createRunEventBus();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db, {}, bus));

    // An out-of-launcher run holds the single slot; a fresh fire must queue.
    const occupier = seedRunningOccupier(db, trigger.id, pvId);
    expect(launcher.fire(trigger).outcome).toBe('queued');
    expect(
      listRuns(db, { triggerId: trigger.id }).filter((r) => r.status === 'queued'),
    ).toHaveLength(1);

    // Terminalize the occupier the way the driver does: PUBLISH `run.finished`
    // (status still `running` at this instant — a SYNCHRONOUS drain would read
    // the slot as occupied and admit nothing) THEN sync the row terminal.
    appendEngineEvent(db, { type: 'run.finished', runId: occupier, outcome: 'success' }, bus);
    syncRunLifecycle(db, occupier, 'success');

    await flushMicrotasks(); // let the deferred drain run + schedule the admitted run
    await launcher.whenIdle();

    const runs = listRuns(db, { triggerId: trigger.id });
    expect(runs.filter((r) => r.status === 'queued')).toHaveLength(0); // the waiter was admitted
    // The admitted run drove to success (it is the non-occupier run for this trigger).
    const admitted = runs.find((r) => r.id !== occupier);
    expect(admitted?.status).toBe('success');
  });

  it('also drains on run.interrupted', async () => {
    const { db } = freshDb();
    const bus = createRunEventBus();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db, {}, bus));

    const occupier = seedRunningOccupier(db, trigger.id, pvId);
    expect(launcher.fire(trigger).outcome).toBe('queued');

    appendEngineEvent(
      db,
      { type: 'run.interrupted', runId: occupier, reason: 'drive_failed' },
      bus,
    );
    syncRunLifecycle(db, occupier, 'interrupted');

    await flushMicrotasks();
    await launcher.whenIdle();

    expect(
      listRuns(db, { triggerId: trigger.id }).filter((r) => r.status === 'queued'),
    ).toHaveLength(0);
  });

  it('a NON-terminal event (node.output) does not drain', async () => {
    const { db } = freshDb();
    const bus = createRunEventBus();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db, {}, bus));

    const occupier = seedRunningOccupier(db, trigger.id, pvId);
    expect(launcher.fire(trigger).outcome).toBe('queued');

    // A live-progress event frees no slot — the waiter must stay queued.
    appendEngineEvent(
      db,
      { type: 'node.output', runId: occupier, nodeId: 'a', name: 'chunk', value: 1 },
      bus,
    );

    await flushMicrotasks();
    expect(
      listRuns(db, { triggerId: trigger.id }).filter((r) => r.status === 'queued'),
    ).toHaveLength(1);
  });

  it('a terminal event for a trigger-less (child) run is a safe no-op', async () => {
    const { db } = freshDb();
    const bus = createRunEventBus();
    const pvId = seedVersion(db);
    const launcher = createRunLauncher(deps(db, {}, bus));

    // A `call_pipeline` CHILD run: no trigger — the hook drains its PIPELINE's
    // queue (#5 S6b; empty here), and must tolerate the null triggerId, not throw.
    const parent = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    const child = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: parent.id,
      params: {},
    });
    updateRun(db, child.id, { status: 'running' });

    appendEngineEvent(db, { type: 'run.finished', runId: child.id, outcome: 'success' }, bus);
    syncRunLifecycle(db, child.id, 'success');

    await expect(flushMicrotasks()).resolves.toBeUndefined(); // no throw escapes the microtask
    launcher.stop();
  });

  it('stop() unsubscribes the hook: a later terminal event drains nothing', async () => {
    const { db } = freshDb();
    const bus = createRunEventBus();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db, {}, bus));

    const occupier = seedRunningOccupier(db, trigger.id, pvId);
    expect(launcher.fire(trigger).outcome).toBe('queued');

    launcher.stop(); // stop draining (drainQueue also guards `stopped`)

    appendEngineEvent(db, { type: 'run.finished', runId: occupier, outcome: 'success' }, bus);
    syncRunLifecycle(db, occupier, 'success');

    await flushMicrotasks();
    // The durable waiter is untouched (a fresh launcher's recoverQueued would pick
    // it up — S6a's durability guarantee).
    expect(
      listRuns(db, { triggerId: trigger.id }).filter((r) => r.status === 'queued'),
    ).toHaveLength(1);
  });
});

describe('RunLauncher — background failure', () => {
  it('terminalizes `interrupted` via a DIRECT patch when the drive throws before run.started', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId });
    // resolveDoc throws BEFORE startRun appends run.started (createRun already
    // succeeded via FK), so there is no event log — a direct lifecycle patch.
    const resolveDoc: DocResolver = () => {
      throw new Error('doc blew up');
    };
    const launcher = createRunLauncher({
      db,
      resolveDoc,
      executor: makeStubExecutor(),
      alarms: stubAlarms(),
      drives: createRunDrives(),
    });

    const result = launcher.fire(trigger);
    expect(result.outcome).toBe('started');
    await launcher.whenIdle();

    expect(getRun(db, result.runId!)?.status).toBe('interrupted');
    // No run.started ever landed, so the log stays empty (nothing to diverge).
    expect(loadEngineEvents(db, result.runId!)).toHaveLength(0);
  });

  it('APPENDS run.interrupted (log stays authoritative) when the drive throws AFTER run.started', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId });
    // An executor that throws on dispatch — run.started is already durable, then
    // the pump faults mid-drive. The launcher must keep the event log the source
    // of truth: append a run.interrupted event, not just patch the row.
    const throwingExecutor: Executor = {
      // Throws synchronously on call (same shape as reconcile's refuseToExecute)
      // — the driver's `for await` never even starts.
      perform(): AsyncIterable<EngineEvent> {
        throw new Error('executor blew up');
      },
    };
    const resolveDoc: DocResolver = (id) => {
      const pv = getPipelineVersion(db, id);
      if (pv === null) throw new Error(`no pv ${id}`);
      return pv;
    };
    const launcher = createRunLauncher({
      db,
      resolveDoc,
      executor: throwingExecutor,
      alarms: stubAlarms(),
      drives: createRunDrives(),
    });

    const result = launcher.fire(trigger);
    await launcher.whenIdle();

    const run = getRun(db, result.runId!);
    expect(run?.status).toBe('interrupted');
    const events = loadEngineEvents(db, result.runId!);
    // #5 S12 — the trigger seed leads, then run.started, then the interrupt.
    expect(events[0]?.type).toBe('run.triggerContext');
    expect(events[1]?.type).toBe('run.started');
    // The row's status is reachable by folding the durable log, not out-of-band.
    expect(events.some((e) => e.type === 'run.interrupted')).toBe(true);
  });

  it('still appends run.interrupted when the doc becomes unresolvable during cleanup', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId });
    // resolveDoc succeeds for startRun (call 1, appends run.started) but throws
    // for the cleanup fold (call 2) — the case where the version vanished mid-
    // flight. The terminal fact must still land in the LOG, not just the row.
    let calls = 0;
    const resolveDoc: DocResolver = (id) => {
      calls += 1;
      if (calls >= 2) throw new Error('doc vanished mid-cleanup');
      const pv = getPipelineVersion(db, id);
      if (pv === null) throw new Error(`no pv ${id}`);
      return pv;
    };
    const throwingExecutor: Executor = {
      perform(): AsyncIterable<EngineEvent> {
        throw new Error('executor blew up');
      },
    };
    const launcher = createRunLauncher({
      db,
      resolveDoc,
      executor: throwingExecutor,
      alarms: stubAlarms(),
      drives: createRunDrives(),
    });

    const result = launcher.fire(trigger);
    await launcher.whenIdle();

    const events = loadEngineEvents(db, result.runId!);
    // run.interrupted is durable in the LOG even though the fold could not run…
    expect(events.some((e) => e.type === 'run.interrupted')).toBe(true);
    // …and the row was patched to agree — log and row converge, never diverge.
    expect(getRun(db, result.runId!)?.status).toBe('interrupted');
  });
});

describe('RunLauncher — #443 never bury a terminal log under a false interrupt', () => {
  it('syncs the row FROM the log (no run.interrupted) when the post-terminal sync throws', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId });

    // Fault-inject #443's exact window. `pump` appends `run.finished` (DURABLE)
    // and only THEN folds it and syncs the row — so a DB write fault in that sync
    // throws out of `startRun` and lands in the launcher's catch, with a run whose
    // LOG already records success but whose ROW still says `running`.
    //
    // `syncRunLifecycle` only writes when the status actually CHANGES, so for this
    // single-node run the updates are exactly: #1 `run.started` (pending→running)
    // and #2 `run.finished` (running→success). Faulting #2 IS the window.
    let updates = 0;
    const faultyDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'update') {
          updates += 1;
          if (updates === 2) throw new Error('db write fault after the terminal append');
        }
        const value = Reflect.get(target, prop) as unknown;
        // Bind to the REAL target (never the proxy): drizzle's internals must not
        // re-enter this trap while servicing the call.
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as typeof db;

    const launcher = createRunLauncher({
      db: faultyDb,
      resolveDoc: deps(db).resolveDoc,
      executor: makeStubExecutor(),
      alarms: stubAlarms(),
      drives: createRunDrives(),
    });
    const result = launcher.fire(trigger);
    await launcher.whenIdle();

    const events = loadEngineEvents(db, result.runId!);
    // Precondition tripwire — assert the fault hit the write we MEANT (the
    // `run.finished` sync), so this test can never silently degrade into testing
    // nothing. Exactly 3 `update` accesses: #1 run.started, #2 the faulted
    // terminal sync, #3 `terminalizeInterrupted` syncing the row from the log. If
    // a future write lands earlier in `startRun`, this fails loudly rather than
    // faulting at the wrong point while still passing.
    expect(updates).toBe(3);
    expect(events.filter((e) => e.type === 'run.finished')).toHaveLength(1);

    // THE FIX: the log's terminal fact is left intact. Burying it under a
    // `run.interrupted` would make the boot reconciler — which #443 makes
    // LOG-authoritative — resync a SUCCEEDED run to `interrupted`.
    expect(events.some((e) => e.type === 'run.interrupted')).toBe(false);
    expect(getRun(db, result.runId!)?.status).toBe('success');
  });
});

describe('RunLauncher — stop', () => {
  it('skips new fires after stop()', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId });
    const launcher = createRunLauncher(deps(db));

    launcher.stop();
    const result = launcher.fire(trigger);
    expect(result.outcome).toBe('skipped');
    expect(listRuns(db, { triggerId: trigger.id })).toHaveLength(0);
  });
});

describe('RunLauncher — #5 S12b trigger param bindings + run-now override', () => {
  it('resolves fire-time bindings and applies the full precedence (default < binding < run-now)', async () => {
    const { db } = freshDb();
    // pv declares three params with defaults; `w` reads the scheduled occurrence.
    const pvId = seedVersion(
      db,
      [node('a')],
      [],
      [strParam('a', 'da'), strParam('b', 'db'), strParam('c', 'dc'), strParam('w', 'dw')],
    );
    // Trigger BINDINGS override the defaults of b/c/w; `a` is left to its default.
    const trigger = seedTrigger(db, {
      pipelineVersionId: pvId,
      params: {
        b: '${trigger.triggerId}',
        c: 'literal-c',
        w: '${trigger.scheduledTime}',
      },
    });

    // RUN-NOW override wins over the binding for `c`.
    const l = createRunLauncher(deps(db));
    const result = l.fire(trigger, {
      scheduledTime: '2026-07-17T09:00:00.000Z',
      runNowParams: { c: 'runnow-c' },
    });
    expect(result.outcome).toBe('started');
    await l.whenIdle();

    const params = startedParams(db, result.runId!);
    expect(params).toEqual({
      a: 'da', // pipeline default (no binding, no override)
      b: trigger.id, // trigger binding (${trigger.triggerId})
      c: 'runnow-c', // run-now override beats the binding's 'literal-c'
      w: '2026-07-17T09:00:00.000Z', // binding to the fire-time scheduled occurrence
    });
  });

  it('a queued fire freezes ITS OWN run-now override at admission', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')], [], [strParam('c', 'dc')]);
    const trigger = seedTrigger(db, {
      pipelineVersionId: pvId,
      concurrency: { policy: 'queue' },
    });
    const l = createRunLauncher(deps(db));

    l.fire(trigger, { runNowParams: { c: 'first' } }); // takes the slot
    l.fire(trigger, { runNowParams: { c: 'second' } }); // queued — must keep 'second'

    await l.whenIdle();

    const resolved = listRuns(db, { triggerId: trigger.id }).map((r) => startedParams(db, r.id).c);
    expect(new Set(resolved)).toEqual(new Set(['first', 'second']));
  });

  it('THROWS SubstituteError and creates no run when a binding cannot resolve for this fire', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')], [], [strParam('x', 'dx')]);
    // `${trigger.body.k}` is save-VALID (body is a known field) but deep-addresses
    // a null body on a manual fire — a fire-time throw, refused before any run row.
    const trigger = seedTrigger(db, {
      pipelineVersionId: pvId,
      params: { x: '${trigger.body.k}' },
    });

    expect(() => createRunLauncher(deps(db)).fire(trigger)).toThrow(SubstituteError);
    expect(listRuns(db, { triggerId: trigger.id })).toHaveLength(0);
  });

  it('THROWS SubstituteError and creates no run on a non-finite number in the fire body (#547 boundary 3, #5 S8)', () => {
    // `JSON.parse('{"x":1e999}')` is valid JSON yielding `Infinity` — reachable
    // from both S8 production feeders (webhook raw body, events payload). Unchecked
    // it would be frozen into the durable `run.triggerContext`, where
    // `JSON.stringify` persists it as `null`: the live folded RunState and the
    // replayed log would silently disagree.
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId });

    const body = JSON.parse('{"x":1e999}') as unknown;
    expect(() => createRunLauncher(deps(db)).fire(trigger, { body })).toThrow(SubstituteError);
    expect(listRuns(db, { triggerId: trigger.id })).toHaveLength(0);
  });
});

describe('RunLauncher — #5 S6b per-pipeline both-must-pass admission', () => {
  const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

  /** One pipeline with an explicit concurrency cap + a version factory, so
   * several triggers (possibly on different versions) share the pipeline. */
  function seedCappedPipeline(db: Db, cap: number | null) {
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P', concurrency: cap });
    const mkVersion = (nodes: Node[] = [node('a')]): string => {
      const input: NewPipelineVersion = {
        pipelineId: pipeline.id,
        params: [],
        outputs: [],
        nodes,
        edges: [],
        catalogVersion: CATALOG_VERSION,
      };
      return createPipelineVersion(db, input).id;
    };
    return { pipeline, mkVersion };
  }

  function seedQueuedRow(db: Db, pvId: string, triggerId: string, queuedAt: number) {
    return createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId,
      parentRunId: null,
      params: {},
      status: 'queued',
      queuedAt,
    });
  }

  it('queue policy: a fire with a FREE trigger slot queues when the PIPELINE cap is reached by another trigger', async () => {
    const { db } = freshDb();
    const { mkVersion } = seedCappedPipeline(db, 1);
    const pvId = mkVersion([node('a')]);
    const t1 = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const t2 = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db, { nodes: { a: { hang: true } } }));

    expect(launcher.fire(t1).outcome).toBe('started'); // occupies the pipeline's ONE slot
    // t2 has no active run of its own — per-trigger alone would start; the
    // pipeline gate must queue it (both-must-pass).
    expect(launcher.fire(t2).outcome).toBe('queued');
    const t2Runs = listRuns(db, { triggerId: t2.id });
    expect(t2Runs).toHaveLength(1);
    expect(t2Runs[0]!.status).toBe('queued');
    await launcher.whenIdle();
  });

  it('parallel policy: pipeline overflow QUEUES (spec: per-pipeline overflow queues), while its own trigger cap still SKIPS', async () => {
    const { db } = freshDb();
    const { mkVersion } = seedCappedPipeline(db, 1);
    const pvId = mkVersion([node('a')]);
    const t1 = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const t2 = seedTrigger(db, {
      pipelineVersionId: pvId,
      concurrency: { policy: 'parallel', max: 3 },
    });
    const launcher = createRunLauncher(deps(db, { nodes: { a: { hang: true } } }));

    expect(launcher.fire(t1).outcome).toBe('started');
    // t2 parallel(max=3) with 0 active of its own: pipeline full → queued, not skipped.
    expect(launcher.fire(t2).outcome).toBe('queued');
    expect(listRuns(db, { triggerId: t2.id })[0]!.status).toBe('queued');
    await launcher.whenIdle();
  });

  it('parallel policy: its OWN cap reached still skips (unchanged), even with pipeline room', async () => {
    const { db } = freshDb();
    const { mkVersion } = seedCappedPipeline(db, 5);
    const pvId = mkVersion([node('a')]);
    const t1 = seedTrigger(db, {
      pipelineVersionId: pvId,
      concurrency: { policy: 'parallel', max: 1 },
    });
    const launcher = createRunLauncher(deps(db, { nodes: { a: { hang: true } } }));

    expect(launcher.fire(t1).outcome).toBe('started');
    const second = launcher.fire(t1);
    expect(second.outcome).toBe('skipped');
    if (second.outcome === 'skipped') expect(second.reason).toContain('parallel cap');
    await launcher.whenIdle();
  });

  it('skip_if_running: pipeline-full queues the fire; a SECOND fire skips while the queued row is outstanding (at-most-one)', async () => {
    const { db } = freshDb();
    const { mkVersion } = seedCappedPipeline(db, 1);
    const pvId = mkVersion([node('a')]);
    const t1 = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const t2 = seedTrigger(db, {
      pipelineVersionId: pvId,
      concurrency: { policy: 'skip_if_running' },
    });
    const launcher = createRunLauncher(deps(db, { nodes: { a: { hang: true } } }));

    expect(launcher.fire(t1).outcome).toBe('started'); // pipeline slot taken
    expect(launcher.fire(t2).outcome).toBe('queued'); // trigger clear, pipeline full → queue
    // The queued row is an OUTSTANDING fire: skip_if_running must not stack another.
    const second = launcher.fire(t2);
    expect(second.outcome).toBe('skipped');
    expect(listRuns(db, { triggerId: t2.id })).toHaveLength(1);
    await launcher.whenIdle();
  });

  it('uncapped pipeline (null): per-trigger behaviour unchanged — a free-slot queue trigger starts even with another trigger active', async () => {
    const { db } = freshDb();
    const { mkVersion } = seedCappedPipeline(db, null);
    const pvId = mkVersion([node('a')]);
    const t1 = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const t2 = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db, { nodes: { a: { hang: true } } }));

    expect(launcher.fire(t1).outcome).toBe('started');
    expect(launcher.fire(t2).outcome).toBe('started'); // no pipeline gate
    await launcher.whenIdle();
  });

  it('cross-trigger drain on settle: T1 finishing admits T2’s queued waiter (pipeline slot freed)', async () => {
    const { db } = freshDb();
    const { mkVersion } = seedCappedPipeline(db, 1);
    // Distinct node ids so T1's node can dwell in flight while T2's is instant.
    const pvSlow = mkVersion([node('slow')]);
    const pvFast = mkVersion([node('b')]);
    const t1 = seedTrigger(db, { pipelineVersionId: pvSlow, concurrency: { policy: 'queue' } });
    const t2 = seedTrigger(db, { pipelineVersionId: pvFast, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db, { nodes: { slow: { delayMs: 30 } } }));

    expect(launcher.fire(t1).outcome).toBe('started');
    expect(launcher.fire(t2).outcome).toBe('queued');

    await launcher.whenIdle();

    // T1's settle drained the PIPELINE queue, admitting T2's row (a per-trigger
    // drain of T1 alone would have stranded it until boot).
    const t2Run = listRuns(db, { triggerId: t2.id })[0]!;
    expect(t2Run.status).toBe('success');
  });

  it('fair drain order: least-recently-admitted trigger first (no monopoly), FIFO within a trigger', async () => {
    const { db } = freshDb();
    const { pipeline, mkVersion } = seedCappedPipeline(db, 1);
    const pvId = mkVersion([node('a')]);
    const t1 = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const t2 = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });

    // Seed the queue DIRECTLY with pinned queuedAt keys (fire() stamps wall-clock
    // ms, which collides within a synchronous burst — the drain's ordering
    // contract is what this test pins, and it reads only durable rows).
    // T1 monopolises the queue with the three OLDEST rows; T2 has one newer row.
    seedQueuedRow(db, pvId, t1.id, 10);
    seedQueuedRow(db, pvId, t1.id, 20);
    seedQueuedRow(db, pvId, t1.id, 30);
    seedQueuedRow(db, pvId, t2.id, 40);

    // Record the ADMISSION order via the bus: every admitted run's run.started
    // is published in drive order (cap 1 → strictly sequential settles).
    const bus = createRunEventBus();
    const startedTriggers: string[] = [];
    let maxObservedActive = 0;
    bus.subscribeAll((e) => {
      if (e.type === 'run.started') {
        const run = getRun(db, e.runId);
        startedTriggers.push(run!.triggerId === t1.id ? 'T1' : 'T2');
        maxObservedActive = Math.max(
          maxObservedActive,
          countActiveRunsForPipeline(db, pipeline.id),
        );
      }
    });
    const launcher = createRunLauncher(deps(db, {}, bus));
    launcher.recoverQueued();
    await launcher.whenIdle();
    await flushMicrotasks(); // the bus-hook drain of the LAST settle is microtask-deferred
    await launcher.whenIdle();

    // Never-served ties broke by oldestQueuedAt → T1 first (10 < 40). After T1
    // is served once it is the MOST-recently-admitted, so never-served T2 goes
    // next — NOT T1's remaining older rows (that would be the monopoly). Then
    // T1 drains FIFO (20, 30).
    expect(startedTriggers).toEqual(['T1', 'T2', 'T1', 'T1']);
    expect(listRuns(db).filter((r) => r.status === 'queued')).toHaveLength(0);
    // The pipeline cap was honoured THROUGHOUT the drain, not just at the end.
    expect(maxObservedActive).toBe(1);
  });

  it('a trigger at its OWN cap is skipped by the drain without stalling other triggers', async () => {
    const { db, sqlite } = freshDb();
    const { mkVersion } = seedCappedPipeline(db, 2);
    const pvSlow = mkVersion([node('slow')]);
    const pvFast = mkVersion([node('b')]);
    // T1 parallel(max=1): its hanging active run pins it AT its own cap while it
    // holds a queued row (enqueued via the pipeline gate earlier in its life).
    const t1 = seedTrigger(db, {
      pipelineVersionId: pvSlow,
      concurrency: { policy: 'parallel', max: 1 },
    });
    const t2 = seedTrigger(db, { pipelineVersionId: pvFast, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db, { nodes: { slow: { hang: true } } }));

    expect(launcher.fire(t1).outcome).toBe('started'); // hangs — T1 at its own cap
    seedQueuedRow(db, pvSlow, t1.id, 10); // T1's waiter (oldest)
    seedQueuedRow(db, pvFast, t2.id, 20); // T2's waiter
    // Pin T2's service record NEWER than T1's, so at-cap T1 sorts FIRST in the
    // LRA order and the drain must CONTINUE past it to reach T2 — a drain that
    // ABORTS on an at-cap candidate (instead of skipping it) fails this test.
    const t2Served = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvFast,
      triggerId: t2.id,
      parentRunId: null,
      params: {},
    });
    updateRun(db, t2Served.id, { status: 'success' });
    const t1Active = listRuns(db, { triggerId: t1.id })[0]!;
    sqlite
      .prepare('UPDATE runs SET started_at = ? WHERE id = ?')
      .run(t1Active.startedAt + 60_000, t2Served.id);

    launcher.recoverQueued(); // pipeline has room (1 active < cap 2)
    await launcher.whenIdle();

    // T1's waiter must NOT stall the drain: T1 is at its own cap, so the drain
    // skips it and admits T2's row.
    const t2Admitted = listRuns(db, { triggerId: t2.id }).filter((r) => r.id !== t2Served.id);
    expect(t2Admitted).toHaveLength(1);
    expect(t2Admitted[0]!.status).toBe('success');
    const t1Statuses = listRuns(db, { triggerId: t1.id })
      .map((r) => r.status)
      .sort();
    expect(t1Statuses).toEqual(['queued', 'running']); // waiter intact, occupier still hanging
  });

  it('bus hook: an out-of-launcher terminalization admits ANOTHER trigger’s queued waiter (pipeline-wide drain)', async () => {
    const { db } = freshDb();
    const bus = createRunEventBus();
    const { mkVersion } = seedCappedPipeline(db, 1);
    const pvId = mkVersion([node('a')]);
    const t1 = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const t2 = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db, {}, bus));

    // An out-of-launcher occupier on T1 holds the pipeline's one slot.
    const occupier = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: t1.id,
      parentRunId: null,
      params: {},
    });
    updateRun(db, occupier.id, { status: 'running' });
    expect(launcher.fire(t2).outcome).toBe('queued');

    appendEngineEvent(db, { type: 'run.finished', runId: occupier.id, outcome: 'success' }, bus);
    syncRunLifecycle(db, occupier.id, 'success');
    await flushMicrotasks();
    await launcher.whenIdle();

    expect(listRuns(db, { triggerId: t2.id })[0]!.status).toBe('success');
  });

  it('bus hook: a trigger-less CHILD run’s terminalization drains its PIPELINE’s queue', async () => {
    const { db } = freshDb();
    const bus = createRunEventBus();
    const { mkVersion } = seedCappedPipeline(db, 1);
    const pvId = mkVersion([node('a')]);
    const t1 = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const launcher = createRunLauncher(deps(db, {}, bus));

    // A (future call_pipeline) CHILD run of this pipeline occupies its slot even
    // with no trigger; its terminalization must free the slot for the queue.
    const parent = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: null,
      params: {},
    });
    updateRun(db, parent.id, { status: 'success' }); // parent itself frees no slot here
    const child = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: parent.id,
      params: {},
    });
    updateRun(db, child.id, { status: 'running' });
    expect(launcher.fire(t1).outcome).toBe('queued'); // pipeline full via the child

    appendEngineEvent(db, { type: 'run.finished', runId: child.id, outcome: 'success' }, bus);
    syncRunLifecycle(db, child.id, 'success');
    await flushMicrotasks();
    await launcher.whenIdle();

    expect(listRuns(db, { triggerId: t1.id })[0]!.status).toBe('success');
  });

  it('a trigger REBOUND across pipelines mid-queue: pipeline A\u2019s drain admits only A\u2019s row — the globally-older foreign row stays queued', async () => {
    const { db } = freshDb();
    const { mkVersion: mkA } = seedCappedPipeline(db, 1);
    const { mkVersion: mkB } = seedCappedPipeline(db, 1);
    const pvA = mkA([node('a')]);
    const pvB = mkB([node('a')]);
    // T is bound to A now, but holds a GLOBALLY-OLDER queued row frozen on B
    // (enqueued before a rebind) plus a newer row on A.
    const t = seedTrigger(db, { pipelineVersionId: pvA, concurrency: { policy: 'queue' } });
    seedQueuedRow(db, pvB, t.id, 10); // foreign-pipeline row, oldest
    seedQueuedRow(db, pvA, t.id, 20); // this pipeline's row
    // Pipeline B is FULL — its row must not be admitted under A's gate.
    const tB = seedTrigger(db, { pipelineVersionId: pvB, concurrency: { policy: 'queue' } });
    const bOccupier = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvB,
      triggerId: tB.id,
      parentRunId: null,
      params: {},
    });
    updateRun(db, bOccupier.id, { status: 'running' });

    const launcher = createRunLauncher(deps(db));
    launcher.recoverQueued(); // drains A (room) and B (full — no-op)
    await launcher.whenIdle();

    const tRuns = listRuns(db, { triggerId: t.id });
    // A's row was admitted and ran; B's row is UNTOUCHED (still queued) — it
    // never re-passed B's gate, so it must not have been driven.
    const aRun = tRuns.find((r) => r.pipelineVersionId === pvA)!;
    const bRun = tRuns.find((r) => r.pipelineVersionId === pvB)!;
    expect(aRun.status).toBe('success');
    expect(bRun.status).toBe('queued');
  });

  it('queue-depth bound applies to the pipeline-overflow enqueue paths too', async () => {
    const { db } = freshDb();
    const { mkVersion } = seedCappedPipeline(db, 1);
    const pvId = mkVersion([node('a')]);
    const t1 = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    const t2 = seedTrigger(db, {
      pipelineVersionId: pvId,
      concurrency: { policy: 'parallel', max: 3 },
    });
    const launcher = createRunLauncher({
      ...deps(db, { nodes: { a: { hang: true } } }),
      maxQueueDepth: 1,
    });

    expect(launcher.fire(t1).outcome).toBe('started'); // pipeline slot taken
    expect(launcher.fire(t2).outcome).toBe('queued'); // parallel → pipeline overflow queues
    const third = launcher.fire(t2);
    expect(third.outcome).toBe('skipped'); // bounded, never unbounded growth
    if (third.outcome === 'skipped') expect(third.reason).toContain('queue is full');
    await launcher.whenIdle();
  });
});
