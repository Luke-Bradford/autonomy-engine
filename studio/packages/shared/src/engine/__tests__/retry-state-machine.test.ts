import { describe, expect, it } from 'vitest';
import type {
  Container,
  Edge,
  EdgeOn,
  EngineEvent,
  FailureKind,
  Node,
  OperationalEdge,
} from '../types.js';
import { NodeRunStatusSchema, TERMINAL_NODE, TerminalNodeStatusSchema } from '../types.js';
import type { NodePolicy } from '../../schemas/pipeline.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';

/**
 * #1 F2b — the RETRY STATE MACHINE (D4's HOLD), per the joint F1b/F2b spec
 * `studio/docs/2026-07-15-foundation-run-outcome-and-retry.md` §A.
 *
 * The shape under test: a `transient` `node.failed` whose policy still has
 * budget folds to the NON-terminal `retry_pending` and emits `scheduleRetry`;
 * the driver arms an alarm and appends `node.retryDue`; folding that
 * re-dispatches under a NEW attempt. Everything else — a `permanent` failure, a
 * node with no policy — behaves exactly as it did before F2b.
 */

let seq = 0;
function node(id: string, policy?: NodePolicy): Node {
  seq += 1;
  return {
    id,
    type: 'agent_task',
    config: {},
    position: { x: seq, y: 0 },
    ...(policy && { policy }),
  };
}

function edge(
  from: string,
  to: string,
  on: EdgeOn,
  extra: Partial<Omit<OperationalEdge, 'on'>> = {},
): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on, ...extra };
}

function engine(nodes: Node[], edges: Edge[] = [], containers: Container[] = []): Engine {
  return createEngine({ nodes, edges, containers } satisfies EngineDoc);
}

const RUN = 'r1';

function started(): EngineEvent {
  return { type: 'run.started', runId: RUN, pipelineVersionId: 'pv1', params: {} };
}
function dispatched(nodeId: string, attemptId: string): EngineEvent {
  return { type: 'node.dispatched', runId: RUN, nodeId, attemptId, idempotent: true };
}
function succeeded(nodeId: string, attemptId: string): EngineEvent {
  return { type: 'node.succeeded', runId: RUN, nodeId, attemptId, outputs: {} };
}
function failed(nodeId: string, attemptId: string, kind: FailureKind = 'transient'): EngineEvent {
  return { type: 'node.failed', runId: RUN, nodeId, attemptId, error: 'boom', kind };
}
function retryDue(nodeId: string, previousAttemptId: string): EngineEvent {
  return { type: 'node.retryDue', runId: RUN, nodeId, previousAttemptId };
}

/** Drive to the point where `id`'s attempt `n` is in flight (`dispatched`). */
function inFlight(eng: Engine, id: string, n = 0) {
  let s = eng.reduce(eng.seedState(), started()).state;
  s = eng.reduce(s, dispatched(id, `${id}#${n}`)).state;
  return s;
}

describe('F2b §A.3 — retry eligibility', () => {
  it('folds a retry-eligible transient failure to the NON-terminal `retry_pending` + scheduleRetry', () => {
    const eng = engine([node('a', { retry: 1 })]);
    const s = inFlight(eng, 'a');

    const r = eng.reduce(s, failed('a', 'a#0'));

    expect(r.state.nodes.a!.status).toBe('retry_pending');
    expect(r.commands).toEqual([{ type: 'scheduleRetry', nodeId: 'a', failedAttemptId: 'a#0' }]);
    // The HOLD's whole point: the run must NOT end while a node is held.
    expect(r.commands.filter((c) => c.type === 'finishRun')).toEqual([]);
    expect(r.state.status).toBe('running');
  });

  // #2 L7 — a `Retry-After` hint frozen on the durable `node.failed` is threaded
  // onto the `scheduleRetry` command so the driver can prefer it over the policy
  // interval. Copied verbatim; the reducer reads no clock (replay-deterministic).
  it('threads a node.failed retryAfterSeconds hint onto the scheduleRetry command', () => {
    const eng = engine([node('a', { retry: 1 })]);
    const s = inFlight(eng, 'a');

    const r = eng.reduce(s, {
      type: 'node.failed',
      runId: RUN,
      nodeId: 'a',
      attemptId: 'a#0',
      error: 'slow down',
      kind: 'transient',
      retryAfterSeconds: 42,
    });

    expect(r.commands).toEqual([
      { type: 'scheduleRetry', nodeId: 'a', failedAttemptId: 'a#0', retryAfterSeconds: 42 },
    ]);
  });

  it.each([['permanent' as const], ['cancelled' as const]])(
    'NEVER retries a `%s` failure, even with budget to spare (D4)',
    (kind) => {
      const eng = engine([node('a', { retry: 5 })]);
      const s = inFlight(eng, 'a');

      const r = eng.reduce(s, failed('a', 'a#0', kind));

      expect(r.state.nodes.a!.status).toBe('failure');
      expect(r.commands.filter((c) => c.type === 'scheduleRetry')).toEqual([]);
      expect(r.commands).toContainEqual(
        expect.objectContaining({ type: 'finishRun', outcome: 'failure' }),
      );
    },
  );

  it('a node with NO policy never retries — every doc written before F2b is unaffected', () => {
    const eng = engine([node('a')]);
    const s = inFlight(eng, 'a');

    const r = eng.reduce(s, failed('a', 'a#0'));

    expect(r.state.nodes.a!.status).toBe('failure');
    expect(r.commands.filter((c) => c.type === 'scheduleRetry')).toEqual([]);
  });

  it('an EXPLICIT `retry: 0` never retries ("never retry this node")', () => {
    const eng = engine([node('a', { retry: 0 })]);
    const s = inFlight(eng, 'a');

    const r = eng.reduce(s, failed('a', 'a#0'));

    expect(r.state.nodes.a!.status).toBe('failure');
    expect(r.commands.filter((c) => c.type === 'scheduleRetry')).toEqual([]);
  });
});

