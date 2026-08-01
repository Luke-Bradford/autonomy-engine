import { Suspense, useEffect, useMemo, useState } from 'react';
import type { PipelineVersion, Run, RunLifecycleStatus } from '@autonomy-studio/shared';
import { useNavigate } from 'react-router';
import { getRun, getRunDetail } from '../../api/runs';
import { useRunStream, type StreamPhase } from './useRunStream';
import { deriveNodeActivity, deriveRunLifecycle, reconcileNodeActivity } from './runSummary';
import { eventGloss, failureClass, formatClock, formatWhen } from './format';
import { nodeStatusLabel } from './nodeStatus';
import { NodeActivityPanel, PANEL_ID } from './NodeActivityPanel';
import { RunGraph } from './RunGraph.lazy';
import { useRunProjection } from './useRunProjection';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Cap on the raw event feed's rendered rows (most recent kept) — bounds the
 * DOM on a chatty run. Node activity is still folded from the full log. */
const MAX_FEED_ROWS = 500;

/** A short, accessible label for the live-connection state. */
function phaseLabel(phase: StreamPhase): string {
  switch (phase) {
    case 'connecting':
      return 'connecting…';
    case 'replaying':
      return 'loading history…';
    case 'live':
      return '● live';
    case 'closed':
      return 'stream ended';
    case 'error':
      return 'stream error';
  }
}

/**
 * The live run monitor — the "watch it run live" MVP step. It fetches the run's
 * immutable metadata once (REST), then tails `run_events` over the WebSocket
 * (replay-then-live via `useRunStream`). Everything below the header is derived
 * PURELY from the event log, so the same code renders a finished run's history
 * and a running run's live feed identically:
 *   - the run's lifecycle status comes from the log (`deriveRunLifecycle`),
 *     falling back to the REST row until the first lifecycle event lands;
 *   - a per-node activity table lights up as nodes dispatch and settle;
 *   - a raw event feed shows every append in order.
 */
