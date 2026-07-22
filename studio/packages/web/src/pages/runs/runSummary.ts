import {
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

export type NodeActivityStatus = 'running' | 'success' | 'failure';

export interface NodeActivity {
  nodeId: string;
  status: NodeActivityStatus;
  /** How many times the node has been dispatched (retries bump this). */
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
  const ensure = (nodeId: string): NodeActivity => {
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
      case 'node.retryRequested': {
        // A retry re-opens the node; the following node.dispatched bumps attempts.
        const n = ensure(e.nodeId);
        n.status = 'running';
        n.error = undefined;
        break;
      }
      case 'call.returned': {
        ensure(e.callNodeId).status = e.childOutcome === 'success' ? 'success' : 'failure';
        break;
      }
      default:
        // run.started / run.finished / run.resumed / run.interrupted are
        // run-level (see deriveRunLifecycle), not node activity.
        //
        // F2b/F2c's `node.retryScheduled` + `node.retryDue` also land here, and
        // they are NOT run-level — this is a known gap, not a classification. A
        // node held for its retry interval keeps the RED `failure` pill its
        // `node.failed` set, though it is waiting to be retried, not failed. The
        // raw event feed below shows both events, so nothing is hidden; only this
        // per-node summary is wrong. Tracked as its own ticket because the fix
        // changes rendered UI and so needs the browser-verify gate.
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
