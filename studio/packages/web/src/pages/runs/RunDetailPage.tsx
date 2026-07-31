import { Suspense, useEffect, useMemo, useState } from 'react';
import type { PipelineVersion, Run, RunLifecycleStatus } from '@autonomy-studio/shared';
import { useNavigate } from 'react-router';
import { getRun, getRunDetail } from '../../api/runs';
import { useRunStream, type StreamPhase } from './useRunStream';
import { deriveNodeActivity, deriveRunLifecycle } from './runSummary';
import { eventGloss, formatClock, formatWhen } from './format';
import { RunGraph } from './RunGraph.lazy';

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
  const nodes = useMemo(() => deriveNodeActivity(stream.events), [stream.events]);
  const lifecycle = useMemo(() => deriveRunLifecycle(stream.events), [stream.events]);
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
        /* #698 — the graph and everything needed to DRAW it (React Flow, and
           the engine reducer the overlay folds) load on demand, so the run
           metadata, node table and event feed below paint without waiting on
           either. The boundary is HERE rather than at the route for that
           reason: all of that is useful without the graph. */
        <Suspense fallback={<p className="page-hint">Loading the graph…</p>}>
          <RunGraph doc={doc} stream={stream} />
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
            {nodes.map((n) => (
              <tr key={n.nodeId}>
                <td>
                  <code>{n.nodeId}</code>
                </td>
                <td>
                  <span className={`node-status node-status-${n.status}`}>{n.status}</span>
                </td>
                <td>{n.attempts}</td>
                <td>{n.outputs}</td>
                <td>{n.error ?? (n.lastOutputName ? `output: ${n.lastOutputName}` : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