describe("F2b — `retry: N` means N retries AFTER the first attempt (F2a's contract)", () => {
  /**
   * Drive a node that fails TRANSIENTLY every time, serving each `scheduleRetry`
   * with an immediate `node.retryDue` (the driver's job, minus the clock), and
   * count how many times it was actually dispatched.
   *
   * This asserts the TOTAL attempt count, not just the first eligibility
   * decision, and that is deliberate: the spec's §A.3 rule
   * (`attempts < policy.retry`) passes a "transient+budget ⇒ retry_pending" test
   * but delivers `retry: N` → N total attempts, because `attempts` is already 1
   * at the first failure (it increments at DISPATCH). Only counting catches it.
   */
  function attemptsUntilTerminal(retry: number): { attempts: number; status: string } {
    const eng = engine([node('a', { retry })]);
    const start = eng.reduce(eng.seedState(), started());
    let s = start.state;
    const pending = [...start.commands];
    let dispatches = 0;

    let guard = 0;
    while (pending.length > 0) {
      if (guard++ > 100) throw new Error('did not converge');
      const c = pending.shift()!;
      if (c.type === 'dispatchNode') {
        dispatches += 1;
        s = eng.reduce(s, dispatched('a', c.attemptId)).state;
        const r = eng.reduce(s, failed('a', c.attemptId));
        s = r.state;
        pending.push(...r.commands);
        continue;
      }
      if (c.type === 'scheduleRetry') {
        // Stand in for the driver+clock: the retry is due immediately.
        const r = eng.reduce(s, retryDue('a', c.failedAttemptId));
        s = r.state;
        pending.push(...r.commands);
        continue;
      }
    }
    return { attempts: dispatches, status: s.nodes.a!.status };
  }

  it.each([
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
  ])('`retry: %i` → %i total attempts, then terminal failure', (retry, expected) => {
    const { attempts, status } = attemptsUntilTerminal(retry);

    expect(attempts).toBe(expected);
    expect(status).toBe('failure');
  });

  it('distinguishes `retry: 1` from `retry: 0` (the off-by-one the §A.3 formula hid)', () => {
    // Under `attempts < retry` these are IDENTICAL (1 attempt each) — an explicit
    // `retry: 1` would silently mean "never retry", which is the exact
    // absent-vs-explicit-0 confusion §A.3's rule exists to prevent.
    expect(attemptsUntilTerminal(1).attempts).toBe(2);
    expect(attemptsUntilTerminal(0).attempts).toBe(1);
  });
});

