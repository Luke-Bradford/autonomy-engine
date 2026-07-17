/**
 * #4 A13 — the `webhook` external-wait control activity + the `externalWait.*`
 * event family it parks/resumes on.
 *
 * A `webhook` node is engine-evaluated like `wait` (`kind:'control'`, never
 * dispatched), and — like `wait` — DURABLE, but a DIFFERENT suspend/resume source:
 * where a `wait` parks `wait_pending` on S1's alarm and resumes on `timer.due`, a
 * `webhook` parks `external_wait_pending` and resumes when an inbound HTTP callback
 * appends `externalWait.completed` (→ `success`, no output) OR its expiry alarm
 * appends `externalWait.expired` (→ `failure`, so the node's `failure` edge routes
 * the timeout/default path). A ready `webhook` resolves its whole-value `${}`
 * `timeoutSeconds` PURELY, holds `ready`, and the driver emits the reducer's own
 * `scheduleExternalWait` command → arms the expiry alarm + correlation row → appends
 * `externalWait.created` (folding `ready` → `external_wait_pending`).
 *
 * Run-time assertions drive the REAL reducer (no mocks): the happy-path callback
 * via the shared `driveRun` harness (which folds `externalWait.created`+`completed`
 * for a `scheduleExternalWait`, having no HTTP layer), and the park/expiry/freshness
 * cases directly via `projectRunState`/`reduce`. Save-time assertions call the real
 * `validateDoc`/`validateRefs`. The route's real auth/replay + the alarm's real
 * timing/freshness are covered server-side (`routes/__tests__/external-wait.test.ts`,
 * `scheduler/__tests__/external-wait-alarm.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { Container, Edge, Node, Param, PipelineVersion } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { validateDoc, validateRefs, validatePipelineDoc } from '../params.js';
import { getActivity } from '../../catalog/registry.js';
import { CATALOG_VERSION } from '../../schemas/version.js';
import { driveRun, simpleResolve } from './helpers/run-driver.js';

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 } };
}
function webhookNode(
  id: string,
  timeoutSeconds: unknown,
  config: Record<string, unknown> = {},
): Node {
  seq += 1;
  return { id, type: 'webhook', config: { timeoutSeconds, ...config }, position: { x: seq, y: 0 } };
}
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
function doc(
  nodes: Node[],
  edges: Edge[] = [],
  containers: Container[] = [],
  params: Param[] = [],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'> {
  return { params, nodes, edges, containers };
}
const foreach = (id: string, children: string[], items: string): Container => ({
  id,
  kind: 'foreach',
  children,
  items,
});

/** Fold a webhook run up to (and including) the park, without resuming it. */
function parkedAt(e: Engine, id = 'w', attemptId = 'w#0') {
  return e.projectRunState([
    { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: {} },
    { type: 'externalWait.created', runId: 'r1', nodeId: id, attemptId, dueAt: 999 },
  ]);
}

describe('webhook parks then completes on an inbound callback (#4 A13)', () => {
  it('resolves timeoutSeconds, holds ready → external_wait_pending → success (never dispatched)', () => {
    const e = eng([webhookNode('w', '${5}')]);
    const { state, order, finish, log } = driveRun(e, { resolve: simpleResolve() });

    expect(state.nodes.w!.status).toBe('success');
    // #4 A16 — a webhook with no declared `config.outputs` completes with an EMPTY
    // typed-output object `{}` (consistent with every other succeeded node, which
    // always gets an `outputs` entry), not `undefined`. The driveRun harness has no
    // HTTP layer, so it folds `externalWait.completed` with no `outputs` field.
    expect(state.outputs.w).toEqual({});
    expect(finish?.outcome).toBe('success');
    // Engine-evaluated: never handed to the executor.
    expect(order).not.toContain('w');
    expect(log.some((ev) => ev.type === 'node.dispatched' && ev.nodeId === 'w')).toBe(false);
    // The durable external-wait facts are in the log, in order.
    const extTypes = log.filter((ev) => ev.type.startsWith('externalWait.')).map((ev) => ev.type);
    expect(extTypes).toEqual(['externalWait.created', 'externalWait.completed']);
  });

  it('a downstream node routes off the webhook success edge', () => {
    const e = eng([webhookNode('w', '${1}'), node('after')], [edge('w', 'after', 'success')]);
    const { state, order } = driveRun(e, { resolve: simpleResolve() });
    expect(state.nodes.after!.status).toBe('success');
    // `after` is a real activity (dispatched); the webhook is not.
    expect(order).toEqual(['after']);
  });

  it('the scheduleExternalWait command carries the resolved numeric timeoutSeconds', () => {
    const e = eng([webhookNode('w', '${30}')]);
    const projected = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: {} },
    ]);
    const { commands } = e.resume(projected);
    expect(commands).toContainEqual({
      type: 'scheduleExternalWait',
      nodeId: 'w',
      attemptId: 'w#0',
      timeoutSeconds: 30,
    });
    // A control node is NEVER dispatched to the executor.
    expect(commands.some((c) => c.type === 'dispatchNode' && c.nodeId === 'w')).toBe(false);
  });
});

