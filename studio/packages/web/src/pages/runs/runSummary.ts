import {
  docNodeIdOf,
  EngineEventSchema,
  terminalStatusOf,
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
 * node state, but it needs the pipeline-version DOC, which this page does not
 * fetch (there is no get-version-by-id endpoint yet — a documented P6c
 * follow-up). So this derives a lighter, doc-free activity view straight off the
 * node-bearing events: a node appears the moment it is dispatched and lights up
 * as its result lands. Every payload is re-validated through `EngineEventSchema`
 * (the whole `EngineEvent` is stored as the envelope's `payload`); a row that
 * does not parse is skipped, not thrown — a live monitor must never crash on one
 * odd frame.
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
 * - `waiting`  — the node is PARKED on something external: a `wait`'s timer
 *   (`wait_pending`) or a `webhook`'s inbound callback (`external_wait_pending`).
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
   * For an executed node that is its dispatch count. Control activities
   * (`if`/`switch`/`wait`/`webhook`) are engine-evaluated and NEVER dispatched,
   * so their count comes from the event that STARTS them instead — the
   * evaluation or the park, each of which carries its own `attemptId` and so is
   * one attempt exactly. Counting only dispatches would leave every control node
   * reading `success` after 0 attempts, which reads as "never ran".
   */
  attempts: number;
  /** Count of streamed `node.output` observability events. */
  outputs: number;
  /** Name of the most recent `node.output`, if any (a live progress hint). */
  lastOutputName: string | undefined;
  /** The failure message, once the node has failed. */
  error: string | undefined;
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
  // the two apart.
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
      };
      byNode.set(nodeId, n);
    }
    return n;
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
        n.error = undefined;
        break;
      }
      case 'node.output': {
        const n = ensure(e.nodeId);
        n.outputs += 1;
        n.lastOutputName = e.name;
        break;
      }
      case 'node.succeeded': {
        ensure(e.nodeId).status = 'success';
        break;
      }
      case 'node.failed': {
        const n = ensure(e.nodeId);
        n.status = 'failure';
        n.error = e.error;
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
        n.error = undefined;
        break;
      }
      case 'node.retryScheduled': {
        // F2b/F2c (#483) — the node is HELD for its retry interval. `node.failed`
        // just painted it red; this says the run is still healthy and the node is
        // coming back. `error` is deliberately KEPT: it is the reason for the
        // hold, and the detail column is the only place it appears. It is cleared
        // by the `node.retryDue`/`node.dispatched` that re-open the node.
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
        n.error = undefined;
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
        ensure(e.callNodeId).status = e.childOutcome === 'success' ? 'success' : 'failure';
        break;
      }
      default:
        // Everything reaching here is deliberately NOT node activity. Stated
        // exhaustively, because an unexplained `default:` is how #483 happened:
        // five node-bearing events fell in here and the monitor quietly lied.
        //
        // - run.started / run.finished / run.resumed / run.interrupted /
        //   run.waiting / run.triggerContext / run.reseeded — RUN-level, folded by
        //   `deriveRunLifecycle`.
        // - container.timeoutScheduled / container.timedOut — CONTAINER-level:
        //   they carry a `containerId` and no `nodeId`, and this is a per-node
        //   table. A container's own state has no row to land in (a P6c
        //   follow-up, which needs the doc this page does not fetch).
        // - activity.metered / activity.captured / activity.agentTelemetry /
        //   activity.toolCalled — node-bearing but pure OBSERVABILITY: they say
        //   nothing about whether the node is running, and folding them would
        //   create rows for nodes that never started. `node.output` is the one
        //   observability event folded here, and only because it feeds the
        //   `outputs` count / `lastOutputName` progress hint.
        break;
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
