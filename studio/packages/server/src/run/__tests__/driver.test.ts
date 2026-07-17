import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type Edge,
  type EdgeOn,
  type Engine,
  type EngineEvent,
  type Node,
  type NewPipelineVersion,
  type Param,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun } from '../../repo/runs.js';
import { runs } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { freshDb } from '../../repo/__tests__/helpers.js';
import {
  buildEngine,
  pump,
  startRun,
  terminalizeInterrupted,
  type DocResolver,
  type DriverDeps,
} from '../driver.js';
import { appendEngineEvent, loadEngineEvents } from '../events.js';
import { createRunEventBus } from '../event-bus.js';
import { listRunDiagnostics } from '../../repo/run-diagnostics.js';
import type { RunEvent } from '@autonomy-studio/shared';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';

type Db = ReturnType<typeof freshDb>['db'];

let seq = 0;
function node(id: string, extra: Partial<Node> = {}): Node {
  seq += 1;
  // An UNCATALOGUED type on purpose: these are run-mechanics fixtures driven by a
  // type-agnostic stub executor, so the activity type is irrelevant — and an
  // uncatalogued type keeps the node's output contract `absent` (F13b/#456 only
  // lowers a catalog default into KNOWN types), so the stub's ad-hoc outputs pass
  // through unfiltered exactly as they did before F13b. A catalogued placeholder
  // would now carry a `declared` contract and fail its `{}` payload.
  return { id, type: 'test_activity', config: {}, position: { x: seq, y: 0 }, ...extra };
}
function edge(from: string, to: string, on: EdgeOn = 'success'): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}
// #4 A1 — a real `if` control node (catalogued kind:control) + its branch arms.
function ifNode(id: string, condition: string): Node {
  return node(id, { type: 'if', config: { condition } });
}
function branchEdge(from: string, to: string, branch: string): Edge {
  return { id: `${from}->${to}:${branch}`, from, to, on: 'branch', branch };
}
// #4 A2 — a real `switch` control node (catalogued kind:control) + its case arms.
function switchNode(id: string, on: string, cases: string[]): Node {
  return node(id, { type: 'switch', config: { on, cases } });
}
// #4 A7 — a real `fail` control node (catalogued kind:control).
function failNode(id: string, message: string): Node {
  return node(id, { type: 'fail', config: { message } });
}

function seedVersion(db: Db, nodes: Node[], edges: Edge[] = [], params: Param[] = []): string {
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

function seedRun(db: Db, pvId: string) {
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId: pvId,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
}

function deps(db: Db, executorOpts: StubExecutorOptions = {}): DriverDeps {
  const resolveDoc: DocResolver = (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
  return { db, resolveDoc, executor: makeStubExecutor(executorOpts), alarms: stubAlarms() };
}

function types(events: EngineEvent[]): string[] {
  return events.map((e) => e.type);
}

describe('driver — startRun happy path', () => {
  it('drives a 2-node chain to success and persists the run + full event log', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('b')], [edge('a', 'b')]);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run);

    expect(state.status).toBe('success');
    expect(state.nodes.a!.status).toBe('success');
    expect(state.nodes.b!.status).toBe('success');

    const persisted = getRun(db, run.id)!;
    expect(persisted.status).toBe('success');
    expect(persisted.finishedAt).not.toBeNull();

    expect(types(loadEngineEvents(db, run.id))).toEqual([
      'run.started',
      'node.dispatched',
      'node.succeeded',
      'node.dispatched',
      'node.succeeded',
      'run.finished',
    ]);
  });

  it('the persisted log replays to the identical final state (event-sourcing invariant)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('a'), node('b'), node('c')],
      [edge('a', 'b'), edge('a', 'c')],
    );
    const run = seedRun(db, pvId);

    const driven = await startRun(deps(db), run);
    const engine = buildEngine(getPipelineVersion(db, pvId)!);
    const replayed = engine.projectRunState(loadEngineEvents(db, run.id));
    expect(replayed).toEqual(driven);
    expect(replayed.status).toBe('success');
  });
});