describe('a parked webhook keeps the run alive (does NOT stall/finish) (#4 A13)', () => {
  it('a run whose sole live node is external_wait_pending stays running, not stalled', () => {
    const e = eng([webhookNode('w', '${5}'), node('after')], [edge('w', 'after', 'success')]);
    const state = parkedAt(e);
    expect(state.nodes.w!.status).toBe('external_wait_pending');
    expect(state.nodes.after!.status).toBe('pending');
    // The stalled-backstop (#491) must NOT terminalize a run parked on a callback.
    expect(state.status).toBe('running');
  });

  it('externalWait.completed then completes the parked node and the run', () => {
    const e = eng([webhookNode('w', '${5}')]);
    const parked = parkedAt(e);
    const { state, commands } = e.reduce(parked, {
      type: 'externalWait.completed',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#0',
    });
    expect(state.nodes.w!.status).toBe('success');
    expect(commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });
});

describe('webhook expiry fails the node and routes the failure edge (#4 A13)', () => {
  it('externalWait.expired folds external_wait_pending → failure and finishes failure', () => {
    const e = eng([webhookNode('w', '${5}')]);
    const parked = parkedAt(e);
    const { state, commands } = e.reduce(parked, {
      type: 'externalWait.expired',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#0',
    });
    expect(state.nodes.w!.status).toBe('failure');
    expect(commands).toContainEqual({
      type: 'finishRun',
      outcome: 'failure',
      reason: 'node_failed:w',
    });
  });

  it('a downstream node routes off the webhook FAILURE edge on expiry', () => {
    const e = eng(
      [webhookNode('w', '${5}'), node('onTimeout')],
      [edge('w', 'onTimeout', 'failure')],
    );
    const parked = parkedAt(e);
    // Drain the expiry + its downstream synchronously via reduce.
    let state = e.reduce(parked, {
      type: 'externalWait.expired',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#0',
    }).state;
    // The failure edge made `onTimeout` ready → dispatch → succeed.
    const cmds = e.resume(state).commands;
    const dispatch = cmds.find((c) => c.type === 'dispatchNode' && c.nodeId === 'onTimeout');
    expect(dispatch).toBeDefined();
    state = e.reduce(state, {
      type: 'node.dispatched',
      runId: 'r1',
      nodeId: 'onTimeout',
      attemptId: 'onTimeout#0',
      idempotent: true,
    }).state;
    const r = e.reduce(state, {
      type: 'node.succeeded',
      runId: 'r1',
      nodeId: 'onTimeout',
      attemptId: 'onTimeout#0',
      outputs: {},
    });
    expect(r.state.nodes.onTimeout!.status).toBe('success');
    // The webhook's handled failure lets the run SUCCEED (handled ⇒ success).
    expect(r.commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });

  it('an expiry is a PERMANENT failure — never re-parked, even with a retry policy', () => {
    // A webhook node carrying a retry policy: an expiry must NOT consult it (the
    // failure edge is the escape hatch, not a re-park). The fold goes straight to
    // `failure`, bypassing onFailed's retryEligible entirely.
    const w = webhookNode('w', '${5}');
    w.policy = { retry: 3, retryIntervalSeconds: 1 };
    const e = eng([w]);
    const parked = parkedAt(e);
    const { state, commands } = e.reduce(parked, {
      type: 'externalWait.expired',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#0',
    });
    expect(state.nodes.w!.status).toBe('failure');
    expect(commands.some((c) => c.type === 'scheduleRetry')).toBe(false);
    expect(commands.some((c) => c.type === 'scheduleExternalWait')).toBe(false);
  });
});

describe('externalWait freshness — at-least-once delivery is a no-op (#4 A13)', () => {
  it('a duplicate externalWait.completed for an already-succeeded webhook folds inertly', () => {
    const e = eng([webhookNode('w', '${5}')]);
    const done = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: {} },
      { type: 'externalWait.created', runId: 'r1', nodeId: 'w', attemptId: 'w#0', dueAt: 1 },
      { type: 'externalWait.completed', runId: 'r1', nodeId: 'w', previousAttemptId: 'w#0' },
    ]);
    expect(done.nodes.w!.status).toBe('success');
    const { state, commands, diagnostics } = e.reduce(done, {
      type: 'externalWait.completed',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#0',
    });
    expect(state.nodes.w!.status).toBe('success');
    expect(commands).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it('an externalWait.expired AFTER completion (completed-then-timeout race) is a no-op', () => {
    // The row is `completed`; a still-armed expiry alarm firing must NOT flip the
    // succeeded node to failure. The fold guards on `external_wait_pending`.
    const e = eng([webhookNode('w', '${5}')]);
    const done = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: {} },
      { type: 'externalWait.created', runId: 'r1', nodeId: 'w', attemptId: 'w#0', dueAt: 1 },
      { type: 'externalWait.completed', runId: 'r1', nodeId: 'w', previousAttemptId: 'w#0' },
    ]);
    const { state, commands } = e.reduce(done, {
      type: 'externalWait.expired',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#0',
    });
    expect(state.nodes.w!.status).toBe('success');
    expect(commands).toEqual([]);
  });

  it('an externalWait.completed naming a stale attempt is a no-op (still parked)', () => {
    const e = eng([webhookNode('w', '${5}')]);
    const parked = parkedAt(e);
    const { state, commands } = e.reduce(parked, {
      type: 'externalWait.completed',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#999',
    });
    expect(state.nodes.w!.status).toBe('external_wait_pending');
    expect(commands).toEqual([]);
  });

  it('a duplicate externalWait.created for an already-parked node is a no-op', () => {
    const e = eng([webhookNode('w', '${5}')]);
    const parked = parkedAt(e);
    const { state, commands } = e.reduce(parked, {
      type: 'externalWait.created',
      runId: 'r1',
      nodeId: 'w',
      attemptId: 'w#0',
      dueAt: 999,
    });
    // Guarded on `ready` at attempt — the second created event (an at-least-once
    // re-arm) folds inertly rather than re-parking.
    expect(state.nodes.w!.status).toBe('external_wait_pending');
    expect(commands).toEqual([]);
  });
});

