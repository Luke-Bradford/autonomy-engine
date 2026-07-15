/**
 * The unified edge/outcome model — spec #1 D5 (F1) + F14, with the business
 * `branch` member #4 A0 implements against.
 *
 * Three things are pinned here:
 *
 * 1. **`skipped` routing (F1).** A skipped predecessor used to make EVERY
 *    outgoing edge impossible, so a skip swallowed the rest of the graph. An
 *    `on:'skipped'` edge now catches it. `completion` deliberately does NOT
 *    fire on a skip — ADF's four paths are distinct ("Upon Completion | …after
 *    the current activity completed, regardless if it succeeded or not" vs
 *    "Upon Skip | …if the activity itself didn't run"), so a skip propagates
 *    unless something explicitly catches it.
 * 2. **JOIN semantics (F14/T7).** AND across predecessors, OR among the
 *    conditions on ONE predecessor. Without the OR, `a --success--> d` +
 *    `a --skipped--> d` could never both satisfy, so `d` always skipped —
 *    which is exactly the ADF Try-Catch-Proceed shape D5 adds `skipped` for.
 * 3. **Success semantics (D5) — CHARACTERIZATION ONLY.** These tests record
 *    what the reducer does TODAY, including where it diverges from the ADF
 *    target. D5 says change `finishRun` only if the tests show divergence, and
 *    that reconcile is its own ticket (F1b) — so the divergence is documented
 *    and asserted here, not fixed.
 */
import { describe, expect, it } from 'vitest';
import type { Edge, EngineCommand, EngineEvent, Node } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 } };
}

function edge(
  from: string,
  to: string,
  on: 'success' | 'failure' | 'completion' | 'skipped',
): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}

function branchEdge(from: string, to: string, branch: string): Edge {
  return { id: `${from}->${to}:branch:${branch}`, from, to, on: 'branch', branch };
}

function engine(nodes: Node[], edges: Edge[] = []): Engine {
  return createEngine({ nodes, edges } satisfies EngineDoc);
}

const RUN = 'r1';
const PV = 'pv1';

/**
 * Drive a run to completion, resolving each dispatched node from `outcomes`
 * (default: success), and report the `finishRun` the engine asked for plus
 * every diagnostic it emitted. Same command-QUEUE shape as `reduce.test.ts`'s
 * `runAll` — a reduce can emit several `dispatchNode`s at once (a fan-out), so
 * draining a queue rather than taking the first command is load-bearing. The
 * real reducer, real events, no mocks.
 */
function runAll(eng: Engine, outcomes: Record<string, 'success' | 'failure'> = {}) {
  let state = eng.seedState();
  const pending: EngineCommand[] = [];
  const diagnostics: string[] = [];
  let finish: { outcome: 'success' | 'failure'; reason?: string } | undefined;

  const apply = (ev: EngineEvent): void => {
    const r = eng.reduce(state, ev);
    state = r.state;
    diagnostics.push(...r.diagnostics);
    pending.push(...r.commands);
  };

  apply({ type: 'run.started', runId: RUN, pipelineVersionId: PV, params: {} });
  let guard = 0;
  while (pending.length) {
    if (guard++ > 2000) throw new Error('driver did not converge');
    const c = pending.shift()!;
    if (c.type === 'finishRun') {
      finish = { outcome: c.outcome, reason: c.reason };
      apply({ type: 'run.finished', runId: RUN, outcome: c.outcome, reason: c.reason });
      continue;
    }
    if (c.type !== 'dispatchNode') continue; // these docs are call-free
    apply({
      type: 'node.dispatched',
      runId: RUN,
      nodeId: c.nodeId,
      attemptId: c.attemptId,
      idempotent: true,
    });
    apply(
      (outcomes[c.nodeId] ?? 'success') === 'failure'
        ? {
            type: 'node.failed',
            runId: RUN,
            nodeId: c.nodeId,
            attemptId: c.attemptId,
            error: 'boom',
            kind: 'permanent',
          }
        : {
            type: 'node.succeeded',
            runId: RUN,
            nodeId: c.nodeId,
            attemptId: c.attemptId,
            outputs: {},
          },
    );
  }
  return { state, finish, diagnostics };
}