describe('driver — if control activity routes through the REAL pump (#4 A1)', () => {
  it('emits condition.evaluated (never dispatches the if), routes the taken arm, skips the other', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [ifNode('c', '${true}'), node('a'), node('b')],
      [branchEdge('c', 'a', 'true'), branchEdge('c', 'b', 'false')],
    );
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run);

    expect(state.status).toBe('success');
    expect(state.branches['c']).toBe('true');
    expect(state.nodes.c!.status).toBe('success');
    expect(state.nodes.a!.status).toBe('success');
    expect(state.nodes.b!.status).toBe('skipped');

    const log = loadEngineEvents(db, run.id);
    // The pump's driver-own `evaluateControl` branch appended a durable
    // `condition.evaluated` — the real driver.ts path, not just the shared harness.
    expect(types(log)).toContain('condition.evaluated');
    // The if is engine-evaluated: it must NEVER reach the executor as a dispatch.
    expect(log.some((e) => e.type === 'node.dispatched' && e.nodeId === 'c')).toBe(false);
  });

  it('the persisted if-run log replays to the identical state (event-sourcing invariant)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [ifNode('c', '${false}'), node('a'), node('b')],
      [branchEdge('c', 'a', 'true'), branchEdge('c', 'b', 'false')],
    );
    const run = seedRun(db, pvId);

    const driven = await startRun(deps(db), run);
    const engine = buildEngine(getPipelineVersion(db, pvId)!);
    const replayed = engine.projectRunState(loadEngineEvents(db, run.id));
    expect(replayed).toEqual(driven);
    expect(replayed.branches['c']).toBe('false');
    expect(replayed.nodes.b!.status).toBe('success');
    expect(replayed.nodes.a!.status).toBe('skipped');
  });
});

describe('driver — switch control activity routes through the REAL pump (#4 A2)', () => {
  it('emits switch.evaluated (never dispatches the switch), routes the matched case, skips the rest', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [switchNode('s', 'tier-${params.n}', ['tier-1', 'tier-2']), node('a'), node('b'), node('d')],
      [
        branchEdge('s', 'a', 'tier-1'),
        branchEdge('s', 'b', 'tier-2'),
        branchEdge('s', 'd', 'default'),
      ],
      [{ name: 'n', type: 'number', required: true }],
    );
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: null,
      params: { n: 1 },
    });

    const state = await startRun(deps(db), run);

    expect(state.status).toBe('success');
    expect(state.branches['s']).toBe('tier-1');
    expect(state.nodes.s!.status).toBe('success');
    expect(state.nodes.a!.status).toBe('success');
    expect(state.nodes.b!.status).toBe('skipped');
    expect(state.nodes.d!.status).toBe('skipped');

    const log = loadEngineEvents(db, run.id);
    // The pump's driver-own `evaluateControl` branch appended the durable event
    // NAMED BY the command (`switch.evaluated`, not `condition.evaluated`) — the
    // real driver.ts `command.event` path, not just the shared harness.
    expect(types(log)).toContain('switch.evaluated');
    expect(types(log)).not.toContain('condition.evaluated');
    // The switch is engine-evaluated: it must NEVER reach the executor as a dispatch.
    expect(log.some((e) => e.type === 'node.dispatched' && e.nodeId === 's')).toBe(false);
  });

  it('the persisted switch-run log replays to the identical state (event-sourcing invariant)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [switchNode('s', '${params.tier}', ['gold']), node('a'), node('d')],
      [branchEdge('s', 'a', 'gold'), branchEdge('s', 'd', 'default')],
      [{ name: 'tier', type: 'string', required: true }],
    );
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: null,
      params: { tier: 'bronze' },
    });

    const driven = await startRun(deps(db), run);
    const engine = buildEngine(getPipelineVersion(db, pvId)!);
    const replayed = engine.projectRunState(loadEngineEvents(db, run.id));
    expect(replayed).toEqual(driven);
    expect(replayed.branches['s']).toBe('default');
    expect(replayed.nodes.d!.status).toBe('success');
    expect(replayed.nodes.a!.status).toBe('skipped');
  });
});

