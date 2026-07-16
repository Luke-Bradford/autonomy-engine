import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type Concurrency,
  type Edge,
  type EdgeOn,
  type EngineEvent,
  type NewPipelineVersion,
  type Node,
  type Trigger,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createTrigger } from '../../repo/triggers.js';
import { getRun, listRuns } from '../../repo/runs.js';
import { loadEngineEvents } from '../events.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { type DocResolver, type DriveDeps, type Executor } from '../driver.js';
import { createRunDrives } from '../drives.js';
import { createRunLauncher, UnboundTriggerError } from '../launcher.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';

type Db = ReturnType<typeof freshDb>['db'];

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

function seedVersion(db: Db, nodes: Node[] = [node('a')], edges: Edge[] = []): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes,
    edges,
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input).id;
}

function seedTrigger(
  db: Db,
  opts: { pipelineVersionId: string | null; concurrency?: Concurrency; enabled?: boolean },
): Trigger {
  return createTrigger(db, {
    ownerId: 'local',
    name: 'T',
    pipelineVersionId: opts.pipelineVersionId,
    params: {},
    mode: 'manual',
    schedule: null,
    webhook: null,
    concurrency: opts.concurrency ?? { policy: 'skip_if_running' },
    runWindows: null,
    enabled: opts.enabled ?? false,
  });
}

function deps(db: Db, executorOpts: StubExecutorOptions = {}): DriveDeps {
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
    expect(events[0]?.type).toBe('run.started');
    expect(events.at(-1)?.type).toBe('run.finished');
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

describe('RunLauncher — queue drains even when a run rests non-terminal', () => {
  it('advances the queue when the previous drive ends at a non-terminal rest (crash sim)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db);
    const trigger = seedTrigger(db, { pipelineVersionId: pvId, concurrency: { policy: 'queue' } });
    // `hang` comes to rest at `running` (node dispatched, no terminal) — the DB
    // active-count stays 1, so a DB-gated drain would stall the queue forever.
    // The in-memory in-flight count still hits 0 on promise-settle, so the drain
    // must launch the queued fire regardless.
    const launcher = createRunLauncher(deps(db, { nodes: { a: { hang: true } } }));

    expect(launcher.fire(trigger).outcome).toBe('started');
    expect(launcher.fire(trigger).outcome).toBe('queued');

    await launcher.whenIdle();

    // Both fires produced a run (the queued one drained despite the first
    // resting non-terminal) — proving the queue did not stall.
    expect(listRuns(db, { triggerId: trigger.id })).toHaveLength(2);
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
    expect(events[0]?.type).toBe('run.started');
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