describe('F2b §A.4 — node.retryDue re-dispatches a held node', () => {
  it('mints a NEW attempt, consumes ONE retry, and emits dispatchNode', () => {
    const eng = engine([node('a', { retry: 2 })]);
    let s = inFlight(eng, 'a');
    s = eng.reduce(s, failed('a', 'a#0')).state;

    const r = eng.reduce(s, retryDue('a', 'a#0'));

    expect(r.state.nodes.a).toMatchObject({
      status: 'ready',
      attempts: 2,
      retries: 1,
      currentAttemptId: 'a#1',
    });
    expect(r.commands).toEqual([
      { type: 'dispatchNode', nodeId: 'a', attemptId: 'a#1', preparedInput: {} },
    ]);
  });

  it('IGNORES a duplicate retryDue (at-least-once delivery must fold idempotently)', () => {
    const eng = engine([node('a', { retry: 2 })]);
    let s = inFlight(eng, 'a');
    s = eng.reduce(s, failed('a', 'a#0')).state;
    s = eng.reduce(s, retryDue('a', 'a#0')).state; // the real one

    const r = eng.reduce(s, retryDue('a', 'a#0')); // the clock re-delivered it

    expect(r.commands).toEqual([]);
    expect(r.state.nodes.a).toMatchObject({ attempts: 2, retries: 1 });
  });

  it('REFUSES a retryDue for a node that is not held (a stale alarm after a success)', () => {
    const eng = engine([node('a', { retry: 2 }), node('b')], [edge('a', 'b', 'success')]);
    let s = inFlight(eng, 'a');
    s = eng.reduce(s, succeeded('a', 'a#0')).state;

    const r = eng.reduce(s, retryDue('a', 'a#0'));

    expect(r.commands).toEqual([]);
    expect(r.state.nodes.a!.status).toBe('success');
  });

  it('IGNORES a retryDue naming an attempt the node has moved past', () => {
    const eng = engine([node('a', { retry: 3 })]);
    let s = inFlight(eng, 'a');
    s = eng.reduce(s, failed('a', 'a#0')).state;
    s = eng.reduce(s, retryDue('a', 'a#0')).state;
    s = eng.reduce(s, dispatched('a', 'a#1')).state;
    s = eng.reduce(s, failed('a', 'a#1')).state; // held again, at attempt a#1

    const r = eng.reduce(s, retryDue('a', 'a#0')); // attempt-0's alarm, late

    expect(r.commands).toEqual([]);
    expect(r.state.nodes.a!.status).toBe('retry_pending');
  });

  it('does NOT widen LIVE_NODE — a late node.succeeded cannot fold onto a held node', () => {
    // §A.4: widening `LIVE_NODE` to include `retry_pending` would let the failed
    // attempt's late success resurrect the node. It must be stale-rejected.
    const eng = engine([node('a', { retry: 1 })]);
    let s = inFlight(eng, 'a');
    s = eng.reduce(s, failed('a', 'a#0')).state;

    const r = eng.reduce(s, succeeded('a', 'a#0'));

    expect(r.state.nodes.a!.status).toBe('retry_pending');
    expect(r.commands).toEqual([]);
  });
});

describe('F2b §A.1 — `retry_pending` is non-terminal, and that IS the mechanism', () => {
  it('holds the whole run open: a held node blocks the run from finishing', () => {
    const eng = engine([node('a', { retry: 1 }), node('b')], [edge('a', 'b', 'success')]);
    const s = inFlight(eng, 'a');

    const r = eng.reduce(s, failed('a', 'a#0'));

    expect(r.commands.filter((c) => c.type === 'finishRun')).toEqual([]);
    // `b` must not be skipped either — `a`'s success edge is still undecided.
    expect(r.state.nodes.b!.status).toBe('pending');
  });

  it('is outside TERMINAL_NODE — the single fact the whole HOLD rests on', () => {
    // Everything else in this describe is a CONSEQUENCE of this one line, which
    // is why F2b needed no new predicate: `endpointOutcome` returns null for it,
    // `allTopLevelTerminal` is false, containers wait, and `${nodes.x.status}`
    // refuses it (pinned in params.test.ts's non-terminal loop).
    expect(TERMINAL_NODE.has('retry_pending')).toBe(false);
    expect(TerminalNodeStatusSchema.options).not.toContain('retry_pending');
    // …while still being a real status the projection can hold.
    expect(NodeRunStatusSchema.options).toContain('retry_pending');
  });

  it('makes a CONTAINER wait for its held child (children.every(TERMINAL_NODE))', () => {
    const eng = engine(
      [node('c1', { retry: 1 })],
      [],
      [{ id: 'k', kind: 'stage', children: ['c1'] }],
    );
    let s = eng.reduce(eng.seedState(), started()).state;
    s = eng.reduce(s, dispatched('c1', 'c1#0')).state;

    const r = eng.reduce(s, failed('c1', 'c1#0'));

    expect(r.state.nodes.c1!.status).toBe('retry_pending');
    // The container must stay active — not decide an outcome on a held child.
    expect(r.state.containers.k!.status).toBe('active');
    expect(r.commands.filter((c) => c.type === 'finishRun')).toEqual([]);
  });
});

