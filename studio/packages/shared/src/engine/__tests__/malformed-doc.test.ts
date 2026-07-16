/**
 * The reducer's own defences against three specific MALFORMED-doc shapes — the
 * sweep for #487, #488 and the empty-loop spin found while fixing them.
 *
 * THREE SHAPES, NOT THE CLASS — and the class now has its own answer elsewhere.
 * This file's three guards are SHAPE-specific: they stop a throw, a deadlock and
 * a spin at the exact places those arise. The general liveness backstop that
 * sits underneath them all is #491's, in `settle` + `stalled-backstop.test.ts`:
 * a fixpoint with nothing terminal and nothing awaiting an event terminalizes
 * the run as `failure{reason:'stalled'}` rather than wedging it forever.
 *
 * The two are complementary and BOTH must stay. #488's fix restores LIVENESS for
 * its shape (the child actually runs); the backstop only converts an unfixable
 * hang into a diagnosed failure. A regression here would turn a run that works
 * into a run that reports `stalled` — still broken, just no longer silent. So do
 * not read the backstop as licence to delete these, and do not read this file as
 * "the reducer survives anything" either.
 *
 * Why these live in the reducer at all — and why they MUST STAY, now that #444
 * gated the write path. The gate closed the DOOR: `createPipelineVersion`
 * refuses a doc `validateDoc` rejects, so no NEW row can carry these shapes. It
 * did not clean the house: every row written BEFORE that gate was never
 * validated, is IMMUTABLE (so it cannot be repaired, only re-authored), and
 * still reaches `createEngine`/`reduce`. Do not read "the server validates now"
 * as licence to delete these guards — the docs they defend against are already
 * in storage. `reduce` is PURE and is
 * the thing every run is folded through: its docblock says it must not throw on a
 * malformed doc, and a hang or a deadlock there is worse than a throw. So the
 * reducer NEUTRALIZES what the validator merely warns about (the posture #480
 * established for cross-boundary edges) and says so in a diagnostic.
 *
 * The empty-loop case is the sharpest, and the reason is worth keeping straight:
 * that doc passed `validateDoc` CLEANLY before this sweep. #487 and #488 need a
 * doc the validator already rejects (advisorily), so an ENFORCING validator would
 * have stopped them at the door. The empty loop it waved through — which is why
 * the guard has to live in the reducer, and why a matching validator rule (added
 * here too) is a courtesy to the author rather than the actual defence.
 */
import { describe, expect, it } from 'vitest';
import type { EngineCommand, EngineEvent, Node } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { validateDoc } from '../params.js';

let seq = 0;
function node(id: string): Node {
  seq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: seq, y: 0 } };
}

const RUN = 'r1';
const PV = 'pv1';

/**
 * Drive a run to completion, resolving each dispatched node from `outcomes`
 * (default: success). Same command-QUEUE shape (and file-local convention) as
 * `edge-model.test.ts`'s and `reduce.test.ts`'s `runAll`.
 *
 * Worth knowing before trusting it: the `guard` catches NONE of the three
 * defects pinned here, and is kept only for parity with the other two copies. A
 * #487 doc throws inside `reduce`; a #488 doc drains the queue and simply exits
 * the loop, which is caught by the OUTCOME assertion (`finish?.outcome` is
 * `'success'` only if the child really ran — and since #491 a regression there
 * surfaces as `failure{reason:'stalled'}` rather than as the hang it once was;
 * this docblock used to cite a `finish === undefined` assertion, which never
 * existed in this file); and the empty loop spins INSIDE one `reduce()` call,
 * which no driver-loop guard — and no vitest `testTimeout`, the spin being
 * synchronous — can preempt. The
 * empty-loop pins therefore HANG rather than fail if they regress, which is the
 * honest cost of pinning a synchronous spin from inside the same process.
 */
