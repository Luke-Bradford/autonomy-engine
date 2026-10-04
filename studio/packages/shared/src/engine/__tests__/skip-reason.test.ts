/**
 * #1484 M2 — WHY a node or container was skipped, recorded by the reducer at the
 * moment it decides the skip (`skipReason`), so the Monitor can say
 * `upstream failed: clean` or `branch not taken` without re-deriving the walk.
 *
 * The readiness causes are pinned here against the REAL reducer via the shared
 * `driveRun` harness. The two container causes (a loop timeout, a parallel
 * ForEach's doom) are pinned beside the tests that already drive those folds
 * (`reduce-p2c.test.ts`, `reduce-a4b.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { Container, Edge, EngineEvent, Node } from '../types.js';
import { createEngine, type Engine } from '../reduce.js';
import { driveRun, simpleResolve } from './helpers/run-driver.js';

let seq = 0;
function node(id: string): Node {
  seq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: seq, y: 0 } };
}
function ifNode(id: string, condition: string): Node {
  seq += 1;
  return { id, type: 'if', config: { condition }, position: { x: seq, y: 0 } };
}
function edge(from: string, to: string, on: 'success' | 'failure' | 'completion'): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}
function branchEdge(from: string, to: string, branch: string): Edge {
  return { id: `${from}->${to}:branch:${branch}`, from, to, on: 'branch', branch };
}
function eng(nodes: Node[], edges: Edge[], containers: Container[] = []): Engine {
  return createEngine({ nodes, edges, containers });
}

describe('skipReason — the reducer records why it skipped (#1484 M2)', () => {
  it('a success edge from a failed activity: upstream failed', () => {
    const e = eng([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const { state } = driveRun(e, { resolve: simpleResolve({ a: 'failure' }) });
    expect(state.nodes.b).toMatchObject({
      status: 'skipped',
      skipReason: { kind: 'upstream', from: 'a', outcome: 'failure' },
    });
  });

  it('two hops down still names the activity that failed, not the skipped one between', () => {
    const e = eng(
      [node('a'), node('b'), node('c')],
      [edge('a', 'b', 'success'), edge('b', 'c', 'success')],
    );
    const { state } = driveRun(e, { resolve: simpleResolve({ a: 'failure' }) });
    expect(state.nodes.c!.skipReason).toEqual({ kind: 'upstream', from: 'a', outcome: 'failure' });
  });

  it('the arm an If did not take: branch not taken, with the label it did take', () => {
    const e = eng(
      [ifNode('c', '${true}'), node('yes'), node('no'), node('after')],
      [
        branchEdge('c', 'yes', 'true'),
        branchEdge('c', 'no', 'false'),
        edge('no', 'after', 'success'),
      ],
    );
    const { state } = driveRun(e, { resolve: simpleResolve() });
    expect(state.nodes.yes!.skipReason).toBeUndefined();
    expect(state.nodes.no).toMatchObject({
      status: 'skipped',
      skipReason: { kind: 'branch', from: 'c', taken: 'true' },
    });
    // Downstream of the dead arm inherits the branch, not "upstream skipped: no".
    expect(state.nodes.after!.skipReason).toEqual({ kind: 'branch', from: 'c', taken: 'true' });
  });

  it('a failure handler whose activity succeeded: upstream succeeded', () => {
    const e = eng([node('a'), node('h')], [edge('a', 'h', 'failure')]);
    const { state } = driveRun(e, { resolve: simpleResolve() });
    expect(state.nodes.h!.skipReason).toEqual({ kind: 'upstream', from: 'a', outcome: 'success' });
  });

  it('join all: the dead predecessor is named, not the one that succeeded', () => {
    const e = eng(
      [node('ok'), node('bad'), node('j')],
      [edge('ok', 'j', 'success'), edge('bad', 'j', 'success')],
    );
    const { state } = driveRun(e, { resolve: simpleResolve({ bad: 'failure' }) });
    expect(state.nodes.j!.skipReason).toEqual({
      kind: 'upstream',
      from: 'bad',
      outcome: 'failure',
    });
  });

  it('a container skipped by its outer edge carries the reason too', () => {
    const e = eng(
      [node('a'), node('inner')],
      [edge('a', 'st', 'success')],
      [{ id: 'st', kind: 'stage', children: ['inner'] }],
    );
    const { state } = driveRun(e, { resolve: simpleResolve({ a: 'failure' }) });
    expect(state.containers.st).toMatchObject({
      status: 'skipped',
      skipReason: { kind: 'upstream', from: 'a', outcome: 'failure' },
    });
  });

  it('a loop round reset drops the reason with the skip', () => {
    // Round 1: x succeeds, so its failure handler h skips. The round ends in
    // that same reduce and resets both to `pending` for round 2: a reason left
    // behind would describe a skip that no longer exists.
    const e = eng(
      [node('x'), node('h')],
      [edge('x', 'h', 'failure')],
      [{ id: 'lp', kind: 'loop', children: ['x', 'h'], exitWhen: '${false}', maxRounds: 3 }],
    );
    const started: EngineEvent = {
      type: 'run.started',
      runId: 'r1',
      pipelineVersionId: 'pv1',
      params: {},
    };
    let s = e.reduce(e.seedState(), started).state;
    s = e.reduce(s, {
      type: 'node.dispatched',
      runId: 'r1',
      nodeId: 'x',
      attemptId: 'x#0',
      idempotent: true,
    }).state;
    s = e.reduce(s, {
      type: 'node.succeeded',
      runId: 'r1',
      nodeId: 'x',
      attemptId: 'x#0',
      outputs: {},
    }).state;
    expect(s.containers.lp!.round).toBe(1);
    expect(s.nodes.h!.status).toBe('pending');
    expect('skipReason' in s.nodes.h!).toBe(false);
  });
});