describe('skipped edges (F1)', () => {
  it('an on:skipped edge CATCHES a skipped predecessor', () => {
    // x succeeds → x->a(failure) is unsatisfied-terminal → a skipped.
    // a->handler(skipped) must now fire: this is the whole point of F1.
    const eng = engine(
      [node('x'), node('a'), node('handler')],
      [edge('x', 'a', 'failure'), edge('a', 'handler', 'skipped')],
    );
    const { state, finish } = runAll(eng);
    expect(state.nodes.a!.status).toBe('skipped');
    expect(state.nodes.handler!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  it('a skipped predecessor does NOT satisfy a success edge', () => {
    const eng = engine(
      [node('x'), node('a'), node('b')],
      [edge('x', 'a', 'failure'), edge('a', 'b', 'success')],
    );
    const { state } = runAll(eng);
    expect(state.nodes.a!.status).toBe('skipped');
    expect(state.nodes.b!.status).toBe('skipped'); // skip propagates
  });

  it('completion does NOT fire on a skip — a skip is not a completion (ADF)', () => {
    // The distinction is load-bearing: if `completion` swallowed skips, "run
    // this whatever happened" would also run for activities that never ran.
    const eng = engine(
      [node('x'), node('a'), node('after')],
      [edge('x', 'a', 'failure'), edge('a', 'after', 'completion')],
    );
    const { state } = runAll(eng);
    expect(state.nodes.a!.status).toBe('skipped');
    expect(state.nodes.after!.status).toBe('skipped');
  });

  it('completion still fires on both success and failure', () => {
    const eng = engine(
      [node('ok'), node('bad'), node('afterOk'), node('afterBad')],
      [edge('ok', 'afterOk', 'completion'), edge('bad', 'afterBad', 'completion')],
    );
    const { state } = runAll(eng, { bad: 'failure' });
    expect(state.nodes.afterOk!.status).toBe('success');
    expect(state.nodes.afterBad!.status).toBe('success');
  });

  it('an on:skipped edge does NOT fire when the predecessor actually ran', () => {
    const eng = engine([node('a'), node('h')], [edge('a', 'h', 'skipped')]);
    const { state } = runAll(eng);
    expect(state.nodes.a!.status).toBe('success');
    expect(state.nodes.h!.status).toBe('skipped');
  });

  // ADF "Generic error handling": UponFailure and UponSkip both land on one
  // handler. An on:skipped edge must NOT count as handling a FAILURE — if it
  // did, a failed node with only a skip-edge would silently pass the run.
  it('a failed node whose only outgoing edge is on:skipped is UNHANDLED → run fails', () => {
    const eng = engine([node('a'), node('h')], [edge('a', 'h', 'skipped')]);
    const { state, finish } = runAll(eng, { a: 'failure' });
    expect(state.nodes.a!.status).toBe('failure');
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('node_failed:a');
  });
});

describe('JOIN semantics (F14 / T7)', () => {
  // The F14 fix. Before: join:'all' ANDed across every EDGE, so two conditions
  // on one predecessor could never both satisfy → the target always skipped.
  it('OR among conditions on ONE predecessor — success|skipped both land on d', () => {
    const eng = engine(
      [node('a'), node('d')],
      [edge('a', 'd', 'success'), edge('a', 'd', 'skipped')],
    );
    const { state } = runAll(eng);
    expect(state.nodes.a!.status).toBe('success');
    expect(state.nodes.d!.status).toBe('success'); // the success arm satisfied it
  });

  it('OR among conditions on ONE predecessor — the skip arm satisfies it', () => {
    const eng = engine(
      [node('x'), node('a'), node('d')],
      [edge('x', 'a', 'failure'), edge('a', 'd', 'success'), edge('a', 'd', 'skipped')],
    );
    const { state } = runAll(eng);
    expect(state.nodes.a!.status).toBe('skipped');
    expect(state.nodes.d!.status).toBe('success'); // caught by the skipped arm
  });

  // ADF Try-Catch-Proceed. Note the shape: `proceed` is deliberately NOT
  // connected to `try` ("Add second activity, but don't connect to the first
  // activity") — it hangs off the HANDLER by two paths, which is what makes
  // "Next Activity will run regardless if First Activity succeeds or not"
  // work. Per the doc's note: "Multiple paths can point to the same activity.
  // For example, UponSuccess and UponSkip can both point to one activity."
  // Wiring `try --success--> proceed` as well would be WRONG: try's group goes
  // dead when it fails, and the AND across predecessors would skip proceed.
  it('ADF Try-Catch-Proceed — proceed runs whether the handler ran or was skipped', () => {
    const tryCatch = (): Edge[] => [
      edge('try', 'handler', 'failure'),
      edge('handler', 'proceed', 'success'),
      edge('handler', 'proceed', 'skipped'),
    ];
    // try SUCCEEDS → handler skipped → proceed still runs (the skip arm).
    const ok = runAll(engine([node('try'), node('handler'), node('proceed')], tryCatch()));
    expect(ok.state.nodes.handler!.status).toBe('skipped');
    expect(ok.state.nodes.proceed!.status).toBe('success');
    expect(ok.finish?.outcome).toBe('success');

    // try FAILS → handler runs and succeeds → proceed runs (the success arm).
    const bad = runAll(engine([node('try'), node('handler'), node('proceed')], tryCatch()), {
      try: 'failure',
    });
    expect(bad.state.nodes.handler!.status).toBe('success');
    expect(bad.state.nodes.proceed!.status).toBe('success');
    expect(bad.finish?.outcome).toBe('success'); // try's failure was handled
  });

  it('AND across predecessors still holds — a dead predecessor skips the target', () => {
    // d needs BOTH a and b. b fails (handled), so b's group is dead → d skipped
    // even though a's group is satisfied.
    const eng = engine(
      [node('a'), node('b'), node('d', { join: 'all' }), node('catch')],
      [edge('a', 'd', 'success'), edge('b', 'd', 'success'), edge('b', 'catch', 'failure')],
    );
    const { state } = runAll(eng, { b: 'failure' });
    expect(state.nodes.d!.status).toBe('skipped');
  });

  it('AND across predecessors, OR within each — d runs when every group has an arm', () => {
    // a succeeds (success arm); b fails → its failure arm satisfies. Both
    // groups satisfied → d runs. Under the old edge-wise AND this was skipped.
    const eng = engine(
      [node('a'), node('b'), node('d', { join: 'all' })],
      [
        edge('a', 'd', 'success'),
        edge('a', 'd', 'skipped'),
        edge('b', 'd', 'success'),
        edge('b', 'd', 'failure'),
      ],
    );
    const { state, finish } = runAll(eng, { b: 'failure' });
    expect(state.nodes.d!.status).toBe('success');
    expect(finish?.outcome).toBe('success'); // b's failure IS handled (b->d on failure)
  });

  // ADF "Generic error handling": a sequential chain, then "Connect both
  // UponFailure and UponSkip paths from the last activity to the error handling
  // activity" — so the handler catches BOTH "the last step failed" and "an
  // earlier step failed, so the last step never ran". The doc's contract: "will
  // only run if any of the previous activities fails. It will not run if they
  // all succeed." Needs skip-propagation AND the OR within one predecessor.
  const genericErrorHandling = (): Edge[] => [
    edge('a', 'b', 'success'),
    edge('b', 'c', 'success'),
    edge('c', 'eh', 'failure'),
    edge('c', 'eh', 'skipped'),
  ];
  const chain = (): Node[] => [node('a'), node('b'), node('c'), node('eh')];

  it('ADF generic error handling — handler does NOT run when everything succeeds', () => {
    const { state } = runAll(engine(chain(), genericErrorHandling()));
    expect(state.nodes.c!.status).toBe('success');
    expect(state.nodes.eh!.status).toBe('skipped'); // both arms dead
  });

  it('ADF generic error handling — handler runs when the LAST activity fails', () => {
    const { state } = runAll(engine(chain(), genericErrorHandling()), { c: 'failure' });
    expect(state.nodes.eh!.status).toBe('success'); // caught by the failure arm
  });

  // NOTE: the third case of this pattern — an EARLIER activity fails, so the
  // skip propagates down the chain to the handler — does NOT work today. It is
  // characterized as a divergence in the D5 block below (the run short-circuits
  // before the skip can reach the handler); F1b owns the decision.

  // The ONE shape whose outcome F14 changes for docs that already exist: a
  // predecessor with 2+ edges to the SAME target under join:'all'. The canvas
  // can author it today (`connect` dedupes only on exact (from,to,on)).
  //
  // Old rule (edge-wise AND): `a` fails → the success arm is dead → `d` skipped.
  // New rule: `a`'s group has a satisfied arm (completion) → `d` runs. The new
  // behaviour is the intended ADF one, and this pins it deliberately.
  //
  // CONSEQUENCE (see the PR + the filed reconcile ticket): folding an OLD log
  // for this shape now yields a different state, so a run that already recorded
  // `run.finished{success}` projects as still-running on replay. Runs are
  // event-sourced, so any reducer change has this property — F1b and D4's retry
  // change will hit it too; the authority rule belongs in the reconciler.
  it('F14 changes this shape deliberately — completion arm rescues a failed predecessor', () => {
    const eng = engine(
      [node('a'), node('d')],
      [edge('a', 'd', 'success'), edge('a', 'd', 'completion')],
    );
    const { state, finish } = runAll(eng, { a: 'failure' });
    expect(state.nodes.d!.status).toBe('success'); // old rule: 'skipped'
    expect(finish?.outcome).toBe('success'); // a's failure is handled by the completion edge
  });

  it('join:any is unchanged — one satisfied arm is enough', () => {
    const eng = engine(
      [node('a'), node('b'), node('d', { join: 'any' }), node('catch')],
      [edge('a', 'd', 'success'), edge('b', 'd', 'success'), edge('b', 'catch', 'failure')],
    );
    const { state } = runAll(eng, { b: 'failure' });
    expect(state.nodes.d!.status).toBe('success');
  });
});

describe('a skip-only loop body cannot spin (bounce cap is a real ceiling)', () => {
  // Newly reachable via F1. An OPERATIONAL back-edge can't spin inside one
  // reduce: firing it resets the body to `pending`, the body then DISPATCHES
  // (status `ready`, non-terminal), so the whole-body-terminal gate blocks a
  // refire until real events land — the driver's I/O paces the loop. A body
  // reached only by `skipped` edges never dispatches: reset → skipped →
  // terminal → refire, with NO I/O in between. So every bounce runs
  // synchronously inside a single `reduce()`, and `maxBounces` has no upper
  // bound in the schema — `maxBounces: 100_000_000` would burn minutes of CPU
  // in one call, blocking the in-process driver's event loop.
  it('caps a skip-only back-edge at the defensive ceiling, not at a huge maxBounces', () => {
    const eng = engine(
      [node('x'), node('a'), node('b')],
      [
        edge('x', 'a', 'failure'), // x succeeds → a skipped
        edge('a', 'b', 'success'), // a skipped → b skipped too
        // b is skipped, so this back-edge is satisfied; its body {a,b} is all
        // terminal, so it resets → both skip again → it fires again, forever.
        { id: 'b->a:back', from: 'b', to: 'a', on: 'skipped', back: true, maxBounces: 100_000_000 },
      ],
    );
    const { finish, state, diagnostics } = runAll(eng);
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('capped');
    // Clamped to the defensive ceiling (10_000) rather than honouring 100M.
    // This bound IS the timing assertion: unclamped, this doc took 62s of
    // synchronous CPU in a single reduce(). No wall-clock assert — it would
    // flake on a loaded runner and prove nothing this doesn't.
    expect(state.bounces['b\x00a\x00skipped\x00']).toBeLessThanOrEqual(10_001);
    // ...and the operator is TOLD their declared cap was overridden, rather
    // than reading `capped` while their doc says 100_000_000.
    expect(diagnostics.join('\n')).toMatch(/declared maxBounces 100000000 exceeds/);
    expect(diagnostics.join('\n')).toMatch(/clamped/);
  });

  it('does NOT clamp-warn for a maxBounces within the ceiling', () => {
    const eng = engine(
      [node('x'), node('a'), node('b')],
      [
        edge('x', 'a', 'failure'),
        edge('a', 'b', 'success'),
        { id: 'b->a:back', from: 'b', to: 'a', on: 'skipped', back: true, maxBounces: 3 },
      ],
    );
    const { finish, state, diagnostics } = runAll(eng);
    expect(finish?.reason).toBe('capped'); // honoured the doc's own small cap
    expect(state.bounces['b\x00a\x00skipped\x00']).toBe(4);
    expect(diagnostics.join('\n')).not.toMatch(/clamped/);
  });
});

describe('business branch edges are INERT until #4 A0/A1/A2', () => {
  // The schema is settled HERE (T3: #1 owns the union) so `if`/`switch` can be
  // built against a final shape. But no activity emits a branch outcome yet, so
  // a branch edge cannot be satisfied. This pins that it degrades OBSERVABLY
  // (diagnostic) rather than silently stranding the downstream.
  it('a branch edge never satisfies, and says why', () => {
    const eng = engine([node('if_1'), node('t')], [branchEdge('if_1', 't', 'true')]);
    const { state, diagnostics } = runAll(eng);
    expect(state.nodes.if_1!.status).toBe('success');
    expect(state.nodes.t!.status).toBe('skipped');
    // Match the EXPLANATION, not just the word "branch" — the edge id itself
    // contains "branch", so /branch/i would pass on a diagnostic that merely
    // echoed it back and told the operator nothing.
    expect(diagnostics.join('\n')).toMatch(/can never be satisfied/);
    expect(diagnostics.join('\n')).toMatch(/A0|A1|A2|if\/switch/);
  });

  // The container skip path is a SEPARATE call site (`settle`'s container loop,
  // not `tryDispatchNode`), so it needs its own coverage — a branch edge into a
  // stage must explain itself the same way.
  it('a branch edge into a CONTAINER explains itself too', () => {
    const eng = createEngine({
      nodes: [node('if_1'), node('child')],
      edges: [branchEdge('if_1', 'stg', 'true')],
      containers: [{ id: 'stg', kind: 'stage', children: ['child'] }],
    });
    const { state, diagnostics } = runAll(eng);
    expect(state.containers.stg!.status).toBe('skipped');
    expect(diagnostics.join('\n')).toMatch(/'stg'/);
    expect(diagnostics.join('\n')).toMatch(/can never be satisfied/);
  });

  // A fan-in of branch edges: the diagnostic must account for ALL of them. A
  // hardcoded singular ("has an incoming 'branch' edge") undercounts the cause
  // and would send an operator hunting one edge when several are inert.
  it('counts EVERY inert branch predecessor, not just one', () => {
    const eng = engine(
      [node('if_1'), node('if_2'), node('t')],
      [branchEdge('if_1', 't', 'true'), branchEdge('if_2', 't', 'false')],
    );
    const { state, diagnostics } = runAll(eng);
    expect(state.nodes.t!.status).toBe('skipped');

    const text = diagnostics.join('\n');
    expect(text).toMatch(/can never be satisfied/);
    // Names the count, and reads as a plural — not "an incoming 'branch' edge".
    expect(text).toMatch(/2 incoming 'branch' edges/);
  });

  // The singular wording must survive the pluralisation — an off-by-one that
  // reported "1 incoming 'branch' edges" would be its own papercut.
  it('still reads naturally for a single inert branch predecessor', () => {
    const eng = engine([node('if_1'), node('t')], [branchEdge('if_1', 't', 'true')]);
    const { diagnostics } = runAll(eng);
    expect(diagnostics.join('\n')).toMatch(/has an incoming 'branch' edge,/);
  });
});

describe('containers — skipped + JOIN inside a stage', () => {
  // D5 names "skipped child inside a stage" as a REQUIRED characterization
  // case, and it is the only one that exercises the separate container walk
  // (`stepContainers`/`firstUnhandledChildFailure`) rather than the top-level
  // one — so both the skip routing and F14's grouping need pinning here.
  it('a skipped child does not fail its stage, and the stage succeeds', () => {
    const eng = createEngine({
      nodes: [node('a'), node('b')],
      // a succeeds → a->b(failure) is unsatisfied-terminal → b skipped.
      edges: [{ id: 'a->b:failure', from: 'a', to: 'b', on: 'failure' }],
      containers: [{ id: 'stg', kind: 'stage', children: ['a', 'b'] }],
    });
    const { state, finish } = runAll(eng);
    expect(state.nodes.b!.status).toBe('skipped');
    expect(state.containers.stg!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  it('an on:skipped edge routes BETWEEN children of a stage', () => {
    const eng = createEngine({
      nodes: [node('a'), node('b'), node('h')],
      edges: [
        { id: 'a->b:failure', from: 'a', to: 'b', on: 'failure' }, // a succeeds → b skipped
        { id: 'b->h:skipped', from: 'b', to: 'h', on: 'skipped' }, // caught inside the stage
      ],
      containers: [{ id: 'stg', kind: 'stage', children: ['a', 'b', 'h'] }],
    });
    const { state } = runAll(eng);
    expect(state.nodes.b!.status).toBe('skipped');
    expect(state.nodes.h!.status).toBe('success');
    expect(state.containers.stg!.status).toBe('success');
  });

  it('F14 grouping applies to CHILD readiness too — OR within one predecessor', () => {
    // Same shape as the top-level OR test, but entirely inside a stage: `d`
    // resolves via childIncoming, a different call path.
    const eng = createEngine({
      nodes: [node('a'), node('d')],
      edges: [
        { id: 'a->d:success', from: 'a', to: 'd', on: 'success' },
        { id: 'a->d:skipped', from: 'a', to: 'd', on: 'skipped' },
      ],
      containers: [{ id: 'stg', kind: 'stage', children: ['a', 'd'] }],
    });
    const { state } = runAll(eng);
    expect(state.nodes.d!.status).toBe('success'); // edge-wise AND would skip it
    expect(state.containers.stg!.status).toBe('success');
  });
});

describe('pipeline success semantics — CHARACTERIZATION (D5; reconcile = F1b)', () => {
  // Recorded, not endorsed. Each case notes whether it MATCHES the ADF target
  // ("Evaluate outcome for all leaves… If a leaf activity was skipped, we
  // evaluate its parent activity instead. Pipeline result is success if and
  // only if all nodes evaluated succeed") so F1b has an exact starting point.
  it('MATCHES ADF: a skipped final branch after a failed condition → success', () => {
    const eng = engine(
      [node('a'), node('handler'), node('b')],
      [edge('a', 'handler', 'failure'), edge('a', 'b', 'success')],
    );
    const { state, finish } = runAll(eng, { a: 'failure' });
    expect(state.nodes.b!.status).toBe('skipped');
    expect(state.nodes.handler!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  it('MATCHES ADF: a skipped top-level leaf with no parent → success', () => {
    const eng = engine(
      [node('x'), node('leaf')],
      [edge('x', 'leaf', 'failure')], // x succeeds → leaf skipped
    );
    const { state, finish } = runAll(eng);
    expect(state.nodes.leaf!.status).toBe('skipped');
    expect(finish?.outcome).toBe('success');
  });

  it('MATCHES ADF: failure caught by a catch branch that then succeeds → success', () => {
    const eng = engine([node('a'), node('catch')], [edge('a', 'catch', 'failure')]);
    const { finish } = runAll(eng, { a: 'failure' });
    expect(finish?.outcome).toBe('success');
  });

  it('MATCHES ADF: a node skipped by an impossible incoming edge → success', () => {
    // Assert on `a` — the node whose OWN incoming edge became impossible (x
    // succeeded, so x--failure-->a can never fire). `b` is skipped by
    // propagation, which is a different property (pinned separately above).
    const eng = engine(
      [node('x'), node('a'), node('b')],
      [edge('x', 'a', 'failure'), edge('a', 'b', 'success')],
    );
    const { state, finish } = runAll(eng);
    expect(state.nodes.a!.status).toBe('skipped');
    expect(finish?.outcome).toBe('success');
  });

  // ---- the DIVERGENCE (F1b owns the decision) -----------------------------
  // ADF Do-If-Else: "When previous activity fails: node Upon Success is skipped
  // and its parent node failed; overall pipeline fails." Studio treats ANY
  // failure carrying an outgoing failure/completion edge as "handled" and
  // returns success — even when the handler is a plain downstream node rather
  // than a real catch. Asserted as-is so F1b's change is a visible diff.
  it('DIVERGES from ADF: a failure is "handled" by any failure edge → success (F1b)', () => {
    const eng = engine(
      [node('a'), node('onFail'), node('onOk')],
      [edge('a', 'onFail', 'failure'), edge('a', 'onOk', 'success')],
    );
    const { state, finish } = runAll(eng, { a: 'failure' });
    expect(state.nodes.a!.status).toBe('failure');
    expect(state.nodes.onOk!.status).toBe('skipped');
    // ADF would fail this run (a leaf's parent failed). Studio succeeds:
    expect(finish?.outcome).toBe('success');
  });

  it('an UNhandled failure still fails the run', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const { finish } = runAll(eng, { a: 'failure' });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('node_failed:a');
  });

  // The sharpest divergence found by these tests, and the one F1b most needs:
  // studio SHORT-CIRCUITS on an unhandled top-level failure (`settle` emits
  // finishRun{failure} the moment `firstUnhandledFailureTop` finds one), so the
  // rest of the graph never settles. ADF instead lets the walk finish and only
  // then evaluates leaves, which is why its own "Generic error handling"
  // pattern — UponFailure+UponSkip from the LAST activity to a handler, so an
  // EARLIER failure reaches the handler by skip-propagation — cannot work here:
  // the handler stays pending forever.
  //
  // Both arms of the pattern that don't cross the short-circuit DO work (see
  // the JOIN block). Fixing this means deciding whether an unhandled failure
  // ends the run eagerly or merely marks it doomed while the walk drains —
  // squarely F1b's call, not a schema ticket's.
  it('DIVERGES from ADF: an unhandled failure short-circuits before a skip can propagate (F1b)', () => {
    const eng = engine(
      [node('a'), node('b'), node('c'), node('eh')],
      [
        edge('a', 'b', 'success'),
        edge('b', 'c', 'success'),
        edge('c', 'eh', 'failure'),
        edge('c', 'eh', 'skipped'),
      ],
    );
    const { state, finish } = runAll(eng, { a: 'failure' });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('node_failed:a');
    // ADF would skip b and c, then run `eh` via the skip arm. Studio stops:
    expect(state.nodes.b!.status).toBe('pending');
    expect(state.nodes.c!.status).toBe('pending');
    expect(state.nodes.eh!.status).toBe('pending');
  });
});
