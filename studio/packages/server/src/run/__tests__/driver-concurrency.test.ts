import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type Edge,
  type EdgeOn,
  type EngineEvent,
  type NewPipelineVersion,
  type Node,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { buildEngine, startRun, type DriverDeps, type DocResolver } from '../driver.js';
import { loadEngineEvents } from '../events.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';
import { stubAlarms } from './stub-alarms.js';

type Db = ReturnType<typeof freshDb>['db'];

let seq = 0;
function node(id: string, extra: Partial<Node> = {}): Node {
  seq += 1;
  // Uncatalogued type on purpose — see driver.test.ts: run-mechanics fixtures
  // driven by the type-agnostic stub executor, with an `absent` output contract.
  return { id, type: 'test_activity', config: {}, position: { x: seq, y: 0 }, ...extra };
}
function edge(from: string, to: string, on: EdgeOn = 'success'): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}
/**
 * A root `r` fanning out to `ids` on success. Parallel SIBLINGS need declared
 * edges: an edge-less doc synthesizes the implicit success-CHAIN over node
 * order (`effectiveEdges`), so "three nodes, no edges" is sequential by design
 * — fan-out from a shared root is the canonical parallel shape.
 */
function fanOut(ids: string[]): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: [node('r'), ...ids.map((id) => node(id))],
    edges: ids.map((id) => edge('r', id)),
  };
}

function seedVersion(db: Db, nodes: Node[], edges: Edge[]): string {
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
  return { db, resolveDoc, executor: makeStubExecutor(executorOpts), alarms: stubAlarms() };
}

/**
 * A bounded latch: resolves `true` when `signal` fires, or `false` after `ms`.
 * The test ASSERTS on the flag instead of hanging the suite when concurrency
 * is absent (a serial pump must FAIL the assertion, not time the suite out).
 */
