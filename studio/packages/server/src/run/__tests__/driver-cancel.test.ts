import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  FAILURE_CODES,
  type Edge,
  type EdgeOn,
  type EngineEvent,
  type Node,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { createRunCancels, type RunCancels } from '../cancel.js';
import {
  buildEngine,
  driveCancelIntent,
  foldPendingCancel,
  startRun,
  type DocResolver,
  type DriveDeps,
  type Executor,
  type ExecutorCommand,
} from '../driver.js';
import { createRunDrives } from '../drives.js';
import { loadEngineEvents } from '../events.js';
import { stubAlarms } from './stub-alarms.js';

/**
 * CX2 (#1320) — the server half of run cancellation, driven through the REAL
 * pump, drive and `startRun` (spec D5/D6). The executor below stands in for the
 * adapters: a `hang` node blocks until its run is aborted and then reports
 * `failed{kind:'cancelled'}`, which is what the real adapters do on their signal.
 */

type Db = ReturnType<typeof freshDb>['db'];

let seq = 0;
function node(id: string, extra: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'test_activity', config: {}, position: { x: seq, y: 0 }, ...extra };
}
function edge(from: string, to: string, on: EdgeOn = 'success'): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}

function seedRun(db: Db, nodes: Node[], edges: Edge[]) {
  const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
  const pv = createPipelineVersion(db, {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes,
    edges,
    catalogVersion: CATALOG_VERSION,
  });
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId: pv.id,
    triggerId: null,
    parentRunId: null,
    params: {},
  });
}

interface AbortableExecutor extends Executor {
  /** Node ids whose attempt reached the executor. */
  readonly dispatched: string[];
  /** Resolves once `n` hanging attempts are blocked. */
  hanging(n: number): Promise<void>;
  readonly aborts: string[];
}

function abortableExecutor(hang: ReadonlySet<string>): AbortableExecutor {
  const live = new Map<string, Set<() => void>>();
  const dispatched: string[] = [];
  const aborts: string[] = [];
  let blocked = 0;
  const waiters: { n: number; resolve: () => void }[] = [];
  const notify = (): void => {
    for (const w of waiters.filter((x) => blocked >= x.n)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }
  };
  return {
    dispatched,
    aborts,
    hanging: (n) =>
      new Promise((resolve) => {
        waiters.push({ n, resolve });
        notify();
      }),
    abortRun(runId) {
      aborts.push(runId);
      for (const release of live.get(runId) ?? []) release();
    },
    async *perform(command: ExecutorCommand, runId: string): AsyncGenerator<EngineEvent> {
      if (command.type !== 'dispatchNode') throw new Error('unexpected command');
      const { nodeId, attemptId } = command;
      dispatched.push(nodeId);
      yield { type: 'node.dispatched', runId, nodeId, attemptId, idempotent: false };
      if (hang.has(nodeId)) {
        await new Promise<void>((resolve) => {
          let set = live.get(runId);
          if (set === undefined) live.set(runId, (set = new Set()));
          set.add(resolve);
          blocked += 1;
          notify();
        });
        yield {
          type: 'node.failed',
          runId,
          nodeId,
          attemptId,
          error: 'aborted',
          kind: 'cancelled',
        };
        return;
      }
      yield { type: 'node.succeeded', runId, nodeId, attemptId, outputs: {} };
    },
  };
}

