import { describe, expect, it } from 'vitest';
import type { EngineCommand, EngineEvent, Node, RunState } from '../types.js';
import { createEngine, type Engine } from '../reduce.js';
import { getActivity, WEB_ACTIVITY_TYPE } from '../../index.js';
import { SECURE_REDACTED } from '../outputs.js';
import { SECURE_ERROR_WITHHELD } from '../secure.js';

/**
 * #1600 OR41 C11c — Web *Wait for callback*.
 *
 * `node.awaitingCallback` (the request succeeded) holds the node `ready` with
 * the request's outputs and emits `scheduleExternalWait`; the driver arms the
 * expiry and appends `externalWait.created`, which parks it
 * `external_wait_pending`; the callback's `externalWait.completed` settles it
 * with the request outputs plus `callback`. A callback that arrived before the
 * park rides `externalWait.created.arrived` and settles it without parking.
 */

const RUN = 'r1';

const REQUEST = {
  status: 202,
  headers: {},
  body: { accepted: true },
  bytes: 17,
  durationMs: 5,
  truncated: false,
};

function web(id: string, config: Record<string, unknown> = {}, policy?: Node['policy']): Node {
  return {
    id,
    type: WEB_ACTIVITY_TYPE,
    connectionId: 'c1',
    config: {
      url: '/jobs',
      method: 'POST',
      waitForCallback: true,
      outputs: getActivity(WEB_ACTIVITY_TYPE)!.outputs,
      ...config,
    },
    position: { x: 0, y: 0 },
    ...(policy && { policy }),
  };
}

function engine(nodes: Node[], edges: { from: string; to: string }[] = []): Engine {
  return createEngine({
    nodes,
    edges: edges.map((e) => ({ id: `${e.from}->${e.to}`, ...e, on: 'success' as const })),
    containers: [],
  });
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
  idempotent: false,
});
const awaiting = (nodeId: string, attemptId: string): EngineEvent => ({
  type: 'node.awaitingCallback',
  runId: RUN,
  nodeId,
  attemptId,
  outputs: REQUEST,
  timeoutSeconds: 600,
});
const created = (
  nodeId: string,
  attemptId: string,
  arrived?: { callback: unknown; reportedError?: string },
): EngineEvent => ({
  type: 'externalWait.created',
  runId: RUN,
  nodeId,
  attemptId,
  dueAt: 1_000,
  ...(arrived !== undefined ? { arrived } : {}),
});
const completed = (
  nodeId: string,
  previousAttemptId: string,
  callback: unknown,
  reportedError?: string,
): EngineEvent => ({
  type: 'externalWait.completed',
  runId: RUN,
  nodeId,
  previousAttemptId,
  outputs: { callback },
  ...(reportedError !== undefined ? { reportedError } : {}),
});
const cancel: EngineEvent = {
  type: 'run.cancelRequested',
  runId: RUN,
  source: { kind: 'operator' },
};

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

describe('#1600 C11c — node.awaitingCallback', () => {
  it('holds the node ready with the request outputs and asks the driver to park it', () => {
    const eng = engine([web('w')]);
    const { state, commands } = fold(eng, [started, dispatched('w', 'w#0'), awaiting('w', 'w#0')]);
    expect(state.nodes.w!.status).toBe('ready');
    expect(state.nodes.w!.callback).toEqual({
      attemptId: 'w#0',
      request: REQUEST,
      timeoutSeconds: 600,
    });
    expect(state.outputs.w).toBeUndefined();
    expect(commands).toEqual([
      { type: 'scheduleExternalWait', nodeId: 'w', attemptId: 'w#0', timeoutSeconds: 600 },
    ]);
  });

  it('ignores an awaiting event for an attempt the node has moved past', () => {
    const eng = engine([web('w')]);
    const { state, commands } = fold(eng, [started, dispatched('w', 'w#0'), awaiting('w', 'w#9')]);
    expect(state.nodes.w!.status).toBe('dispatched');
    expect(state.nodes.w!.callback).toBeUndefined();
    expect(commands).toEqual([]);
  });

  it('under a cancel, ends the attempt instead of parking it', () => {
    const eng = engine([web('w')]);
    const { state, commands } = fold(eng, [
      started,
      dispatched('w', 'w#0'),
      cancel,
      awaiting('w', 'w#0'),
    ]);
    expect(state.nodes.w!.status).toBe('failure');
    expect(state.nodes.w!.callback).toBeUndefined();
    expect(commands.some((c) => c.type === 'scheduleExternalWait')).toBe(false);
  });
});