describe('driver — fail control activity routes through the REAL pump (#4 A7)', () => {
  it('emits node.failed with the message, permanent kind, forced_fail code (never dispatches the fail)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [failNode('f', 'rejected: ${params.reason}')],
      [],
      [{ name: 'reason', type: 'string', required: true }],
    );
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: null,
      params: { reason: 'bad input' },
    });

    const state = await startRun(deps(db), run);

    expect(state.status).toBe('failure');
    expect(state.nodes.f!.status).toBe('failure');

    const log = loadEngineEvents(db, run.id);
    // The pump's driver-own `failNode` branch appended a durable `node.failed` —
    // the real driver.ts path, not just the shared harness.
    const failed = log.find((e) => e.type === 'node.failed' && e.nodeId === 'f') as
      Extract<EngineEvent, { type: 'node.failed' }> | undefined;
    expect(failed?.error).toBe('rejected: bad input');
    expect(failed?.kind).toBe('permanent');
    expect(failed?.code).toBe('forced_fail');
    // The fail is engine-evaluated: it must NEVER reach the executor as a dispatch.
    expect(log.some((e) => e.type === 'node.dispatched' && e.nodeId === 'f')).toBe(false);
  });

  it('the persisted fail-run log replays to the identical state (event-sourcing invariant)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [failNode('f', 'boom')]);
    const run = seedRun(db, pvId);

    const driven = await startRun(deps(db), run);
    const engine = buildEngine(getPipelineVersion(db, pvId)!);
    const replayed = engine.projectRunState(loadEngineEvents(db, run.id));
    expect(replayed).toEqual(driven);
    expect(replayed.status).toBe('failure');
    expect(replayed.nodes.f!.status).toBe('failure');
  });
});

describe('driver — filter control activity routes through the REAL pump (#4 A8)', () => {
  // #4 A8 — a real `filter` control node (catalogued kind:control).
  function filterNode(id: string, items: string, predicate: string): Node {
    return node(id, { type: 'filter', config: { items, predicate } });
  }

  it('emits node.succeeded with the filtered result output (never dispatches the filter)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [filterNode('flt', '${params.nums}', '${greater(item, 2)}')],
      [],
      [{ name: 'nums', type: 'json', required: true }],
    );
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: null,
      params: { nums: [1, 4, 2, 5] },
    });

    const state = await startRun(deps(db), run);

    expect(state.status).toBe('success');
    expect(state.nodes.flt!.status).toBe('success');
    // Order preserved: 4, 5 (the > 2 elements) in their input positions.
    expect(state.outputs.flt).toEqual({ result: [4, 5] });

    const log = loadEngineEvents(db, run.id);
    // The pump's driver-own `succeedControl` branch appended a durable
    // `node.succeeded` — the real driver.ts path, not just the shared harness.
    const succeeded = log.find((e) => e.type === 'node.succeeded' && e.nodeId === 'flt') as
      Extract<EngineEvent, { type: 'node.succeeded' }> | undefined;
    expect(succeeded?.outputs).toEqual({ result: [4, 5] });
    // The filter is engine-evaluated: it must NEVER reach the executor as a dispatch.
    expect(log.some((e) => e.type === 'node.dispatched' && e.nodeId === 'flt')).toBe(false);
  });

  it('the persisted filter-run log replays to the identical state (event-sourcing invariant)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [filterNode('flt', '${params.nums}', '${greater(item, 2)}')],
      [],
      [{ name: 'nums', type: 'json', required: true }],
    );
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: null,
      params: { nums: [3, 1] },
    });

    const driven = await startRun(deps(db), run);
    const engine = buildEngine(getPipelineVersion(db, pvId)!);
    const replayed = engine.projectRunState(loadEngineEvents(db, run.id));
    expect(replayed).toEqual(driven);
    expect(replayed.status).toBe('success');
    expect(replayed.outputs.flt).toEqual({ result: [3] });
  });
});

