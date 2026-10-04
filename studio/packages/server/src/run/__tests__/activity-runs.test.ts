import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type Container,
  type Edge,
  type EngineEvent,
  type NewPipelineVersion,
  type Node,
} from '@autonomy-studio/shared';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun } from '../../repo/runs.js';
import type { Db } from '../../repo/types.js';
import { STUB_SAVE_CATALOG } from '../../__tests__/stub-catalog.js';
import { projectActivityRuns } from '../activity-runs.js';
import {
  buildEngine,
  driveRun,
  makeDocResolver,
  startRun,
  type DriveDeps,
  type Executor,
} from '../driver.js';
import { createRunDrives } from '../drives.js';
import { appendEngineEvent, loadEngineLog } from '../events.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';

/**
 * #1484 OR35 M2/M3 — the activity-runs read model, read off logs the REAL driver
 * wrote through the stub executor, so every row is the engine's own account of
 * a run rather than a hand-built event list.
 */

let seq = 0;
function node(id: string, extra: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'test_activity', config: {}, position: { x: seq, y: 0 }, ...extra };
}
function edge(from: string, to: string): Edge {
  return { id: `${from}->${to}`, from, to, on: 'success' };
}
function branchEdge(from: string, to: string, branch: string): Edge {
  return { id: `${from}->${to}:${branch}`, from, to, on: 'branch', branch };
}

function seedVersion(
  db: Db,
  nodes: Node[],
  edges: Edge[] = [],
  containers: Container[] = [],
  list?: unknown[],
) {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params:
      list === undefined ? [] : [{ name: 'list', type: 'json', required: false, default: list }],
    outputs: [],
    nodes,
    edges,
    containers,
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input, { catalog: STUB_SAVE_CATALOG }).id;
}

function deps(db: Db, executor: Executor): DriveDeps {
  return {
    db,
    resolveDoc: makeDocResolver(db),
    executor,
    alarms: stubAlarms(),
    drives: createRunDrives(),
  };
}