describe('#1600 C11c — the park and the callback', () => {
  const toPark = [started, dispatched('w', 'w#0'), awaiting('w', 'w#0'), created('w', 'w#0')];

  it('parks the node and the run', () => {
    const eng = engine([web('w')]);
    const { state, commands } = fold(eng, toPark);
    expect(state.nodes.w!.status).toBe('external_wait_pending');
    expect(commands.map((c) => c.type)).toEqual(['parkRun']);
  });

  it('settles on the callback with the request outputs plus callback, and routes success', () => {
    const eng = engine(
      [web('w'), { id: 'next', type: 'noop', config: {}, position: { x: 0, y: 0 } }],
      [{ from: 'w', to: 'next' }],
    );
    const callback = { Output: { rows: 3 } };
    const r = fold(eng, [...toPark, completed('w', 'w#0', callback)]);
    expect(r.state.nodes.w!.status).toBe('success');
    expect(r.state.nodes.w!.callback).toBeUndefined();
    expect(r.state.outputs.w).toEqual({ ...REQUEST, callback });
    expect(r.state.nodes.next!.status).toBe('ready');
  });

  it('a callback that reported a failure fails the node, permanently, with no retry', () => {
    const eng = engine([web('w', { reportStatusOnCallback: true }, { retry: 3 })]);
    const r = fold(eng, [
      ...toPark,
      completed('w', 'w#0', { StatusCode: '500' }, 'the callback reported StatusCode 500'),
    ]);
    expect(r.state.nodes.w!.status).toBe('failure');
    expect(r.state.outputs.w).toBeUndefined();
    expect(r.commands).toEqual([
      expect.objectContaining({ type: 'finishRun', outcome: 'failure' }),
    ]);
  });

  it('a callback naming another attempt is a no-op', () => {
    const eng = engine([web('w')]);
    const r = fold(eng, [...toPark, completed('w', 'w#7', {})]);
    expect(r.state.nodes.w!.status).toBe('external_wait_pending');
  });

  it('an expiry fails the node and drops the held request', () => {
    const eng = engine([web('w')]);
    const r = fold(eng, [
      ...toPark,
      { type: 'externalWait.expired', runId: RUN, nodeId: 'w', previousAttemptId: 'w#0' },
    ]);
    expect(r.state.nodes.w!.status).toBe('failure');
    expect(r.state.nodes.w!.callback).toBeUndefined();
  });
});

describe('#1600 C11c — a callback that arrived before the park', () => {
  it('settles at the arm, never parking the node or the run', () => {
    const eng = engine([web('w')]);
    const r = fold(eng, [
      started,
      dispatched('w', 'w#0'),
      awaiting('w', 'w#0'),
      created('w', 'w#0', { callback: { Output: { ok: 1 } } }),
    ]);
    expect(r.state.nodes.w!.status).toBe('success');
    expect(r.state.outputs.w).toEqual({ ...REQUEST, callback: { Output: { ok: 1 } } });
    expect(r.commands).toEqual([
      expect.objectContaining({ type: 'finishRun', outcome: 'success' }),
    ]);
  });

  it('fails at the arm when the early callback reported a failure', () => {
    const eng = engine([web('w', { reportStatusOnCallback: true })]);
    const r = fold(eng, [
      started,
      dispatched('w', 'w#0'),
      awaiting('w', 'w#0'),
      created('w', 'w#0', { callback: { StatusCode: 403 }, reportedError: 'reported 403' }),
    ]);
    expect(r.state.nodes.w!.status).toBe('failure');
    expect(r.commands).toEqual([
      expect.objectContaining({ type: 'finishRun', outcome: 'failure' }),
    ]);
  });

  it('a cancel between the request and the arm ends the wait at the arm', () => {
    const eng = engine([web('w')]);
    const r = fold(eng, [
      started,
      dispatched('w', 'w#0'),
      awaiting('w', 'w#0'),
      cancel,
      created('w', 'w#0'),
    ]);
    expect(r.state.nodes.w!.status).toBe('failure');
    expect(r.state.nodes.w!.callback).toBeUndefined();
  });
});