describe('driver — wait control activity routes through the REAL pump (#4 A5+A6)', () => {
  // #4 A6 — a real `wait` control node (catalogued kind:control).
  function waitNode(id: string, seconds: string): Node {
    return node(id, { type: 'wait', config: { seconds } });
  }

  it('arms the alarm and appends timer.waitScheduled, PARKING the node (never dispatches the wait)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [waitNode('w', '${5}')]);
    const run = seedRun(db, pvId);
    // Capture the stub so we can inspect the armed alarm (the stub returns a real
    // row but never fires it — so the node stays parked and the run stays running).
    const alarms = stubAlarms();
    const resolveDoc: DocResolver = (id) => getPipelineVersion(db, id)!;
    const d: DriverDeps = {
      db,
      resolveDoc,
      executor: makeStubExecutor(),
      alarms,
      now: () => 1_000,
    };

    const state = await startRun(d, run);

    // Parked, not finished — the alarm clock (absent here) owes the timer.due.
    expect(state.nodes.w!.status).toBe('wait_pending');
    expect(state.status).toBe('running');

    // The pump's driver-own `scheduleWait` branch armed a durable alarm...
    expect(alarms.armed).toHaveLength(1);
    expect(alarms.armed[0]).toMatchObject({
      kind: 'node_wait',
      ref: { runId: run.id, nodeId: 'w', attemptId: 'w#0' },
      dueAt: 1_000 + 5_000,
    });
    // ...THEN appended a durable `timer.waitScheduled` whose dueAt is read back from
    // the armed row (the real driver.ts path, not just the shared harness).
    const log = loadEngineEvents(db, run.id);
    const scheduled = log.find((e) => e.type === 'timer.waitScheduled' && e.nodeId === 'w') as
      Extract<EngineEvent, { type: 'timer.waitScheduled' }> | undefined;
    expect(scheduled?.attemptId).toBe('w#0');
    expect(scheduled?.dueAt).toBe(1_000 + 5_000);
    // The wait is engine-evaluated: it must NEVER reach the executor as a dispatch.
    expect(log.some((e) => e.type === 'node.dispatched' && e.nodeId === 'w')).toBe(false);
  });

  it('resolves a ${} seconds over run state, coercing to the numeric dueAt', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [waitNode('w', '${params.delay}')],
      [],
      [{ name: 'delay', type: 'number', required: true }],
    );
    const run = createRun(db, {
      ownerId: 'local',
      pipelineVersionId: pvId,
      triggerId: null,
      parentRunId: null,
      params: { delay: 12 },
    });
    const alarms = stubAlarms();
    const resolveDoc: DocResolver = (id) => getPipelineVersion(db, id)!;
    const d: DriverDeps = {
      db,
      resolveDoc,
      executor: makeStubExecutor(),
      alarms,
      now: () => 2_000,
    };

    await startRun(d, run);
    expect(alarms.armed[0]!.dueAt).toBe(2_000 + 12_000);
  });

  it('the persisted parked-wait log replays to the identical state (event-sourcing invariant)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [waitNode('w', '${5}')]);
    const run = seedRun(db, pvId);

    const driven = await startRun(deps(db), run);
    const engine = buildEngine(getPipelineVersion(db, pvId)!);
    const replayed = engine.projectRunState(loadEngineEvents(db, run.id));
    expect(replayed).toEqual(driven);
    expect(replayed.nodes.w!.status).toBe('wait_pending');
    expect(replayed.status).toBe('running');
  });
});

