import {
  docNodeIdOf,
  EngineEventSchema,
  terminalStatusOf,
  type FailureKind,
  type RunEvent,
  type RunLifecycleStatus,
} from '@autonomy-studio/shared';

/**
 * PURE derivations the live-run view renders from a run's event log. They take
 * the same `RunEvent` envelopes the REST replay returns and the WebSocket
 * tails, so history and live frames fold identically. Nothing here does I/O or
 * touches `window` except `runStreamUrl`, whose location is injectable for
 * tests.
 *
 * The full engine reducer (`createEngine(doc).projectRunState`) is the SSOT for
 * node state, and as of U11 the run page DOES fold it — R1
 * (`GET /api/runs/:id/detail`) resolves the version doc it needs, and
 * `runProjection.ts`/`RunCanvas.tsx` draw the result on the graph.
 *
 * This doc-FREE derivation is kept deliberately, and is not a leftover. It needs
 * no doc, so it still renders for a run whose version no longer resolves, and it
 * still renders while the stream is mid-replay — both cases where the overlay
 * correctly refuses to draw. Its status vocabulary is its own and LOSSIER than
 * the engine's on purpose (see `NodeActivity` below); where the two disagree,
 * the engine is right.
 */

/** Same-origin WebSocket URL for a run's live event tail. `wss` under TLS. */
export function runStreamUrl(
  runId: string,
  loc: { protocol: string; host: string } = window.location,
): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/api/runs/${encodeURIComponent(runId)}/events/stream`;
}

/**
 * What the monitor says a node is doing. `retrying` and `waiting` are the two
 * NON-TERMINAL holds, and they exist because without them a held node is
 * indistinguishable from a failed one (#483):
 *
 * - `retrying` — the node failed `transient`ly, its policy still has budget, and
 *   it is waiting out the retry interval (the engine's `retry_pending`).
 * - `waiting`  — the node is PARKED on a DURABLE alarm that announced itself in
 *   the log: a `wait`'s timer (`wait_pending`) or a `webhook`'s inbound callback
 *   (`external_wait_pending`).
 *
 * NOT the engine's `NodeRunStatus.waiting`, which means something else entirely
 * (a `call_pipeline` node whose child run is in flight). This vocabulary is the
 * MONITOR's, and deliberately lossy — see the module doc on why this view is
 * doc-free. A call node is in fact the one park this status CANNOT show: the
 * engine parks it via a `startChild` COMMAND and appends no event until
 * `call.returned`, so there is nothing in the log to fold and the node stays
 * absent from the table for the whole child run (#796 — it needs a new engine
 * event, not a projection change).
 *
 * That window is one synchronous step TODAY, not a real blind spot: `call_pipeline`
 * does not execute yet (the executor's `startChild` branch yields an immediate
 * `call.returned{failure}` — P3b), so there is no child run to be blind to. #796
 * owns the spawn seam AND the `call.started` append it then owes; #735, which
 * reported the blind spot alone, closed into it.
 *
 * Both are healthy, in-progress states. They are deliberately distinct from
 * `running`: `running` means the node is executing, and a held/parked node is
 * not — conflating them would tell an operator watching a stuck run that work is
 * happening when nothing is.
 */
export type NodeActivityStatus = 'running' | 'retrying' | 'waiting' | 'success' | 'failure';

export interface NodeActivity {
  nodeId: string;
  status: NodeActivityStatus;
  /**
   * How many times the node has been STARTED, and retries bump it.
   *
   * For an executed node that is its dispatch count. But SIX activity kinds are
   * engine-evaluated and never dispatched at all — `if`, `switch`, `wait`,
   * `webhook`, `fail`, `filter` — as is a `call_pipeline` node, so counting only
   * `node.dispatched` would leave every one of them reading terminal after 0
   * attempts, i.e. "never ran".
   *
   * Two rules cover them without a doc (which this view does not have, so it
   * cannot ask what KIND a node is):
   *  - an event that STARTS a node counts (a dispatch, an `if`/`switch`
   *    evaluation, a `wait`/`webhook` park) — each carries its own `attemptId`,
   *    so one event is one attempt exactly;
   *  - a TERMINAL event for a node with no attempts yet is itself the start
   *    (`fail`/`filter`, whose only event is their `node.failed`/`node.succeeded`,
   *    and a call node, whose only event is `call.returned`). A dispatched node
   *    already has attempts ≥ 1 by then, so this never double-counts.
   */
  attempts: number;
  /** Count of streamed `node.output` observability events. */
  outputs: number;
  /** Name of the most recent `node.output`, if any (a live progress hint). */
  lastOutputName: string | undefined;
  /** The failure message, once the node has failed. */
  error: string | undefined;
  /**
   * #1 F0's machine-readable failure CLASS, off the `node.failed` that set
   * `error` — the difference between "the provider throttled us" and "the
   * credential is wrong", which the raw message is not obliged to say.
   *
   * `undefined` is a real answer, not a gap: two failure paths never produce a
   * `node.failed` at all (`externalWait.expired`, whose expiry alarm fails the
   * node directly), so a red row can legitimately have no class. Readers must
   * render the absence rather than substitute a default — the reducer's own
   * reading of an expired wait as permanent lives in the reducer, and restating
   * it here would make this a second, drifting authority on it.
   */
  failureKind: FailureKind | undefined;
  /** The optional machine detail beside `failureKind` (`FAILURE_CODES`, open). */
  failureCode: string | undefined;
  /**
   * The DECLARED outputs of the most recent `node.succeeded` — the node's typed
   * result contract, distinct from `outputs`/`lastOutputName` above, which count
   * the streamed `node.output` observability frames.
   */
  outputValues: Record<string, unknown> | undefined;
  /**
   * The RAW node id the result on show came from, when it differed from the
   * canvas node id this row folds onto — i.e. a parallel foreach's item instance
   * (`w@1` → `w`). `undefined` for an ordinary node, so the collapse is named
   * exactly where it happened instead of being caveated everywhere.
   */
  instanceId: string | undefined;
}

/**
 * Fold the node-bearing events into per-node activity, in first-seen order
 * (insertion order of the map = dispatch order, stable for rendering). A node
 * is first seen on its dispatch (or a `call.returned` for a call node whose
 * dispatch is not itself an event).
 */
export function deriveNodeActivity(events: RunEvent[]): NodeActivity[] {
  const byNode = new Map<string, NodeActivity>();
  // #566 slice 2 / #4 A4b — a PARALLEL foreach's body events carry per-item
  // INSTANCE keys (`w@1`); fold them onto the CANVAS node's row (`w`) so item
  // instances light up the one node the author drew — last-write-wins, the same
  // collapse the sequential foreach's rounds already have. CAVEAT: a literal
  // node id shaped like `x@2` is folded onto `x` too — accepted; save-time now
  // refuses such ids for parallel docs, and a doc-free event view cannot tell
  // the two apart. Since #483 that collapse also covers the PARKED statuses, and
  // reads worse there: a parallel foreach over a `wait` shows `success` the
  // moment the FIRST instance's timer fires, while its siblings are still parked.
  // Same last-write-wins rule as before, just newly visible.
  //
  // NO STALENESS GUARD, unlike every reducer fold this mirrors (which check node
  // status + `attemptId` and no-op on redelivery). That is safe only because the
  // durable-alarm handlers gate the APPEND — `retry-alarm.ts`, `wait-alarm.ts`,
  // `external-wait-alarm.ts` all check the node is still parked at that attempt
  // before writing, and the webhook route has its own row-status guard — so a
  // stale `timer.due`/`externalWait.expired`/`node.retryDue` never reaches the
  // log at all. That is an EXTERNAL guarantee this file depends on: if an append
  // guard were ever relaxed, a late `externalWait.expired` would flip a green row
  // red here while the reducer treats it as a no-op, and the two views would
  // disagree with nothing failing.
  const ensure = (rawNodeId: string): NodeActivity => {
    const nodeId = docNodeIdOf(rawNodeId);
    let n = byNode.get(nodeId);
    if (!n) {
      n = {
        nodeId,
        status: 'running',
        attempts: 0,
        outputs: 0,
        lastOutputName: undefined,
        error: undefined,
        failureKind: undefined,
        failureCode: undefined,
        outputValues: undefined,
        instanceId: undefined,
      };
      byNode.set(nodeId, n);
    }
    return n;
  };

  /**
   * Drop the node's last TERMINAL result, because the node has re-opened. One
   * helper rather than five assignments at each of the three re-open sites: the
   * message, its class, the outputs and the instance they came from are one
   * fact, and splitting them is how a stale kind outlives the message it
   * classifies. Deliberately NOT called on `node.retryScheduled` — the hold
   * keeps its reason on screen (see that case).
   */
  const clearResult = (n: NodeActivity): void => {
    n.error = undefined;
    n.failureKind = undefined;
    n.failureCode = undefined;
    n.outputValues = undefined;
    n.instanceId = undefined;
  };

  /** The raw id, when this event came from a foreach ITEM INSTANCE of the node. */
  const instanceOf = (rawNodeId: string): string | undefined =>
    docNodeIdOf(rawNodeId) === rawNodeId ? undefined : rawNodeId;

  /**
   * A TERMINAL event for a node we never saw start. That happens for the
   * activities the engine evaluates itself and never dispatches — `fail` and
   * `filter`, whose only event is the `node.failed`/`node.succeeded` the driver
   * appends for them, and a `call_pipeline` node, whose only event is
   * `call.returned`. Their one event IS their one attempt. A dispatched (or
   * evaluated, or parked) node already has attempts ≥ 1 by the time it
   * terminates, so this can never double-count.
   */
  const countIfUnstarted = (n: NodeActivity): void => {
    if (n.attempts === 0) n.attempts = 1;
  };

  for (const row of events) {
    const parsed = EngineEventSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    const e = parsed.data;
    switch (e.type) {
      case 'node.dispatched': {
        const n = ensure(e.nodeId);
        n.status = 'running';
        n.attempts += 1;
        clearResult(n);
        break;
      }
      case 'node.output': {
        const n = ensure(e.nodeId);
        n.outputs += 1;
        n.lastOutputName = e.name;
        break;
      }
      case 'node.succeeded': {
        const n = ensure(e.nodeId);
        n.status = 'success';
        n.outputValues = e.outputs;
        n.instanceId = instanceOf(e.nodeId);
        countIfUnstarted(n); // a `filter`'s only event
        break;
      }
      case 'node.failed': {
        const n = ensure(e.nodeId);
        n.status = 'failure';
        n.error = e.error;
        n.failureKind = e.kind;
        n.failureCode = e.code;
        n.instanceId = instanceOf(e.nodeId);
        countIfUnstarted(n); // a `fail` control node's only event
        break;
      }
      case 'node.retryRequested':
      case 'node.retryDue': {
        // Both re-OPEN the node, and the `node.dispatched` that follows is what
        // bumps `attempts` — so neither counts an attempt of its own, or every
        // retry would be counted twice. (`retryRequested` is the boot
        // reconciler's crash-recovery decision, `retryDue` is F2b/F2c's policy
        // retry firing; they differ in the engine, not in what the monitor shows.)
        const n = ensure(e.nodeId);
        n.status = 'running';
        clearResult(n);
        break;
      }
      case 'node.retryScheduled': {
        // F2b/F2c (#483) — the node is HELD for its retry interval. `node.failed`
        // just painted it red; this says the run is still healthy and the node is
        // coming back. `error` is deliberately KEPT: it is the reason for the
        // hold, and the detail column is the only place it appears. It is cleared
        // by the `node.retryDue`/`node.dispatched` that re-open the node.
        // U24: the failure CLASS is kept for the same reason and cleared by the
        // same events — `clearResult` moves the whole result as one fact, so the
        // kind can never outlive the message it classifies.
        ensure(e.nodeId).status = 'retrying';
        break;
      }
      case 'timer.waitScheduled':
      case 'externalWait.created': {
        // #4 A5/A6 + A13 — the node PARKED on an alarm (a `wait`'s timer) or on an
        // inbound callback (a `webhook`). These are the START of a control node's
        // life, not a transition within it: such nodes are engine-evaluated and
        // never dispatched, so this is also the event that counts their attempt.
        const n = ensure(e.nodeId);
        n.status = 'waiting';
        n.attempts += 1;
        clearResult(n);
        break;
      }
      case 'timer.due':
      case 'externalWait.completed': {
        // The park resolved successfully. These ARE the node's success event —
        // there is no following `node.succeeded` for a parked node (reduce.ts
        // `onWaitDue` / `onExternalWaitCompleted` flip it to `success` directly).
        ensure(e.nodeId).status = 'success';
        break;
      }
      case 'externalWait.expired': {
        // #4 A13 — the expiry alarm beat the callback, which the reducer treats as
        // a PERMANENT failure. The event carries no message (there is no provider
        // to quote), so state the reason rather than leave a red row with a blank
        // detail column.
        const n = ensure(e.nodeId);
        n.status = 'failure';
        n.error = 'external wait expired before a callback arrived';
        break;
      }
      case 'condition.evaluated':
      case 'switch.evaluated': {
        // An `if`/`switch` is engine-evaluated and never dispatched, and THIS is
        // its terminal-success event (reduce.ts `onControlBranchEvaluated`). Until
        // it was folded, control nodes never appeared in this table at all — the
        // author drew them, the run executed them, and the monitor showed nothing.
        const n = ensure(e.nodeId);
        n.status = 'success';
        n.attempts += 1;
        break;
      }
      case 'call.returned': {
        const n = ensure(e.callNodeId);
        n.status = e.childOutcome === 'success' ? 'success' : 'failure';
        countIfUnstarted(n); // a call node's only event
        break;
      }

      // ── Deliberately NOT node activity ────────────────────────────────────
      // Listed as explicit empty cases rather than swept into a `default:`, and
      // that is the actual fix for #483's defect CLASS. #483 was not "two events
      // were missed"; it was that a `default:` silently absorbed NINE node-bearing
      // events and the monitor lied with every unit test green. Prose cannot stop
      // that recurring — the `never` assertion below can: every one of the union's
      // members is now named, so adding a 29th `EngineEvent` narrows `e` to
      // something other than `never` in the final branch and fails TYPECHECK until
      // its author decides which side it falls on. Same guard `engine/reduce.ts`
      // documents for `NodeRunStatus`, in the form a non-returning switch needs.

      // Why each is ignored, kept HERE rather than beside its `case` so the
      // labels stay adjacent — eslint's `no-fallthrough` counts a case carrying
      // only a comment as non-empty (the same constraint `engine/reduce.ts`
      // records):
      //   - `run.*` — RUN-level, no node row. `run.started`/`run.resumed`/
      //     `run.waiting` and the terminal pair are folded by
      //     `deriveRunLifecycle` below. `run.triggerContext` and `run.reseeded`
      //     are folded by NOTHING today — they are provenance that only the raw
      //     event feed renders.
      //   - `container.*` — CONTAINER-level: they carry a `containerId` and NO
      //     `nodeId`, so in a per-node table there is no row for them to land in.
      //     Surfacing container state needs the version doc this page does not
      //     fetch (a P6c follow-up).
      //   - `activity.*` — node-bearing but pure OBSERVABILITY: they say nothing
      //     about whether the node is running, and folding them would create rows
      //     for nodes that never started. `node.output` is the one observability
      //     event folded above, and only because it feeds the `outputs` count and
      //     the `lastOutputName` progress hint.
      case 'run.started':
      case 'run.finished':
      case 'run.resumed':
      case 'run.interrupted':
      case 'run.waiting':
      case 'run.triggerContext':
      case 'run.reseeded':
      case 'container.timeoutScheduled':
      case 'container.timedOut':
      case 'activity.metered':
      case 'activity.captured':
      case 'activity.agentTelemetry':
      case 'activity.toolCalled':
      case 'activity.warned':
        break;
      default: {
        // Unreachable while every member above is named — which is exactly the
        // property being enforced. A new event type makes this assignment fail to
        // compile; it is not a runtime branch.
        const exhaustive: never = e;
        void exhaustive;
        break;
      }
    }
  }

  return [...byNode.values()];
}

/**
 * The run's lifecycle status AS THE LOG SEES IT, or `null` if no lifecycle event
 * has landed yet (the caller then shows the run row's REST status). Later events
 * win, so a `run.finished` after `run.started` yields the terminal outcome.
 *
 * The terminal events map through `terminalStatusOf` — the engine's SSOT (#443),
 * shared with the reducer and the boot reconciler, so this page and `runs.status`
 * can never disagree about what a `run.finished` MEANS.
 *
 * Deliberately NOT the same rule as the server's `terminalFactFromLog`, which
 * takes the last TERMINAL event: this is a live VIEW, so a `run.resumed` tailing
 * in must show the run as running again. `terminalFactFromLog` answers a
 * different question — "what terminal fact does this log durably record" — where a
 * resume must never erase the terminal under it. Same mapping, different rule, by
 * intent.
 */
export function deriveRunLifecycle(events: RunEvent[]): RunLifecycleStatus | null {
  let status: RunLifecycleStatus | null = null;
  for (const row of events) {
    const parsed = EngineEventSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    const e = parsed.data;
    const terminal = terminalStatusOf(e);
    if (terminal !== null) {
      status = terminal;
    } else if (e.type === 'run.started' || e.type === 'run.resumed') {
      // A resume/(re)start tailing in shows the run running again — and CLEARS a
      // prior `waiting` (the live-view reverse edge, mirroring the reducer's
      // waiting→running un-park, wired in #619 as `unparkIfWaiting`).
      status = 'running';
    } else if (e.type === 'run.waiting') {
      // #5 S3 — the run parked on an external event. Live VIEW: show it `waiting`
      // (not the stale `running`) until a `run.started`/`run.resumed` returns it.
      // Non-exhaustive if/else, so this case is added by hand (no compile guard).
      status = 'waiting';
    }
  }
  return status;
}
