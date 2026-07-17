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
    // #4 A1/A2 — the driver's OWN `evaluateControl` command (a `control` `if`/
    // `switch` evaluated its branch): fold the durable event NAMED BY the command
    // (`condition.evaluated` for an `if`, `switch.evaluated` for a `switch`), no
    // executor. Mirrors the real driver's `pump` (`server/src/run/driver.ts`,
    // which appends `command.event`) — hardcoding `condition.evaluated` here would
    // fold the wrong event on a switch node and exercise the switch path for the
    // WRONG reason. Without this an if/switch run never routes and the guard throws.
    if (c.type === 'evaluateControl') {
      apply({
        type: c.event,
        runId,
        nodeId: c.nodeId,
        attemptId: c.attemptId,
        branch: c.branch,
      });
      continue;
    }
    // #4 A7 — the driver's OWN `failNode` command (a `control` `fail` force-fails):
    // append `node.failed` with the message the reducer resolved, fixed
    // `kind:'permanent'` + `code:'forced_fail'`. Mirrors the real driver's `pump`
    // (`server/src/run/driver.ts` `failNode` branch); without it a fail node holds
    // `ready` forever and the run never finishes (`finish` stays undefined).
    if (c.type === 'failNode') {
      apply({
        type: 'node.failed',
        runId,
        nodeId: c.nodeId,
        attemptId: c.attemptId,
        error: c.error,
        kind: 'permanent',
        code: 'forced_fail',
      });
      continue;
    }
    // #4 A8 — the driver's OWN `succeedControl` command (a `control` `filter`
    // succeeds): append `node.succeeded` with the `outputs` the reducer resolved
    // (the filtered `{ result }`). Mirrors the real driver's `pump`
    // (`server/src/run/driver.ts` `succeedControl` branch); without it a filter
    // node holds `ready` forever and the run never finishes.
    if (c.type === 'succeedControl') {
      apply({
        type: 'node.succeeded',
        runId,
        nodeId: c.nodeId,
        attemptId: c.attemptId,
        outputs: c.outputs,
      });
      continue;
    }
    // #4 A6 — the driver's OWN `scheduleWait` command (a `control` `wait` parks on a
    // durable timer): the real driver ARMS S1's alarm then appends
    // `timer.waitScheduled`, and the alarm clock later appends `timer.due` once the
    // wall clock reaches `dueAt` (`server/src/run/driver.ts` `armWait` +
    // `scheduler/wait-alarm.ts`). The harness has NO clock, so it folds BOTH
    // immediately (synthetic `dueAt`) — exercising the park→resume state machine end
    // to end. Without it a wait node holds `ready` (then `wait_pending`) forever and
    // the run never finishes. The alarm's real timing/freshness is covered
    // server-side in `scheduler/__tests__/wait-alarm.test.ts`.
    if (c.type === 'scheduleWait') {
      apply({
        type: 'timer.waitScheduled',
        runId,
        nodeId: c.nodeId,
        attemptId: c.attemptId,
        dueAt: 0,
      });
      apply({
        type: 'timer.due',
        runId,
        nodeId: c.nodeId,
        previousAttemptId: c.attemptId,
      });
      continue;
    }
    // #4 A13 — the driver's OWN `scheduleExternalWait` command (a `control`
    // `webhook` parks awaiting an inbound callback): the real driver ARMS S1's
    // expiry alarm + a correlation row then appends `externalWait.created`, and the
    // node resumes when the inbound `POST /api/external-wait/:token` route appends
    // `externalWait.completed` (or the expiry alarm appends `externalWait.expired`)
    // — `server/src/run/driver.ts` `armExternalWait` + `routes/external-wait.ts` +
    // `scheduler/external-wait-alarm.ts`. The harness has no HTTP layer/clock, so it
    // models the HAPPY-PATH callback: fold `externalWait.created` then
    // `externalWait.completed` immediately (exercising the park→resume state machine
    // end to end). The EXPIRY path (`externalWait.expired` → `failure`) is a distinct
    // choice a harness can't make, so it is driven directly via `reduce` in
    // `webhook-routing.test.ts`; the route's real auth/replay/timing is covered
    // server-side (`routes/__tests__`, `scheduler/__tests__/external-wait-alarm.test.ts`).
    if (c.type === 'scheduleExternalWait') {
      apply({
        type: 'externalWait.created',
        runId,
        nodeId: c.nodeId,
        attemptId: c.attemptId,
        dueAt: 0,
      });
      apply({
        type: 'externalWait.completed',
        runId,
        nodeId: c.nodeId,
        previousAttemptId: c.attemptId,
      });
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
