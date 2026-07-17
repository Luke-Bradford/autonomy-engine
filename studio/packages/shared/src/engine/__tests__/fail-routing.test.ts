/**
 * #4 A7 — the `fail` control activity (run-time half).
 *
 * A `fail` node is engine-evaluated like `if`/`switch` (`kind:'control'`, never
 * dispatched), but it produces a FAILURE, not a branch: a ready `fail` resolves
 * its `${}` `message` PURELY, holds `ready`, and the driver appends `node.failed`
 * (`kind:'permanent'`, `code:'forced_fail'`) via the reducer's own `failNode`
 * command. The graph's `failure` edges then handle it (unhandled → the run fails,
 * ADF Fail's "fail the pipeline"). All against the REAL reducer via the shared
 * `driveRun` harness — no mocks; the harness folds the `failNode` command exactly
 * as the server driver's `pump` does.
 *
 * `fail` reuses the whole failure model (`onFailed`, `retryEligible`, `settle`)
 * and the control-evaluation handshake (hold `ready` → a driver-own command → a
 * durable event), differing only in the DECISION (resolve a message → force-fail
 * vs evaluate a branch) and the event (`node.failed` vs `condition.evaluated`).
 */
import { describe, expect, it } from 'vitest';
import type { Edge, EngineEvent, Node } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { driveRun, simpleResolve } from './helpers/run-driver.js';

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 } };
}
function failNode(id: string, message: unknown, extra: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'fail', config: { message }, position: { x: seq, y: 0 }, ...extra };
}
function edge(
  from: string,
  to: string,
  on: 'success' | 'failure' | 'completion' | 'skipped' = 'success',
): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}
function eng(nodes: Node[], edges: Edge[] = []): Engine {
  return createEngine({ nodes, edges } satisfies EngineDoc);
}

const started = (params: Record<string, unknown> = {}): EngineEvent => ({
  type: 'run.started',
  runId: 'r1',
  pipelineVersionId: 'pv1',
  params,
});

const failedEvent = (log: EngineEvent[], nodeId: string) =>
  log.find((e) => e.type === 'node.failed' && e.nodeId === nodeId) as
    Extract<EngineEvent, { type: 'node.failed' }> | undefined;

describe('fail force-fails the node with its authored message (#4 A7)', () => {
  it('an unhandled fail fails the run, blaming the fail node; node.failed carries the message, permanent kind, forced_fail code', () => {
    const e = eng([failNode('f', 'validation rejected the input')]);
    const { state, order, finish, finishes, log } = driveRun(e, { resolve: simpleResolve() });

    expect(state.nodes.f!.status).toBe('failure');
    // The DFS-blame reason is `node_failed:<id>` (a pinned invariant); the message
    // lives on `node.failed.error`, never the finish reason.
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('node_failed:f');
    expect(finishes).toBe(1);

    const fe = failedEvent(log, 'f');
    expect(fe?.error).toBe('validation rejected the input');
    expect(fe?.kind).toBe('permanent');
    expect(fe?.code).toBe('forced_fail');
    // Engine-evaluated: the fail node is NEVER dispatched to the executor.
    expect(order).not.toContain('f');
    expect(log.some((ev) => ev.type === 'node.dispatched' && ev.nodeId === 'f')).toBe(false);
  });

  it('resolves an embedded ${} template in the message', () => {
    const e = eng([failNode('f', 'rejected tier ${params.tier}')]);
    const { log } = driveRun(e, { params: { tier: 'bronze' }, resolve: simpleResolve() });
    expect(failedEvent(log, 'f')?.error).toBe('rejected tier bronze');
  });

  it("a fail's failure edge routes to a handler — the failure is handled, the run succeeds", () => {
    const e = eng([failNode('f', 'boom'), node('handler')], [edge('f', 'handler', 'failure')]);
    const { state, order, finish } = driveRun(e, { resolve: simpleResolve() });
    expect(state.nodes.f!.status).toBe('failure');
    expect(order).toContain('handler');
    expect(state.nodes.handler!.status).toBe('success');
    // A handled failure (a satisfied `failure` edge) does not fail the run — the
    // existing edge-model semantics, which `fail` inherits unchanged.
    expect(finish?.outcome).toBe('success');
  });

  it('is NOT retry-eligible even with a retry policy — a deliberate fail is permanent', () => {
    const e = eng([failNode('f', 'boom', { policy: { retry: 3 } })]);
    const { state, finish, log } = driveRun(e, { resolve: simpleResolve() });
    // kind is fixed `permanent`, so `retryEligible` never fires: the node settles
    // to `failure`, never `retry_pending`, and no retry is scheduled.
    expect(state.nodes.f!.status).toBe('failure');
    expect(finish?.outcome).toBe('failure');
    expect(log.some((ev) => ev.type === 'node.retryScheduled')).toBe(false);
  });

  it('a downstream node after a handled fail runs on the failure branch', () => {
    // fail -> handler (failure), handler -> done (success): the whole chain runs.
    const e = eng(
      [failNode('f', 'boom'), node('handler'), node('done')],
      [edge('f', 'handler', 'failure'), edge('handler', 'done', 'success')],
    );
    const { state, finish } = driveRun(e, { resolve: simpleResolve() });
    expect(state.nodes.done!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });
});

describe('fail with a malformed message fails the run LOUD (#4 A7)', () => {
  it('a missing message → invalid_event (never a manufactured default message)', () => {
    const e = eng([failNode('f', undefined)]);
    const { finish, finishes } = driveRun(e, { resolve: simpleResolve() });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
    expect(finishes).toBe(1);
  });

  it('an empty/whitespace message → invalid_event', () => {
    const e = eng([failNode('f', '   ')]);
    const { finish } = driveRun(e, { resolve: simpleResolve() });
    expect(finish?.reason).toBe('invalid_event');
  });

  it('a bad ${} ref in the message → invalid_event', () => {
    const e = eng([failNode('f', 'reason: ${nodes.missing.output.x}')]);
    const { finish } = driveRun(e, { resolve: simpleResolve() });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
  });
});

describe('fail crash recovery re-emits failNode (#4 A7)', () => {
  it('resume re-derives the failNode a projection discarded', () => {
    const e = eng([failNode('f', 'boom ${params.n}')]);
    // A log that ends the instant the fail became `ready`: the reducer emitted
    // `failNode`, but `projectRunState` keeps STATE not COMMANDS, so a crash here
    // loses it — without the resume fork the run hangs `ready` forever.
    const projected = e.projectRunState([started({ n: 1 })]);
    expect(projected.nodes.f!.status).toBe('ready');
    const { commands } = e.resume(projected);
    expect(commands).toContainEqual({
      type: 'failNode',
      nodeId: 'f',
      attemptId: 'f#0',
      error: 'boom 1',
    });
    // A control node must NEVER be re-dispatched to the executor on resume.
    expect(commands.some((c) => c.type === 'dispatchNode' && c.nodeId === 'f')).toBe(false);
  });
});
