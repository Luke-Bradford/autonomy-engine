import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type Edge,
  type EngineEvent,
  type NewPipelineVersion,
  type Node,
  type RunState,
} from '@autonomy-studio/shared';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, listRunSummariesPage } from '../../repo/runs.js';
import { appendRunEvent, listRunLogFacts } from '../../repo/run-events.js';
import type { Db } from '../../repo/types.js';
import { STUB_SAVE_CATALOG } from '../../__tests__/stub-catalog.js';
import { activityCountsFromState, makeRunActivityFold } from '../activity-counts.js';
import { makeDocResolver, startRun, type DocResolver } from '../driver.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';

/**
 * #1484 OR35 M1 — the runs list's Activities and Rows-written columns, read
 * back through `listRunSummariesPage` after a REAL drive, so the counts are the
 * engine's own fold of a log the driver wrote, not a hand-built one.
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

function seedVersion(db: Db, nodes: Node[], edges: Edge[] = []): string {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes,
    edges,
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input, { catalog: STUB_SAVE_CATALOG }).id;
}

function seedRun(db: Db, pipelineVersionId: string, ownerId = 'local') {
  return createRun(db, {
    ownerId,
    pipelineVersionId,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
}

async function drive(db: Db, pvId: string, nodes: StubExecutorOptions['nodes'] = {}) {
  const run = seedRun(db, pvId);
  await startRun(
    {
      db,
      resolveDoc: makeDocResolver(db),
      executor: makeStubExecutor({ nodes }),
      alarms: stubAlarms(),
    },
    run,
  );
  return run.id;
}

function summaryOf(db: Db, runId: string, fold = makeRunActivityFold(makeDocResolver(db))) {
  const row = listRunSummariesPage(db, { ownerId: 'local' }, { limit: 100 }, fold).items.find(
    (r) => r.id === runId,
  );
  if (row === undefined) throw new Error(`run ${runId} not listed`);
  return row;
}

describe('#1484 runs list — Activities', () => {
  it('counts a failure and the downstream node the failure skipped', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);
    const runId = await drive(db, pvId, { b: { outcome: 'failure', error: 'boom' } });

    expect(summaryOf(db, runId).activities).toEqual({
      succeeded: 1,
      failed: 1,
      skipped: 1,
      reused: 0,
      unfinished: 0,
    });
  });

  it('counts the branch an If did not take as skipped, and the If itself as an activity', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(
      db,
      [node('c', { type: 'if', config: { condition: '${equals(1, 1)}' } }), node('t'), node('f')],
      [branchEdge('c', 't', 'true'), branchEdge('c', 'f', 'false')],
    );
    const runId = await drive(db, pvId);

    expect(summaryOf(db, runId).activities).toEqual({
      succeeded: 2,
      failed: 0,
      skipped: 1,
      reused: 0,
      unfinished: 0,
    });
  });

  it('counts a node a run never reached as unfinished, not as a success', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('b')], [edge('a', 'b')]);
    // `hang` leaves `a` dispatched with no terminal, so `b` is still pending.
    const runId = await drive(db, pvId, { a: { hang: true } });

    expect(summaryOf(db, runId).activities).toEqual({
      succeeded: 0,
      failed: 0,
      skipped: 0,
      reused: 0,
      unfinished: 2,
    });
  });

  it('is null — never a zeroed count — for a run with no log, or no run.started', () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const empty = seedRun(db, pvId);
    const unstarted = seedRun(db, pvId);
    appendRunEvent(db, {
      runId: unstarted.id,
      type: 'run.triggerContext',
      payload: { type: 'run.triggerContext', runId: unstarted.id, triggerId: 't1' },
    });

    expect(summaryOf(db, empty.id).activities).toBeNull();
    expect(summaryOf(db, unstarted.id).activities).toBeNull();
  });

  it('is null for a run whose log does not parse, and the rest of the page still lists', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const good = await drive(db, pvId);
    const bad = seedRun(db, pvId);
    appendRunEvent(db, { runId: bad.id, type: 'run.started', payload: { type: 'run.started' } });

    expect(summaryOf(db, bad.id).activities).toBeNull();
    expect(summaryOf(db, good).activities?.succeeded).toBe(1);
  });

  it('folds a settled run once, and refolds it when its log grows', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const runId = await drive(db, pvId);
    const real = makeDocResolver(db);
    let resolved = 0;
    const counting: DocResolver = (id) => {
      resolved += 1;
      return real(id);
    };
    const fold = makeRunActivityFold(counting);

    summaryOf(db, runId, fold);
    summaryOf(db, runId, fold);
    expect(resolved).toBe(1);

    appendRunEvent(db, {
      runId,
      type: 'node.output',
      payload: { type: 'node.output', runId, nodeId: 'a', name: 'late', value: 1 },
    });
    summaryOf(db, runId, fold);
    expect(resolved).toBe(2);
  });
});

describe('#1484 runs list — Rows written', () => {
  it("sums every success's rowsWritten", async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);
    const runId = await drive(db, pvId, {
      a: { outputs: { rowsWritten: 66 } },
      b: { outputs: { rowsWritten: 6 } },
      c: { outputs: { rowsWritten: 20 } },
    });

    expect(summaryOf(db, runId).rowsWritten).toBe(92);
  });

  it('is 0 for a copy that wrote nothing, and null when nothing reported the figure', async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const zero = await drive(db, pvId, { a: { outputs: { rowsWritten: 0 } } });
    const none = await drive(db, pvId);

    expect(summaryOf(db, zero).rowsWritten).toBe(0);
    expect(summaryOf(db, none).rowsWritten).toBeNull();
  });

  it("ignores a failed copy's running total and any value that is not a non-negative integer", async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a'), node('b'), node('c')]);
    const runId = await drive(db, pvId, {
      a: { outputs: { rowsWritten: '5' } },
      b: { outputs: { rowsWritten: -3 } },
      c: { outputs: { rowsWritten: 2.5 } },
    });
    // A failed copy reports its uncommitted total as `node.output`, never as a success.
    appendRunEvent(db, {
      runId,
      type: 'node.output',
      payload: { type: 'node.output', runId, nodeId: 'a', name: 'rowsWritten', value: 40 },
    });

    // A child pipeline's outputs come back on `call.returned`; the child's rows
    // are on the child's own row, so they must not be counted again here.
    appendRunEvent(db, {
      runId,
      type: 'call.returned',
      payload: {
        type: 'call.returned',
        runId,
        callNodeId: 'a',
        attemptId: 'a#0',
        childRunId: 'child',
        childOutcome: 'success',
        outputs: { rowsWritten: 9 },
      },
    });

    expect(summaryOf(db, runId).rowsWritten).toBeNull();
  });

  it("is owner-scoped: another owner's runs contribute nothing", async () => {
    const { db } = freshDb();
    const pvId = seedVersion(db, [node('a')]);
    const runId = await drive(db, pvId, { a: { outputs: { rowsWritten: 7 } } });

    expect(listRunLogFacts(db, [runId], 'local').get(runId)?.rowsWritten).toBe(7);
    expect(listRunLogFacts(db, [runId], 'someone-else').size).toBe(0);
  });
});

describe('#1484 activityCountsFromState — a rerun-from-failed', () => {
  const state = (statuses: Record<string, string>, containers: Record<string, string> = {}) =>
    ({
      nodes: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { status }])),
      containers: Object.fromEntries(
        Object.entries(containers).map(([id, status]) => [id, { status }]),
      ),
    }) as unknown as RunState;
  const reseeded = (frontier: string[], copiedContainers: string[] = []): EngineEvent =>
    ({
      type: 'run.reseeded',
      runId: 'r',
      sourceRunId: 'r0',
      frontier,
      copiedOutputs: {},
      copiedContainers: Object.fromEntries(copiedContainers.map((id) => [id, {}])),
    }) as unknown as EngineEvent;

  it('counts the copied frontier, and a copied container with its body, as reused', () => {
    const doc = {
      nodes: [node('a'), node('inner'), node('b')],
      containers: [{ id: 'loop', kind: 'stage', children: ['inner'] }],
    } as never;
    const counts = activityCountsFromState(
      doc,
      [reseeded(['a'], ['loop'])],
      state({ a: 'success', inner: 'success', b: 'success' }, { loop: 'success' }),
    );

    expect(counts).toEqual({ succeeded: 1, failed: 0, skipped: 0, reused: 3, unfinished: 0 });
  });

  it('counts a node absent from state (a parallel ForEach body) as nothing', () => {
    const doc = { nodes: [node('a'), node('body')], containers: [] } as never;
    expect(activityCountsFromState(doc, [], state({ a: 'success' }))).toEqual({
      succeeded: 1,
      failed: 0,
      skipped: 0,
      reused: 0,
      unfinished: 0,
    });
  });
});