describe('F2b — the retry budget is PER LOOP ROUND, not per run lifetime', () => {
  it('a back-edge bounce RESETS `retries`, so round 2 retries as round 1 did', () => {
    // The defect this pins: `attempts` is deliberately MONOTONIC across a reset
    // (§A.6 — it is what makes a prior round's result unfoldable). Keying
    // eligibility on `attempts` would therefore let BOUNCES spend the operator's
    // retry budget: this node would retry in round 1 and never again, its budget
    // consumed by looping rather than by failing. `retries` is the separate
    // counter that fixes it; `attempts` keeps marching, as it must.
    const eng = engine(
      [node('gen', { retry: 1 }), node('check')],
      [
        edge('gen', 'check', 'success'),
        edge('check', 'gen', 'failure', { back: true, maxBounces: 5 }),
      ],
    );
    let s = eng.reduce(eng.seedState(), started()).state;

    // --- round 1: gen fails transiently, retries, succeeds; check fails → bounce
    s = eng.reduce(s, dispatched('gen', 'gen#0')).state;
    s = eng.reduce(s, failed('gen', 'gen#0')).state;
    expect(s.nodes.gen).toMatchObject({ status: 'retry_pending', retries: 0 });
    s = eng.reduce(s, retryDue('gen', 'gen#0')).state;
    expect(s.nodes.gen).toMatchObject({ retries: 1, attempts: 2 });
    s = eng.reduce(s, dispatched('gen', 'gen#1')).state;
    s = eng.reduce(s, succeeded('gen', 'gen#1')).state;
    s = eng.reduce(s, dispatched('check', 'check#0')).state;
    const bounced = eng.reduce(s, failed('check', 'check#0', 'permanent'));
    s = bounced.state;

    // The bounce reset the body: a FRESH budget, but attempts kept marching.
    expect(s.nodes.gen).toMatchObject({ status: 'ready', retries: 0 });
    expect(s.nodes.gen!.attempts).toBeGreaterThan(2);

    // --- round 2: the SAME transient failure must be retry-eligible again
    const attemptId = s.nodes.gen!.currentAttemptId!;
    s = eng.reduce(s, dispatched('gen', attemptId)).state;
    const r = eng.reduce(s, failed('gen', attemptId));

    expect(r.state.nodes.gen!.status).toBe('retry_pending');
    expect(r.commands).toContainEqual(
      expect.objectContaining({ type: 'scheduleRetry', nodeId: 'gen' }),
    );
  });

  it('boot recovery (node.retryRequested) does NOT consume the policy budget', () => {
    // A crash-recovery re-dispatch is not a policy retry: the node never got to
    // fail. `attempts` conflates the two (it counts BOTH), which is the third
    // reason eligibility cannot key off it.
    const eng = engine([node('a', { retry: 1 })]);
    let s = inFlight(eng, 'a');

    s = eng.reduce(s, {
      type: 'node.retryRequested',
      runId: RUN,
      nodeId: 'a',
      previousAttemptId: 'a#0',
      reason: 'boot_reconcile',
    }).state;
    expect(s.nodes.a).toMatchObject({ attempts: 2, retries: 0 });

    // The policy's ONE retry must still be available after the boot recovery.
    s = eng.reduce(s, dispatched('a', 'a#1')).state;
    const r = eng.reduce(s, failed('a', 'a#1'));

    expect(r.state.nodes.a!.status).toBe('retry_pending');
  });
});

describe('F2b §A.5 — a held run has NO boot-recovery path of its own (by design)', () => {
  it('run.resumed emits NOTHING for a held node — the durable alarm row is its recovery', () => {
    // This pins the DESIGNED behaviour, not an oversight — but NOT for the reason
    // this comment used to give ("re-deriving a scheduleRetry here would
    // DOUBLE-ARM the alarm"). That premise was false: `armWakeup` is
    // upsert-if-absent and returns the existing row whatever its status, so
    // re-arming is free. The real reason is that the reducer is PURE and cannot
    // read the alarm table, so it cannot answer the only question that matters —
    // does a row actually exist? A crash between the HOLD becoming durable and
    // the arm landing leaves a held node with NO alarm, and `reconcile.ts` (which
    // CAN see the table) is what checks for that and re-arms.
    //
    // It is also why F2b must never ship without F2c — a held run with no live
    // alarm clock stays `running` forever.
    const eng = engine([node('a', { retry: 1 })]);
    let s = inFlight(eng, 'a');
    s = eng.reduce(s, failed('a', 'a#0')).state;

    const r = eng.reduce(s, { type: 'run.resumed', runId: RUN, reason: 'boot_reconcile' });

    expect(r.commands).toEqual([]);
    expect(r.state.nodes.a!.status).toBe('retry_pending');
    expect(r.state.status).toBe('running');
  });
});

describe('F2b — node.retryScheduled is an inert durable fact', () => {
  it("folds to NOTHING: the state change was onFailed's, this only records when", () => {
    const eng = engine([node('a', { retry: 1 })]);
    let s = inFlight(eng, 'a');
    s = eng.reduce(s, failed('a', 'a#0')).state;

    const r = eng.reduce(s, {
      type: 'node.retryScheduled',
      runId: RUN,
      nodeId: 'a',
      attemptId: 'a#0',
      nextAttemptAt: 1_700_000_000_000,
    });

    expect(r.state).toEqual(s);
    expect(r.commands).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });
});
