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
 * 3. **Success semantics — the run-outcome predicate (D5 + F1b).** These began
 *    as CHARACTERIZATION ONLY: they recorded what the reducer did, including
 *    three cases labelled `DIVERGES from ADF`, because D5 said reconcile was
 *    its own ticket. **F1b did that reconcile**, so they are now ASSERTIONS of
 *    the ADF target, not recordings, and every `DIVERGES` label is gone. The
 *    one place studio deliberately does NOT match ADF is the `join:'any'` pin,
 *    which says so in place and explains why (ADF has no such join, and ADF's
 *    rule is fail-OPEN under it).
 *
 *    Two of the original labels were themselves wrong, which is worth
 *    remembering: `MATCHES ADF: a skipped final branch…` and
 *    `DIVERGES from ADF: a failure is "handled"…` were isomorphic up to node
 *    renaming, asserted the identical outcome, and carried OPPOSITE labels.
 */
import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { driveRun, simpleResolve } from './helpers/run-driver.js';

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

/**
 * Drive a run to completion, resolving each dispatched node from `outcomes`
 * (default: success). A thin adapter over the shared `driveRun` mechanic
 * (`helpers/run-driver.ts`) — see there for the queue-drain / `finishes` / guard
 * rationale. Real reducer, real events, no mocks; `RUN`/`PV` are `driveRun`'s
 * defaults.
 */
