import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type Concurrency,
  type Edge,
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
import { type DocResolver, type DriverDeps, type Executor } from '../driver.js';
import { createRunLauncher, UnboundTriggerError } from '../launcher.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';

type Db = ReturnType<typeof freshDb>['db'];

let seq = 0;
function node(id: string, extra: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: seq, y: 0 }, ...extra };
}
function edge(from: string, to: string, on: Edge['on'] = 'success'): Edge {
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

function deps(db: Db, executorOpts: StubExecutorOptions = {}): DriverDeps {
  const resolveDoc: DocResolver = (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
  return { db, resolveDoc, executor: makeStubExecutor(executorOpts) };
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
    const launcher = createRunLauncher({ db, resolveDoc, executor: makeStubExecutor() });

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
    const launcher = createRunLauncher({ db, resolveDoc, executor: throwingExecutor });

    const result = launcher.fire(trigger);
    await launcher.whenIdle();

    const run = getRun(db, result.runId!);
    expect(run?.status).toBe('interrupted');
    const events = loadEngineEvents(db, result.runId!);
    expect(events[0]?.type).toBe('run.started');
    // The row's status is reachable by folding the durable log, not out-of-band.
    expect(events.some((e) => e.type === 'run.interrupted')).toBe(true);
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
