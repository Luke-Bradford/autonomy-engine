import { useEffect, useState } from 'react';
import type { Run } from '@autonomy-studio/shared';
import { listRuns } from '../../api/runs';
import { navigate } from '../../router';
import { formatWhen } from './format';

/**
 * The Runs list — the entry to the P6 live monitor. Runs are created by the
 * engine/scheduler (fire a trigger, or a scheduled window), never here, so this
 * page is read-only: it lists what has run and links each to its live detail
 * view. A run that is still executing is watched live on the detail page (the
 * WebSocket tail); this list itself is a point-in-time snapshot, refreshed on
 * demand.
 */
export function RunsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Refresh" to re-run the load effect (re-fetch on demand). The
  // effect owns the fetch so its AbortController cleanly cancels an in-flight
  // request on unmount or a re-refresh.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    listRuns(controller.signal)
      .then((rows) => {
        setRuns(rows);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [reloadKey]);

  return (
    <section aria-labelledby="runs-heading">
      <div className="page-header">
        <h2 id="runs-heading">Runs</h2>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)}>
          Refresh
        </button>
      </div>

      <p className="page-hint">
        Every fire of a trigger (or a scheduled window) creates a run. Open one to watch it unfold
        live — its nodes and events stream in as the engine executes.
      </p>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {runs === null && !error && <p>Loading runs…</p>}

      {runs !== null && runs.length === 0 && (
        <p>No runs yet. Fire a trigger on the Triggers page to start one.</p>
      )}

      {runs !== null && runs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Run</th>
              <th scope="col">Pipeline version</th>
              <th scope="col">Status</th>
              <th scope="col">Started</th>
              <th scope="col">Finished</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  <code>{r.id}</code>
                </td>
                <td>
                  <code>{r.pipelineVersionId}</code>
                </td>
                <td>
                  <span className={`run-status run-status-${r.status}`}>{r.status}</span>
                </td>
                <td>{formatWhen(r.startedAt)}</td>
                <td>{formatWhen(r.finishedAt)}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => navigate(`/runs/${r.id}`)}
                    aria-label={`Watch run ${r.id}`}
                  >
                    Watch
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
