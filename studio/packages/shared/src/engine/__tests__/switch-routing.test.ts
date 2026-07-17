/**
 * #4 A2 — the `switch` control activity (run-time half).
 *
 * Mirrors `branch-routing.test.ts` (the `if` half): a `switch` node evaluates its
 * `${}` `on` expression to a STRING, the driver makes the chosen branch durable
 * (`switch.evaluated` → folded into `state.branches`), `edgeState` satisfies
 * exactly the matched case arm (or `default`), and the un-taken arms skip. All
 * against the REAL reducer via the shared `driveRun` harness — no mocks; the
 * harness folds the reducer's own `evaluateControl` command exactly as the server
 * driver's `pump` does.
 *
 * `switch` reuses the whole A0 branch/outcome model (`state.branches`, `edgeState`,
 * `noteDeadBranchOnSkip`) and the A1 control-evaluation machinery (`evaluateControl`
 * → a durable event), differing only in the DECISION (a value match vs a boolean)
 * and the event name (`switch.evaluated` vs `condition.evaluated`).
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
function switchNode(id: string, on: unknown, cases: unknown): Node {
  seq += 1;
  return { id, type: 'switch', config: { on, cases }, position: { x: seq, y: 0 } };
}
function branchEdge(from: string, to: string, branch: string): Edge {
  return { id: `${from}->${to}:branch:${branch}`, from, to, on: 'branch', branch };
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

describe('switch routes the matched case, skips the others (#4 A2)', () => {
  it('a value matching a declared case runs that arm and skips the rest', () => {
    const e = eng(
      [switchNode('s', '${params.tier}', ['gold', 'silver']), node('a'), node('b'), node('d')],
      [
        branchEdge('s', 'a', 'gold'),
        branchEdge('s', 'b', 'silver'),
        branchEdge('s', 'd', 'default'),
      ],
    );
    const { state, order, finish, finishes, log } = driveRun(e, {
      params: { tier: 'gold' },
      resolve: simpleResolve(),
    });
    expect(state.nodes.s!.status).toBe('success');
    expect(state.branches['s']).toBe('gold');
    // The DISTINCT durable event flows through the pump + fold (not the `if`'s
    // `condition.evaluated`) — the log carries `switch.evaluated`, no `condition.*`.
    expect(log.map((ev) => ev.type)).toContain('switch.evaluated');
    expect(log.map((ev) => ev.type)).not.toContain('condition.evaluated');
    expect(order).toContain('a');
    expect(state.nodes.a!.status).toBe('success');
    expect(state.nodes.b!.status).toBe('skipped');
    expect(state.nodes.d!.status).toBe('skipped');
    expect(finish?.outcome).toBe('success');
    expect(finishes).toBe(1);
  });

  it('a value matching NO case routes to the default arm', () => {
    const e = eng(
      [switchNode('s', '${params.tier}', ['gold', 'silver']), node('a'), node('d')],
      [branchEdge('s', 'a', 'gold'), branchEdge('s', 'd', 'default')],
    );
    const { state, order, finish } = driveRun(e, {
      params: { tier: 'bronze' },
      resolve: simpleResolve(),
    });
    expect(state.branches['s']).toBe('default');
    expect(order).toContain('d');
    expect(state.nodes.d!.status).toBe('success');
    expect(state.nodes.a!.status).toBe('skipped');
    expect(finish?.outcome).toBe('success');
  });

  it('routes on an EMBEDDED string template (not just a whole-value ${})', () => {
    // `switch` matches on a STRING, so a composite label like "tier-${x}" is a
    // legitimate `on` (unlike `if`, whose boolean can only come whole-value). This
    // is the A2-1 correctness point — an embedded template must NOT be rejected.
    const e = eng(
      [switchNode('s', 'tier-${params.n}', ['tier-1', 'tier-2']), node('a'), node('d')],
      [branchEdge('s', 'a', 'tier-1'), branchEdge('s', 'd', 'default')],
    );
    const { state, finish } = driveRun(e, { params: { n: 1 }, resolve: simpleResolve() });
    expect(state.branches['s']).toBe('tier-1');
    expect(state.nodes.a!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  it('the switch node is never dispatched to the executor', () => {
    const e = eng(
      [switchNode('s', '${params.tier}', ['gold']), node('a')],
      [branchEdge('s', 'a', 'gold')],
    );
    const { order } = driveRun(e, { params: { tier: 'gold' }, resolve: simpleResolve() });
    expect(order).not.toContain('s');
    expect(order).toEqual(['a']);
  });
});

describe('switch on-expression failures terminalize invalid_event (#4 A2)', () => {
  it('a non-string whole-value on fails the run invalid_event', () => {
    // `params.n` is a NUMBER → `evalSwitchBranch` throws (a switch matches on a
    // string) → prepFailure → finishRun{invalid_event}.
    const e = eng([switchNode('s', '${params.n}', ['1']), node('a')], [branchEdge('s', 'a', '1')]);
    const { finish } = driveRun(e, { params: { n: 1 }, resolve: simpleResolve() });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
  });

  it('a missing on fails the run invalid_event', () => {
    const badSwitch: Node = {
      id: 's',
      type: 'switch',
      config: { cases: ['x'] },
      position: { x: 0, y: 0 },
    };
    const e = eng([badSwitch, node('a')], [branchEdge('s', 'a', 'x')]);
    const { finish } = driveRun(e, { resolve: simpleResolve() });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
  });
});

describe('switch reuses the A0 branch model (#4 A2)', () => {
  it('inside a container it routes identically (container parity)', () => {
    const e = createEngine({
      nodes: [switchNode('s', '${params.tier}', ['gold', 'silver']), node('a'), node('b')],
      edges: [branchEdge('s', 'a', 'gold'), branchEdge('s', 'b', 'silver')],
      containers: [{ id: 'stg', kind: 'stage', children: ['s', 'a', 'b'] }],
    });
    const { state, finish } = driveRun(e, { params: { tier: 'gold' }, resolve: simpleResolve() });
    expect(state.branches['s']).toBe('gold');
    expect(state.nodes.a!.status).toBe('success');
    expect(state.nodes.b!.status).toBe('skipped');
    expect(state.containers.stg!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  it('the other-arm skip is NOT flagged as a dead-branch anomaly', () => {
    const e = eng(
      [switchNode('s', '${params.tier}', ['gold', 'silver']), node('a'), node('b')],
      [branchEdge('s', 'a', 'gold'), branchEdge('s', 'b', 'silver')],
    );
    const { state, diagnostics } = driveRun(e, {
      params: { tier: 'gold' },
      resolve: simpleResolve(),
    });
    expect(state.nodes.b!.status).toBe('skipped');
    expect(diagnostics.join(' ')).not.toMatch(/was skipped.*without recording a/);
  });
});

describe('switch.evaluated folding — attempt guards (#4 A2)', () => {
  it('ignores a stale switch.evaluated (wrong attempt)', () => {
    const e = eng(
      [switchNode('s', '${params.tier}', ['gold']), node('a')],
      [branchEdge('s', 'a', 'gold')],
    );
    let st = e.seedState();
    st = e.reduce(st, started({ tier: 'gold' })).state; // switch is a root → ready, attempt s#0
    expect(st.nodes.s!.status).toBe('ready');
    const stale = e.reduce(st, {
      type: 'switch.evaluated',
      runId: 'r1',
      nodeId: 's',
      attemptId: 's#99',
      branch: 'gold',
    });
    expect(stale.state.nodes.s!.status).toBe('ready'); // unchanged
    expect(stale.state.branches['s']).toBeUndefined();
  });
});

describe('switch crash recovery re-emits evaluateControl (#4 A2)', () => {
  it('resume re-derives the switch.evaluated evaluateControl a projection discarded', () => {
    const e = eng(
      [switchNode('s', '${params.tier}', ['gold']), node('a')],
      [branchEdge('s', 'a', 'gold')],
    );
    const projected = e.projectRunState([started({ tier: 'gold' })]);
    expect(projected.nodes.s!.status).toBe('ready');
    const { commands } = e.resume(projected);
    expect(commands).toContainEqual({
      type: 'evaluateControl',
      nodeId: 's',
      attemptId: 's#0',
      branch: 'gold',
      event: 'switch.evaluated',
    });
  });
});