describe('webhook with a malformed config fails the run LOUD (#4 A13)', () => {
  it('timeoutSeconds resolving to a non-finite value → invalid_event (never a silent default)', () => {
    const e = eng([webhookNode('w', '${params.bad}')]);
    const { finish, finishes } = driveRun(e, {
      params: { bad: 'not-a-number' },
      resolve: simpleResolve(),
    });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
    expect(finishes).toBe(1);
  });

  it('timeoutSeconds resolving to a NEGATIVE number → invalid_event', () => {
    const e = eng([webhookNode('w', '${params.neg}')]);
    const { finish } = driveRun(e, { params: { neg: -5 }, resolve: simpleResolve() });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
  });

  it('a bad ${} ref in timeoutSeconds → invalid_event', () => {
    const e = eng([webhookNode('w', '${nodes.missing.output.x}')]);
    const { finish } = driveRun(e, { resolve: simpleResolve() });
    expect(finish?.reason).toBe('invalid_event');
  });

  it('timeoutSeconds too large to keep dueAt a safe integer → invalid_event', () => {
    const e = eng([webhookNode('w', '${params.huge}')]);
    const { finish } = driveRun(e, { params: { huge: 1e300 }, resolve: simpleResolve() });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
  });

  it.each([
    ['an empty array', []],
    ['a single-element array (Number([5]) === 5)', [5]],
    ['a boolean', true],
    ['null', null],
    ['an empty string', ''],
    ['an object', { x: 1 }],
  ])('timeoutSeconds resolving to %s → invalid_event (no silent coercion)', (_label, value) => {
    const e = eng([webhookNode('w', '${params.v}')]);
    const { finish } = driveRun(e, { params: { v: value }, resolve: simpleResolve() });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
  });
});