function runAll(
  eng: Engine,
  opts: {
    params?: Record<string, unknown>;
    outcomes?: Record<string, 'success' | 'failure'>;
  } = {},
) {
  const { params = {}, outcomes = {} } = opts;
  let state = eng.seedState();
  const pending: EngineCommand[] = [];
  const diagnostics: string[] = [];
  const order: string[] = [];
  let finish: { outcome: 'success' | 'failure'; reason?: string } | undefined;

  const apply = (ev: EngineEvent): void => {
    const r = eng.reduce(state, ev);
    state = r.state;
    diagnostics.push(...r.diagnostics);
    pending.push(...r.commands);
  };

  apply({ type: 'run.started', runId: RUN, pipelineVersionId: PV, params });
  let guard = 0;
  while (pending.length) {
    if (guard++ > 2000) throw new Error('driver did not converge');
    const c = pending.shift()!;
    if (c.type === 'finishRun') {
      finish = { outcome: c.outcome, reason: c.reason };
      apply({ type: 'run.finished', runId: RUN, outcome: c.outcome, reason: c.reason });
      continue;
    }
    if (c.type !== 'dispatchNode') continue;
    order.push(c.nodeId);
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
  return { state, finish, diagnostics, order };
}

describe('#487 — a container child that is not a node id must not THROW', () => {
  // The bug was reported as "a NESTED container", but the class is wider and is
  // exactly the one `validateDoc` already states (params.ts: "child '<x>' is not
  // a node in this pipeline"): ANY child id with no node behind it. `seedState`
  // seeds `state.nodes` from `doc.nodes`, so every shape below threw on a
  // `state.nodes[<child>]!` read — in `tryDispatchNode`, which `settle` reaches
  // before `stepContainers` (the site #487 named).
  it('a NESTED container id as a child does not throw', () => {
    const eng = createEngine({
      nodes: [node('n1')],
      edges: [],
      containers: [
        { id: 'outer', kind: 'stage', children: ['inner'] },
        { id: 'inner', kind: 'stage', children: ['n1'] },
      ],
    } satisfies EngineDoc);
    expect(() => runAll(eng)).not.toThrow();
  });

  it('a GHOST child (no such node) does not throw', () => {
    const eng = createEngine({
      nodes: [node('n1')],
      edges: [],
      containers: [{ id: 'c', kind: 'stage', children: ['ghost', 'n1'] }],
    } satisfies EngineDoc);
    expect(() => runAll(eng)).not.toThrow();
  });

  it('a SELF child (a container naming its own id) does not throw', () => {
    const eng = createEngine({
      nodes: [node('n1')],
      edges: [],
      containers: [{ id: 'c', kind: 'stage', children: ['c', 'n1'] }],
    } satisfies EngineDoc);
    expect(() => runAll(eng)).not.toThrow();
  });

  // The SEMANTICS of the neutralization, pinned rather than left to "reaches a
  // sane terminal". A dropped child is treated as if it were not authored; the
  // container's REAL children still run. `inner` is unaffected by the drop: it is
  // ALREADY a top-level entity today (`topEntities` = top-level nodes + ALL
  // container ids — container ids are never filtered by child membership), so it
  // enters and runs `n1` as a root. `outer` is left with an empty body and, being
  // a stage, succeeds vacuously — the same terminal an authored empty stage
  // reaches (pinned below).
  it('the real children still run; the dropped child is treated as unauthored', () => {
    const eng = createEngine({
      nodes: [node('n1')],
      edges: [],
      containers: [
        { id: 'outer', kind: 'stage', children: ['inner'] },
        { id: 'inner', kind: 'stage', children: ['n1'] },
      ],
    } satisfies EngineDoc);
    const { state, finish, order } = runAll(eng);
    expect(order).toEqual(['n1']);
    expect(state.containers['inner']?.status).toBe('success');
    expect(state.containers['outer']?.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  // The two pins below exist because the first cut of this fix FAILED them. The
  // filter must answer "does this child have node state?" WITHOUT also answering
  // "who owns this id?" — deriving edge classification from the filtered set
  // re-opens #480's fail-open for one doc class. Neither doc throws on the
  // pre-#487 reducer, so a regression here would silently change the answer for
  // docs that were working.
  it('a dropped child does not un-cross its edges (#480 fail-open stays closed)', () => {
    const eng = createEngine({
      nodes: [node('g'), node('n1'), node('handler')],
      edges: [
        { id: 'e1', from: 'g', to: 'outer', on: 'failure' },
        // `inner` is AUTHORED as a child of `outer`, so this edge leaves a
        // container boundary and must stay voided — even though `inner` is
        // dropped from `outer`'s effective body for being a container id.
        { id: 'e2', from: 'inner', to: 'handler', on: 'failure' },
      ],
      containers: [
        { id: 'outer', kind: 'stage', children: ['inner'] },
        { id: 'inner', kind: 'stage', children: ['n1'] },
      ],
    } satisfies EngineDoc);
    const { finish } = runAll(eng, { outcomes: { n1: 'failure' } });
    expect(finish?.outcome).toBe('failure');
  });

  it('a dropped child does not free its SIBLINGS to fire as roots', () => {
    const eng = createEngine({
      nodes: [node('n1'), node('a')],
      // `inner` and `a` are both authored children of `outer`, so this edge is
      // INTERNAL to `outer` and must keep gating `a`.
      edges: [{ id: 'e', from: 'inner', to: 'a', on: 'success' }],
      containers: [
        { id: 'outer', kind: 'stage', children: ['inner', 'a'] },
        { id: 'inner', kind: 'stage', children: ['n1'] },
      ],
    } satisfies EngineDoc);
    const { order } = runAll(eng);
    // `a` waits for `inner` to succeed; it must not dispatch as an unconditional
    // root of `outer`.
    expect(order.indexOf('a')).toBeGreaterThan(order.indexOf('n1'));
  });

  it('says so: a dropped child is reported once per run', () => {
    const eng = createEngine({
      nodes: [node('n1')],
      edges: [],
      containers: [{ id: 'c', kind: 'stage', children: ['ghost', 'n1'] }],
    } satisfies EngineDoc);
    const { diagnostics } = runAll(eng);
    const hit = diagnostics.filter((d) => d.includes("'ghost'"));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain('is not a node');
    expect(hit[0]).toContain('IGNORED');
  });
});

describe('#488 — a child → its OWN container id forward edge must not DEADLOCK', () => {
  // The edge makes the container wait on a child it must first activate: `c`
  // waits for `h` via `topIncoming`, while `h` only dispatches once `c` is
  // `active`. Mutual wait ⇒ nothing dispatches. Before #491 that wedged the run
  // `running` forever; now the stalled backstop terminalizes it as
  // `failure{reason:'stalled'}` — which is containment, NOT this guard becoming
  // redundant. Without the guard the authored container never runs and the run
  // reports `stalled`; with it, the child runs and the run succeeds. That is the
  // difference this test pins. The edge is INERT: the container is already the
  // child's parent scope, so the edge encodes a dependency that inverts
  // activation order.
  it('the child runs and the run finishes', () => {
    const eng = createEngine({
      nodes: [node('h')],
      edges: [{ id: 'e', from: 'h', to: 'c', on: 'success' }],
      containers: [{ id: 'c', kind: 'stage', children: ['h'] }],
    } satisfies EngineDoc);
    const { finish, order, state } = runAll(eng);
    expect(order).toEqual(['h']);
    expect(state.containers['c']?.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  it('says so: the inert edge is reported', () => {
    const eng = createEngine({
      nodes: [node('h')],
      edges: [{ id: 'e', from: 'h', to: 'c', on: 'success' }],
      containers: [{ id: 'c', kind: 'stage', children: ['h'] }],
    } satisfies EngineDoc);
    const { diagnostics } = runAll(eng);
    expect(diagnostics.filter((d) => d.includes("'e'"))).toHaveLength(1);
  });

  // The scope is deliberately NARROW. #480 kept child → top edges in
  // `topIncoming` because they are LOAD-BEARING: the edge is what still SKIPS the
  // top-level target when the child does not take it. Dropping those would leave
  // the target with no incoming edges — a root that fires unconditionally, a
  // WORSE fail-open. That reasoning does not extend to a child → its OWN
  // container (which strands the walk — `stalled` since #491), and only that
  // case is excluded here.
  it('a child → a DIFFERENT top-level entity still gates that entity (#480 pin holds)', () => {
    const eng = createEngine({
      nodes: [node('h'), node('d')],
      edges: [{ id: 'e', from: 'h', to: 'd', on: 'failure' }],
      containers: [{ id: 'c', kind: 'stage', children: ['h'] }],
    } satisfies EngineDoc);
    const { state, order } = runAll(eng);
    // `h` succeeds, so the failure edge is unsatisfied-terminal ⇒ `d` skips.
    // It must NOT run as an unconditional root.
    expect(order).toEqual(['h']);
    expect(state.nodes['d']?.status).toBe('skipped');
  });
});

describe('an empty-bodied LOOP must not spin the reducer forever', () => {
  // The severest of the three: this doc passes `validateDoc` CLEANLY.
  //   - `ContainerSchema.children` is `z.array(z.string().min(1))` — no min length.
  //   - `validateDoc` requires a loop's `exitWhen` but never a `maxRounds`.
  //   - a non-constant `exitWhen` (a params ref) passes the constant-rule.
  // With an empty body the round is VACUOUSLY terminal, resets nothing, and
  // re-rounds instantly: round N+1 is bit-identical to round N, so `exitWhen` can
  // provably never change. `settle` spins SYNCHRONOUSLY at 100% CPU inside one
  // `reduce()` — no timeout can preempt it and the driver's event loop is wedged.
  const EMPTY_LOOP: EngineDoc = {
    nodes: [],
    edges: [],
    containers: [{ id: 'c', kind: 'loop', children: [], exitWhen: "${equals(params.go,'yes')}" }],
  };

  it('terminates with failure `no_progress` instead of spinning', () => {
    const eng = createEngine(EMPTY_LOOP);
    const { finish, state } = runAll(eng, { params: { go: 'no' } });
    expect(finish?.outcome).toBe('failure');
    expect(state.containers['c']?.status).toBe('failure');
    expect(state.containers['c']?.reason).toBe('no_progress');
  });

  it('a loop whose only child is a NON-node id is the same shape (what #487 leaves behind)', () => {
    // This is why the two fixes ship together: #487's normalization turns this
    // doc INTO the empty-body loop above. Fixed alone it would trade a throw for
    // an unkillable hang.
    const eng = createEngine({
      nodes: [node('n1')],
      edges: [],
      containers: [
        { id: 'lp', kind: 'loop', children: ['inner'], exitWhen: "${equals(params.go,'yes')}" },
        { id: 'inner', kind: 'stage', children: ['n1'] },
      ],
    } satisfies EngineDoc);
    const { state } = runAll(eng, { params: { go: 'no' } });
    expect(state.containers['lp']?.reason).toBe('no_progress');
  });

  // A BEHAVIOUR CHANGE, called out rather than left for a reviewer to find: an
  // empty loop WITH a `maxRounds` already terminated, reporting `capped`. That
  // reason is a lie — `capped` means "hit the round budget", implying rounds did
  // work. `no_progress` takes precedence because the body could never have
  // progressed, whatever the budget said.
  it('`no_progress` takes precedence over `capped` when maxRounds is set', () => {
    const eng = createEngine({
      nodes: [],
      edges: [],
      containers: [
        {
          id: 'c',
          kind: 'loop',
          children: [],
          exitWhen: "${equals(params.go,'yes')}",
          maxRounds: 3,
        },
      ],
    } satisfies EngineDoc);
    const { state } = runAll(eng, { params: { go: 'no' } });
    expect(state.containers['c']?.reason).toBe('no_progress');
    expect(state.containers['c']?.round).toBe(0);
  });

  it('an empty STAGE still succeeds immediately (unchanged — nothing to do is done)', () => {
    const eng = createEngine({
      nodes: [],
      edges: [],
      containers: [{ id: 'c', kind: 'stage', children: [] }],
    } satisfies EngineDoc);
    const { state, finish } = runAll(eng);
    expect(state.containers['c']?.status).toBe('success');
    expect(finish?.outcome).toBe('success');
  });

  // Asserts BOTH halves of the story in one shot. Exactly ONE error means the doc
  // passes every OTHER rule (schema-legal children, `exitWhen` present,
  // non-constant, boolean-typed) — i.e. before this fix `validateDoc` returned
  // `[]`, so even an ENFORCING validator would have waved this doc straight
  // through to the spin. And that one error is the new no-progress rule, so
  // validator and reducer now agree on the shape.
  it('validateDoc reports the no-progress loop, and NOTHING else was ever wrong with it', () => {
    const errors = validateDoc({
      params: [{ name: 'go', type: 'string', required: false, default: 'no' }],
      ...EMPTY_LOOP,
    } as never);
    expect(errors).toEqual([expect.stringContaining('makes no progress')]);
  });
});
