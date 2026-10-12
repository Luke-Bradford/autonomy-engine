/**
 * #1600 OR41 C0c — an INACTIVE activity (catalogue spec §3; ADF "deactivate an
 * activity"). It never runs: the walk records a `node.inactive` placeholder whose
 * `markAs` becomes its terminal status, and that outcome alone drives its
 * outgoing edges. Against the REAL reducer via the shared `driveRun` harness,
 * which folds `inactivateNode` exactly as the server driver's `pump` does.
 */
import { describe, expect, it } from 'vitest';
import type { Container, Edge, EngineEvent, Node } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { driveRun, simpleResolve } from './helpers/run-driver.js';

let seq = 0;
function node(id: string, extra: Partial<Node> = {}, type = 'agent_task'): Node {
  seq += 1;
  return { id, type, config: {}, position: { x: seq, y: 0 }, ...extra };
}
const off = (id: string, markAs?: Node['onInactiveMarkAs'], type?: string): Node =>
  node(id, { state: 'inactive', ...(markAs && { onInactiveMarkAs: markAs }) }, type);
function edge(
  from: string,
  to: string,
  on: 'success' | 'failure' | 'completion' | 'skipped' = 'success',
): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}
function eng(nodes: Node[], edges: Edge[] = [], containers: Container[] = []): Engine {
  return createEngine({ nodes, edges, containers } satisfies EngineDoc);
}
/** x → three handlers, one per outcome, plus a completion catch. */
function fan(x: Node): Engine {
  return eng(
    [x, node('onS'), node('onF'), node('onSkip'), node('onDone')],
    [
      edge('x', 'onS', 'success'),
      edge('x', 'onF', 'failure'),
      edge('x', 'onSkip', 'skipped'),
      edge('x', 'onDone', 'completion'),
    ],
  );
}
const inactiveEvents = (log: EngineEvent[]) => log.filter((e) => e.type === 'node.inactive');