describe('webhook crash recovery re-emits scheduleExternalWait (#4 A13)', () => {
  it('resume re-derives the scheduleExternalWait a projection discarded, never re-dispatching', () => {
    const e = eng([webhookNode('w', '${5}')]);
    const projected = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: {} },
    ]);
    // The command was discarded by the projection; the node is `ready`, not parked.
    expect(projected.nodes.w!.status).toBe('ready');
    const { commands } = e.resume(projected);
    expect(commands).toContainEqual({
      type: 'scheduleExternalWait',
      nodeId: 'w',
      attemptId: 'w#0',
      timeoutSeconds: 5,
    });
    expect(commands.some((c) => c.type === 'dispatchNode' && c.nodeId === 'w')).toBe(false);
  });

  it('an external_wait_pending node is NOT re-emitted on resume (its alarm is durable)', () => {
    // Once parked, resume re-derives NOTHING for the webhook — the alarm row + the
    // correlation row (armed BEFORE the externalWait.created append) are the sole
    // resolvers. Re-emitting scheduleExternalWait here would double-arm.
    const e = eng([webhookNode('w', '${5}')]);
    const parked = parkedAt(e);
    expect(parked.nodes.w!.status).toBe('external_wait_pending');
    const { commands } = e.resume(parked);
    expect(commands.some((c) => c.type === 'scheduleExternalWait')).toBe(false);
  });

  it('re-derives scheduleExternalWait for a webhook INSIDE a foreach, threading ${item} (#569)', () => {
    const e = eng([webhookNode('w', '${item}')], [], [foreach('fe', ['w'], '${params.timeouts}')]);
    const projected = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: { timeouts: [4, 5] } },
    ]);
    expect(projected.nodes.w!.status).toBe('ready');
    const { commands } = e.resume(projected);
    // Item 0's timeout = 4 reached `timeoutSeconds`; the recovery fork passed
    // `foreachItemOf` so `${item}` resolves rather than throwing (the #569 shape).
    expect(commands).toContainEqual({
      type: 'scheduleExternalWait',
      nodeId: 'w',
      attemptId: 'w#0',
      timeoutSeconds: 4,
    });
    expect(commands.some((c) => c.type === 'finishRun')).toBe(false);
  });
});

describe('webhook save-time validation (#4 A13)', () => {
  it('accepts a well-formed webhook', () => {
    const d = doc([webhookNode('w', '${300}')]);
    expect(validatePipelineDoc(d)).toEqual([]);
  });

  it('accepts a ${} timeoutSeconds referencing an upstream output', () => {
    const d = doc(
      [node('a'), webhookNode('w', '${nodes.a.output.ttl}')],
      [edge('a', 'w', 'success')],
    );
    expect(validateRefs(d)).toEqual([]);
  });

  it('rejects a missing timeoutSeconds', () => {
    const d = doc([webhookNode('w', undefined)]);
    expect(validateDoc(d).join(' ')).toMatch(/timeoutSeconds/);
  });

  it('rejects an empty timeoutSeconds', () => {
    const d = doc([webhookNode('w', '   ')]);
    expect(validateDoc(d).join(' ')).toMatch(/timeoutSeconds/);
  });

  it('rejects a non-whole-value timeoutSeconds (embedded template) → whole-value error', () => {
    const d = doc(
      [webhookNode('w', 'expire in ${params.n} sec')],
      [],
      [],
      [{ name: 'n', type: 'number', required: true }],
    );
    expect(validateDoc(d).join(' ')).toContain('whole-value');
  });

  it('rejects a bad ${} ref in timeoutSeconds at SAVE', () => {
    const d = doc([webhookNode('w', '${nodes.ghost.output.y}')]);
    expect(validateRefs(d).join(' ')).toMatch(/ghost/);
  });
});