function deps(db: Db, executor: Executor, cancels: RunCancels): DriveDeps {
  const resolveDoc: DocResolver = (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
  return { db, resolveDoc, executor, alarms: stubAlarms(), drives: createRunDrives(), cancels };
}

const types = (db: Db, runId: string): string[] => loadEngineEvents(db, runId).map((e) => e.type);

describe('CX2 — cancelling a run through the server driver', () => {
  it('a live pump folds the cancel through its poke, aborts in-flight work and finishes cancelled', async () => {
    const { db } = freshDb();
    // `a` hangs; its success successor AND its failure handler must both stay
    // undispatched: cancel mode starts no work, and a cancelled failure is
    // never routed down a failure edge.
    const run = seedRun(
      db,
      [node('a'), node('next'), node('handler')],
      [edge('a', 'next'), edge('a', 'handler', 'failure')],
    );
    const cancels = createRunCancels();
    const executor = abortableExecutor(new Set(['a']));
    const d = deps(db, executor, cancels);

    const done = d.drives.serialize(run.id, () => startRun(d, run));
    await executor.hanging(1);

    cancels.request(run.id, { kind: 'operator' });
    expect(cancels.poke(run.id)).toBe(true);
    const state = await done;

    expect(state.status).toBe('cancelled');
    expect(getRun(db, run.id)?.status).toBe('cancelled');
    expect(executor.dispatched).toEqual(['a']);
    expect(executor.aborts).toEqual([run.id]);
    // The fact precedes the failure it caused, in the pump's own log order.
    expect(types(db, run.id)).toEqual([
      'run.started',
      'node.dispatched',
      'run.cancelRequested',
      'node.failed',
      'run.finished',
    ]);
    expect(cancels.pending(run.id)).toBe(false);
  });

  it('a stream still queued behind the per-run cap when the cancel folds ends cancelled without ever reaching the executor', async () => {
    const { db } = freshDb();
    // Five parallel siblings, all hanging: the per-run cap admits four, so the
    // fifth is still queued when the cancel folds. Dropping it would leave its
    // `ready` node in flight forever.
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const run = seedRun(
      db,
      [node('r'), ...ids.map((id) => node(id))],
      ids.map((id) => edge('r', id)),
    );
    const cancels = createRunCancels();
    const executor = abortableExecutor(new Set(ids));
    const d = deps(db, executor, cancels);

    const done = d.drives.serialize(run.id, () => startRun(d, run));
    await executor.hanging(4);
    cancels.request(run.id, { kind: 'operator' });
    cancels.poke(run.id);
    const state = await done;

    expect(state.status).toBe('cancelled');
    expect(executor.dispatched).toEqual(['r', 'a', 'b', 'c', 'd']);
    const fifth = loadEngineEvents(db, run.id).filter(
      (e): e is Extract<EngineEvent, { type: 'node.failed' }> =>
        e.type === 'node.failed' && e.nodeId === 'e',
    );
    expect(fifth).toHaveLength(1);
    expect(fifth[0]).toMatchObject({ kind: 'cancelled', code: FAILURE_CODES.RUN_CANCELLED });
  });

  it('a parked (waiting) run is cancelled by the serialized drive: nothing is in flight, so it finishes at once', async () => {
    const { db } = freshDb();
    const run = seedRun(
      db,
      [node('w', { type: 'wait', config: { seconds: '${3600}' } }), node('after')],
      [edge('w', 'after')],
    );
    const cancels = createRunCancels();
    const executor = abortableExecutor(new Set());
    const d = deps(db, executor, cancels);
    await d.drives.serialize(run.id, () => startRun(d, run));
    expect(getRun(db, run.id)?.status).toBe('waiting');

    cancels.request(run.id, { kind: 'operator' });
    expect(cancels.poke(run.id)).toBe(false); // no pump holds a parked run
    await driveCancelIntent(d, run.id);

    expect(getRun(db, run.id)?.status).toBe('cancelled');
    expect(executor.dispatched).toEqual([]);
    expect(types(db, run.id).slice(-2)).toEqual(['run.cancelRequested', 'run.finished']);
    expect(cancels.pending(run.id)).toBe(false);
  });

  it('a run cancelled before it started finishes cancelled with no run.started, whichever holder folds it', async () => {
    for (const via of ['startRun', 'serialized drive'] as const) {
      const { db } = freshDb();
      const run = seedRun(db, [node('a')], []);
      const cancels = createRunCancels();
      const executor = abortableExecutor(new Set());
      const d = deps(db, executor, cancels);

      cancels.request(run.id, { kind: 'operator' });
      if (via === 'startRun') await d.drives.serialize(run.id, () => startRun(d, run));
      else await driveCancelIntent(d, run.id);

      expect(getRun(db, run.id)?.status, via).toBe('cancelled');
      expect(types(db, run.id), via).toEqual(['run.cancelRequested', 'run.finished']);
      expect(executor.dispatched, via).toEqual([]);
    }
  });

  it('starting a run a cancel already finished is not a fault: startRun returns the terminal state', async () => {
    const { db } = freshDb();
    const run = seedRun(db, [node('a')], []);
    const cancels = createRunCancels();
    const d = deps(db, abortableExecutor(new Set()), cancels);
    cancels.request(run.id, { kind: 'operator' });
    await driveCancelIntent(d, run.id);

    const state = await d.drives.serialize(run.id, () => startRun(d, run));

    expect(state.status).toBe('cancelled');
    expect(types(db, run.id)).toEqual(['run.cancelRequested', 'run.finished']);
  });

  it('the serialized drive does nothing when no intent is left (a pump already folded it)', async () => {
    const { db } = freshDb();
    // A PARKED run, because re-driving one is observable: `resume` would
    // re-derive its timer. A finished run would hide a missing guard.
    const run = seedRun(
      db,
      [node('w', { type: 'wait', config: { seconds: '${3600}' } }), node('after')],
      [edge('w', 'after')],
    );
    const cancels = createRunCancels();
    const d = deps(db, abortableExecutor(new Set()), cancels);
    await d.drives.serialize(run.id, () => startRun(d, run));
    const before = types(db, run.id);
    const armsBefore = (d.alarms as ReturnType<typeof stubAlarms>).armCalls.length;

    await driveCancelIntent(d, run.id);

    expect(types(db, run.id)).toEqual(before);
    expect((d.alarms as ReturnType<typeof stubAlarms>).armCalls.length).toBe(armsBefore);
  });

  it('a cancel that lost the race to the run finishing is discarded, not left in the map', async () => {
    const { db } = freshDb();
    const run = seedRun(db, [node('a')], []);
    const cancels = createRunCancels();
    const d = deps(db, abortableExecutor(new Set()), cancels);
    await d.drives.serialize(run.id, () => startRun(d, run));

    cancels.request(run.id, { kind: 'operator' });
    await driveCancelIntent(d, run.id);

    expect(getRun(db, run.id)?.status).toBe('success');
    expect(types(db, run.id)).not.toContain('run.cancelRequested');
    expect(cancels.pending(run.id)).toBe(false);
  });

  it('an append that throws leaves the intent in the map for the next holder', () => {
    const { db } = freshDb();
    const run = seedRun(db, [node('a')], []);
    const cancels = createRunCancels();
    const d = deps(db, abortableExecutor(new Set()), cancels);
    const engine = buildEngine(getPipelineVersion(db, run.pipelineVersionId)!);
    cancels.request('run_with_no_row', { kind: 'operator' });

    // No `runs` row: the `run_events` FK refuses the append.
    expect(() => foldPendingCancel(d, engine, engine.seedState(), 'run_with_no_row')).toThrow();
    expect(cancels.pending('run_with_no_row')).toBe(true);

    // ...and a fold that lands consumes it in the same call.
    cancels.request(run.id, { kind: 'operator' });
    expect(foldPendingCancel(d, engine, engine.seedState(), run.id)).not.toBeNull();
    expect(cancels.pending(run.id)).toBe(false);
  });
});
