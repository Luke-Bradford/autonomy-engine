import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type Container,
  type Edge,
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
    params: list === undefined ? [] : [{ name: 'list', type: 'json', required: false, default: list }],
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
    const pvId = seedVersion(db, [node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);
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
    expect(b!.error).toEqual({ message: 'boom', kind: 'permanent', connectionId: null });
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
    expect(
      rows.map((r) => [r.nodeId, r.activityId, r.status, r.iteration?.index]).sort(),
    ).toEqual([
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
      const { kind: _dropped, ...payload } = l.payload as Record<string, unknown>;
      return { ...l, payload };
    });

    const [row] = projectActivityRuns(doc, buildEngine(doc), log);
    expect(row?.error).toEqual({ message: 'old', kind: null, connectionId: null });
  });
});
