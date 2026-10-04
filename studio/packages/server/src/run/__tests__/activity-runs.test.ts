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

function projectAll(db: Db, pvId: string, runId: string) {
  const doc = makeDocResolver(db)(pvId);
  return projectActivityRuns(doc, buildEngine(doc), loadEngineLog(db, runId));
}
const project = (db: Db, pvId: string, runId: string) => projectAll(db, pvId, runId).rows;
const groupsOf = (db: Db, pvId: string, runId: string) => projectAll(db, pvId, runId).groups;

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
    // …and says why, as the engine decided it.
    expect(c!.skipReason).toEqual({ kind: 'upstream', from: 'b', outcome: 'failure' });
    expect(a!.skipReason).toBeNull();
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
    expect(rows.find((r) => r.activityId === 'f')).toMatchObject({
      status: 'skipped',
      skipReason: { kind: 'branch', from: 'c', taken: 'true' },
    });
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

    const [row] = projectActivityRuns(doc, buildEngine(doc), log).rows;
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
    // #1546 — item x's skip is reset in the same reduce that ends the item, so
    // its reason comes from the reducer's `resetSkips`, not the state.
    expect(
      project(db, pvId, runId)
        .filter((r) => r.activityId === 't')
        .map((r) => r.skipReason),
    ).toEqual([
      { kind: 'branch', from: 'c', taken: 'false' },
      { kind: 'branch', from: 'c', taken: 'false' },
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
    // #1546 — each item's body is deleted in the reduce that skipped `t`.
    expect(rows.filter((r) => r.activityId === 't').map((r) => r.skipReason)).toEqual([
      { kind: 'branch', from: 'c', taken: 'false' },
      { kind: 'branch', from: 'c', taken: 'false' },
    ]);
  });

  it('says why a loop body handler was skipped in every round, not only the last', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('x'), node('h')],
      [{ id: 'x->h', from: 'x', to: 'h', on: 'failure' }],
      [{ id: 'lp', kind: 'loop', children: ['x', 'h'], exitWhen: '${equals(1, 2)}', maxRounds: 3 }],
    );
    const runId = await drive(db, pvId, stub());

    const skips = project(db, pvId, runId).filter((r) => r.activityId === 'h');
    expect(skips.map((r) => [r.status, r.iteration?.index, r.skipReason])).toEqual(
      [0, 1, 2].map((i) => ['skipped', i, { kind: 'upstream', from: 'x', outcome: 'success' }]),
    );
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

    expect(project(db, pvId, runId).map((r) => [r.attemptId, r.status, r.skipReason])).toEqual([
      ['a#0', 'skipped', { kind: 'timeout', containerId: 'lp' }],
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

    expect(projectActivityRuns(doc, buildEngine(doc), log).rows).toEqual([
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

  it('lets no late duplicate result rewrite a settled row', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const runId = await drive(db, pvId, stub({ a: { outcome: 'failure', error: 'boom' } }));
    // Redelivered after the run ended: the reducer ignores it, and so must this.
    appendEngineEvent(db, {
      type: 'node.failed',
      runId,
      nodeId: 'a',
      attemptId: 'a#0',
      error: 'late',
      kind: 'transient',
    });

    expect(project(db, pvId, runId)[0]?.error).toMatchObject({
      message: 'boom',
      kind: 'permanent',
    });
  });
});

describe('#1484 activity runs — containers are groups', () => {
  const foreach = (extra: Partial<Container> = {}): Container => ({
    id: 'fe',
    kind: 'foreach',
    children: ['inner'],
    items: '${params.list}',
    ...extra,
  });

  it('makes a ForEach a group with one iteration per item, and says which container each row is in', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('inner')], [], [foreach()], [10, { name: 'b.csv' }]);
    const runId = await drive(db, pvId, stub());

    const { rows, groups } = projectAll(db, pvId, runId);
    for (const r of rows) {
      expect(r.containerId).toBe('fe');
      expect(r.containerId).toBe(r.iteration?.containerId);
    }
    expect(groups).toEqual([
      expect.objectContaining({
        containerId: 'fe',
        kind: 'foreach',
        status: 'success',
        reason: null,
        reused: false,
        itemCount: 2,
        position: 0,
      }),
    ]);
    const [g] = groups;
    expect(g!.finishedAt).toBeGreaterThanOrEqual(g!.startedAt!);
    expect(g!.durationMs).toBe(g!.finishedAt! - g!.startedAt!);
    expect(g!.iterations.map((i) => [i.index, i.count, i.item, i.status])).toEqual([
      [0, 2, '10', 'success'],
      [1, 2, 'b.csv', 'success'],
    ]);
    const [first, second] = g!.iterations;
    expect(first!.startedAt).toBe(rows[0]!.startedAt);
    expect(first!.finishedAt).toBe(rows[0]!.finishedAt);
    expect(second!.startedAt).toBeGreaterThanOrEqual(first!.finishedAt!);
  });

  it('places a group where it started among the rows, and leaves a row outside any container ungrouped', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('a'), node('inner'), node('z')],
      [edge('a', 'fe'), edge('fe', 'z')],
      [foreach()],
      [1],
    );
    const runId = await drive(db, pvId, stub());

    const { rows, groups } = projectAll(db, pvId, runId);
    expect(rows.map((r) => [r.activityId, r.containerId])).toEqual([
      ['a', null],
      ['inner', 'fe'],
      ['z', null],
    ]);
    expect(groups.map((g) => [g.containerId, g.position])).toEqual([['fe', 1]]);
  });

  it('ends a ForEach with no items as it enters: a group with times and no iterations', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('inner')], [], [foreach()], []);
    const runId = await drive(db, pvId, stub());

    const [g] = groupsOf(db, pvId, runId);
    expect(g).toMatchObject({ status: 'success', itemCount: 0, iterations: [], durationMs: 0 });
    expect(g!.startedAt).not.toBeNull();
  });

  it('fails the item a body failure ended, and gives the group the engine’s reason', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('inner')], [], [foreach()], [1, 2]);
    const runId = await drive(db, pvId, stub({ inner: { outcome: 'failure' } }));

    const [g] = groupsOf(db, pvId, runId);
    expect(g).toMatchObject({ status: 'failure', itemCount: 2 });
    expect(g!.reason).toMatch(/^child_failed/);
    expect(g!.iterations.map((i) => [i.index, i.status])).toEqual([[0, 'failure']]);
  });

  it('reads an item whose failure the body handled as complete, though one of its rows failed', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('inner'), node('h')],
      [{ id: 'inner->h', from: 'inner', to: 'h', on: 'failure' }],
      [foreach({ children: ['inner', 'h'] })],
      [1, 2],
    );
    const runId = await drive(db, pvId, stub({ inner: { outcome: 'failure' } }));

    const { rows, groups } = projectAll(db, pvId, runId);
    expect(rows.filter((r) => r.status === 'failure')).toHaveLength(2);
    expect(groups[0]!.status).toBe('success');
    expect(groups[0]!.iterations.map((i) => i.status)).toEqual(['success', 'success']);
  });

  it('fails an item the doom cut short when its own attempt failed as it drained', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('x'), node('y')],
      [edge('x', 'y')],
      [foreach({ children: ['x', 'y'], batchCount: 2 })],
      [1, 2, 3],
    );
    const failing = { outcome: 'failure' as const };
    const runId = await drive(db, pvId, stub({ 'x@0': failing, 'x@1': failing }));

    const [g] = groupsOf(db, pvId, runId);
    expect(g!.iterations.map((i) => [i.index, i.status])).toEqual([
      [0, 'failure'],
      [1, 'failure'],
    ]);
  });

  it('makes a parallel ForEach doom fail the blamed item and skip the one it cut short', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('x'), node('y')],
      [edge('x', 'y')],
      [foreach({ children: ['x', 'y'], batchCount: 2 })],
      [1, 2, 3],
    );
    const runId = await drive(db, pvId, stub({ 'x@0': { outcome: 'failure' } }));

    const [g] = groupsOf(db, pvId, runId);
    expect(g).toMatchObject({ status: 'failure', reason: 'child_failed:x@0', itemCount: 3 });
    expect(g!.iterations.map((i) => [i.index, i.status])).toEqual([
      [0, 'failure'],
      [1, 'skipped'],
    ]);
    // Each skip says why: item 0's by its own failure, item 1's by the doom.
    expect(
      project(db, pvId, runId)
        .filter((r) => r.status === 'skipped')
        .map((r) => [r.nodeId, r.skipReason]),
    ).toEqual([
      ['y@0', { kind: 'upstream', from: 'x', outcome: 'failure' }],
      ['y@1', { kind: 'doomed', containerId: 'fe', blame: 'x@0' }],
    ]);
  });

  it('says why a doom skipped an item that it also ended in the same reduce', async () => {
    // Item 1 is parked on its Wait when item 0 fails: the doom flips item 1's
    // body to `skipped` and, nothing being in flight, deletes the item in that
    // same reduce, so the reason is read from `resetSkips` (#1546).
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('x'), node('hold', { type: 'wait', config: { seconds: '${1}' } }), node('y')],
      [edge('x', 'hold'), edge('hold', 'y')],
      [foreach({ children: ['x', 'hold', 'y'], batchCount: 2 })],
      [1, 2],
    );
    const runId = await drive(db, pvId, stub({ 'x@0': { outcome: 'failure', delayMs: 30 } }));

    const y1 = project(db, pvId, runId).find((r) => r.nodeId === 'y@1');
    expect(y1).toMatchObject({
      status: 'skipped',
      skipReason: { kind: 'doomed', containerId: 'fe', blame: 'x@0' },
    });
  });

  it('keeps an item that completed a success when another item failed the ForEach', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('inner')], [], [foreach({ batchCount: 2 })], [1, 2]);
    const runId = await drive(db, pvId, stub({ 'inner@1': { outcome: 'failure' } }));

    const [g] = groupsOf(db, pvId, runId);
    expect(g!.status).toBe('failure');
    expect(g!.iterations.map((i) => [i.index, i.status])).toEqual([
      [0, 'success'],
      [1, 'failure'],
    ]);
  });

  it('ends an item whose last row is a skip, which has no time of its own', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('c', { type: 'if', config: { condition: '${equals(1, 2)}' } }), node('t')],
      [branchEdge('c', 't', 'true')],
      [foreach({ children: ['c', 't'] })],
      ['x'],
    );
    const runId = await drive(db, pvId, stub());

    const [g] = groupsOf(db, pvId, runId);
    const [item] = g!.iterations;
    expect(item).toMatchObject({ status: 'success' });
    expect(item!.finishedAt).not.toBeNull();
  });

  it('marks every item of a clean parallel ForEach a success', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('inner')], [], [foreach({ batchCount: 2 })], [1, 2, 3]);
    const runId = await drive(db, pvId, stub());

    const [g] = groupsOf(db, pvId, runId);
    expect(g!.iterations.map((i) => [i.index, i.status])).toEqual([
      [0, 'success'],
      [1, 'success'],
      [2, 'success'],
    ]);
  });

  it('keeps a container live while its body is: no end, and the item running', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('inner')], [], [foreach()], [1]);
    const runId = await drive(db, pvId, stub({ inner: { hang: true } }));

    const [g] = groupsOf(db, pvId, runId);
    expect(g).toMatchObject({ status: 'active', finishedAt: null, durationMs: null });
    expect(g!.iterations).toEqual([
      expect.objectContaining({ index: 0, status: 'active', finishedAt: null }),
    ]);
  });

  it('gives a loop a timeout reason and fails the round the timeout cut short', async () => {
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

    const [g] = groupsOf(db, pvId, runId);
    expect(g).toMatchObject({
      kind: 'loop',
      status: 'failure',
      reason: 'timeout',
      itemCount: null,
    });
    expect(g!.iterations).toEqual([
      expect.objectContaining({ index: 0, count: null, status: 'failure' }),
    ]);
    // Its one row was skipped, yet the round has ended: it has an end time.
    expect(g!.iterations[0]!.finishedAt).not.toBeNull();
  });

  it('reads the rounds a capped loop finished as successes, and the last as its failure', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('a')],
      [],
      [{ id: 'lp', kind: 'loop', children: ['a'], exitWhen: '${equals(1, 2)}', maxRounds: 2 }],
    );
    const runId = await drive(db, pvId, stub());

    const [g] = groupsOf(db, pvId, runId);
    expect(g).toMatchObject({ status: 'failure', reason: 'capped' });
    expect(g!.iterations.map((i) => [i.index, i.status])).toEqual([
      [0, 'success'],
      [1, 'failure'],
    ]);
  });

  it('makes a Stage a group with no iterations', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('a'), node('b')],
      [edge('a', 'b')],
      [{ id: 'stg', kind: 'stage', children: ['a', 'b'] }],
    );
    const runId = await drive(db, pvId, stub());

    const { rows, groups } = projectAll(db, pvId, runId);
    expect(rows.map((r) => [r.activityId, r.containerId, r.iteration])).toEqual([
      ['a', 'stg', null],
      ['b', 'stg', null],
    ]);
    expect(groups).toEqual([
      expect.objectContaining({
        containerId: 'stg',
        kind: 'stage',
        status: 'success',
        iterations: [],
      }),
    ]);
  });

  it('makes a skipped container a group with no times, in its place', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('inner')], [edge('a', 'fe')], [foreach()], [1]);
    const runId = await drive(db, pvId, stub({ a: { outcome: 'failure' } }));

    const { rows, groups } = projectAll(db, pvId, runId);
    expect(rows.map((r) => r.activityId)).toEqual(['a']);
    expect(groups).toEqual([
      expect.objectContaining({
        containerId: 'fe',
        status: 'skipped',
        skipReason: { kind: 'upstream', from: 'a', outcome: 'failure' },
        startedAt: null,
        finishedAt: null,
        iterations: [],
        position: 1,
      }),
    ]);
  });

  it('makes no group of a container the run never reached', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('inner')], [edge('a', 'fe')], [foreach()], [1]);
    const runId = await drive(db, pvId, stub({ a: { hang: true } }));

    expect(groupsOf(db, pvId, runId)).toEqual([]);
  });

  it('shows a container a rerun copied as reused, with no times, leading the rows', () => {
    const doc = {
      nodes: [node('a'), node('b')],
      edges: [edge('stg', 'b')],
      containers: [{ id: 'stg', kind: 'stage', children: ['a'] }],
      variables: [],
    } as never as Parameters<typeof buildEngine>[0];
    const at = (ts: number, event: EngineEvent) => ({ ts, event, payload: event });
    const log = [
      at(1, {
        type: 'run.started',
        runId: 'R2',
        pipelineVersionId: 'pv',
        params: {},
        rerunOf: 'R1',
      }),
      at(2, {
        type: 'run.reseeded',
        runId: 'R2',
        sourceRunId: 'R1',
        frontier: ['a'],
        copiedOutputs: { a: {} },
        copiedContainers: { stg: { status: 'success', round: 0, outputs: {} } },
      }),
    ];

    const { rows, groups } = projectActivityRuns(doc, buildEngine(doc), log);
    expect(rows[0]).toMatchObject({ key: 'reused:a', containerId: 'stg', reused: true });
    expect(groups).toEqual([
      expect.objectContaining({
        containerId: 'stg',
        status: 'success',
        reused: true,
        startedAt: null,
        finishedAt: null,
        position: 0,
      }),
    ]);
  });

  it('places a group a rerun started after the rows it carried', () => {
    const doc = {
      nodes: [node('a'), node('b')],
      edges: [edge('a', 'stg')],
      containers: [{ id: 'stg', kind: 'stage', children: ['b'] }],
      variables: [],
    } as never as Parameters<typeof buildEngine>[0];
    const at = (ts: number, event: EngineEvent) => ({ ts, event, payload: event });
    const log = [
      at(1, {
        type: 'run.started',
        runId: 'R2',
        pipelineVersionId: 'pv',
        params: {},
        rerunOf: 'R1',
      }),
      at(2, {
        type: 'run.reseeded',
        runId: 'R2',
        sourceRunId: 'R1',
        frontier: ['a'],
        copiedOutputs: { a: {} },
        copiedContainers: {},
      }),
    ];

    const { rows, groups } = projectActivityRuns(doc, buildEngine(doc), log);
    expect(rows.map((r) => r.key)).toEqual(['reused:a']);
    expect(groups).toEqual([
      expect.objectContaining({ containerId: 'stg', reused: false, startedAt: 2, position: 1 }),
    ]);
  });
});