describe('driver — startRun trigger context (#5 S12)', () => {
  it('appends run.triggerContext BEFORE run.started and folds it into state', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { config: { at: '${trigger.scheduledTime}' } })]);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run, {
      triggerId: 'trg-1',
      scheduledTime: '2026-07-17T09:00:00.000Z',
      body: null,
    });

    expect(types(loadEngineEvents(db, run.id))[0]).toBe('run.triggerContext');
    expect(types(loadEngineEvents(db, run.id))[1]).toBe('run.started');
    expect(state.triggerContext).toEqual({
      triggerId: 'trg-1',
      scheduledTime: '2026-07-17T09:00:00.000Z',
      body: null,
    });
  });

  it('appends NO run.triggerContext when a run is started without a trigger', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db), run);

    expect(types(loadEngineEvents(db, run.id))[0]).toBe('run.started');
    expect(types(loadEngineEvents(db, run.id))).not.toContain('run.triggerContext');
    expect(state.triggerContext).toBeNull();
  });

  // G2 (plan review): a run whose ONLY durable event is run.triggerContext (the
  // run.started append faulted after it committed) must NOT be left a pending
  // zombie. The reducer terminalizes run.interrupted on a pending run, so the
  // ROW and a RE-PROJECTION of the log both reach `interrupted` — no divergence.
  it('terminalizes a lone-run.triggerContext run to interrupted, row == projection', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    const bus = createRunEventBus();
    appendEngineEvent(db, { type: 'run.triggerContext', runId: run.id, triggerId: 'trg-1' }, bus);

    terminalizeInterrupted({ ...deps(db), bus }, run.id);

    expect(getRun(db, run.id)?.status).toBe('interrupted');
    // The log stays authoritative — a run.interrupted fact was appended.
    const events = loadEngineEvents(db, run.id);
    expect(types(events)).toEqual(['run.triggerContext', 'run.interrupted']);
    // The event-sourcing invariant: the row equals what folding the log computes.
    const projected = buildEngine(getPipelineVersion(db, pvId)!).projectRunState(events);
    expect(projected.status).toBe('interrupted');
  });
});

describe('driver — failure routing', () => {
  it('an unhandled node failure fails the run (row + projection)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('b')], [edge('a', 'b')]);
    const run = seedRun(db, pvId);

    const state = await startRun(deps(db, { nodes: { a: { outcome: 'failure' } } }), run);

    expect(state.status).toBe('failure');
    expect(state.nodes.a!.status).toBe('failure');
    // b is never DISPATCHED (its only edge was a success edge from a failed
    // node) — it is `skipped`, the verdict F1b's drain lets it reach. Same
    // benign flip as the shared suite's implicit-chain pin: pre-F1b the eager
    // short-circuit froze it at `pending` mid-walk.
    expect(state.nodes.b!.status).toBe('skipped');
    expect(getRun(db, run.id)!.status).toBe('failure');
    const log = loadEngineEvents(db, run.id);
    expect(types(log)).toContain('node.failed');
    expect(types(log)).toContain('run.finished');
  });
});

describe('driver — call_pipeline via startChild', () => {
  it('drives a waiting call node to success on call.returned', async () => {
    const { db } = freshDb();
    const callNode = node('call', {
      type: 'call_pipeline',
      call: { pipelineVersionId: 'pv-child', params: {} },
    });
    const pvId = seedVersion(db, [callNode]);
    const run = seedRun(db, pvId);

    const d = deps(db, { child: { childOutcome: 'success', outputs: { r: 1 } } });
    const state = await startRun(d, run);

    expect(state.status).toBe('success');
    expect(state.nodes.call!.status).toBe('success');
    expect(types(loadEngineEvents(db, run.id))).toEqual([
      'run.started',
      'call.returned',
      'run.finished',
    ]);
  });
});

describe('driver — startRun guards', () => {
  it('refuses to start a run that already has an event log', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);

    await startRun(deps(db), run);
    await expect(startRun(deps(db), run)).rejects.toThrow(/already has an event log/);
  });

  it('marks the run running (not left pending) as soon as it starts', async () => {
    const { db } = freshDb();
    // A node that hangs after dispatch: the run comes to rest still `running`.
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    expect(getRun(db, run.id)!.status).toBe('pending');

    const state = await startRun(deps(db, { nodes: { a: { hang: true } } }), run);
    expect(state.status).toBe('running');
    expect(state.nodes.a!.status).toBe('dispatched');
    expect(getRun(db, run.id)!.status).toBe('running');
    expect(getRun(db, run.id)!.finishedAt).toBeNull();
  });
});

// ===========================================================================
// #6 E3 — `run.started.startedAt` is stamped from the run ROW
// ===========================================================================