describe('#1600 C11c — crash recovery (run.resumed)', () => {
  it('re-parks a held node, never re-sending its request', () => {
    const eng = engine([web('w')]);
    const { state } = fold(eng, [started, dispatched('w', 'w#0'), awaiting('w', 'w#0')]);
    const r = eng.reduce(state, { type: 'run.resumed', runId: RUN, reason: 'boot_reconcile' });
    expect(r.commands).toEqual([
      { type: 'scheduleExternalWait', nodeId: 'w', attemptId: 'w#0', timeoutSeconds: 600 },
    ]);
  });
});

describe('#1600 C11c — a loop reset while parked (#1761)', () => {
  // A parked node can only be reset after it was ABANDONED: a loop's wall-clock
  // timeout flips its live children to `skipped` (`abandonLiveChildren` spreads
  // the node, so the held `callback` survives), the loop fails, its failure edge
  // runs `h`, and `h`'s back-edge to the loop resets the abandoned children. The
  // reset must drop the held request, or the next round's park would find a
  // stale record from the round before.
  it('a back-edge reset drops the held callback of an abandoned node', () => {
    const eng = createEngine({
      nodes: [web('w'), { ...web('h'), type: 'noop', config: {} }],
      edges: [
        { id: 'lp->h', from: 'lp', to: 'h', on: 'failure' },
        {
          id: 'h->lp:success',
          from: 'h',
          to: 'lp',
          on: 'success',
          back: true,
          maxBounces: 2,
        },
      ],
      containers: [{ id: 'lp', kind: 'loop', children: ['w'], maxRounds: 3, timeout: 60 }],
    });
    const parked = fold(eng, [started, dispatched('w', 'w#0'), awaiting('w', 'w#0')]);
    expect(parked.state.nodes.w!.callback).toBeDefined();

    const timedOut = fold(
      eng,
      [{ type: 'container.timedOut', runId: RUN, containerId: 'lp' }],
      parked.state,
    );
    expect(timedOut.state.nodes.w!.status).toBe('skipped');
    // The abandonment itself keeps the record; only the reset below drops it.
    expect(timedOut.state.nodes.w!.callback).toBeDefined();

    const bounced = fold(
      eng,
      [
        dispatched('h', 'h#0'),
        { type: 'node.succeeded', runId: RUN, nodeId: 'h', attemptId: 'h#0', outputs: {} },
      ],
      timedOut.state,
    );
    expect(Object.values(bounced.state.bounces)).toEqual([1]);
    expect(bounced.state.nodes.w!.status).toBe('pending');
    expect(bounced.state.nodes.w!.callback).toBeUndefined();
  });
});

describe('#1600 C11c — secure output', () => {
  const secure = web('w', {}, { secureOutput: true });
  const eng = engine([secure]);

  it('withholds the held request outputs and an early callback', () => {
    const held = eng.redact(awaiting('w', 'w#0'));
    expect(held.type === 'node.awaitingCallback' && held.outputs.status).toBe(SECURE_REDACTED);
    const early = eng.redact(created('w', 'w#0', { callback: { secret: 1 }, reportedError: 'x' }));
    expect(early.type === 'externalWait.created' && early.arrived).toEqual({
      callback: SECURE_REDACTED,
      reportedError: SECURE_ERROR_WITHHELD,
    });
    const done = eng.redact(completed('w', 'w#0', { secret: 1 }, 'y'));
    expect(done.type === 'externalWait.completed' && done.reportedError).toBe(
      SECURE_ERROR_WITHHELD,
    );
  });

  it('leaves a park without an early callback untouched', () => {
    const plain = created('w', 'w#0');
    expect(eng.redact(plain)).toEqual(plain);
  });
});