function boundedRace(signal: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([
    signal.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

describe('driver — intra-run concurrent dispatch (#4 A4b slice 1)', () => {
  it('parallel siblings execute their adapter phases CONCURRENTLY', async () => {
    const { db } = freshDb();
    const { nodes, edges } = fanOut(['a', 'b']);
    const run = seedRun(db, seedVersion(db, nodes, edges));

    let releaseA: () => void = () => {};
    const bStarted = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let overlapped = false;

    const state = await startRun(
      deps(db, {
        nodes: {
          // `a` HOLDS its adapter phase open until `b`'s adapter phase begins.
          // Under a serial pump `b` never starts while `a` is in flight, the
          // 1s fallback fires, and `overlapped` stays false.
          a: {
            gate: async () => {
              overlapped = await boundedRace(bStarted, 1000);
            },
          },
          b: { onStart: () => releaseA() },
        },
      }),
      run,
    );

    expect(overlapped).toBe(true);
    expect(state.status).toBe('success');
    expect(state.nodes.a!.status).toBe('success');
    expect(state.nodes.b!.status).toBe('success');
  });

  it('per-node event order holds and the parallel log replays to the identical state', async () => {
    const { db } = freshDb();
    const { nodes, edges } = fanOut(['a', 'b', 'c']);
    const pvId = seedVersion(db, nodes, edges);
    const run = seedRun(db, pvId);

    const driven = await startRun(
      deps(db, {
        nodes: { a: { delayMs: 30, outputs: { v: 1 } }, b: { delayMs: 10 }, c: { delayMs: 20 } },
      }),
      run,
    );

    expect(driven.status).toBe('success');
    const events = loadEngineEvents(db, run.id);
    // Per-node crash-safety order: `node.dispatched` strictly before the terminal.
    for (const id of ['a', 'b', 'c']) {
      const dispatchedAt = events.findIndex((e) => e.type === 'node.dispatched' && e.nodeId === id);
      const terminalAt = events.findIndex((e) => e.type === 'node.succeeded' && e.nodeId === id);
      expect(dispatchedAt).toBeGreaterThan(-1);
      expect(terminalAt).toBeGreaterThan(dispatchedAt);
    }
    // Event-sourcing invariant: the persisted log (whatever interleaving the
    // wall clock produced) replays to the exact driven state.
    const engine = buildEngine(getPipelineVersion(db, pvId)!);
    expect(engine.projectRunState(events)).toEqual(driven);
  });

  it('an adapter phase only ever begins with its own node.dispatched already durable', async () => {
    const { db } = freshDb();
    const { nodes, edges } = fanOut(['a', 'b']);
    const run = seedRun(db, seedVersion(db, nodes, edges));

    const durableAtStart: Record<string, boolean> = {};
    const probe = (id: string) => () => {
      durableAtStart[id] = loadEngineEvents(db, run.id).some(
        (e) => e.type === 'node.dispatched' && e.nodeId === id,
      );
    };

    const state = await startRun(
      deps(db, {
        nodes: { a: { onStart: probe('a'), delayMs: 5 }, b: { onStart: probe('b'), delayMs: 5 } },
      }),
      run,
    );

    expect(state.status).toBe('success');
    expect(durableAtStart).toEqual({ a: true, b: true });
  });

  it('a cascade dispatch joins the concurrent set while a sibling is still in flight', async () => {
    const { db } = freshDb();
    // r -> (a, b) plus a -> c: when `a` finishes, `c`'s dispatch must NOT wait
    // for slow sibling `b` to drain first.
    const { nodes, edges } = fanOut(['a', 'b']);
    const pvId = seedVersion(db, [...nodes, node('c')], [...edges, edge('a', 'c')]);
    const run = seedRun(db, pvId);

    let releaseB: () => void = () => {};
    const cStarted = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let cascadeOverlapped = false;

    const state = await startRun(
      deps(db, {
        nodes: {
          b: {
            gate: async () => {
              cascadeOverlapped = await boundedRace(cStarted, 1000);
            },
          },
          c: { onStart: () => releaseB() },
        },
      }),
      run,
    );

    expect(cascadeOverlapped).toBe(true);
    expect(state.status).toBe('success');
  });

  it('an unhandled sibling failure DRAINS in-flight work before run.finished (F1b drain)', async () => {
    const { db } = freshDb();
    const { nodes, edges } = fanOut(['a', 'b']);
    const run = seedRun(db, seedVersion(db, nodes, edges));

    const state = await startRun(
      deps(db, {
        nodes: {
          a: { outcome: 'failure', error: 'nope' },
          b: { delayMs: 30 },
        },
      }),
      run,
    );

    // F1b: no eager short-circuit — the run fails only once every top-level
    // node is terminal, so slow `b` (already in flight when `a` failed) still
    // folds its success first.
    expect(state.status).toBe('failure');
    expect(state.nodes.a!.status).toBe('failure');
    expect(state.nodes.b!.status).toBe('success');
    const events = loadEngineEvents(db, run.id);
    const bSucceededAt = events.findIndex((e) => e.type === 'node.succeeded' && e.nodeId === 'b');
    expect(bSucceededAt).toBeGreaterThan(-1);
    expect(events.findIndex((e) => e.type === 'run.finished')).toBeGreaterThan(bSucceededAt);
  });

  it('honours the per-run dispatch-concurrency cap while still overlapping', async () => {
    const { db } = freshDb();
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
    const { nodes, edges } = fanOut(ids);
    const run = seedRun(db, seedVersion(db, nodes, edges));

    let inFlight = 0;
    let maxInFlight = 0;
    const plan = {
      onStart: () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
      },
      gate: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlight -= 1;
      },
    };

    const state = await startRun(
      deps(db, { nodes: Object.fromEntries(ids.map((id) => [id, plan])) }),
      run,
    );

    expect(state.status).toBe('success');
    // The pump's own per-run cap (4) bounds the concurrent adapter phases (the
    // stub bypasses the executor's global p-limit, so this exercises the pump's
    // cap alone); the floor asserts concurrency actually happened (a serial
    // pump gives 1).
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it('a terminal fact while a sibling is IN FLIGHT drops its remaining events and returns', async () => {
    const { db } = freshDb();
    // r -> b (slow) and r -> x -> a, where `a`'s dispatch prep THROWS at run
    // time: `${nodes.x.output.v}` passes the #444 write gate (`x` is
    // uncatalogued, so its output contract is `absent` and the static checker
    // cannot type the ref) but `x` actually emits `{}`, so the prep's walk
    // fails. `x` finishes while `b` is still in flight, `a`'s prep failure
    // emits finishRun{invalid_event}, and the pump must tear down — drop b's
    // undelivered events, await b's stream settlement — not hang and not
    // append past the terminal.
    const { nodes, edges } = fanOut(['b', 'x']);
    const pvId = seedVersion(
      db,
      [...nodes, node('a', { config: { bad: '${nodes.x.output.v}' } })],
      [...edges, edge('x', 'a')],
    );
    const run = seedRun(db, pvId);

    const state = await startRun(
      deps(db, {
        nodes: {
          // Bounded, released by nothing: b outlives the run's terminal fact.
          b: { gate: () => new Promise((resolve) => setTimeout(resolve, 200)) },
        },
      }),
      run,
    );

    expect(state.status).toBe('failure');
    const events = loadEngineEvents(db, run.id);
    const finishedAt = events.findIndex((e) => e.type === 'run.finished');
    expect(finishedAt).toBeGreaterThan(-1);
    // Pin the terminal to the PREP failure (not a stall or drain outcome), so
    // the fixture's "runtime-only throw" premise is itself asserted.
    expect(events[finishedAt]).toMatchObject({ outcome: 'failure', reason: 'invalid_event' });
    // b's terminal never landed — its stream's remaining events were dropped,
    // and NOTHING was appended after the run's terminal fact.
    expect(events.some((e) => e.type === 'node.succeeded' && e.nodeId === 'b')).toBe(false);
    expect(finishedAt).toBe(events.length - 1);
    expect(state.nodes.b!.status).toBe('dispatched');
  });

  it('a fold error on the channel path rejects the drive — never hangs the lock', async () => {
    const { db } = freshDb();
    const { nodes, edges } = fanOut(['a', 'b']);
    const run = seedRun(db, seedVersion(db, nodes, edges));

    // `a` yields an event the append-path schema re-parse REJECTS, making
    // `fold` itself throw while sibling `b` is suspended mid-push. The pump
    // must settle the shifted entry before rethrowing — an unsettled entry
    // would strand `b`'s pusher and hang teardown under the drive lock (the
    // pre-fix failure both review lenses flagged).
    const base = makeStubExecutor({ nodes: { b: { delayMs: 30 } } });
    const malforming: DriverDeps['executor'] = {
      async *perform(command, runId) {
        if (command.type === 'dispatchNode' && command.nodeId === 'a') {
          yield* base.perform(command, runId);
          yield { type: 'not.an.event' } as unknown as EngineEvent;
          return;
        }
        yield* base.perform(command, runId);
      },
    };

    const d = deps(db);
    await expect(startRun({ ...d, executor: malforming }, run)).rejects.toThrow();
  });

  it('a stream that throws mid-flight tears down cleanly and rethrows', async () => {
    const { db } = freshDb();
    const { nodes, edges } = fanOut(['a', 'b']);
    const run = seedRun(db, seedVersion(db, nodes, edges));

    const base = makeStubExecutor({ nodes: { b: { delayMs: 30 } } });
    const throwing: DriverDeps['executor'] = {
      async *perform(command, runId) {
        if (command.type === 'dispatchNode' && command.nodeId === 'a') {
          for await (const event of base.perform(command, runId)) {
            if (event.type === 'node.succeeded') throw new Error('adapter exploded');
            yield event;
          }
          return;
        }
        yield* base.perform(command, runId);
      },
    };

    const d = deps(db);
    await expect(startRun({ ...d, executor: throwing }, run)).rejects.toThrow('adapter exploded');
  });
});