describe('startRun — the startedAt fact', () => {
  // `runs.started_at` already owns "when did this run start". Stamping the event
  // from a FRESH clock instead would give one named fact two durable answers that
  // silently disagree — by minutes, once #5's scheduler admits queued runs.
  //
  // The row is BACKDATED here rather than started immediately, which is what
  // gives the test teeth: created-then-started-microseconds-later lands both
  // spellings in the same millisecond, so a fresh-clock regression would pass
  // unnoticed (confirmed by mutation). An hour-old row is the real queued-run
  // shape, and it separates them unambiguously.
  it('stamps the event from runs.started_at, not a fresh clock', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const created = seedRun(db, pvId);
    const admittedAt = created.startedAt - 3_600_000;
    db.update(runs).set({ startedAt: admittedAt }).where(eq(runs.id, created.id)).run();
    const run = getRun(db, created.id)!;
    expect(run.startedAt).toBe(admittedAt); // the row is genuinely backdated

    await startRun(deps(db), run);

    const started = loadEngineEvents(db, run.id).find((e) => e.type === 'run.started') as Extract<
      EngineEvent,
      { type: 'run.started' }
    >;
    expect(started.startedAt).toBe(new Date(admittedAt).toISOString());
  });

  // The whole point of logging it as a fact: the reducer reads no clock, so the
  // value a `${run.startedAt}` expression sees is fixed by the log alone.
  // The whole point of logging it as a FACT: the reducer reads no clock, so
  // replaying the log alone reproduces the value a `${run.startedAt}` expression
  // saw — no live clock can drift into it.
  it('replays from the log to the same value', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { config: { at: '${run.startedAt}' } })]);
    const created = seedRun(db, pvId);
    const admittedAt = created.startedAt - 3_600_000;
    db.update(runs).set({ startedAt: admittedAt }).where(eq(runs.id, created.id)).run();

    await startRun(deps(db), getRun(db, created.id)!);

    const engine = buildEngine(getPipelineVersion(db, pvId)!);
    const state = engine.projectRunState(loadEngineEvents(db, created.id));
    expect(state.startedAt).toBe(new Date(admittedAt).toISOString());
  });
});