describe('webhook typed output — the fold stores declared outputs (#4 A16)', () => {
  const declared = (outputs: Array<{ name: string; type: string }>) => ({ outputs });

  it('stores the declared, filtered outputs the completion event carries', () => {
    const e = eng([webhookNode('w', '${5}', declared([{ name: 'decision', type: 'string' }]))]);
    const parked = parkedAt(e);
    const { state, commands } = e.reduce(parked, {
      type: 'externalWait.completed',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#0',
      outputs: { decision: 'approve' },
    });
    expect(state.nodes.w!.status).toBe('success');
    expect(state.outputs.w).toEqual({ decision: 'approve' });
    expect(commands).toContainEqual({ type: 'finishRun', outcome: 'success' });
  });

  it('a downstream node reads the webhook output via ${nodes.w.output.decision}', () => {
    const w = webhookNode('w', '${5}', declared([{ name: 'decision', type: 'string' }]));
    const after: Node = {
      id: 'after',
      type: 'agent_task',
      config: { note: '${nodes.w.output.decision}' },
      position: { x: 99, y: 0 },
    };
    const e = eng([w, after], [edge('w', 'after', 'success')]);
    const parked = parkedAt(e);
    const state = e.reduce(parked, {
      type: 'externalWait.completed',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#0',
      outputs: { decision: 'reject' },
    }).state;
    const cmd = e
      .resume(state)
      .commands.find((c) => c.type === 'dispatchNode' && c.nodeId === 'after');
    expect(cmd).toBeDefined();
    // The resolved input carried the webhook's typed output downstream.
    expect((cmd as { preparedInput?: Record<string, unknown> }).preparedInput).toEqual({
      note: 'reject',
    });
  });

  it('re-filters undeclared keys in the event, never seeding an unrefable output', () => {
    // A hand-crafted/imported event with an undeclared extra key must not leak it
    // into run state — the fold re-runs storeOutputs against the version contract.
    const e = eng([webhookNode('w', '${5}', declared([{ name: 'decision', type: 'string' }]))]);
    const parked = parkedAt(e);
    const { state } = e.reduce(parked, {
      type: 'externalWait.completed',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#0',
      outputs: { decision: 'approve', secret: 'leaked' },
    });
    expect(state.outputs.w).toEqual({ decision: 'approve' });
  });

  it('a webhook with no declared outputs stores {} (A13 empty-outputs preserved)', () => {
    const e = eng([webhookNode('w', '${5}')]);
    const parked = parkedAt(e);
    const { state } = e.reduce(parked, {
      type: 'externalWait.completed',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#0',
      outputs: { decision: 'approve' },
    });
    expect(state.nodes.w!.status).toBe('success');
    // No contract → nothing refable → store nothing.
    expect(state.outputs.w).toEqual({});
  });

  it('a pre-A16 completion event with no outputs field folds to empty outputs', () => {
    const e = eng([webhookNode('w', '${5}', declared([{ name: 'decision', type: 'string' }]))]);
    const parked = parkedAt(e);
    const { state } = e.reduce(parked, {
      type: 'externalWait.completed',
      runId: 'r1',
      nodeId: 'w',
      previousAttemptId: 'w#0',
    });
    expect(state.nodes.w!.status).toBe('success');
    expect(state.outputs.w).toEqual({});
  });

  it('the static ref-checker accepts a ${nodes.w.output.X} against a declared webhook', () => {
    const d = doc(
      [
        webhookNode('w', '${5}', declared([{ name: 'decision', type: 'string' }])),
        node('after', { note: '${nodes.w.output.decision}' }),
      ],
      [edge('w', 'after', 'success')],
    );
    expect(validateRefs(d)).toEqual([]);
  });

  it('the static ref-checker rejects a ${nodes.w.output.X} the webhook does NOT declare', () => {
    const d = doc(
      [
        webhookNode('w', '${5}', declared([{ name: 'decision', type: 'string' }])),
        node('after', { note: '${nodes.w.output.ghost}' }),
      ],
      [edge('w', 'after', 'success')],
    );
    expect(validateRefs(d).join(' ')).toMatch(/ghost/);
  });
});

describe('webhook catalog entry (#4 A13)', () => {
  it('is a control activity with no connection and no outputs', () => {
    const entry = getActivity('webhook');
    expect(entry?.kind).toBe('control');
    expect(entry?.connectionKinds).toEqual([]);
    expect(entry?.outputs).toEqual([]);
  });

  it('cataloguing the webhook type bumped CATALOG_VERSION to at least 10', () => {
    // `>=` (not `toBe(10)`) so a later catalog TYPE bump does not falsely fail this
    // assertion; it still pins that the webhook bump (10) landed and never regresses.
    expect(CATALOG_VERSION).toBeGreaterThanOrEqual(10);
  });
});
