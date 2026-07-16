/**
 * The shared synchronous run-driver test harness (#499).
 *
 * ONE model of the P2d driver, hand-rolled identically in four (really five)
 * engine tests before this extraction. Each copy folds `run.started`, drains the
 * command queue the reducer returns, synthesizes `node.dispatched` then an
 * outcome event per `dispatchNode`, and folds `finishRun` → `run.finished`. A
 * reducer change touched all of them; the copies' docblocks had already drifted
 * and contradicted each other twice. This is the single home for that mechanic.
 *
 * WHY IT IS SAFE TO SHARE. A shared harness couples every reducer test to one
 * fixture, so a driver bug could hide across the whole suite. `run-driver.test.ts`
 * is the mitigation: it pins THIS driver's own event sequence + accounting
 * directly against the real reducer, so a mechanic bug surfaces there rather than
 * being silently absorbed downstream.
 *
 * WHAT VARIES, AND HOW. Only the per-node OUTCOME event differs between callers
 * (a plain success/failure vs a rich `plan` with custom outputs/error). That is
 * the injected `resolve` seam — everything else is identical, so it lives here.
 * Callers keep their own thin `runAll` wrapper adapting their ergonomic signature
 * to `driveRun`, so no call site changed.
 *
 * THE `finishes` COUNTER is load-bearing, not bookkeeping. It counts EVERY
 * `finishRun` the reducer emits rather than keeping only the first, and it is the
 * only thing that can catch an `else if` → `if` regression in `settle` that would
 * emit a second terminal command — the pump folds the first terminal and the run
 * goes terminal, so a naive "first finish only" harness would swallow the second
 * silently. `stalled-backstop.test.ts` asserts `finishes === 1` for exactly this.
 *
 * THE `guard` is a convergence backstop (a runaway queue throws rather than
 * hangs the suite). It deliberately does NOT catch the shape-specific defects the
 * malformed-doc / stalled tests pin — those files document, beside their own
 * wrappers, why the guard cannot protect them (a synchronous spin inside one
 * `reduce`, a throw inside `reduce`, an outcome-assertion catch). `driveRun`
 * NEVER wraps `reduce` in try/catch: malformed-doc relies on a #487 throw
 * propagating.
 */
import type { EngineCommand, EngineEvent, RunState } from '../../types.js';
import type { Engine } from '../../reduce.js';

/** The default run/version identifiers every engine test uses. */
const DEFAULT_RUN_ID = 'r1';
const DEFAULT_PV_ID = 'pv1';

/**
 * Produce the terminal event for a dispatched node — a `node.succeeded` or
 * `node.failed`. Receives `runId` so a caller that overrides it stays consistent.
 */
export type OutcomeResolver = (nodeId: string, attemptId: string, runId: string) => EngineEvent;

export interface DriveOptions {
  /** Defaults to `'r1'`. */
  runId?: string;
  /** Defaults to `'pv1'`. */
  pipelineVersionId?: string;
  /** `run.started` params. Defaults to `{}`. */
  params?: Record<string, unknown>;
  /** Injected per-node outcome — the ONE thing that varies between callers. */
  resolve: OutcomeResolver;
}

export interface DriveResult {
  /** The final projected run state. */
  state: RunState;
  /** Every event applied, in fold order — replays to `state`. */
  log: EngineEvent[];
  /** Every diagnostic the reducer emitted, concatenated in order. */
  diagnostics: string[];
  /** Dispatch order (each `dispatchNode`'s nodeId, as drained). */
  order: string[];
  /** The FIRST `finishRun` the reducer asked for (a healthy run has exactly one). */
  finish: { outcome: 'success' | 'failure'; reason?: string } | undefined;
  /** How many `finishRun` commands were drained — see the `finishes` note above. */
  finishes: number;
}

/**
 * The simple success/failure resolver shared by `edge-model`, `malformed-doc` and
 * `stalled-backstop`: each dispatched node succeeds with empty outputs, unless
 * named in `outcomes` with `'failure'` (then `node.failed{error:'boom',
 * kind:'permanent'}`). `reduce.test.ts` uses its own richer resolver (custom
 * outputs/error) and deliberately does NOT route through this.
 */
export function simpleResolve(
  outcomes: Record<string, 'success' | 'failure'> = {},
): OutcomeResolver {
  return (nodeId, attemptId, runId) =>
    (outcomes[nodeId] ?? 'success') === 'failure'
      ? { type: 'node.failed', runId, nodeId, attemptId, error: 'boom', kind: 'permanent' }
      : { type: 'node.succeeded', runId, nodeId, attemptId, outputs: {} };
}

/**
 * Drive a run to quiescence against the REAL reducer — no mocks. Folds
 * `run.started`, then drains the command queue: a `finishRun` folds
 * `run.finished`; a `dispatchNode` folds `node.dispatched` then the injected
 * outcome event. A `startChild`/other command is skipped (these docs are
 * call-free by construction; a caller needing children drives its own).
 */
export function driveRun(eng: Engine, opts: DriveOptions): DriveResult {
  const runId = opts.runId ?? DEFAULT_RUN_ID;
  const pipelineVersionId = opts.pipelineVersionId ?? DEFAULT_PV_ID;
  const params = opts.params ?? {};

  let state = eng.seedState();
  const log: EngineEvent[] = [];
  const diagnostics: string[] = [];
  const order: string[] = [];
  const pending: EngineCommand[] = [];
  let finish: { outcome: 'success' | 'failure'; reason?: string } | undefined;
  let finishes = 0;

  const apply = (ev: EngineEvent): void => {
    const r = eng.reduce(state, ev);
    state = r.state;
    log.push(ev);
    diagnostics.push(...r.diagnostics);
    pending.push(...r.commands);
  };

  apply({ type: 'run.started', runId, pipelineVersionId, params });
  let guard = 0;
  while (pending.length) {
    if (guard++ > 2000) throw new Error('driver did not converge');
    const c = pending.shift()!;
    if (c.type === 'finishRun') {
      finishes += 1;
      if (finish === undefined) finish = { outcome: c.outcome, reason: c.reason };
      apply({ type: 'run.finished', runId, outcome: c.outcome, reason: c.reason });
      continue;
    }
    if (c.type !== 'dispatchNode') continue;
    order.push(c.nodeId);
    apply({
      type: 'node.dispatched',
      runId,
      nodeId: c.nodeId,
      attemptId: c.attemptId,
      idempotent: true,
    });
    apply(opts.resolve(c.nodeId, c.attemptId, runId));
  }

  return { state, log, diagnostics, order, finish, finishes };
}
