import { describe, expect, it } from 'vitest';
import {
  ContainerRunStatusSchema,
  NodeRunStatusSchema,
  type EngineDoc,
  type RunEvent,
} from '@autonomy-studio/shared';
import {
  EMPTY_CARRY,
  containerStatusTone,
  engineForDoc,
  foldRunProjection,
  nodeStatusTone,
} from './runProjection';

const DOC: EngineDoc = {
  nodes: [
    { id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
    { id: 'b', type: 'http_request', position: { x: 200, y: 0 }, config: {} },
    { id: 'c', type: 'http_request', position: { x: 400, y: 0 }, config: {} },
  ],
  edges: [
    { id: 'e1', from: 'a', to: 'b', on: 'success' },
    { id: 'e2', from: 'a', to: 'c', on: 'failure' },
  ],
};

let seq = 0;
function ev(payload: Record<string, unknown>): RunEvent {
  return {
    id: `evt_${seq}`,
    runId: 'run_1',
    seq: seq++,
    type: String(payload.type),
    payload,
    ts: 1_700_000_000_000 + seq,
  } as RunEvent;
}

/**
 * A `run.started`, then the dispatch of `a`.
 *
 * The dispatch's `attemptId` is read back OFF THE PROJECTION rather than
 * hand-written: `onDispatched` ignores an event whose `attemptId` is not the
 * one the reducer itself assigned when the node became ready, so a made-up id
 * folds to nothing and the test would pass while asserting nothing happened.
 */
function startedLog(): RunEvent[] {
  seq = 0;
  const started = ev({
    type: 'run.started',
    runId: 'run_1',
    pipelineVersionId: 'pv_1',
    params: {},
  });
  const engine = engineForDoc(DOC);
  const afterStart = foldRunProjection(engine, DOC, [started], EMPTY_CARRY).projection;
  if (!afterStart.ok) throw new Error('fixture: run.started must project');
  const attemptId = afterStart.state.nodes.a?.currentAttemptId;
  if (attemptId === undefined) throw new Error('fixture: `a` must be ready with an attempt');

  return [
    started,
    ev({ type: 'node.dispatched', runId: 'run_1', nodeId: 'a', attemptId, idempotent: false }),
  ];
}

describe('foldRunProjection', () => {
  it('knows EVERY node in the doc once the run has started — the doc-free table cannot see a node that never ran', () => {
    // The doc is what buys this. `b` and `c` have no event of their own at this
    // point in the log, so `deriveNodeActivity` has nothing to put in a row for
    // them; the engine still reports them, because it was given the graph.
    const engine = engineForDoc(DOC);
    const { projection } = foldRunProjection(engine, DOC, startedLog(), EMPTY_CARRY);

    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    expect(Object.keys(projection.state.nodes).sort()).toEqual(['a', 'b', 'c']);
    expect(projection.state.nodes.b?.status).toBe('pending');
    expect(projection.state.nodes.c?.status).toBe('pending');
  });

  it('projects an EMPTY log to a state with no nodes at all — not to an all-pending graph', () => {
    // Load-bearing for the page: the seed is empty, so "no events yet" must NOT
    // be drawn as "every node is pending". A finished run rendered mid-replay
    // would otherwise claim nothing ran. The page gates the overlay on the
    // stream having finished replaying for exactly this reason.
    const engine = engineForDoc(DOC);
    const { projection } = foldRunProjection(engine, DOC, [], EMPTY_CARRY);

    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    expect(projection.state.nodes).toEqual({});
  });

  it('folds the engine reducer, so a dispatched node reports the ENGINE status', () => {
    const engine = engineForDoc(DOC);
    const { projection } = foldRunProjection(engine, DOC, startedLog(), EMPTY_CARRY);

    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    expect(projection.state.nodes.a?.status).toBe('dispatched');
    expect(projection.state.nodes.b?.status).toBe('pending');
  });

  it('an incremental suffix fold equals a full refold, event by event', () => {
    // The whole reason a carry exists. Fold the log one event at a time, reusing
    // the carry, and assert the result matches folding the same prefix cold.
    const engine = engineForDoc(DOC);
    const log = startedLog();

    let carry = EMPTY_CARRY;
    for (let i = 1; i <= log.length; i += 1) {
      const prefix = log.slice(0, i);
      const incremental = foldRunProjection(engine, DOC, prefix, carry);
      carry = incremental.carry;

      const cold = foldRunProjection(engineForDoc(DOC), DOC, prefix, EMPTY_CARRY);
      expect(incremental.projection).toEqual(cold.projection);
    }
    expect(carry.count).toBe(log.length);
  });

  it('refolds from the seed when the carry is not a prefix of the log (a shrunken log)', () => {
    const engine = engineForDoc(DOC);
    const log = startedLog();
    const { carry } = foldRunProjection(engine, DOC, log, EMPTY_CARRY);
    expect(carry.count).toBe(2);

    // A shorter log than the carry claims to have folded: the carry is invalid.
    const shrunk = foldRunProjection(engine, DOC, log.slice(0, 1), carry);
    const cold = foldRunProjection(engineForDoc(DOC), DOC, log.slice(0, 1), EMPTY_CARRY);
    expect(shrunk.projection).toEqual(cold.projection);
  });

  it('refolds from the seed when the DOC changed, never carrying one run’s state onto another graph', () => {
    const engine = engineForDoc(DOC);
    const { carry } = foldRunProjection(engine, DOC, startedLog(), EMPTY_CARRY);

    const otherDoc: EngineDoc = {
      nodes: [{ id: 'z', type: 'http_request', position: { x: 0, y: 0 }, config: {} }],
      edges: [],
    };
    seq = 100;
    const otherLog = [
      ev({ type: 'run.started', runId: 'run_2', pipelineVersionId: 'pv_2', params: {} }),
    ];
    const { projection } = foldRunProjection(engineForDoc(otherDoc), otherDoc, otherLog, carry);

    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    // `a`/`b`/`c` from the previous doc must not survive into this graph, and
    // the fold must have started from the seed rather than resuming at count 2.
    expect(Object.keys(projection.state.nodes)).toEqual(['z']);
    expect(projection.state.runId).toBe('run_2');
  });

  it('ABANDONS the projection on an unparseable event rather than folding a hole', () => {
    const engine = engineForDoc(DOC);
    seq = 0;
    const log = [ev({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} })];
    log.push({ ...log[0]!, id: 'evt_bad', seq: 1, type: 'node.dispatched', payload: { type: 'node.dispatched' } } as RunEvent);

    const { projection, carry } = foldRunProjection(engine, DOC, log, EMPTY_CARRY);
    expect(projection.ok).toBe(false);
    if (projection.ok) return;
    expect(projection.reason).toContain('event 1');
    // and the carry is dropped, so a later render cannot resume from the prefix
    expect(carry).toEqual(EMPTY_CARRY);
  });
});

describe('status tones', () => {
  it('maps every engine node status — no status is left without a tone', () => {
    for (const status of NodeRunStatusSchema.options) {
      expect(nodeStatusTone(status)).toBeTruthy();
    }
    // The groupings that carry meaning, pinned so a careless edit trips:
    expect(nodeStatusTone('pending')).toBe('neutral');
    expect(nodeStatusTone('dispatched')).toBe('running');
    expect(nodeStatusTone('skipped')).toBe('skipped');
    // All four parked statuses share ONE tone, and it is not `neutral` — a
    // parked node is not an idle one.
    for (const held of ['waiting', 'retry_pending', 'wait_pending', 'external_wait_pending'] as const) {
      expect(nodeStatusTone(held)).toBe('holding');
    }
  });

  it('maps every container status, with `active` as the container’s running tone', () => {
    for (const status of ContainerRunStatusSchema.options) {
      expect(containerStatusTone(status)).toBeTruthy();
    }
    expect(containerStatusTone('active')).toBe('running');
  });
});