describe('driver — reduce-first finishRun (#477)', () => {
  // The driver's OWN `finishRun` is REDUCED before it is appended: its verdict is
  // known without the log, so a `run.finished` the reducer would REJECT never
  // becomes durable. Before #477 `pump` appended `run.finished` and only THEN
  // folded it, so a rejected `run.finished{success}` sat durably in the log
  // followed by its `finishRun{failure,invalid_event}` replacement — and a crash
  // between the two left the rejected success as the sole terminal, which the
  // #443 log-authoritative reconciler resyncs as `success` where it should be
  // `failure`. Reducing first makes that impossible log unconstructible.
  it('never appends a run.finished the reducer rejects; folds the replacement instead', async () => {
    const { db } = freshDb();
    // Node still `ready` (never dispatched) ⇒ the run is NOT actually finished,
    // so `run.finished{success}` is impossible and the reducer rejects it.
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    const engine = buildEngine(getPipelineVersion(db, pvId)!);
    // A realistic partial log: started, node `a` ready, nothing terminal.
    appendEngineEvent(db, {
      type: 'run.started',
      runId: run.id,
      pipelineVersionId: pvId,
      startedAt: new Date(run.startedAt).toISOString(),
      params: {},
    });
    const state = engine.projectRunState(loadEngineEvents(db, run.id));
    expect(state.status).toBe('running');

    const bus = createRunEventBus();
    const published: RunEvent[] = [];
    bus.subscribe(run.id, (e) => published.push(e));

    const final = await pump({ ...deps(db), bus }, engine, state, [
      { type: 'finishRun', outcome: 'success' },
    ]);

    // The run terminalizes as FAILURE (the reducer's replacement), never success.
    expect(final.status).toBe('failure');
    expect(getRun(db, run.id)!.status).toBe('failure');

    // The impossible `run.finished{success}` is NOWHERE in the durable log.
    const finishes = loadEngineEvents(db, run.id).filter((e) => e.type === 'run.finished');
    expect(finishes).toHaveLength(1);
    const finish = finishes[0] as Extract<EngineEvent, { type: 'run.finished' }>;
    expect(finish.outcome).toBe('failure');
    expect(finish.reason).toBe('invalid_event');

    // The rejection diagnostic still reaches the durable sink (#497) — carried to
    // the replacement's seq rather than dropped, since no rejected event exists.
    const diags = listRunDiagnostics(db, run.id);
    expect(diags.some((d) => d.message.includes('impossible run.finished{success}'))).toBe(true);

    // A live watcher never sees a phantom `run.finished{success}` flicker.
    const publishedFinishes = published.filter((e) => e.type === 'run.finished');
    expect(publishedFinishes).toHaveLength(1);
    expect(
      (publishedFinishes[0]!.payload as Extract<EngineEvent, { type: 'run.finished' }>).outcome,
    ).toBe('failure');
  });

  // Reduce-first must not break the ordinary ACCEPTED terminal: a genuine
  // `finishRun{success}` still appends exactly one `run.finished{success}`,
  // syncs the row, and publishes once.
  it('appends an accepted run.finished{success} exactly once and publishes it', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);

    const bus = createRunEventBus();
    const published: RunEvent[] = [];
    bus.subscribe(run.id, (e) => published.push(e));

    const state = await startRun({ ...deps(db), bus }, run);

    expect(state.status).toBe('success');
    expect(getRun(db, run.id)!.status).toBe('success');
    const finishes = loadEngineEvents(db, run.id).filter((e) => e.type === 'run.finished');
    expect(finishes).toHaveLength(1);
    expect((finishes[0] as Extract<EngineEvent, { type: 'run.finished' }>).outcome).toBe('success');
    const publishedFinishes = published.filter((e) => e.type === 'run.finished');
    expect(publishedFinishes).toHaveLength(1);
    expect(
      (publishedFinishes[0]!.payload as Extract<EngineEvent, { type: 'run.finished' }>).outcome,
    ).toBe('success');
  });

  // A `running` state to feed a wrapped engine whose `reduce` never accepts.
  function runningState(db: Db) {
    const pvId = seedVersion(db, [node('a')]);
    const run = seedRun(db, pvId);
    const engine = buildEngine(getPipelineVersion(db, pvId)!);
    appendEngineEvent(db, {
      type: 'run.started',
      runId: run.id,
      pipelineVersionId: pvId,
      startedAt: new Date(run.startedAt).toISOString(),
      params: {},
    });
    const state = engine.projectRunState(loadEngineEvents(db, run.id));
    expect(state.status).toBe('running');
    return { engine, state, runId: run.id };
  }

  // The reduce-first loop's termination is STRUCTURAL, not a matter of trusting
  // the reducer's "failure is always accepted" contract: a reducer that keeps
  // rejecting the driver's own finish (always offering a fresh replacement) hits
  // the fold cap and THROWS (→ the caller's `terminalizeInterrupted`) rather than
  // spinning forever under the per-run lock.
  it('throws instead of spinning when the reducer never converges to an accepted finish', async () => {
    const { db } = freshDb();
    const { engine, state } = runningState(db);
    const neverAccepts: Engine = {
      ...engine,
      // Always non-terminal, always a fresh finishRun replacement → never accepts.
      reduce: (s) => ({
        state: s,
        commands: [{ type: 'finishRun', outcome: 'failure', reason: 'invalid_event' }],
        diagnostics: ['forced non-convergence'],
      }),
    };
    await expect(
      pump(deps(db), neverAccepts, state, [{ type: 'finishRun', outcome: 'success' }]),
    ).rejects.toThrow(/did not converge/);
  });

  // The other backstop: a reducer that rejects with NO replacement finishRun (so
  // there is nothing to fold in the rejected event's place) throws rather than
  // building a `run.finished` from an undefined command.
  it('throws when the reducer rejects with no replacement finishRun', async () => {
    const { db } = freshDb();
    const { engine, state } = runningState(db);
    const noReplacement: Engine = {
      ...engine,
      reduce: (s) => ({ state: s, commands: [], diagnostics: ['rejected, no replacement'] }),
    };
    await expect(
      pump(deps(db), noReplacement, state, [{ type: 'finishRun', outcome: 'success' }]),
    ).rejects.toThrow(/no replacement finishRun/);
  });
});