function runAll(eng: Engine, outcomes: Record<string, 'success' | 'failure'> = {}) {
  return driveRun(eng, { resolve: simpleResolve(outcomes) });
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

describe('business branch edges — a branch edge off a NON-branching source is dead (#4 A0)', () => {
  // #4 A0 made branch edges routable via `state.branches` — but only an `if`
  // populates that map. A branch edge whose source is NOT a branching activity
  // (here `node()` builds an `agent_task`) records no branch, so the edge is
  // `unsatisfied-terminal` and the target skips. What CHANGED at A0: the retired
  // `noteInertBranch` diagnostic no longer fires — the old "can never be
  // satisfied … #4 A0/A1/A2" text is gone, because a branch edge is now a normal
  // (here, un-taken) arm, not a broken doc. The full `if`-routing behaviour lives
  // in `branch-routing.test.ts` (it needs real control nodes).
  it('skips the target with NO inert-branch diagnostic', () => {
    const eng = engine([node('src'), node('t')], [branchEdge('src', 't', 'true')]);
    const { state, diagnostics } = runAll(eng);
    expect(state.nodes.src!.status).toBe('success');
    expect(state.nodes.t!.status).toBe('skipped');
    const text = diagnostics.join('\n');
    expect(text).not.toMatch(/can never be satisfied/);
    expect(text).not.toMatch(/emits a branch outcome/);
  });

  it('skips a CONTAINER target off a non-branching source, also with no diagnostic', () => {
    const eng = createEngine({
      nodes: [node('src'), node('child')],
      edges: [branchEdge('src', 'stg', 'true')],
      containers: [{ id: 'stg', kind: 'stage', children: ['child'] }],
    });
    const { state, diagnostics } = runAll(eng);
    expect(state.containers.stg!.status).toBe('skipped');
    expect(diagnostics.join('\n')).not.toMatch(/can never be satisfied/);
  });
});

describe('containers — skipped + JOIN inside a stage', () => {
  // D5 names "skipped child inside a stage" as a REQUIRED characterization
  // case, and it is the only one that exercises the separate container walk
  // (`stepContainers`/`containerOutcomeFailure`) rather than the top-level
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

/**
 * #480 — a CROSS-BOUNDARY forward edge must not absorb a failure at top scope.
 *
 * `validateDoc` forbids these edges outright, and the write path refuses such a
 * doc as of #444 — but rows written before that gate were never validated and
 * still reach the reducer. The reducer therefore has to be fail-SAFE on the
 * shape by itself rather than assume validation removed it.
 *
 * The MECHANISM — why the fix touches `topOutgoing` and deliberately not
 * `topIncoming` — is documented where it lives, in `createEngine`'s index build
 * (`reduce.ts`). Kept there rather than restated here so the two cannot drift.
 * What this block adds is why each PIN exists.
 *
 * The fix changes one index but has TWO observable consequences, one pin each:
 * absorption no longer fires on the edge (test 1), and the source can become a
 * forward LEAF, so leaf-evaluation reaches its failed ancestor (test 2).
 *
 * The rest are NETS, not fix-tests — they pass before and after. They exist
 * because the obvious generalization (drop the edge from `topIncoming` too)
 * breaks them while every other test in this package stays green.
 */
describe('cross-boundary edges (#480)', () => {
  it('a failure edge into a container CHILD does not absorb — the run FAILS', () => {
    // `a` is a child of stage `c`, so `h --failure--> a` never reaches c's
    // internal walk: `a` runs as a stage root regardless of what `h` did. The
    // edge must therefore be inert for absorption too. Before the fix it sat in
    // `topOutgoing['h']` and read as "a satisfied failure edge whose target
    // RAN" — h's failure looked handled and the run reported SUCCESS.
    const eng = createEngine({
      nodes: [node('h'), node('a')],
      edges: [edge('h', 'a', 'failure')],
      containers: [{ id: 'c', kind: 'stage', children: ['a'] }],
    });
    const { finish } = runAll(eng, { h: 'failure' });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('node_failed:h');
  });

  it('the neutralized edge is REPORTED — the operator is told it was ignored', () => {
    // `validateDoc` would flag this doc, but nothing calls it on the way in
    // (#444), so without a diagnostic the operator sees `node_failed:h` with no
    // hint that the handler edge they authored was voided. Same reasoning — and
    // the same conclusion — as the other bind-time neutralization diagnostics.
    const eng = createEngine({
      nodes: [node('h'), node('a')],
      edges: [edge('h', 'a', 'failure')],
      containers: [{ id: 'c', kind: 'stage', children: ['a'] }],
    });
    const { diagnostics } = runAll(eng, { h: 'failure' });
    expect(
      diagnostics.some((d) => d.includes("edge 'h->a:failure'") && d.includes('IGNORED')),
    ).toBe(true);
  });

  it('a LIVE child → top edge is NOT reported as neutralized', () => {
    // The honesty pin for the diagnostic above. This edge is cross-boundary too,
    // but it still routes (it skips `t`), so claiming it was ignored would be a
    // lie — only edges actually dropped from `topOutgoing` are reported.
    const eng = createEngine({
      nodes: [node('h'), node('t')],
      edges: [edge('h', 't', 'failure')],
      containers: [{ id: 'c', kind: 'stage', children: ['h'] }],
    });
    const { diagnostics } = runAll(eng);
    expect(diagnostics.some((d) => d.includes('IGNORED'))).toBe(false);
  });

  it('the source becomes a forward LEAF — a cleanly-handled failure still fails the run', () => {
    // The SECOND consequence, and the most surprising thing about this fix: `p`'s
    // failure IS properly handled (`q` runs), yet the run now fails.
    //
    // `h` is skipped (p did not succeed) and its only outgoing edge is the
    // illegal one into `a`. Neutralizing that edge leaves `h` with no outgoing
    // edge at all, so it is now a forward leaf — and F1b's settled rule is that
    // a SKIPPED leaf recurses to its parents, where `p` failed. Correct: it is
    // exactly the outcome the doc would have had if the illegal edge had never
    // been authored, which is the whole point of neutralizing it.
    const eng = createEngine({
      nodes: [node('p'), node('q'), node('h'), node('a')],
      edges: [
        edge('p', 'q', 'failure'), // q RUNS — p's failure is absorbed
        edge('p', 'h', 'success'), // p failed → h skipped
        edge('h', 'a', 'success'), // the illegal cross-boundary edge
      ],
      containers: [{ id: 'c', kind: 'stage', children: ['a'] }],
    });
    const { state, finish } = runAll(eng, { p: 'failure' });
    expect(state.nodes.q!.status).toBe('success');
    expect(state.nodes.h!.status).toBe('skipped');
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('node_failed:p');
  });

  it('a CHILD → top failure edge still SKIPS its target when the child succeeds', () => {
    // The direction-2 net. `h` succeeds, so `h --failure--> t` is
    // unsatisfied-terminal and `t` must skip. If the edge were also dropped
    // from `topIncoming`, `t` would have no incoming edges, become a root, and
    // run its failure handler on a wholly successful run.
    const eng = createEngine({
      nodes: [node('h'), node('t')],
      edges: [edge('h', 't', 'failure')],
      containers: [{ id: 'c', kind: 'stage', children: ['h'] }],
    });
    const { state, finish } = runAll(eng);
    expect(state.nodes.h!.status).toBe('success');
    expect(state.nodes.t!.status).toBe('skipped');
    expect(finish?.outcome).toBe('success');
  });

  it('a CHILD → top success edge still ORDERS its target after the child', () => {
    // The same net, on dispatch order rather than status: `t` must not run
    // before the child that produces its input. Silent otherwise — `t` would
    // still reach `success`, just with `${nodes.h.outputs.*}` resolved against
    // an absent output.
    const eng = createEngine({
      nodes: [node('h'), node('t')],
      edges: [edge('h', 't', 'success')],
      containers: [{ id: 'c', kind: 'stage', children: ['h'] }],
    });
    const { order } = runAll(eng);
    expect(order).toEqual(['h', 't']);
  });

  it('a failure edge to a CONTAINER ID still absorbs — that edge is not cross-boundary', () => {
    // The non-regression pin. `validateDoc` explicitly allows top ↔ container-id
    // edges (neither endpoint is a child), so this must keep absorbing: it is
    // the difference between neutralizing cross-boundary edges and breaking
    // container-targeted ones.
    const eng = createEngine({
      nodes: [node('h'), node('a')],
      edges: [edge('h', 'c', 'failure')],
      containers: [{ id: 'c', kind: 'stage', children: ['a'] }],
    });
    const { state, finish } = runAll(eng, { h: 'failure' });
    expect(state.containers.c!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  it('CONTAINER scope stays fail-safe on the MIRRORED shape (source inside the container)', () => {
    // The asymmetry the ticket noted. Note this is test 1 mirrored, not repeated:
    // there the container held the TARGET, here it holds the SOURCE. At container
    // scope `childOutgoing` already excludes the cross-boundary edge, so the
    // child's failure was never absorbed and the container fails. Pinned so the
    // top-scope fix cannot silently change the scope that was already right.
    const eng = createEngine({
      nodes: [node('h'), node('a')],
      edges: [edge('h', 'a', 'failure')],
      containers: [{ id: 'c', kind: 'stage', children: ['h'] }],
    });
    const { state, finish } = runAll(eng, { h: 'failure' });
    expect(state.containers.c!.status).toBe('failure');
    expect(finish?.outcome).toBe('failure');
  });
});

describe('cross-container child → child edge (#498)', () => {
  // The one cross-boundary shape the #480 guard missed. `n1` is a child of `c1`
  // and `n2` a child of `c2`: the authored edge `n1 → n2` lands in NO index —
  // its source is not a top entity (so the crossBoundary report inside the
  // `topOutgoing` block never fires) and its target is not a top entity (so
  // `topIncoming` does not take it), and it is not the #488 own-container case.
  // Every sibling shape in the family reports "IGNORED"; only this one was
  // silent. The neutralization was already correct — a child's forward edge
  // cannot cross a boundary — so the fix adds ONLY the missing diagnostic
  // (observable since #497 gave `diagnostics` a durable sink).
  const twoStages = (edges: Edge[]): EngineDoc => ({
    nodes: [node('n1'), node('n2')],
    edges,
    containers: [
      { id: 'c1', kind: 'stage', children: ['n1'] },
      { id: 'c2', kind: 'stage', children: ['n2'] },
    ],
  });

  it('the dropped edge is REPORTED as ignored', () => {
    const eng = createEngine(twoStages([edge('n1', 'n2', 'success')]));
    const { diagnostics } = runAll(eng);
    expect(
      diagnostics.some((d) => d.includes("edge 'n1->n2:success'") && d.includes('IGNORED')),
    ).toBe(true);
  });

  it('is reported exactly ONCE — no duplicate diagnostic', () => {
    const eng = createEngine(twoStages([edge('n1', 'n2', 'success')]));
    const { diagnostics } = runAll(eng);
    expect(diagnostics.filter((d) => d.includes("edge 'n1->n2:success'"))).toHaveLength(1);
  });

  it('each direction is reported independently', () => {
    const eng = createEngine(twoStages([edge('n1', 'n2', 'success'), edge('n2', 'n1', 'success')]));
    const { diagnostics } = runAll(eng);
    expect(diagnostics.filter((d) => d.includes("edge 'n1->n2:success'"))).toHaveLength(1);
    expect(diagnostics.filter((d) => d.includes("edge 'n2->n1:success'"))).toHaveLength(1);
  });

  it('routing is UNCHANGED — the edge stays neutralized, both children run', () => {
    // The fix adds the diagnostic WITHOUT changing the outcome: with the edge
    // neutralized, `c1` and `c2` are both roots, so `n1` and `n2` dispatch as
    // their stage roots and the run succeeds. (Pre-fix behaviour, pinned so the
    // diagnostic cannot be mistaken for a semantics change.)
    const eng = createEngine(twoStages([edge('n1', 'n2', 'success')]));
    const { state, finish } = runAll(eng);
    expect(state.nodes.n1!.status).toBe('success');
    expect(state.nodes.n2!.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  it('a child → OTHER container ID edge still routes and is NOT reported', () => {
    // Honesty non-regression, alongside the child→top pin above. This edge is
    // cross-boundary too, but it is LOAD-BEARING in `topIncoming` (it skips the
    // target container `c2` when `n1` does not take it), so it still routes —
    // claiming it was ignored would be a lie. The new fall-through must not
    // catch it.
    const eng = createEngine({
      nodes: [node('n1'), node('n2')],
      edges: [edge('n1', 'c2', 'success')],
      containers: [
        { id: 'c1', kind: 'stage', children: ['n1'] },
        { id: 'c2', kind: 'stage', children: ['n2'] },
      ],
    });
    const { diagnostics } = runAll(eng);
    expect(
      diagnostics.some((d) => d.includes("edge 'n1->c2:success'") && d.includes('IGNORED')),
    ).toBe(false);
  });

  it('a top → child edge is still reported EXACTLY once — the fall-through does not double it', () => {
    // The other honesty guard on the new fall-through. A top→child edge is
    // already reported by the top-source block (#480); the fall-through's
    // `!topOutgoing.has(e.from)` discriminator is the ONLY thing stopping it
    // reporting a SECOND time. Weaken that to a bare `else` and this count trips.
    const eng = createEngine({
      nodes: [node('h'), node('a')],
      edges: [edge('h', 'a', 'success')],
      containers: [{ id: 'c', kind: 'stage', children: ['a'] }],
    });
    const { diagnostics } = runAll(eng);
    expect(diagnostics.filter((d) => d.includes("edge 'h->a:success'"))).toHaveLength(1);
  });
});

describe('pipeline success semantics — the run-outcome predicate (F1b)', () => {
  // F1b RECONCILED these against the ADF target ("Evaluate outcome for all
  // leaves… If a leaf activity was skipped, we evaluate its parent activity
  // instead. Pipeline result is success if and only if all nodes evaluated
  // succeed"). They are now ASSERTED, not merely recorded.
  //
  // The rule (joint spec §C.3) is a CONJUNCTION — a run fails iff either half
  // fails, and neither half alone is correct:
  //   1. ABSORPTION — every `failure` entity must be absorbed by a satisfied
  //      failure/completion catch that RAN, or by a skip-taint reaching a
  //      satisfied on:'skipped' catch that RAN. Leaf-evaluation ALONE is
  //      strict ADF parity, which is FAIL-OPEN under studio's `join:'any'`
  //      (ADF has no such join) — see the `join:'any'` pin below.
  //   2. LEAF-EVALUATION — every forward leaf must evaluate to success; a
  //      `skipped` leaf recurses to its parents. Absorption ALONE leaves the
  //      ADF Do-If-Else shape green.
  it('ADF Do-If-Else: a skipped final branch after a failed condition → FAILURE', () => {
    // Was labelled `MATCHES ADF … → success`. That label was doubly wrong: ADF
    // FAILS this shape, and it is isomorphic (up to renaming) to the
    // Do-If-Else case below that was labelled a DIVERGENCE. Two labels,
    // opposite claims, identical graph — the pair is what exposed it.
    const eng = engine(
      [node('a'), node('handler'), node('b')],
      [edge('a', 'handler', 'failure'), edge('a', 'b', 'success')],
    );
    const { state, finish } = runAll(eng, { a: 'failure' });
    expect(state.nodes.b!.status).toBe('skipped');
    expect(state.nodes.handler!.status).toBe('success');
    // `a` IS absorbed (its failure edge caught), but the skipped leaf `b`
    // recurses to its parent `a`, which failed.
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('node_failed:a');
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

  // ---- the former DIVERGENCE, now closed by F1b ---------------------------
  // ADF Do-If-Else: "When previous activity fails: node Upon Success is skipped
  // and its parent node failed; overall pipeline fails." Studio used to treat
  // ANY failure carrying an outgoing failure/completion edge as "handled" and
  // return success. The leaf conjunct closes it: the skipped `onOk` recurses to
  // `a`, which failed.
  //
  // Note the real difference was never "the handler isn't a real catch" (#442's
  // framing) — under ADF, `a --failure--> h` with no other branch also succeeds
  // (pinned below). It was the missing skipped-leaf ⇒ evaluate-parent rule.
  it('ADF Do-If-Else: a failure with a skipped sibling branch → FAILURE', () => {
    const eng = engine(
      [node('a'), node('onFail'), node('onOk')],
      [edge('a', 'onFail', 'failure'), edge('a', 'onOk', 'success')],
    );
    const { state, finish } = runAll(eng, { a: 'failure' });
    expect(state.nodes.a!.status).toBe('failure');
    expect(state.nodes.onOk!.status).toBe('skipped');
    expect(state.nodes.onFail!.status).toBe('success');
    expect(finish?.outcome).toBe('failure');
    // The BLAMED node sits UPSTREAM of the leaf that triggered evaluation: the
    // reason names `a`, reached via the skipped leaf `onOk`. The vocabulary is
    // deliberately unchanged (§C.5.4), so an operator can no longer infer from
    // it that `a` had no handler.
    expect(finish?.reason).toBe('node_failed:a');
  });

  it('an UNhandled failure still fails the run', () => {
    const eng = engine([node('a'), node('b')], [edge('a', 'b', 'success')]);
    const { finish } = runAll(eng, { a: 'failure' });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('node_failed:a');
  });

  // The sharpest divergence these tests found, and the one F1b most needed.
  // Studio used to SHORT-CIRCUIT on an unhandled top-level failure (`settle`
  // emitted finishRun{failure} the moment the predicate found one), so the rest
  // of the graph never settled and ADF's own "Generic error handling" pattern —
  // UponFailure+UponSkip from the LAST activity to a handler, so an EARLIER
  // failure reaches the handler by skip-propagation — could not work at all:
  // the handler stayed `pending` forever. That was #442's core complaint.
  //
  // `settle` now DRAINS to a fixpoint and evaluates the outcome once every
  // top-level entity is terminal, so the handler runs and the run is green.
  it('ADF Generic error handling: a failure reaches the handler by skip-propagation → SUCCESS', () => {
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
    // The walk drains: a's skip-taint propagates b → c, and `eh` runs via the
    // skip arm (its two edges share ONE predecessor, so F14's OR satisfies it).
    expect(state.nodes.b!.status).toBe('skipped');
    expect(state.nodes.c!.status).toBe('skipped');
    expect(state.nodes.eh!.status).toBe('success');
    // `a` is ABSORBED: its taint transitively reaches `c --skipped--> eh`, a
    // satisfied skip catch whose target RAN. And there is no skipped leaf —
    // `eh` is the only forward leaf, and it succeeded.
    expect(finish?.outcome).toBe('success');
  });

  // ---- absorption: the conjunct that keeps the leaf rule fail-SAFE ---------
  // Strict ADF leaf-evaluation ALONE reports SUCCESS here — the decisive fact
  // that eliminated ADF parity as an option (joint spec P1). `d`'s `a`-group is
  // dead but its `p`-group is satisfied, so `join:'any'` runs it; `a` and `p`
  // both have out-edges, so `d` is the ONLY forward leaf, and `d` succeeded.
  // A run whose node failed with NO catch anywhere would report success.
  //
  // `join:'any'` is studio-specific — ADF has no such join, so the rule studio
  // would have been copying was never designed against this shape.
  it("join:'any': a wholly unhandled failure absorbed by a live sibling → FAILURE", () => {
    const eng = engine(
      [node('a'), node('p'), node('d', { join: 'any' })],
      [edge('a', 'd', 'success'), edge('p', 'd', 'success')],
    );
    const { state, finish } = runAll(eng, { a: 'failure' });
    expect(state.nodes.d!.status).toBe('success'); // p->d satisfied the `any` join
    // `a` carries NO failure/completion edge at all, and its taint EVAPORATES at
    // `d` — `d` ran for an unrelated reason (a different predecessor), which is
    // NOT absorption. Fail-safe: the run fails.
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('node_failed:a');
  });
});

describe('absorption requires a catch that actually RAN (§C.5.3 — back-edges)', () => {
  // §C.5.3 asked F1b to decide what a "leaf" is given back-edges, and to pin it.
  // Decided: the predicate is FORWARD-only (`topOutgoing` excludes back-edges by
  // construction) where the pre-F1b one merged `backOutgoing`.
  //
  // Pinning that honestly means pinning what is actually OBSERVABLE, which is
  // NOT forward-only-ness: a satisfied failure back-edge is consumed by
  // `fireBackEdges` at the top of `settle` and never survives to the predicate,
  // so re-merging back-edges leaves the whole suite green (mutation-verified).
  // There is no reachable doc that distinguishes the two, and a test asserting
  // otherwise would be theatre.
  //
  // What IS observable — and what these two pin — is the `ran()` requirement
  // that closes the old fail-open: the pre-F1b predicate asked only whether a
  // failure/completion edge EXISTED, never whether its target ran.
  it('is unobservable on a VALID doc: a satisfied failure back-edge bounces, never sitting terminal', () => {
    // The canonical retry loop. `check` fails, its back-edge is satisfied, and
    // `fireBackEdges` runs at the TOP of `settle` — long before the outcome
    // predicate at the fixpoint. So `check` is RESET, not left terminal-failure
    // holding a back-edge. (An exhausted budget finishes the run `capped`
    // instead — also before the predicate. Both are pinned in reduce-p2c.)
    const eng = engine(
      [node('gen'), node('check')],
      [
        edge('gen', 'check', 'success'),
        {
          id: 'check->gen:failure',
          from: 'check',
          to: 'gen',
          on: 'failure',
          back: true,
          maxBounces: 3,
        },
      ],
    );
    let checkCalls = 0;
    const { state, finish } = runAll(eng, {
      // check fails once (→ bounce), then succeeds.
      get check(): 'success' | 'failure' {
        checkCalls += 1;
        return checkCalls === 1 ? 'failure' : 'success';
      },
    });
    expect(state.nodes.check!.status).toBe('success');
    expect(Object.values(state.bounces)).toEqual([1]);
    expect(finish?.outcome).toBe('success');
  });

  it('a failure back-edge that can NEVER fire is unabsorbed → run fails (this was fail-OPEN)', () => {
    // The only shape that reaches the predicate holding a back-edge: one whose
    // reset body can never go terminal, so `fireBackEdges`' whole-body gate
    // never opens. `lp` is skipped, so its child `c1` never activates and stays
    // `pending` forever — while every TOP-LEVEL entity (g, a, lp) is terminal.
    //
    // Pre-F1b this run reported SUCCESS: `a` held a failure edge, so it read
    // "handled" though the catch could never run. Fail-open, and exactly the
    // direction this repo forbids. (Mutation-verified in both directions:
    // against `origin/main`'s reducer this doc returns finishRun{success}.)
    //
    // What closes it is `ran(e.to)` — `lp` is `skipped`, so it never ran and
    // cannot absorb. Note this pin does NOT depend on the predicate being
    // forward-only: it holds either way, because `ran()` is the operative
    // clause. See the block comment above.
    //
    // `validateDoc` REJECTS this doc ("makes no progress — its reset body must
    // include its source"), so it is unreachable through the canvas. It is
    // pinned anyway because the #444 write gate only closed the DOOR: rows
    // written before it were never validated, are immutable, and still reach
    // this reducer. Same reasoning `evalExitWhen` records for the whole-value
    // rule — the reducer is the half that BINDS for a doc already in storage.
    const eng = createEngine({
      nodes: [node('g'), node('a'), node('c1')],
      edges: [
        edge('g', 'lp', 'failure'), // g succeeds → lp skipped → c1 never runs
        edge('lp', 'a', 'skipped'), // …but the skip routes to `a`, which runs
        { id: 'a->lp:failure', from: 'a', to: 'lp', on: 'failure', back: true, maxBounces: 3 },
      ],
      containers: [{ id: 'lp', kind: 'stage', children: ['c1'] }],
    });
    const { state, finish } = runAll(eng, { a: 'failure' });
    expect(state.containers.lp!.status).toBe('skipped');
    expect(state.nodes.c1!.status).toBe('pending'); // the body gate never opens
    expect(state.nodes.a!.status).toBe('failure');
    expect(Object.values(state.bounces)).toEqual([]); // the back-edge never fired
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('node_failed:a');
  });
});

describe('the outcome predicate terminates, and is bounded', () => {
  // The `seen` guards are load-bearing, and NOT for the reason a forward cycle
  // suggests. A forward cycle's nodes never terminalize, so leaf-evaluation
  // (which only runs once every top-level entity IS terminal) is never reached
  // on one. But a cycle whose nodes are all terminal-`skipped` IS reachable: the
  // skip enters from OUTSIDE the cycle, so every node in it resolves without
  // ever running.
  //
  // `forwardCycleErrors` rejects these docs at save time, and the write path
  // refuses them as of #444 — but rows written before that gate were never
  // validated, like every save-time rule the reducer must not lean on.
  //
  // BOTH walks need their OWN pin: they are reached by DIFFERENT conjuncts, so
  // one test cannot cover both. Each is mutation-verified — deleting just that
  // walk's guard hangs exactly its own test and leaves the other green. (A hang,
  // not a RangeError: the walks are iterative, so an unguarded revisit loops
  // forever inside one synchronous `reduce()`. vitest cannot interrupt that —
  // the whole worker wedges, which is what the driver's pump would do too.)
  it('evalEndpoint: a cycle of skipped nodes does not hang (conjunct 2)', () => {
    const eng = engine(
      [node('x'), node('a'), node('b'), node('c')],
      [
        edge('x', 'a', 'failure'), // x succeeds → a's only live group is dead → a skipped
        edge('a', 'b', 'success'),
        edge('b', 'a', 'success'), // the cycle: a → b → a, both skipped
        edge('b', 'c', 'success'), // c is the forward leaf that triggers evaluation
      ],
    );
    const { state, finish } = runAll(eng);
    expect(state.nodes.a!.status).toBe('skipped');
    expect(state.nodes.b!.status).toBe('skipped');
    expect(state.nodes.c!.status).toBe('skipped');
    // The leaf `c` walks b → a → x; `x` succeeded, so nothing is blamed, and the
    // revisit of `b` terminates instead of walking forever.
    expect(finish?.outcome).toBe('success');
  });

  it('absorbedSkip: a FAILED node whose taint enters a skipped cycle does not hang (conjunct 1)', () => {
    // Reached only via conjunct 1 — `f` fails, so `absorbedFailure` follows its
    // dead edge into the taint walk, which then circles s1 → s2 → s1. The test
    // above never reaches this walk: its doc has no failed node at all.
    const eng = engine(
      [node('f'), node('s1'), node('s2')],
      [
        edge('f', 's1', 'success'), // f fails → s1's group dead → s1 skipped
        edge('s1', 's2', 'success'),
        edge('s2', 's1', 'success'), // the cycle, both skipped
      ],
    );
    const { state, finish } = runAll(eng, { f: 'failure' });
    expect(state.nodes.s1!.status).toBe('skipped');
    expect(state.nodes.s2!.status).toBe('skipped');
    // No `on:'skipped'` catch anywhere, so the taint is never absorbed and `f`
    // is blamed — the point is that deciding that TERMINATES.
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('node_failed:f');
  });

  // NOT pinned, deliberately: stack depth. Both walks are ITERATIVE, because a
  // recursive form makes the reducer's stack depth O(chain length) on a doc the
  // engine does not control, and a RangeError thrown from inside the PURE
  // reducer crashes the driver's pump. That was measured on the recursive draft
  // of this predicate — fine at 4k chained nodes, `RangeError: Maximum call
  // stack size exceeded` at 5k, where the flat loop it replaced coped — so the
  // iterative form is a real fix, not a precaution.
  //
  // There is no test because an HONEST one costs ~4s: recursion survives to
  // ~4k, so any doc small enough to be a cheap test passes either way and would
  // pin nothing. At the size that DOES discriminate, `settle`'s fixpoint is
  // already O(n²) (~4s for one drive at 5k, measured), so such a doc is
  // unusable for reasons that dwarf the stack. The iterative form costs nothing
  // to keep; a 4s test that pins the engine's worst-case scaling alongside the
  // property would be the more fragile asset.
});

describe('container parity — ONE rule, two scopes (§D)', () => {
  // §D: whatever the run-outcome rule is, it applies VERBATIM to a container's
  // children via childOutgoing/childIncoming. Called out because the old
  // top-level and child predicates were near-duplicates, so a fire that fixed
  // only the top-level one would have left containers on the old semantics
  // SILENTLY — nothing would have failed.
  it('the ADF Do-If-Else shape INSIDE a stage fails the stage, and the run', () => {
    const eng = createEngine({
      nodes: [node('a'), node('onFail'), node('onOk')],
      edges: [edge('a', 'onFail', 'failure'), edge('a', 'onOk', 'success')],
      containers: [{ id: 'stg', kind: 'stage', children: ['a', 'onFail', 'onOk'] }],
    });
    const { state, finish } = runAll(eng, { a: 'failure' });
    expect(state.nodes.onFail!.status).toBe('success');
    expect(state.nodes.onOk!.status).toBe('skipped');
    // Same verdict as the identical shape at top level: `a` is absorbed by
    // `onFail`, but the skipped leaf `onOk` recurses to `a`, which failed.
    expect(state.containers.stg!.status).toBe('failure');
    // A sanctioned consequence, stated because nothing pinned it before: a loop
    // body containing this shape now FAILS its container instead of re-rounding.
    // The container's own failure is then judged at TOP level by the same
    // predicate — `stg` has no outer catch, so it is unabsorbed and fails the run.
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('node_failed:stg');
  });
});
