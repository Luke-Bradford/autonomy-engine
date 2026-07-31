import { useEffect, useMemo, useState } from 'react';
import type { PipelineVersion, Run, RunLifecycleStatus, RunState } from '@autonomy-studio/shared';
import { useNavigate } from 'react-router';
import { getRunDetail } from '../../api/runs';
import { useRunStream, type RunStreamState, type StreamPhase } from './useRunStream';
import { deriveNodeActivity, deriveRunLifecycle } from './runSummary';
import { eventGloss, formatClock, formatWhen } from './format';
import { RunCanvas } from './RunCanvas';
import { engineForDoc, projectRun } from './runProjection';

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
 * The overlay is either projected, or it explains why it is not. There is no
 * "draw it anyway" state — see `useRunProjection`.
 */
type Overlay = { ready: true; state: RunState } | { ready: false; reason: string };

/** The pre-fetch state — module-level so it is a stable identity. */
const LOADING_GRAPH: Overlay = { ready: false, reason: 'Loading the pipeline graph…' };

/**
 * U11 — the ENGINE's node state for this run, or the reason there is none.
 *
 * Gated on the stream having finished replaying, which is load-bearing rather
 * than cosmetic. The engine's seed holds NO nodes until `run.started` folds, and
 * `useRunStream` starts from an empty log, so projecting mid-replay would draw a
 * finished run as a graph on which nothing has a status — and, a frame later, as
 * one where only the first node does. A monitor that says "nothing ran" about a
 * run that did is worse than one that says "not yet".
 *
 * That gate is also where the deliberate absence of an `events` member on R1 is
 * paid for: the overlay is fed by the WebSocket alone, so a stream that never
 * connects has no fallback source. It says so, in place, and the doc-free table
 * below is unaffected.
 *
 * Folds the WHOLE log per render, matching the page's two existing folds —
 * `projectRun` says why an incremental carry is not the win it looks like here.
 */
function useRunProjection(doc: PipelineVersion | null, stream: RunStreamState): Overlay {
  const engine = useMemo(() => (doc === null ? null : engineForDoc(doc)), [doc]);

  return useMemo(() => {
    if (engine === null) return LOADING_GRAPH;
    if (stream.phase === 'connecting' || stream.phase === 'replaying') {
      return { ready: false, reason: 'Loading this run\u2019s history\u2026' };
    }
    if (stream.phase === 'error') {
      return {
        ready: false,
        reason: 'The event stream is unavailable, so node state cannot be projected.',
      };
    }

    const projection = projectRun(engine, stream.events);
    return projection.ok
      ? { ready: true, state: projection.state }
      : { ready: false, reason: `Node state cannot be projected: ${projection.reason}.` };
  }, [engine, stream.events, stream.phase]);
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
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => ac.abort();
  }, [runId]);

  const stream = useRunStream(runId);
  const overlay = useRunProjection(doc, stream);
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
            : 'The pipeline graph is unavailable.'}
        </p>
      ) : (
        <>
          {/* The graph is drawn whether or not the run projects onto it — the
              authored shape is a fact of the version, and the run state is an
              overlay ON it. When there is no overlay the nodes say so, rather
              than being coloured as if nothing had run. */}
          <RunCanvas doc={doc} state={overlay.ready ? overlay.state : null} />
          {!overlay.ready && (
            <p className="page-hint" role="status">
              {overlay.reason}
            </p>
          )}
        </>
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
