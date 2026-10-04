import { Link } from 'react-router';
import type { ActivityRun, RunStatus } from '@autonomy-studio/shared';
import { When } from '../../lib/When';
import { failureClass, formatCount, formatElapsed } from './format';
import { nodeStatusLabel, nodeStatusPillClass } from './nodeStatus';
import { runDetailPath } from './runPath';
import { ACTIVITY_RUN_COLUMNS, iterationText } from './activityRunsColumns';

/** Bytes as the activity reported them, saying which way they moved. */
function bytesText(row: ActivityRun): string {
  const parts: string[] = [];
  if (row.bytesRead !== null) parts.push(`${formatCount(row.bytesRead)} read`);
  if (row.bytesWritten !== null) parts.push(`${formatCount(row.bytesWritten)} written`);
  return parts.join(' · ');
}

const count = (n: number | null) => (n === null ? '' : formatCount(n));

/**
 * #1484 OR35 M2 — the run's activity runs: one row per attempt of each activity,
 * per iteration, directly under the run's header (the server's projection,
 * `GET /api/runs/:id/activity-runs`). Dense on purpose: 32px rows, 13px text,
 * numbers right-aligned. An empty cell is a fact the activity did not report,
 * not a zero.
 *
 * Names and types come from the version that ran (`nameOf`, `typeOf`), never
 * from the server, which names nothing.
 */
export function ActivityRunsTable({
  rows,
  error,
  runStatus,
  nameOf,
  typeOf,
}: {
  rows: readonly ActivityRun[] | null;
  error: string | null;
  runStatus: RunStatus;
  nameOf: (activityId: string) => string | null;
  typeOf: (activityId: string) => string | null;
}) {
  return (
    <section className="activity-runs" aria-labelledby="activity-runs-heading">
      <h3 id="activity-runs-heading">Activity runs</h3>
      {error !== null && (
        <p role="alert" className="error">
          Could not read the activity runs: {error}
        </p>
      )}
      {rows === null ? (
        error === null && <p>Loading activity runs…</p>
      ) : rows.length === 0 ? (
        <p>No activity has run yet.</p>
      ) : (
        <div className="activity-runs__scroll">
          <table className="activity-runs__table">
            <thead>
              <tr>
                {ACTIVITY_RUN_COLUMNS.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const name = nameOf(row.activityId);
                const errorLine = row.error?.message.split('\n')[0] ?? '';
                // The class beside the message, as the node table words it.
                const cls =
                  row.error === null
                    ? ''
                    : failureClass(row.error.kind ?? undefined, row.error.code ?? undefined);
                return (
                  <tr key={row.key} data-activity-id={row.activityId}>
                    <td title={row.nodeId}>{name ?? <code>{row.nodeId}</code>}</td>
                    <td>{typeOf(row.activityId) ?? ''}</td>
                    <td>
                      {row.reused ? (
                        <span className={nodeStatusPillClass('success', runStatus)}>reused</span>
                      ) : (
                        <span className={nodeStatusPillClass(row.status, runStatus)}>
                          {nodeStatusLabel(row.status, runStatus)}
                        </span>
                      )}
                    </td>
                    <td>
                      <When ms={row.startedAt} precision="ms" timeOfDay />
                    </td>
                    <td>
                      <When ms={row.finishedAt} precision="ms" timeOfDay />
                    </td>
                    <td className="num">
                      {row.durationMs === null ? '' : formatElapsed(row.durationMs)}
                    </td>
                    <td className="num">{row.attempt ?? ''}</td>
                    <td>{iterationText(row.iteration)}</td>
                    <td>{row.branch ?? ''}</td>
                    <td className="num">{count(row.rowsRead)}</td>
                    <td className="num">{count(row.rowsWritten)}</td>
                    <td className="num">{bytesText(row)}</td>
                    <td>
                      {row.childRun !== null ? (
                        <Link to={runDetailPath(row.childRun.id)}>
                          {row.childRun.pipelineName ?? <code>{row.childRun.id}</code>}
                        </Link>
                      ) : row.childRunId !== null ? (
                        <code>{row.childRunId}</code>
                      ) : null}
                    </td>
                    <td className="activity-runs__error" title={row.error?.message}>
                      {cls === '' ? errorLine : `${errorLine} (${cls})`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
