import { describe, expect, it } from 'vitest';
import type { Container, EngineCommand, EngineEvent, Node, RunState } from '../types.js';
import type { NodePolicy } from '../../schemas/pipeline.js';
import { createEngine, type Engine } from '../reduce.js';

/**
 * #1600 OR41 C8d — Get metadata *Wait until*: the durable re-check park.
 *
 * `node.notReady` holds the node `ready` and emits `scheduleRecheck`; the driver
 * arms the alarm and appends `node.recheckScheduled`, which parks it
 * `wait_pending` (run `waiting`); the alarm's `node.recheckDue` re-dispatches it
 * under a new attempt that spends no retry budget.
 */

const RUN = 'r1';
const G = 1_000_000;

function gm(id: string, policy?: NodePolicy): Node {
  return {
    id,
    type: 'get_metadata',
    config: { path: '/in/a.csv', fieldList: ['exists'], waitUntil: 'exists' },
    position: { x: 0, y: 0 },
    ...(policy && { policy }),
  };
}

function engine(nodes: Node[], containers: Container[] = []): Engine {
  return createEngine({ nodes, edges: [], containers });
}

const started: EngineEvent = {
  type: 'run.started',
  runId: RUN,
  pipelineVersionId: 'pv1',
  params: {},
};
const dispatched = (nodeId: string, attemptId: string): EngineEvent => ({
  type: 'node.dispatched',
  runId: RUN,
  nodeId,
  attemptId,
  idempotent: true,
});
const notReady = (nodeId: string, attemptId: string): EngineEvent => ({
  type: 'node.notReady',
  runId: RUN,
  nodeId,
  attemptId,
  reason: '/in/a.csv does not exist yet',
  recheckAfterSeconds: 10,
  giveUpAfterSeconds: 60,
});
const scheduled = (nodeId: string, attemptId: string, giveUpAt = G): EngineEvent => ({
  type: 'node.recheckScheduled',
  runId: RUN,
  nodeId,
  attemptId,
  nextCheckAt: 10,
  giveUpAt,
});
const due = (nodeId: string, previousAttemptId: string): EngineEvent => ({
  type: 'node.recheckDue',
  runId: RUN,
  nodeId,
  previousAttemptId,
});
const succeeded = (nodeId: string, attemptId: string): EngineEvent => ({
  type: 'node.succeeded',
  runId: RUN,
  nodeId,
  attemptId,
  outputs: { path: '/in/a.csv', exists: true },
});

function fold(eng: Engine, events: EngineEvent[], from?: RunState) {
  let state = from ?? eng.seedState();
  let commands: EngineCommand[] = [];
  for (const e of events) {
    const r = eng.reduce(state, e);
    state = r.state;
    commands = r.commands;
  }
  return { state, commands };
}

/** To the first park: dispatched, not ready, alarm armed. */
const toPark = (id = 'g') => [
  started,
  dispatched(id, `${id}#0`),
  notReady(id, `${id}#0`),
  scheduled(id, `${id}#0`),
];

describe('#1600 C8d — node.notReady', () => {
  it('holds the node ready and asks the driver to re-check, with no deadline yet', () => {
    const eng = engine([gm('g')]);
    const { state, commands } = fold(eng, [started, dispatched('g', 'g#0'), notReady('g', 'g#0')]);
    expect(state.nodes.g!.status).toBe('ready');
    expect(state.status).toBe('running');
    expect(state.nodes.g!.recheck).toEqual({
      notReadyAttemptId: 'g#0',
      reason: '/in/a.csv does not exist yet',
      afterSeconds: 10,
      giveUpAfterSeconds: 60,
    });
    expect(commands).toEqual([
      {
        type: 'scheduleRecheck',
        nodeId: 'g',
        attemptId: 'g#0',
        reason: '/in/a.csv does not exist yet',
        afterSeconds: 10,
        giveUpAfterSeconds: 60,
        giveUpAt: null,
      },
    ]);
  });

  it('ignores a not-ready for an attempt the node has moved past', () => {
    const eng = engine([gm('g')]);
    const { state } = fold(eng, [started, dispatched('g', 'g#0')]);
    const r = eng.reduce(state, notReady('g', 'g#9'));
    expect(r.state).toBe(state);
    expect(r.commands).toEqual([]);
  });

  it('in cancel mode, fails the node: the cancel stopped the wait', () => {
    const eng = engine([gm('g')]);
    const { state } = fold(eng, [
      started,
      dispatched('g', 'g#0'),
      { type: 'run.cancelRequested', runId: RUN, source: { kind: 'operator' } },
      notReady('g', 'g#0'),
    ]);
    expect(state.nodes.g!.status).toBe('failure');
    expect(state.nodes.g!.recheck).toBeUndefined();
    expect(state.cancelRequested?.stoppedWork).toBe(true);
  });
});

