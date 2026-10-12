/**
 * #1600 OR41 C0e — an INACTIVE container (catalogue spec §3: "Containers get
 * Name, Description, State"). It never enters: no `items` evaluation, no loop
 * alarm, no child dispatch. The walk folds it straight to its Mark as, with
 * `inactive: true`, and that outcome alone drives its outgoing edges. Pure, like
 * a container's enter and skip: no event, because the outcome is a function of
 * the pinned doc. Against the REAL reducer via the shared `driveRun` harness.
 */
import { describe, expect, it } from 'vitest';
import type { Container, Edge, Node } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { driveRun, simpleResolve } from './helpers/run-driver.js';

let seq = 0;
function node(id: string, extra: Partial<Node> = {}, type = 'agent_task'): Node {
  seq += 1;
  return { id, type, config: {}, position: { x: seq, y: 0 }, ...extra };
}
function edge(
  from: string,
  to: string,
  on: 'success' | 'failure' | 'completion' | 'skipped' = 'success',
): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}
/** An inactive foreach whose `items` would fail the run if it were ever read. */
function offForeach(markAs?: Container['onInactiveMarkAs']): Container {
  return {
    id: 'c',
    kind: 'foreach',
    children: ['body'],
    items: '${params.missing}',
    state: 'inactive',
    ...(markAs && { onInactiveMarkAs: markAs }),
  };
}
/** c → three handlers, one per outcome, plus a completion catch. */
function fan(c: Container): Engine {
  return createEngine({
    nodes: [node('body'), node('onS'), node('onF'), node('onSkip'), node('onDone')],
    edges: [
      edge('c', 'onS', 'success'),
      edge('c', 'onF', 'failure'),
      edge('c', 'onSkip', 'skipped'),
      edge('c', 'onDone', 'completion'),
    ],
    containers: [c],
  } satisfies EngineDoc);
}

describe('an inactive container never enters and records its Mark as (#1600 C0e)', () => {
  it('default Succeeded: never evaluates items or runs its body; success + completion edges run', () => {
    const { state, order, finish, log } = driveRun(fan(offForeach()), {
      resolve: simpleResolve(),
    });
    expect(order).not.toContain('body');
    expect(log.some((e) => 'nodeId' in e && e.nodeId === 'body')).toBe(false);
    expect(state.containers.c).toMatchObject({ status: 'success', inactive: true, outputs: {} });
    expect(state.containers.c!.items).toBeUndefined();
    expect(state.containers.c!.reason).toBeUndefined();
    // ADF: an inactive activity has no outputs, so none are projected.
    expect(state.outputs.c).toBeUndefined();
    expect(order).toEqual(expect.arrayContaining(['onS', 'onDone']));
    expect(state.nodes.onF!.status).toBe('skipped');
    expect(state.nodes.onSkip!.status).toBe('skipped');
    expect(finish?.outcome).toBe('success');
  });

  it('Failed: failure + completion edges run, with reason inactive; unhandled, it fails the run', () => {
    const handled = driveRun(fan(offForeach('failure')), { resolve: simpleResolve() });
    expect(handled.state.containers.c).toMatchObject({
      status: 'failure',
      inactive: true,
      reason: 'inactive',
    });
    expect(handled.order).toEqual(expect.arrayContaining(['onF', 'onDone']));
    expect(handled.order).not.toContain('onS');
    // Exactly the verdict a REAL container failure reaches in the same graph.
    const real = driveRun(
      createEngine({
        nodes: [
          node('body', { config: { message: 'boom' } }, 'fail'),
          node('onS'),
          node('onF'),
          node('onSkip'),
          node('onDone'),
        ],
        edges: [
          edge('c', 'onS', 'success'),
          edge('c', 'onF', 'failure'),
          edge('c', 'onSkip', 'skipped'),
          edge('c', 'onDone', 'completion'),
        ],
        containers: [{ id: 'c', kind: 'foreach', children: ['body'], items: '${params.list}' }],
      }),
      { params: { list: [1] }, resolve: simpleResolve() },
    );
    expect(real.state.containers.c!.status).toBe('failure');
    expect(handled.finish).toEqual(real.finish);

    const lone = driveRun(
      createEngine({ nodes: [node('body')], edges: [], containers: [offForeach('failure')] }),
      { resolve: simpleResolve() },
    );
    expect(lone.finish).toEqual({ outcome: 'failure', reason: 'node_failed:c' });
  });

  it('Skipped: only the skipped edge runs', () => {
    const { state, order } = driveRun(fan(offForeach('skipped')), { resolve: simpleResolve() });
    expect(state.containers.c).toMatchObject({ status: 'skipped', inactive: true });
    expect(state.containers.c!.skipReason).toBeUndefined();
    expect(order).toContain('onSkip');
    expect(order).not.toContain('onS');
    expect(order).not.toContain('onDone');
  });

  it('a timed loop arms no alarm, and a stage starts nothing', () => {
    const loop = driveRun(
      createEngine({
        nodes: [node('a'), node('b')],
        edges: [],
        containers: [
          {
            id: 'L',
            kind: 'loop',
            children: ['a'],
            exitWhen: '${true}',
            timeout: 60,
            state: 'inactive',
          },
          { id: 'S', kind: 'stage', children: ['b'], state: 'inactive' },
        ],
      }),
      { resolve: simpleResolve() },
    );
    expect(loop.log.some((e) => e.type === 'container.timeoutScheduled')).toBe(false);
    expect(loop.order).toEqual([]);
    expect(loop.state.containers.L).toMatchObject({ status: 'success', inactive: true });
    expect(loop.state.containers.S).toMatchObject({ status: 'success', inactive: true });
    expect(loop.finish?.outcome).toBe('success');
  });

  it('a container downstream of a skipped predecessor is skipped, not inactive', () => {
    const { state } = driveRun(
      createEngine({
        nodes: [node('up'), node('body')],
        edges: [edge('up', 'c', 'failure')],
        containers: [offForeach()],
      }),
      { resolve: simpleResolve() },
    );
    expect(state.containers.c!.status).toBe('skipped');
    expect(state.containers.c!.inactive).toBeUndefined();
  });

  it('replays to the same state from its own log', () => {
    const e = fan(offForeach('failure'));
    const { state, log } = driveRun(e, { resolve: simpleResolve() });
    let replay = e.seedState();
    for (const ev of log) replay = e.reduce(replay, ev).state;
    expect(replay).toEqual(state);
  });
});