async function drive(db: Db, pvId: string, executor: Executor) {
  const run = createRun(db, {
    ownerId: 'local',
    pipelineVersionId: pvId,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
  await startRun(deps(db, executor), run);
  return run.id;
}

function project(db: Db, pvId: string, runId: string) {
  const doc = makeDocResolver(db)(pvId);
  return projectActivityRuns(doc, buildEngine(doc), loadEngineLog(db, runId));
}

const stub = (nodes: StubExecutorOptions['nodes'] = {}) => makeStubExecutor({ nodes });

describe('#1484 activity runs — one row per attempt', () => {
  it('times each attempt, names a failure, and adds the downstream skip as a row', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('a'), node('b'), node('c')],
      [edge('a', 'b'), edge('b', 'c')],
    );
    const runId = await drive(db, pvId, stub({ b: { outcome: 'failure', error: 'boom' } }));

    const rows = project(db, pvId, runId);
    expect(rows.map((r) => [r.activityId, r.status, r.attempt])).toEqual([
      ['a', 'success', 1],
      ['b', 'failure', 1],
      ['c', 'skipped', null],
    ]);
    const [a, b, c] = rows;
    expect(a!.attemptId).toBe('a#0');
    expect(typeof a!.startedAt).toBe('number');
    expect(a!.finishedAt).toBeGreaterThanOrEqual(a!.startedAt!);
    expect(a!.durationMs).toBe(a!.finishedAt! - a!.startedAt!);
    expect(b!.error).toEqual({
      message: 'boom',
      kind: 'permanent',
      code: null,
      connectionId: null,
    });
    // A skip never ran: no attempt, no times.
    expect(c).toMatchObject({ attemptId: null, startedAt: null, finishedAt: null, error: null });
  });

  it('records the branch an If took, and the branch it did not take as a skip', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('c', { type: 'if', config: { condition: '${equals(1, 1)}' } }), node('t'), node('f')],
      [branchEdge('c', 't', 'true'), branchEdge('c', 'f', 'false')],
    );
    const runId = await drive(db, pvId, stub());

    const rows = project(db, pvId, runId);
    // The If never gets a `node.dispatched`; it is a row all the same.
    expect(rows.find((r) => r.activityId === 'c')).toMatchObject({
      status: 'success',
      branch: 'true',
    });
    expect(rows.find((r) => r.activityId === 't')?.status).toBe('success');
    expect(rows.find((r) => r.activityId === 'f')?.status).toBe('skipped');
  });

  it("reads rows and bytes off the attempt's own success, and drops a figure that is not a count", async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('copy')]);
    const runId = await drive(
      db,
      pvId,
      stub({
        copy: {
          outputs: { rowsRead: 5, rowsWritten: 4, bytesRead: 1024, bytesWritten: -1 },
        },
      }),
    );

    expect(project(db, pvId, runId)[0]).toMatchObject({
      rowsRead: 5,
      rowsWritten: 4,
      bytesRead: 1024,
      bytesWritten: null,
    });
  });

  it('gives each item of a sequential ForEach its own row, with its index and item', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('inner')],
      [],
      [{ id: 'fe', kind: 'foreach', children: ['inner'], items: '${params.list}' }],
      [10, { name: 'b.csv' }],
    );
    const runId = await drive(db, pvId, stub());

    const rows = project(db, pvId, runId);
    expect(rows.map((r) => [r.activityId, r.status, r.attempt, r.iteration])).toEqual([
      ['inner', 'success', 1, { containerId: 'fe', index: 0, count: 2, item: '10' }],
      ['inner', 'success', 1, { containerId: 'fe', index: 1, count: 2, item: 'b.csv' }],
    ]);
  });

  it('gives each item of a parallel ForEach its own row, keyed by its instance', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('w')],
      [],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${params.list}', batchCount: 2 }],
      [1, 2, 3],
    );
    const runId = await drive(db, pvId, stub());

    const rows = project(db, pvId, runId);
    expect(rows.map((r) => [r.nodeId, r.activityId, r.status, r.iteration?.index]).sort()).toEqual([
      ['w@0', 'w', 'success', 0],
      ['w@1', 'w', 'success', 1],
      ['w@2', 'w', 'success', 2],
    ]);
  });

  it('numbers a policy retry as attempt 2, and keeps the failed attempt as its own row', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { policy: { retry: 1, retryIntervalSeconds: 30 } })]);
    const inner = stub();
    // The first attempt fails transiently; every later one succeeds.
    const flaky: Executor = {
      async *perform(command, runId) {
        if (command.type === 'dispatchNode' && command.attemptId === 'a#0') {
          yield { type: 'node.dispatched', runId, nodeId: 'a', attemptId: 'a#0', idempotent: true };
          yield {
            type: 'node.failed',
            runId,
            nodeId: 'a',
            attemptId: 'a#0',
            error: 'busy',
            kind: 'transient',
          };
          return;
        }
        yield* inner.perform(command, runId);
      },
    };
    const runId = await drive(db, pvId, flaky);
    // What the retry alarm does when it fires (`scheduler/retry-alarm.ts`).
    appendEngineEvent(db, { type: 'node.retryDue', runId, nodeId: 'a', previousAttemptId: 'a#0' });
    await driveRun(deps(db, flaky), runId);

    const rows = project(db, pvId, runId);
    expect(rows.map((r) => [r.attemptId, r.status, r.attempt, r.error?.kind])).toEqual([
      ['a#0', 'failure', 1, 'transient'],
      ['a#1', 'success', 2, undefined],
    ]);
  });

  it('leaves an attempt with no result open: no end, no duration', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const runId = await drive(db, pvId, stub({ a: { hang: true } }));

    expect(project(db, pvId, runId)).toEqual([
      expect.objectContaining({ status: 'dispatched', finishedAt: null, durationMs: null }),
    ]);
  });

  it('claims no failure kind the log did not state', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const runId = await drive(db, pvId, stub({ a: { outcome: 'failure', error: 'old' } }));
    const doc = makeDocResolver(db)(pvId);
    // An old row, written before `kind` existed: the parse defaults it.
    const log = loadEngineLog(db, runId).map((l) => {
      if (l.event.type !== 'node.failed') return l;
      const payload = { ...(l.payload as Record<string, unknown>) };
      delete payload.kind;
      return { ...l, payload };
    });

    const [row] = projectActivityRuns(doc, buildEngine(doc), log);
    expect(row?.error).toEqual({ message: 'old', kind: null, code: null, connectionId: null });
  });

  it('settles an If that ends each ForEach item, and keeps the skip inside every item', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('c', { type: 'if', config: { condition: '${equals(1, 2)}' } }), node('t')],
      [branchEdge('c', 't', 'true')],
      [{ id: 'fe', kind: 'foreach', children: ['c', 't'], items: '${params.list}' }],
      ['x', 'y'],
    );
    const runId = await drive(db, pvId, stub());

    // The If's result and the skip both happen in the reduce that resets the
    // body for the next item; neither may be lost for the first item.
    expect(
      project(db, pvId, runId).map((r) => [r.activityId, r.status, r.branch, r.iteration?.item]),
    ).toEqual([
      ['c', 'success', 'false', 'x'],
      ['t', 'skipped', null, 'x'],
      ['c', 'success', 'false', 'y'],
      ['t', 'skipped', null, 'y'],
    ]);
  });

  it('keeps the skip inside every item of a parallel ForEach', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('c', { type: 'if', config: { condition: '${equals(1, 2)}' } }), node('t')],
      [branchEdge('c', 't', 'true')],
      [{ id: 'fe', kind: 'foreach', children: ['c', 't'], items: '${params.list}', batchCount: 2 }],
      ['x', 'y'],
    );
    const runId = await drive(db, pvId, stub());

    const rows = project(db, pvId, runId);
    expect(rows.map((r) => [r.nodeId, r.status, r.iteration?.index]).sort()).toEqual([
      ['c@0', 'success', 0],
      ['c@1', 'success', 1],
      ['t@0', 'skipped', 0],
      ['t@1', 'skipped', 1],
    ]);
  });

  it('ends a Wait at its timer, not at the moment it was scheduled', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('hold', { type: 'wait', config: { seconds: '${1}' } })]);
    const executor = stub();
    const runId = await drive(db, pvId, executor);
    const [scheduled] = project(db, pvId, runId);
    expect(scheduled).toMatchObject({ status: 'wait_pending', finishedAt: null });

    await new Promise((resolve) => setTimeout(resolve, 5));
    appendEngineEvent(db, {
      type: 'timer.due',
      runId,
      nodeId: 'hold',
      previousAttemptId: 'hold#0',
    });
    await driveRun(deps(db, executor), runId);

    const [row] = project(db, pvId, runId);
    expect(row).toMatchObject({ status: 'success', startedAt: scheduled!.startedAt });
    expect(row!.finishedAt).toBeGreaterThan(row!.startedAt!);
  });

  it('settles an attempt a loop timeout abandoned as that row, not as a second one', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('a')],
      [],
      [
        {
          id: 'lp',
          kind: 'loop',
          children: ['a'],
          exitWhen: "${equals(nodes.a.status, 'success')}",
          maxRounds: 3,
          timeout: 60,
        },
      ],
    );
    const executor = stub({ a: { hang: true } });
    const runId = await drive(db, pvId, executor);
    appendEngineEvent(db, { type: 'container.timedOut', runId, containerId: 'lp' });
    await driveRun(deps(db, executor), runId);

    expect(project(db, pvId, runId).map((r) => [r.attemptId, r.status])).toEqual([
      ['a#0', 'skipped'],
    ]);
  });

  it('shows what a rerun reused, and the refusal of a called pipeline as its error', () => {
    const doc = {
      nodes: [
        node('a'),
        node('call', {
          type: 'call_pipeline',
          call: { pipelineVersionId: 'pv-child', params: {} },
        }),
      ],
      edges: [edge('a', 'call')],
      containers: [],
      variables: [],
    } as never as Parameters<typeof buildEngine>[0];
    const at = (ts: number, event: EngineEvent) => ({ ts, event, payload: event });
    const started: EngineEvent = {
      type: 'run.started',
      runId: 'R2',
      pipelineVersionId: 'pv',
      params: {},
      rerunOf: 'R1',
    };
    const reseeded: EngineEvent = {
      type: 'run.reseeded',
      runId: 'R2',
      sourceRunId: 'R1',
      frontier: ['a'],
      copiedOutputs: { a: {} },
      copiedContainers: {},
    };
    // The child id the engine expects is its own: take it from the command.
    const engine = buildEngine(doc);
    const spawn = engine
      .reduce(engine.reduce(engine.seedState(), started).state, reseeded)
      .commands.find((c) => c.type === 'startChild');
    if (spawn?.type !== 'startChild') throw new Error('no startChild');
    const kid = spawn.childRunId;
    const log = [
      at(1, started),
      at(2, reseeded),
      at(3, {
        type: 'call.started',
        runId: 'R2',
        callNodeId: 'call',
        attemptId: spawn.attemptId,
        childRunId: kid,
      }),
      at(9, {
        type: 'call.returned',
        runId: 'R2',
        callNodeId: 'call',
        attemptId: spawn.attemptId,
        childRunId: kid,
        childOutcome: 'failure',
        outputs: {},
        reason: 'the called version is archived',
      }),
    ];

    expect(projectActivityRuns(doc, buildEngine(doc), log)).toEqual([
      expect.objectContaining({
        key: 'reused:a',
        reused: true,
        status: 'success',
        startedAt: null,
      }),
      expect.objectContaining({
        attemptId: spawn.attemptId,
        status: 'failure',
        childRunId: kid,
        startedAt: 3,
        finishedAt: 9,
        durationMs: 6,
        error: {
          message: 'the called version is archived',
          kind: null,
          code: null,
          connectionId: null,
        },
      }),
    ]);
  });
});