describe('#1600 C8d — the park and the re-check', () => {
  it('parks the node wait_pending, the run waiting, and stamps the deadline', () => {
    const eng = engine([gm('g')]);
    const { state, commands } = fold(eng, toPark());
    expect(state.nodes.g!.status).toBe('wait_pending');
    expect(state.nodes.g!.recheck?.giveUpAt).toBe(G);
    expect(commands).toContainEqual(expect.objectContaining({ type: 'parkRun' }));
    const parked = eng.reduce(state, {
      type: 'run.waiting',
      runId: RUN,
      reason: 'waiting_timer',
    }).state;
    expect(parked.status).toBe('waiting');
  });

  it('re-dispatches under a new attempt on a parked run, spending no retry', () => {
    const eng = engine([gm('g')]);
    let { state } = fold(eng, toPark());
    state = eng.reduce(state, { type: 'run.waiting', runId: RUN, reason: 'waiting_timer' }).state;
    const r = eng.reduce(state, due('g', 'g#0'));
    expect(r.state.status).toBe('running');
    expect(r.state.nodes.g).toMatchObject({
      status: 'ready',
      currentAttemptId: 'g#1',
      attempts: 2,
      retries: 0,
    });
    expect(r.commands).toEqual([
      expect.objectContaining({ type: 'dispatchNode', nodeId: 'g', attemptId: 'g#1' }),
    ]);
  });

  it('keeps the first deadline for the next check, then settles and drops the record', () => {
    const eng = engine([gm('g')]);
    const { state, commands } = fold(eng, [
      ...toPark(),
      due('g', 'g#0'),
      dispatched('g', 'g#1'),
      notReady('g', 'g#1'),
    ]);
    expect(commands).toEqual([
      expect.objectContaining({ type: 'scheduleRecheck', attemptId: 'g#1', giveUpAt: G }),
    ]);
    const done = fold(
      eng,
      [scheduled('g', 'g#1', G), due('g', 'g#1'), dispatched('g', 'g#2'), succeeded('g', 'g#2')],
      state,
    );
    expect(done.state.nodes.g!.status).toBe('success');
    expect(done.state.nodes.g!.recheck).toBeUndefined();
    expect(done.commands).toContainEqual(
      expect.objectContaining({ type: 'finishRun', outcome: 'success' }),
    );
  });

  it('keeps the deadline across a policy retry between checks', () => {
    const eng = engine([gm('g', { retry: 1 })]);
    const { commands } = fold(eng, [
      ...toPark(),
      due('g', 'g#0'),
      dispatched('g', 'g#1'),
      {
        type: 'node.failed',
        runId: RUN,
        nodeId: 'g',
        attemptId: 'g#1',
        error: 'EIO',
        kind: 'transient',
      },
      { type: 'node.retryDue', runId: RUN, nodeId: 'g', previousAttemptId: 'g#1' },
      dispatched('g', 'g#2'),
      notReady('g', 'g#2'),
    ]);
    expect(commands).toEqual([
      expect.objectContaining({ type: 'scheduleRecheck', attemptId: 'g#2', giveUpAt: G }),
    ]);
  });

  it('treats a stale or duplicate alarm event as a no-op', () => {
    const eng = engine([gm('g')]);
    const { state } = fold(eng, toPark());
    for (const e of [due('g', 'g#7'), scheduled('g', 'g#0', 5)]) {
      const r = eng.reduce(state, e);
      expect(r.state.nodes.g).toEqual(state.nodes.g);
      expect(r.commands).toEqual([]);
    }
  });

  it('never completes a re-check park on a wait timer', () => {
    const eng = engine([gm('g')]);
    const { state } = fold(eng, toPark());
    const r = eng.reduce(state, {
      type: 'timer.due',
      runId: RUN,
      nodeId: 'g',
      previousAttemptId: 'g#0',
    });
    expect(r.state.nodes.g!.status).toBe('wait_pending');
  });

  it('a cancel on the parked run fails the park and finishes the run cancelled', () => {
    const eng = engine([gm('g')]);
    let { state } = fold(eng, toPark());
    state = eng.reduce(state, { type: 'run.waiting', runId: RUN, reason: 'waiting_timer' }).state;
    const r = eng.reduce(state, {
      type: 'run.cancelRequested',
      runId: RUN,
      source: { kind: 'operator' },
    });
    expect(r.state.nodes.g!.status).toBe('failure');
    expect(r.state.nodes.g!.recheck).toBeUndefined();
    expect(r.commands).toContainEqual(
      expect.objectContaining({ type: 'finishRun', outcome: 'cancelled' }),
    );
    expect(eng.reduce(r.state, due('g', 'g#0')).commands).toEqual([]);
  });
});

describe('#1600 C8d — crash recovery (run.resumed)', () => {
  it('re-emits the lost scheduleRecheck, never a dispatch', () => {
    const eng = engine([gm('g')]);
    const { state } = fold(eng, [started, dispatched('g', 'g#0'), notReady('g', 'g#0')]);
    const r = eng.reduce(state, { type: 'run.resumed', runId: RUN, reason: 'boot_reconcile' });
    expect(r.commands).toEqual([
      expect.objectContaining({ type: 'scheduleRecheck', attemptId: 'g#0', giveUpAt: null }),
    ]);
  });

  it('re-emits the lost dispatch of a check that was already due', () => {
    const eng = engine([gm('g')]);
    const { state } = fold(eng, [...toPark(), due('g', 'g#0')]);
    const r = eng.reduce(state, { type: 'run.resumed', runId: RUN, reason: 'boot_reconcile' });
    expect(r.commands).toEqual([
      expect.objectContaining({ type: 'dispatchNode', attemptId: 'g#1' }),
    ]);
  });
});
