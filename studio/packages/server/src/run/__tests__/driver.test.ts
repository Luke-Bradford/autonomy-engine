import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type Edge,
  type EdgeOn,
  type EngineEvent,
  type Node,
  type NewPipelineVersion,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun } from '../../repo/runs.js';
import { runs } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { buildEngine, startRun, type DocResolver, type DriverDeps } from '../driver.js';
import { loadEngineEvents } from '../events.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';

type Db = ReturnType<typeof freshDb>['db'];

let seq = 0;
function node(id: string, extra: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: seq, y: 0 }, ...extra };
}
function edge(from: string, to: string, on: EdgeOn = 'success'): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
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
  return { db, resolveDoc, executor: makeStubExecutor(executorOpts) };
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