describe('#1600 C11c-2 — a Web with no Request URL only waits', () => {
  // No URL, no connection: the inbound-only wait a `webhook` was.
  const waitsOnly = (config: Record<string, unknown> = {}): Node => {
    const node = web('w', { callbackTimeoutSeconds: 120, ...config });
    delete node.config.method;
    if (!('url' in config)) delete node.config.url;
    delete node.connectionId;
    return node;
  };
  const NULLS = {
    status: null,
    headers: null,
    body: null,
    bytes: null,
    durationMs: null,
    truncated: null,
  };

  it('is never dispatched: run.started holds it ready and asks the driver to park it', () => {
    const eng = engine([waitsOnly()]);
    const r = eng.reduce(eng.seedState(), started);
    expect(r.commands).toEqual([
      { type: 'scheduleExternalWait', nodeId: 'w', attemptId: 'w#0', timeoutSeconds: 120 },
    ]);
    expect(r.state.nodes.w!.status).toBe('ready');
    expect(r.state.nodes.w!.callback).toEqual({
      attemptId: 'w#0',
      request: NULLS,
      timeoutSeconds: 120,
    });
  });

  it("waits ADF's 10 minutes when the timeout is empty", () => {
    const node = waitsOnly();
    delete node.config.callbackTimeoutSeconds;
    const eng = engine([node]);
    const r = eng.reduce(eng.seedState(), started);
    expect(r.commands).toEqual([expect.objectContaining({ timeoutSeconds: 600 })]);
  });

  it('an empty Request URL box is no URL', () => {
    const eng = engine([waitsOnly({ url: '' })]);
    const r = eng.reduce(eng.seedState(), started);
    expect(r.commands.map((c) => c.type)).toEqual(['scheduleExternalWait']);
  });

  it('a Web with a URL is still dispatched', () => {
    const eng = engine([web('w')]);
    const r = eng.reduce(eng.seedState(), started);
    expect(r.commands.map((c) => c.type)).toEqual(['dispatchNode']);
  });

  it('settles on the callback with null request outputs plus callback', () => {
    const eng = engine([waitsOnly()]);
    const callback = { approved: true };
    const r = fold(eng, [started, created('w', 'w#0'), completed('w', 'w#0', callback)]);
    expect(r.state.nodes.w!.status).toBe('success');
    expect(r.state.outputs.w).toEqual({ ...NULLS, callback });
  });

  it('a reported failure fails it', () => {
    const eng = engine([waitsOnly({ reportStatusOnCallback: true })]);
    const r = fold(eng, [
      started,
      created('w', 'w#0'),
      completed('w', 'w#0', { StatusCode: 403 }, 'the callback reported StatusCode 403'),
    ]);
    expect(r.state.nodes.w!.status).toBe('failure');
  });

  it('an expiry fails it', () => {
    const eng = engine([waitsOnly()]);
    const r = fold(eng, [
      started,
      created('w', 'w#0'),
      { type: 'externalWait.expired', runId: RUN, nodeId: 'w', previousAttemptId: 'w#0' },
    ]);
    expect(r.state.nodes.w!.status).toBe('failure');
  });

  it('a callback that came in the crash window settles it at the arm', () => {
    const eng = engine([waitsOnly()]);
    const r = fold(eng, [started, created('w', 'w#0', { callback: 'ok' })]);
    expect(r.state.nodes.w!.status).toBe('success');
    expect(r.state.outputs.w).toEqual({ ...NULLS, callback: 'ok' });
  });

  it('a crash before the park re-parks it on resume, never dispatching it', () => {
    const eng = engine([waitsOnly()]);
    const { state } = fold(eng, [started]);
    const r = eng.reduce(state, { type: 'run.resumed', runId: RUN, reason: 'boot_reconcile' });
    expect(r.commands).toEqual([
      { type: 'scheduleExternalWait', nodeId: 'w', attemptId: 'w#0', timeoutSeconds: 120 },
    ]);
  });

  it('an inactive one is marked, never parked', () => {
    const node = { ...waitsOnly(), state: 'inactive' as const };
    const eng = engine([node]);
    const r = eng.reduce(eng.seedState(), started);
    expect(r.commands.map((c) => c.type)).not.toContain('scheduleExternalWait');
    expect(r.state.nodes.w!.callback).toBeUndefined();
  });

  it('a callback timeout save would refuse fails the run cleanly instead of arming', () => {
    const eng = engine([waitsOnly({ callbackTimeoutSeconds: 0 })]);
    const r = eng.reduce(eng.seedState(), started);
    expect(r.commands).toEqual([
      expect.objectContaining({ type: 'finishRun', outcome: 'failure' }),
    ]);
  });

  it('a cancel before the park ends the wait at the arm', () => {
    const eng = engine([waitsOnly()]);
    const r = fold(eng, [started, cancel, created('w', 'w#0')]);
    expect(r.state.nodes.w!.status).toBe('failure');
  });
});