export function RunDetailPage({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [doc, setDoc] = useState<PipelineVersion | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // `RunDetailRoute` renders this with `key={runId}`, so a different run
  // remounts the component fresh (state back to null) rather than us resetting
  // state synchronously in the effect body — the effect only performs the fetch.
  useEffect(() => {
    const ac = new AbortController();
    getRunDetail(runId, ac.signal)
      .then((d) => {
        setRun(d.run);
        setDoc(d.pipelineVersion);
      })
      .catch((detailErr: unknown) => {
        if (ac.signal.aborted) return;
        /* R1 resolves the run AND its doc together, so a doc that will not
           resolve (409 — deleted, or present but no longer parsing) would
           otherwise cost the operator the run's metadata, the node table and the
           event feed as well. None of those need the doc, and a run whose graph
           is gone is exactly when they matter most — `terminalFactFromLog`
           records the same preference on the server. So fall back to the plain
           run read; only if THAT fails is the page genuinely empty. */
        return getRun(runId, ac.signal).then(
          (r) => {
            setRun(r);
            setLoadError(
              `The pipeline graph could not be loaded, so there is no node overlay: ${message(detailErr)}`,
            );
          },
          () => {
            if (ac.signal.aborted) return;
            setLoadError(message(detailErr));
          },
        );
      });
    return () => ac.abort();
  }, [runId]);

  const stream = useRunStream(runId);

  /* U25 — ONE projection for the whole page. The graph below takes this same
     overlay rather than folding the log a second time inside its lazy chunk,
     and the node table reconciles against it, so neither surface can invent a
     status the other does not have: they read one value.

     They can still SAY different amounts about one node, and the honest
     statement of the guarantee is narrower than "they agree". A parallel
     foreach's body node has no bare-id entry in `state.nodes` at all, so the
     graph draws it with no status while the table shows the fold's — the graph
     is silent, not contradictory, and the table is the better-informed of the
     two. That predates U25 (`runFlow.ts` reads `state.nodes[n.id]` directly)
     and is #439 UI work, not a reconciliation bug. */
  const overlay = useRunProjection(doc, stream);
  const folded = useMemo(() => deriveNodeActivity(stream.events), [stream.events]);
  const nodes = useMemo(
    /* When the engine has an opinion it wins, and it brings the rows the log
       alone cannot produce — a node that never started, and a node routed
       AROUND (which the reducer computes and appends no event for, so the fold
       structurally cannot show it). Without a trustworthy projection the
       doc-free fold stands on its own, which is the case a run whose version no
       longer resolves has always depended on. */
    () => (overlay.ready ? reconcileNodeActivity(folded, overlay.state) : folded),
    [folded, overlay],
  );
  const lifecycle = useMemo(() => deriveRunLifecycle(stream.events), [stream.events]);

  // U24 — which node's drill-in is open. Held as an ID and RESOLVED against the
  // live fold rather than storing the row itself, so the panel tracks a running
  // node's state as frames arrive, and a node that leaves the table (a different
  // run's log replacing this one) closes the panel by simply not resolving.
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  const openNode = useMemo(
    () => nodes.find((n) => n.nodeId === openNodeId) ?? null,
    [nodes, openNodeId],
  );
  const status: RunLifecycleStatus | string = lifecycle ?? run?.status ?? 'pending';

  // The raw feed is capped to the most recent rows so a chatty run (thousands of
  // `node.output` frames) can't grow the DOM without bound; node activity above
  // is still folded from the FULL log, so nothing is lost from the summary.
  const totalEvents = stream.events.length;
  const feed = useMemo(
    () => (totalEvents > MAX_FEED_ROWS ? stream.events.slice(-MAX_FEED_ROWS) : stream.events),
    [stream.events, totalEvents],
  );

  return (
    <section aria-labelledby="run-heading">
      <div className="page-header">
        <h2 id="run-heading">
          Run <code>{runId}</code>
        </h2>
        <button type="button" onClick={() => void navigate('/monitor/runs')}>
          ← All runs
        </button>
      </div>

      <p className="page-hint">
        <span className={`run-status run-status-${status}`}>{status}</span>{' '}
        <span className={`stream-phase stream-phase-${stream.phase}`} role="status">
          {phaseLabel(stream.phase)}
        </span>
      </p>

      {loadError && (
        <p role="alert" className="error">
          {loadError}
        </p>
      )}
      {stream.phase === 'error' && stream.error && (
        <p role="alert" className="error">
          {stream.error}
        </p>
      )}

      {run && (
        <dl className="run-meta">
          <dt>Pipeline version</dt>
          <dd>
            <code>{run.pipelineVersionId}</code>
          </dd>
          <dt>Trigger</dt>
          <dd>{run.triggerId ? <code>{run.triggerId}</code> : '—'}</dd>
          <dt>Started</dt>
          <dd>{formatWhen(run.startedAt)}</dd>
          <dt>Finished</dt>
          <dd>{formatWhen(run.finishedAt)}</dd>
          <dt>Params</dt>
          <dd>
            <code>{JSON.stringify(run.params)}</code>
          </dd>
        </dl>
      )}

      <h3>Graph</h3>
      {doc === null ? (
        <p>
          {loadError === null
            ? 'Loading the pipeline graph…'
            : 'The pipeline graph is unavailable, so there is no node overlay. The event feed below is unaffected.'}
        </p>
      ) : (
        /* #698 — React Flow loads on demand, so the run metadata, node table
           and event feed below paint without waiting on it. The boundary is
           HERE rather than at the route for that reason: all of that is useful
           without the graph. The engine reducer used to sit behind this
           boundary too and no longer does (U25 lifted the projection to the
           page so the table could reconcile against it) — which changed no
           bytes, because eager code already imported the engine barrel and
           `reduce.js` was placed in the entry chunk regardless. */
        <Suspense fallback={<p className="page-hint">Loading the graph…</p>}>
          <RunGraph doc={doc} overlay={overlay} />
        </Suspense>
      )}

      <h3>Nodes</h3>
      {nodes.length === 0 ? (
        <p>No node activity yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Node</th>
              <th scope="col">Status</th>
              <th scope="col">Attempts</th>
              <th scope="col">Outputs</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => {
              /* U24 — the failure CLASS beside the message. `""` when the
                 failure carries none, which is a real state (an expired
                 external wait), so it renders as nothing rather than a guess. */
              const cls = failureClass(n.failureKind, n.failureCode);
              return (
                <tr key={n.nodeId}>
                  <td>
                    {/* A real <button> rather than a clickable/aria-ified <tr>:
                        it takes its accessible name from the node id for free
                        and is keyboard-operable without inventing key handling. */}
                    <button
                      type="button"
                      className="node-drill-in"
                      aria-expanded={openNodeId === n.nodeId}
                      aria-controls={openNodeId === n.nodeId ? PANEL_ID : undefined}
                      onClick={() => setOpenNodeId(openNodeId === n.nodeId ? null : n.nodeId)}
                    >
                      <code>{n.nodeId}</code>
                    </button>
                  </td>
                  <td>
                    {/* U25 — the word comes from `nodeStatus.ts`, which the
                        graph reads too, so the two surfaces cannot describe one
                        node differently. The CLASS stays keyed on the raw
                        status: the graph's six tones put a retry backoff and a
                        routine park in one `holding` hue, and #483 established
                        that those must not share a colour here. */}
                    <span className={`node-status node-status-${n.status}`}>
                      {nodeStatusLabel(n.status)}
                    </span>
                  </td>
                  <td>{n.attempts}</td>
                  <td>{n.outputs}</td>
                  <td>
                    {n.error !== undefined
                      ? cls === ''
                        ? n.error
                        : `${n.error} (${cls})`
                      : n.lastOutputName
                        ? `output: ${n.lastOutputName}`
                        : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {openNode !== null && (
        <NodeActivityPanel node={openNode} onClose={() => setOpenNodeId(null)} />
      )}

      <h3>Events</h3>
      {totalEvents === 0 ? (
        <p>No events yet.</p>
      ) : (
        <table className="event-feed">
          <thead>
            <tr>
              <th scope="col">Seq</th>
              <th scope="col">Time</th>
              <th scope="col">Type</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {totalEvents > MAX_FEED_ROWS && (
              <tr>
                <td colSpan={4}>
                  … showing the most recent {MAX_FEED_ROWS} of {totalEvents} events
                </td>
              </tr>
            )}
            {feed.map((e) => (
              <tr key={e.seq}>
                <td>{e.seq}</td>
                <td>{formatClock(e.ts)}</td>
                <td>
                  <code>{e.type}</code>
                </td>
                <td>{eventGloss(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
