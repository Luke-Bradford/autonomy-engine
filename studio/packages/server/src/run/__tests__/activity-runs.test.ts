import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  INACTIVE_USER_PROPERTY_UNRESOLVED,
  type Container,
  type Edge,
  type EngineEvent,
  type NewPipelineVersion,
  type Node,
  SECURE_REDACTED,
} from '@autonomy-studio/shared';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun } from '../../repo/runs.js';
import type { Db } from '../../repo/types.js';
import { STUB_SAVE_CATALOG } from '../../__tests__/stub-catalog.js';
import {
  INACTIVE_FAILED_MESSAGE,
  projectActivityRuns,
  projectActivityRunsFromLog,
  copiedUserPropertiesOf,
} from '../activity-runs.js';
import {
  buildEngine,
  driveRun,
  makeDocResolver,
  startRun,
  type DriveDeps,
  type Executor,
} from '../driver.js';
import { createRunDrives } from '../drives.js';
import { appendEngineEvent, loadEngineLog, type LoggedEngineEvent } from '../events.js';
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
    // #1673 — a Webhook parks on a token; any stable string stands in here.
    signExternalWaitToken: ({ runId, nodeId, attemptId }) => `${runId}:${nodeId}:${attemptId}`,
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

  it('#1600 C0c — an INACTIVE activity is a row marked inactive, settled on its Mark as, and never reaches the executor', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('a', { state: 'inactive', onInactiveMarkAs: 'skipped' }), node('b'), node('c')],
      [edge('a', 'b'), { id: 'a->c:skipped', from: 'a', to: 'c', on: 'skipped' }],
    );
    // Were `a` dispatched, the stub would fail it, and the run would show it.
    const runId = await drive(db, pvId, stub({ a: { outcome: 'failure', error: 'ran' } }));

    const rows = project(db, pvId, runId);
    expect(rows.map((r) => [r.activityId, r.status, r.inactive])).toEqual([
      ['a', 'skipped', true],
      ['b', 'skipped', false],
      ['c', 'success', false],
    ]);
    const a = rows[0]!;
    // Nothing ran: no error, and no measured span.
    expect(a).toMatchObject({ attemptId: 'a#0', error: null, durationMs: null });
    expect(
      loadEngineLog(db, runId).some(
        ({ event: e }) => e.type === 'node.dispatched' && e.nodeId === 'a',
      ),
    ).toBe(false);
  });

  it('#1600 C0d — each attempt row carries the user properties its dispatch resolved', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [
      node('a', {
        policy: { retry: 1, retryIntervalSeconds: 30 },
        userProperties: [
          { name: 'Run', value: '${run.runId}' },
          { name: 'Bad', value: "${int('abc')}" },
        ],
      }),
      node('b'),
    ]);
    // Every attempt fails transiently, so the retry is a second dispatch.
    const flaky = stub({ a: { outcome: 'failure', error: 'flaky', kind: 'transient' } });
    const runId = await drive(db, pvId, flaky);
    appendEngineEvent(db, { type: 'node.retryDue', runId, nodeId: 'a', previousAttemptId: 'a#0' });
    await driveRun(deps(db, flaky), runId);
    const rows = project(db, pvId, runId);
    const aRows = rows.filter((r) => r.activityId === 'a');
    expect(aRows.length).toBe(2);
    for (const r of aRows) {
      expect(r.userProperties?.[0]).toEqual({ name: 'Run', value: runId });
      expect(r.userProperties?.[1]).toMatchObject({ name: 'Bad', error: expect.any(String) });
    }
    expect(rows.find((r) => r.activityId === 'b')?.userProperties).toBeNull();
  });

  it('#1673 — an attempt refused before dispatch carries the user properties its dispatch resolved', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [
      node('a', { userProperties: [{ name: 'Run', value: '${run.runId}' }] }),
    ]);
    const runId = await drive(db, pvId, stub({ a: { preflightError: 'no connection' } }));
    expect(loadEngineLog(db, runId).some(({ event: e }) => e.type === 'node.dispatched')).toBe(
      false,
    );
    const [a] = project(db, pvId, runId);
    expect(a).toMatchObject({ status: 'failure', attemptId: 'a#0' });
    expect(a?.userProperties).toEqual([{ name: 'Run', value: runId }]);
  });

  it('#1673 — an activity the engine evaluates, and a pipeline call, carry them from their own event', async () => {
    const { db } = freshDb();
    const props = (name: string) => ({ userProperties: [{ name, value: '${run.runId}' }] });
    const pvId = seedVersion(
      db,
      [
        node('c', { type: 'if', config: { condition: '${equals(1, 1)}' }, ...props('If') }),
        node('t', { type: 'fail', config: { message: 'stop' }, ...props('Fail') }),
        node('w', { type: 'wait', config: { seconds: '${60}' }, ...props('Wait') }),
        node('p', {
          type: 'execute_pipeline',
          config: {},
          call: { pipelineVersionId: 'pv-child', params: {} },
          ...props('Call'),
        }),
      ],
      [branchEdge('c', 't', 'true')],
    );
    const runId = await drive(db, pvId, stub());
    const log = loadEngineLog(db, runId).map((l) => l.event);
    expect(log.some((e) => e.type === 'node.dispatched')).toBe(false);
    const want = (name: string) => [{ name, value: runId }];
    const byId = (rows: { activityId: string; userProperties: unknown }[], id: string) =>
      rows.find((r) => r.activityId === id)?.userProperties;
    const rows = project(db, pvId, runId);
    const logRows = projectActivityRunsFromLog(loadEngineLog(db, runId)).rows;
    for (const [id, name] of [
      ['c', 'If'],
      ['t', 'Fail'],
      ['w', 'Wait'],
      ['p', 'Call'],
    ] as const) {
      expect(byId(rows, id), id).toEqual(want(name));
      expect(byId(logRows, id), `${id} (log basis)`).toEqual(want(name));
    }
  });

  it('#1673 — an inactive activity carries its literal ones from its placeholder run', async () => {
    const { db } = freshDb();
    const props = [
      { name: 'Kind', value: 'nightly' },
      { name: 'Run', value: '${run.runId}' },
    ];
    const pvId = seedVersion(db, [
      node('a', { state: 'inactive', userProperties: props }),
      node('b', { state: 'inactive', onInactiveMarkAs: 'failure', userProperties: props }),
    ]);
    const runId = await drive(db, pvId, stub());
    const want = [
      { name: 'Kind', value: 'nightly' },
      { name: 'Run', error: INACTIVE_USER_PROPERTY_UNRESOLVED },
    ];
    const inactive = loadEngineLog(db, runId).filter(({ event: e }) => e.type === 'node.inactive');
    expect(inactive).toHaveLength(2);
    for (const rows of [
      project(db, pvId, runId),
      projectActivityRunsFromLog(loadEngineLog(db, runId)).rows,
    ]) {
      expect(rows.map((r) => [r.activityId, r.status, r.inactive, r.userProperties])).toEqual([
        ['a', 'success', true, want],
        ['b', 'failure', true, want],
      ]);
    }
  });

  it('#1673 — a Switch, a Filter, a call that started and a Webhook carry them too', async () => {
    const { db } = freshDb();
    const props = (name: string) => ({ userProperties: [{ name, value: '${run.runId}' }] });
    const pvId = seedVersion(db, [
      node('s', { type: 'switch', config: { on: 'x', cases: ['x'] }, ...props('Switch') }),
      node('f', {
        type: 'filter',
        config: { items: '${createArray(1)}', predicate: '${true}' },
        ...props('Filter'),
      }),
      node('p', {
        type: 'execute_pipeline',
        config: {},
        call: { pipelineVersionId: 'pv-child', params: {} },
        ...props('Call'),
      }),
    ]);
    // A child that is announced (`call.started`) before it returns.
    const base = stub();
    const announcing: Executor = {
      ...base,
      async *perform(command, runId) {
        if (command.type === 'startChild') {
          yield {
            type: 'call.started',
            runId,
            callNodeId: command.callNodeId,
            attemptId: command.attemptId,
            childRunId: command.childRunId,
          };
        }
        yield* base.perform(command, runId);
      },
    };
    const runId = await drive(db, pvId, announcing);
    const log = loadEngineLog(db, runId).map((l) => l.event);
    const want = (name: string) => [{ name, value: runId }];
    // The call's record is its `call.started`; its `call.returned` repeats nothing.
    const callEvents = log.filter((e) => e.type === 'call.started' || e.type === 'call.returned');
    expect(callEvents.map((e) => [e.type, 'userProperties' in e && e.userProperties])).toEqual([
      ['call.started', want('Call')],
      ['call.returned', false],
    ]);
    const rows = project(db, pvId, runId);
    for (const [id, name] of [
      ['s', 'Switch'],
      ['f', 'Filter'],
      ['p', 'Call'],
    ] as const) {
      expect(rows.find((r) => r.activityId === id)?.userProperties, id).toEqual(want(name));
    }
    // A Webhook parks the run on its own, so it gets a run of its own.
    const hookPv = seedVersion(db, [
      node('h', { type: 'webhook', config: { timeoutSeconds: '${600}' }, ...props('Webhook') }),
    ]);
    const hookRun = await drive(db, hookPv, stub());
    expect(project(db, hookPv, hookRun)[0]?.userProperties).toEqual([
      { name: 'Webhook', value: hookRun },
    ]);
  });

  it('#1673 — withholds them on a secure Wait in the log itself', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [
      node('w', {
        type: 'wait',
        config: { seconds: '${60}' },
        policy: { secureInput: true },
        userProperties: [{ name: 'Run', value: '${run.runId}' }],
      }),
    ]);
    const runId = await drive(db, pvId, stub());
    const parked = loadEngineLog(db, runId).find((l) => l.event.type === 'timer.waitScheduled');
    expect(parked?.event.type === 'timer.waitScheduled' && parked.event.userProperties).toEqual([
      { name: 'Run', value: SECURE_REDACTED },
    ]);
  });

  it('#1673 — keeps the first record: a later event that records a re-resolution replaces nothing', () => {
    const at = { runId: 'r1', callNodeId: 'p', attemptId: 'p#0', childRunId: 'c1' };
    const log: LoggedEngineEvent[] = [
      {
        ts: 1,
        payload: null,
        event: { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv', params: {} },
      },
      {
        ts: 2,
        payload: null,
        event: { type: 'call.started', ...at, userProperties: [{ name: 'V', value: 'first' }] },
      },
      {
        ts: 3,
        payload: null,
        event: {
          type: 'call.returned',
          ...at,
          childOutcome: 'success',
          outputs: {},
          userProperties: [{ name: 'V', value: 'after a restart' }],
        },
      },
    ];
    const [row] = projectActivityRunsFromLog(log).rows;
    expect(row?.userProperties).toEqual([{ name: 'V', value: 'first' }]);
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

  it('gives a row the event that started it also settled no duration: nothing timed it (#867)', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('c', { type: 'if', config: { condition: '${equals(1, 1)}' } }), node('t')],
      [branchEdge('c', 't', 'true')],
    );
    const runId = await drive(db, pvId, stub());

    const rows = project(db, pvId, runId);
    const c = rows.find((r) => r.activityId === 'c')!;
    // When it happened is known; how long it took was never measured, so it
    // is not reported, rather than reported as 0.
    expect(c.startedAt).not.toBeNull();
    expect(c.finishedAt).toBe(c.startedAt);
    expect(c.durationMs).toBeNull();
    const t = rows.find((r) => r.activityId === 't')!;
    expect(t.durationMs).toBe(t.finishedAt! - t.startedAt!);
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

  it('#1600 C0c — an inactive activity marked Failed fails the run, and its row says why', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a', { state: 'inactive', onInactiveMarkAs: 'failure' })]);
    const runId = await drive(db, pvId, stub());
    const [a] = project(db, pvId, runId);
    expect(a).toMatchObject({ status: 'failure', inactive: true });
    expect(a!.error).toEqual({
      message: INACTIVE_FAILED_MESSAGE,
      kind: null,
      code: null,
      connectionId: null,
    });
  });

  it('#1600 C0c — an inactive body node ending each ForEach item gets one inactive row per item', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('first'), node('last', { state: 'inactive', onInactiveMarkAs: 'skipped' })],
      [edge('first', 'last')],
      [{ id: 'fe', kind: 'foreach', children: ['first', 'last'], items: '${params.list}' }],
      [1, 2],
    );
    const runId = await drive(db, pvId, stub());

    const rows = project(db, pvId, runId).filter((r) => r.activityId === 'last');
    expect(rows.map((r) => [r.status, r.inactive, r.iteration?.index])).toEqual([
      ['skipped', true, 0],
      ['skipped', true, 1],
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

  it('#1600 C8d — keeps a Wait until and its re-checks as ONE row, from the first check to the last', () => {
    const doc = {
      nodes: [node('g')],
      edges: [],
      containers: [],
      variables: [],
    } as never as Parameters<typeof buildEngine>[0];
    const at = (ts: number, event: EngineEvent) => ({ ts, event, payload: event });
    const runId = 'R';
    const notReady = (attemptId: string) =>
      ({
        type: 'node.notReady',
        runId,
        nodeId: 'g',
        attemptId,
        reason: "'/in/a.csv' does not exist yet",
        recheckAfterSeconds: 10,
        giveUpAfterSeconds: 60,
      }) satisfies EngineEvent;
    const log = [
      at(1, {
        type: 'run.started',
        runId,
        pipelineVersionId: 'pv',
        params: {},
      } satisfies EngineEvent),
      at(2, {
        type: 'node.dispatched',
        runId,
        nodeId: 'g',
        attemptId: 'g#0',
        idempotent: true,
      } satisfies EngineEvent),
      at(3, notReady('g#0')),
      at(3, {
        type: 'node.recheckScheduled',
        runId,
        nodeId: 'g',
        attemptId: 'g#0',
        nextCheckAt: 13,
        giveUpAt: 63,
      } satisfies EngineEvent),
    ];
    const engine = buildEngine(doc);
    expect(projectActivityRuns(doc, engine, log).rows).toEqual([
      expect.objectContaining({
        attemptId: 'g#0',
        status: 'wait_pending',
        startedAt: 2,
        finishedAt: null,
      }),
    ]);
    log.push(
      at(13, {
        type: 'node.recheckDue',
        runId,
        nodeId: 'g',
        previousAttemptId: 'g#0',
      } satisfies EngineEvent),
      at(14, {
        type: 'node.dispatched',
        runId,
        nodeId: 'g',
        attemptId: 'g#1',
        idempotent: true,
      } satisfies EngineEvent),
      at(15, {
        type: 'node.succeeded',
        runId,
        nodeId: 'g',
        attemptId: 'g#1',
        outputs: {},
      } satisfies EngineEvent),
    );
    const rows = projectActivityRuns(doc, engine, log).rows;
    // The log-only projection (no doc) collapses them the same way.
    expect(projectActivityRunsFromLog(log).rows).toEqual([
      expect.objectContaining({
        attemptId: 'g#1',
        status: 'success',
        startedAt: 2,
        finishedAt: 15,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attemptId: 'g#1',
      attempt: 1,
      status: 'success',
      startedAt: 2,
      finishedAt: 15,
    });
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

  it('#1669 — a reused row is inactive when the rerun copied an inactive activity', () => {
    const doc = {
      nodes: [node('a', { state: 'inactive' }), node('b')],
      edges: [edge('a', 'b')],
      containers: [],
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
      } satisfies EngineEvent),
      at(2, {
        type: 'run.reseeded',
        runId: 'R2',
        sourceRunId: 'R1',
        frontier: ['a'],
        copiedOutputs: { a: {} },
        copiedContainers: {},
        copiedInactive: ['a'],
      } satisfies EngineEvent),
    ];
    const rows = projectActivityRuns(doc, buildEngine(doc), log).rows;
    expect(rows[0]).toMatchObject({
      key: 'reused:a',
      reused: true,
      inactive: true,
      status: 'success',
    });
  });

  it('#1673 — a reused row shows the user properties the reseed copied', () => {
    const doc = {
      nodes: [node('a'), node('b')],
      edges: [edge('a', 'b')],
      containers: [],
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
      } satisfies EngineEvent),
      at(2, {
        type: 'run.reseeded',
        runId: 'R2',
        sourceRunId: 'R1',
        frontier: ['a', 'b'],
        copiedOutputs: { a: {}, b: {} },
        copiedContainers: {},
        copiedUserProperties: { b: [{ name: 'Run', value: 'R1' }] },
      } satisfies EngineEvent),
    ];
    const rows = projectActivityRuns(doc, buildEngine(doc), log).rows;
    expect(rows.map((r) => [r.key, r.userProperties])).toEqual([
      ['reused:a', null],
      ['reused:b', [{ name: 'Run', value: 'R1' }]],
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

  it('#1600 C0e — an INACTIVE container is a group marked inactive, never started, with no rows of its own', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('inner'), node('after')],
      [{ id: 'fe->after:failure', from: 'fe', to: 'after', on: 'failure' }],
      [foreach({ state: 'inactive', onInactiveMarkAs: 'failure' })],
      [1, 2],
    );
    // Were `inner` dispatched, the stub would fail it, and the run would show it.
    const runId = await drive(db, pvId, stub({ inner: { outcome: 'failure', error: 'ran' } }));

    const { rows, groups } = projectAll(db, pvId, runId);
    expect(rows.map((r) => [r.activityId, r.status])).toEqual([['after', 'success']]);
    expect(groups).toEqual([
      expect.objectContaining({
        containerId: 'fe',
        status: 'failure',
        reason: 'inactive',
        inactive: true,
        reused: false,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        itemCount: null,
        iterations: [],
      }),
    ]);
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

  it('keeps a Wait that ends its parallel item a success, not an abandoned skip', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('hold', { type: 'wait', config: { seconds: '${1}' } })],
      [],
      [foreach({ children: ['hold'], batchCount: 2 })],
      [1],
    );
    const executor = stub();
    const runId = await drive(db, pvId, executor);
    const [parked] = project(db, pvId, runId);
    expect(parked).toMatchObject({ nodeId: 'hold@0', status: 'wait_pending' });
    // The timer settles the Wait, which ends the item and deletes its instance
    // in the same reduce: the result event decides, not the deletion (#1548).
    appendEngineEvent(db, {
      type: 'timer.due',
      runId,
      nodeId: 'hold@0',
      previousAttemptId: parked!.attemptId!,
    });
    await driveRun(deps(db, executor), runId);

    const rows = project(db, pvId, runId);
    expect(rows.map((r) => [r.nodeId, r.status, r.skipReason])).toEqual([
      ['hold@0', 'success', null],
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

    const doomed = { kind: 'doomed', containerId: 'fe', blame: 'x@0' };
    const rows = project(db, pvId, runId);
    expect(rows.find((r) => r.nodeId === 'y@1')).toMatchObject({
      status: 'skipped',
      skipReason: doomed,
    });
    // #1548 — the Wait the doom abandoned is that row, settled, not left waiting
    // on a finished run, and the item it was in has ended.
    const hold = rows.filter((r) => r.nodeId === 'hold@1');
    expect(hold).toHaveLength(1);
    expect(hold[0]).toMatchObject({ status: 'skipped', skipReason: doomed });
    expect(hold[0]!.finishedAt).not.toBeNull();
    const [g] = groupsOf(db, pvId, runId);
    expect(g!.iterations.find((i) => i.index === 1)?.finishedAt).not.toBeNull();
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

  it('adds no skipped rows for a loop or ForEach a rerun copied past its first round (#1549)', () => {
    const doc = {
      nodes: [node('a'), node('f'), node('b')],
      edges: [edge('lp', 'fe'), edge('fe', 'b')],
      containers: [
        { id: 'lp', kind: 'loop', children: ['a'], exitWhen: '${equals(1, 2)}', maxRounds: 5 },
        { id: 'fe', kind: 'foreach', children: ['f'], items: '${createArray(1, 2)}' },
      ],
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
        frontier: ['a', 'f'],
        copiedOutputs: { a: {}, f: {} },
        copiedContainers: {
          lp: { status: 'success', round: 2, outputs: {} },
          fe: { status: 'success', round: 1, items: [1, 2], results: [{}, {}], outputs: {} },
        },
      }),
    ];

    const { rows } = projectActivityRuns(doc, buildEngine(doc), log);
    expect(rows.filter((r) => r.status === 'skipped')).toEqual([]);
    expect(rows.map((r) => r.key)).toEqual(['reused:a', 'reused:f']);
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

describe('#1557 activity runs from the log alone — the version no longer resolves', () => {
  const fromLog = (db: Db, runId: string) => projectActivityRunsFromLog(loadEngineLog(db, runId));
  /** The fields the log alone can say. */
  const logged = (r: ReturnType<typeof project>[number]) => ({
    key: r.key,
    nodeId: r.nodeId,
    attemptId: r.attemptId,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    branch: r.branch,
    rowsRead: r.rowsRead,
    rowsWritten: r.rowsWritten,
    bytesRead: r.bytesRead,
    bytesWritten: r.bytesWritten,
    childRunId: r.childRunId,
    error: r.error,
  });

  it('#1600 C0d — carries the user properties each dispatch recorded', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [
      node('a', { userProperties: [{ name: 'Run', value: '${run.runId}' }] }),
    ]);
    const runId = await drive(db, pvId, stub());
    expect(fromLog(db, runId).rows.map((r) => r.userProperties)).toEqual([
      [{ name: 'Run', value: runId }],
    ]);
  });

  it('#1673 — carries them from a failure before dispatch too', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [
      node('a', { userProperties: [{ name: 'Run', value: '${run.runId}' }] }),
    ]);
    const runId = await drive(db, pvId, stub({ a: { preflightError: 'no connection' } }));
    expect(fromLog(db, runId).rows.map((r) => r.userProperties)).toEqual([
      [{ name: 'Run', value: runId }],
    ]);
  });

  it("gives every attempt the full account's times, status, branch, counts and error", async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [
        node('c', { type: 'if', config: { condition: '${equals(1, 1)}' } }),
        node('t'),
        node('f'),
        node('boom'),
        node('after'),
      ],
      [
        branchEdge('c', 't', 'true'),
        branchEdge('c', 'f', 'false'),
        edge('t', 'boom'),
        edge('boom', 'after'),
      ],
    );
    const runId = await drive(
      db,
      pvId,
      stub({
        t: { outputs: { rowsRead: 5, rowsWritten: 4, bytesRead: 1024, bytesWritten: -1 } },
        boom: { outcome: 'failure', error: 'boom' },
      }),
    );

    const full = project(db, pvId, runId).filter((r) => r.attemptId !== null);
    expect(full.map((r) => r.activityId)).toEqual(['c', 't', 'boom']);
    const { rows, groups } = fromLog(db, runId);
    // No skip rows (`f`, `after`): no event records a skip.
    expect(rows.map(logged)).toEqual(full.map(logged));
    expect(rows.every((r) => r.attempt === null && r.iteration === null)).toBe(true);
    expect(rows.every((r) => r.activityId === r.nodeId && r.containerId === null)).toBe(true);
    expect(groups).toEqual([]);
  });

  it('lets no late duplicate result rewrite a settled row', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const runId = await drive(db, pvId, stub({ a: { outcome: 'failure', error: 'boom' } }));
    appendEngineEvent(db, {
      type: 'node.failed',
      runId,
      nodeId: 'a',
      attemptId: 'a#0',
      error: 'late',
      kind: 'transient',
    });
    appendEngineEvent(db, {
      type: 'node.succeeded',
      runId,
      nodeId: 'a',
      attemptId: 'a#0',
      outputs: { rowsRead: 9 },
    });

    expect(fromLog(db, runId).rows).toEqual([
      expect.objectContaining({
        status: 'failure',
        rowsRead: null,
        error: expect.objectContaining({ message: 'boom', kind: 'permanent' }),
      }),
    ]);
  });

  const at = (ts: number, event: EngineEvent) => ({ ts, event, payload: event });
  const started: EngineEvent = {
    type: 'run.started',
    runId: 'R',
    pipelineVersionId: 'pv',
    params: {},
  };
  const dispatched: EngineEvent = {
    type: 'node.dispatched',
    runId: 'R',
    nodeId: 'w@1',
    attemptId: 'w@1#0',
    idempotent: true,
  };

  it('reads an attempt still open when the run finished as abandoned: skipped, with no end', () => {
    const { rows } = projectActivityRunsFromLog([
      at(1, started),
      at(2, dispatched),
      at(5, { type: 'run.finished', runId: 'R', outcome: 'failure' }),
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        nodeId: 'w@1',
        // The instance key cannot be told from a literal doc id without the doc.
        activityId: 'w@1',
        status: 'skipped',
        startedAt: 2,
        finishedAt: null,
        durationMs: null,
      }),
    ]);
  });

  it('leaves an open attempt as it was on a cancelled run, and while the run is live', () => {
    const cancelled = projectActivityRunsFromLog([
      at(1, started),
      at(2, dispatched),
      at(5, { type: 'run.finished', runId: 'R', outcome: 'cancelled' }),
    ]);
    expect(cancelled.rows[0]).toMatchObject({ status: 'dispatched', finishedAt: null });
    const live = projectActivityRunsFromLog([at(1, started), at(2, dispatched)]);
    expect(live.rows[0]).toMatchObject({ status: 'dispatched', finishedAt: null });
  });

  it('settles a Wait at its timer and an attempt an operator retried with the reason given', () => {
    const { rows } = projectActivityRunsFromLog([
      at(1, started),
      at(2, {
        type: 'timer.waitScheduled',
        runId: 'R',
        nodeId: 'hold',
        attemptId: 'hold#0',
        dueAt: 7,
      }),
      at(7, { type: 'timer.due', runId: 'R', nodeId: 'hold', previousAttemptId: 'hold#0' }),
      at(8, { ...dispatched, nodeId: 'x', attemptId: 'x#0' }),
      at(12, {
        type: 'node.retryRequested',
        runId: 'R',
        nodeId: 'x',
        previousAttemptId: 'x#0',
        reason: 'stuck',
      }),
      at(13, { ...dispatched, nodeId: 'x', attemptId: 'x#1' }),
    ]);
    expect(
      rows.map((r) => [r.attemptId, r.status, r.durationMs, r.error?.message ?? null]),
    ).toEqual([
      ['hold#0', 'success', 5, null],
      ['x#0', 'failure', 4, 'stuck'],
      ['x#1', 'dispatched', null, null],
    ]);
  });

  it('#1669 — a reused row is inactive when the reseed copied it as inactive', () => {
    const { rows } = projectActivityRunsFromLog([
      at(1, { ...started, rerunOf: 'R0' }),
      at(2, {
        type: 'run.reseeded',
        runId: 'R',
        sourceRunId: 'R0',
        frontier: ['a', 'b'],
        copiedOutputs: { a: {}, b: {} },
        copiedContainers: {},
        copiedInactive: ['b'],
      }),
    ]);
    expect(rows.map((r) => [r.key, r.reused, r.inactive])).toEqual([
      ['reused:a', true, false],
      ['reused:b', true, true],
    ]);
  });

  it('#1673 — a reused row shows the user properties the reseed copied', () => {
    const { rows } = projectActivityRunsFromLog([
      at(1, { ...started, rerunOf: 'R0' }),
      at(2, {
        type: 'run.reseeded',
        runId: 'R',
        sourceRunId: 'R0',
        frontier: ['a', 'b'],
        copiedOutputs: { a: {}, b: {} },
        copiedContainers: {},
        copiedUserProperties: { a: [{ name: 'Run', value: 'R0' }] },
      }),
    ]);
    expect(rows.map((r) => [r.key, r.userProperties])).toEqual([
      ['reused:a', [{ name: 'Run', value: 'R0' }]],
      ['reused:b', null],
    ]);
  });

  it("leads with a rerun's reused frontier, and gives a refused call its reason", () => {
    const { rows } = projectActivityRunsFromLog([
      at(1, { ...started, rerunOf: 'R0' }),
      at(2, {
        type: 'run.reseeded',
        runId: 'R',
        sourceRunId: 'R0',
        frontier: ['a'],
        copiedOutputs: { a: {} },
        copiedContainers: {},
      }),
      at(3, {
        type: 'call.started',
        runId: 'R',
        callNodeId: 'call',
        attemptId: 'call#0',
        childRunId: 'kid',
      }),
      at(9, {
        type: 'call.returned',
        runId: 'R',
        callNodeId: 'call',
        attemptId: 'call#0',
        childRunId: 'kid',
        childOutcome: 'failure',
        outputs: {},
        reason: 'the called version is archived',
      }),
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        key: 'reused:a',
        reused: true,
        status: 'success',
        startedAt: null,
      }),
      expect.objectContaining({
        attemptId: 'call#0',
        status: 'failure',
        childRunId: 'kid',
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

describe('#1600 OR41 C7d — a Lookup’s count fills the Rows read column', () => {
  /** Project with some doc nodes RETYPED: the stub save catalog has no `lookup`,
   * and the column reads the doc node's type, never the executor's. */
  function projectTyped(db: Db, pvId: string, runId: string, types: Record<string, string>) {
    const doc = makeDocResolver(db)(pvId);
    const typed = {
      ...doc,
      nodes: doc.nodes.map((n) => (types[n.id] === undefined ? n : { ...n, type: types[n.id]! })),
    };
    return projectActivityRuns(typed, buildEngine(doc), loadEngineLog(db, runId)).rows;
  }

  it('reads `count`, or `rowCount` on a contract saved before C7a, and only for a Lookup', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('lk'), node('old'), node('other')]);
    const runId = await drive(
      db,
      pvId,
      stub({
        lk: { outputs: { rows: [], count: 7, rowCount: 7 } },
        old: { outputs: { rows: [], rowCount: 3 } },
        other: { outputs: { count: 9 } },
      }),
    );
    const rows = projectTyped(db, pvId, runId, { lk: 'lookup', old: 'lookup' });
    const byId = Object.fromEntries(rows.map((r) => [r.nodeId, r.rowsRead]));
    // `count` means rows only for a type that says so; any other type's is not.
    expect(byId).toEqual({ lk: 7, old: 3, other: null });
  });

  it('fills each instance of a parallel ForEach over a Lookup', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('w')],
      [],
      [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${params.list}', batchCount: 2 }],
      [1, 2],
    );
    // The stub plans by the dispatched (instance) id.
    const runId = await drive(
      db,
      pvId,
      stub({ 'w@0': { outputs: { count: 4 } }, 'w@1': { outputs: { count: 6 } } }),
    );
    const rows = projectTyped(db, pvId, runId, { w: 'lookup' });
    expect(rows.map((r) => [r.nodeId, r.rowsRead]).sort()).toEqual([
      ['w@0', 4],
      ['w@1', 6],
    ]);
  });

  it('stays blank from the log alone, which cannot say the activity is a Lookup', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('lk')]);
    const runId = await drive(db, pvId, stub({ lk: { outputs: { count: 7 } } }));
    expect(projectActivityRunsFromLog(loadEngineLog(db, runId)).rows[0]?.rowsRead).toBeNull();
  });
});

describe('#1673 — copiedUserPropertiesOf, the user properties a rerun copies', () => {
  const row = (nodeId: string, value: string | null) => ({
    nodeId,
    userProperties: value === null ? null : [{ name: 'p', value }],
  });
  it('takes each copied node’s last row, and leaves out a node with none or not copied', () => {
    const rows = [
      row('a', 'retry'),
      row('a', 'kept'),
      row('b', null),
      row('c', 'not copied'),
    ] as never as Parameters<typeof copiedUserPropertiesOf>[0];
    expect(copiedUserPropertiesOf(rows, ['a', 'b'])).toEqual({ a: [{ name: 'p', value: 'kept' }] });
  });
});
