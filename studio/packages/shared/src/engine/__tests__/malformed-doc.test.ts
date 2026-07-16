/**
 * The reducer's own defences against a MALFORMED doc — the sweep for #487, #488
 * and the empty-loop spin found while fixing them.
 *
 * Why these live in the reducer at all: `validateDoc` is ADVISORY (#444). Its
 * only caller is the canvas badge, which does not block Save, and the server
 * never calls it — so a git import or a direct `POST /api/pipelines/:id/versions`
 * reaches `createEngine`/`reduce` with an arbitrary doc. `reduce` is PURE and is
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
 * Drive a run to completion, resolving every dispatched node successfully.
 * Same command-QUEUE shape (and file-local convention) as `edge-model.test.ts`'s
 * and `reduce.test.ts`'s `runAll`. The `guard` is the point of the exercise here:
 * a doc that deadlocks emits no `finishRun` at all, so these tests assert on
 * `finish` being defined rather than trusting the loop to end.
 */
function runAll(eng: Engine, params: Record<string, unknown> = {}) {
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
    apply({
      type: 'node.succeeded',
      runId: RUN,
      nodeId: c.nodeId,
      attemptId: c.attemptId,
      outputs: {},
    });
  }
  return { state, finish, diagnostics, order };
}

describe('#487 — a container child that is not a node id must not THROW', () => {
  // The bug was reported as "a NESTED container", but the class is wider and is
  // exactly the one `validateDoc` already states (params.ts: "child '<x>' is not
  // a node in this pipeline"): ANY child id with no node behind it. `seedState`
  // seeds `state.nodes` from `doc.nodes`, so `stepContainers`' `state.nodes[ch]!`
  // walked off the end for every shape below.
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
  // `active`. Mutual wait ⇒ no dispatch, no finishRun, run wedged `running`
  // forever. The edge is INERT: the container is already the child's parent
  // scope, so the edge encodes a dependency that inverts activation order.
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
  // container (which deadlocks), and only that case is excluded here.
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
    const { finish, state } = runAll(eng, { go: 'no' });
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
    const { state } = runAll(eng, { go: 'no' });
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
    const { state } = runAll(eng, { go: 'no' });
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