describe('an inactive node never runs and records its Mark as (#1600 C0c)', () => {
  it('default Succeeded: success + completion edges run, failure + skipped do not; the run succeeds', () => {
    const { state, order, finish, log } = driveRun(fan(off('x')), { resolve: simpleResolve() });
    expect(order).not.toContain('x');
    expect(log.some((e) => e.type === 'node.dispatched' && e.nodeId === 'x')).toBe(false);
    expect(inactiveEvents(log)).toEqual([
      { type: 'node.inactive', runId: 'r1', nodeId: 'x', attemptId: 'x#0', markAs: 'success' },
    ]);
    expect(state.nodes.x).toMatchObject({ status: 'success', inactive: true });
    expect(state.outputs.x).toBeUndefined();
    expect(order).toEqual(expect.arrayContaining(['onS', 'onDone']));
    expect(state.nodes.onF!.status).toBe('skipped');
    expect(state.nodes.onSkip!.status).toBe('skipped');
    expect(finish?.outcome).toBe('success');
  });

  it('Failed: failure + completion edges run, and the run is judged as for a real failure', () => {
    const { state, order, finish } = driveRun(fan(off('x', 'failure')), {
      resolve: simpleResolve(),
    });
    expect(state.nodes.x).toMatchObject({ status: 'failure', inactive: true });
    expect(order).toEqual(expect.arrayContaining(['onF', 'onDone']));
    expect(order).not.toContain('onS');
    expect(state.nodes.onSkip!.status).toBe('skipped');
    // Exactly the verdict a REAL failure reaches in the same graph: the inactive
    // node changes what happened, never how the graph judges it.
    const real = driveRun(fan(node('x', { config: { message: 'boom' } }, 'fail')), {
      resolve: simpleResolve(),
    });
    expect(finish).toEqual(real.finish);
    expect(order).toEqual(real.order);
  });

  it('Failed and unhandled fails the run, blaming the node — and never retries, whatever the policy', () => {
    const { state, finish, log } = driveRun(eng([off('x', 'failure')]), {
      resolve: simpleResolve(),
    });
    expect(state.nodes.x!.status).toBe('failure');
    expect(finish).toEqual({ outcome: 'failure', reason: 'node_failed:x' });
    const withPolicy = driveRun(
      eng([node('x', { state: 'inactive', onInactiveMarkAs: 'failure', policy: { retry: 3 } })]),
      { resolve: simpleResolve() },
    );
    expect(withPolicy.log.some((e) => e.type === 'node.retryScheduled')).toBe(false);
    expect(withPolicy.state.nodes.x!.status).toBe('failure');
    expect(log.some((e) => e.type === 'node.failed')).toBe(false);
  });

  it('Skipped: only the skipped edge runs (completion does not catch a skip); no skip reason of its own', () => {
    const { state, order, finish } = driveRun(fan(off('x', 'skipped')), {
      resolve: simpleResolve(),
    });
    expect(state.nodes.x).toMatchObject({ status: 'skipped', inactive: true });
    expect(state.nodes.x!.skipReason).toBeUndefined();
    expect(order).toEqual(['onSkip']);
    expect(state.nodes.onS!.status).toBe('skipped');
    expect(state.nodes.onDone!.status).toBe('skipped');
    // A downstream skip names its upstream, not an "inactive" reason of its own.
    expect(state.nodes.onS!.skipReason).toMatchObject({ kind: 'upstream', from: 'x' });
    expect(finish?.outcome).toBe('success');
  });

  it('a node downstream of a SKIPPED predecessor is skipped, never recorded inactive (no event)', () => {
    const { state, log } = driveRun(
      eng([off('a', 'skipped'), off('b')], [edge('a', 'b', 'success')]),
      { resolve: simpleResolve() },
    );
    expect(state.nodes.b!.status).toBe('skipped');
    expect(state.nodes.b!.inactive).toBeUndefined();
    expect(inactiveEvents(log).map((e) => e.nodeId)).toEqual(['a']);
  });

  it('any type is switched off — a control node (fail) and a call node never evaluate or start', () => {
    const fail = driveRun(
      eng([node('f', { state: 'inactive', config: { message: 'boom' } } as Partial<Node>, 'fail')]),
      { resolve: simpleResolve() },
    );
    expect(fail.state.nodes.f).toMatchObject({ status: 'success', inactive: true });
    expect(fail.log.some((e) => e.type === 'node.failed')).toBe(false);
    expect(fail.finish?.outcome).toBe('success');
  });

  it('an inactive if marked Succeeded records no branch, and says nothing about a dead branch edge', () => {
    const ifNode = node('c', { state: 'inactive', config: { condition: '${true}' } }, 'if');
    const r = driveRun(
      eng(
        [ifNode, node('t')],
        [{ id: 'c->t:branch', from: 'c', to: 't', on: 'branch', branch: 'true' } as Edge],
      ),
      { resolve: simpleResolve() },
    );
    expect(r.state.nodes.c).toMatchObject({ status: 'success', inactive: true });
    expect(r.state.branches['c']).toBeUndefined();
    expect(r.state.nodes.t!.status).toBe('skipped');
    expect(r.diagnostics.some((d) => d.includes('without recording a branch'))).toBe(false);
  });

  it('inside a foreach every item records its own placeholder', () => {
    const { state, log, finish } = driveRun(
      eng(
        [off('w')],
        [],
        [{ id: 'fe', kind: 'foreach', children: ['w'], items: '${params.list}' }],
      ),
      { params: { list: [1, 2] }, resolve: simpleResolve() },
    );
    expect(inactiveEvents(log)).toHaveLength(2);
    expect(state.containers.fe!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  it('replays to the same state from its own log', () => {
    const e = fan(off('x', 'failure'));
    const { state, log } = driveRun(e, { resolve: simpleResolve() });
    let replay = e.seedState();
    for (const ev of log) replay = e.reduce(replay, ev).state;
    expect(replay).toEqual(state);
  });
});

describe('crash recovery never runs an inactive node (#1600 C0c)', () => {
  it('run.resumed re-emits inactivateNode — never dispatchNode — for a ready inactive node', () => {
    const e = eng([off('x', 'failure')]);
    const s = e.reduce(e.seedState(), {
      type: 'run.started',
      runId: 'r1',
      pipelineVersionId: 'pv1',
      params: {},
    }).state;
    expect(s.nodes.x!.status).toBe('ready');
    const resumed = e.reduce(s, { type: 'run.resumed', runId: 'r1', reason: 'boot_reconcile' });
    expect(resumed.commands).toEqual([
      { type: 'inactivateNode', nodeId: 'x', attemptId: 'x#0', markAs: 'failure' },
    ]);
  });

  it('a stale node.inactive (wrong attempt) is a no-op; one for a never-reached node is invalid', () => {
    const e = eng([off('x')], []);
    const s = e.reduce(e.seedState(), {
      type: 'run.started',
      runId: 'r1',
      pipelineVersionId: 'pv1',
      params: {},
    }).state;
    const stale = e.reduce(s, {
      type: 'node.inactive',
      runId: 'r1',
      nodeId: 'x',
      attemptId: 'x#9',
      markAs: 'success',
    });
    expect(stale.state).toBe(s);
    const e2 = eng([node('a'), off('b')], [edge('a', 'b')]);
    const s2 = e2.reduce(e2.seedState(), {
      type: 'run.started',
      runId: 'r1',
      pipelineVersionId: 'pv1',
      params: {},
    }).state;
    const bad = e2.reduce(s2, {
      type: 'node.inactive',
      runId: 'r1',
      nodeId: 'b',
      attemptId: 'b#0',
      markAs: 'success',
    });
    expect(bad.commands).toContainEqual({
      type: 'finishRun',
      outcome: 'failure',
      reason: 'invalid_event',
    });
  });
});
