import { useCallback, useMemo } from 'react';
import type { WorkspaceEventRow } from '@autonomy-studio/shared';
import { listWorkspaceAudit } from '../../api/workspaceAudit';
import { usePolledResource } from '../../hooks/usePolledResource';
import { formatWhen } from '../runs/format';
import { describeWorkspaceEvent } from './describeWorkspaceEvent';

/**
 * #1075 — Monitor › Audit: the workspace's own history.
 *
 * The log (#3 G6a) records the workspace mutations that row state alone cannot
 * answer historically — who connected the repo, when a pipeline was archived
 * and what triggers that disabled, what an import brought in and from which
 * commit, which version was published as active. Every one of those writers
 * shipped with G6a/G6c/#907 and the read route with them; nothing in the app
 * ever called it, so the history existed and was unreadable.
 *
 * WHY MONITOR, not Manage. The events are all mutations of MANAGE resources, so
 * that hub was the tempting home — but the overview spec files this surface
 * under "T13 monitor surfaces" (`docs/2026-07-14-foundation-overview.md`:
 * *"event-source workspace mutations + publish history for non-version
 * audit"*), and the hub split it describes is by ACT: Manage is where you
 * change the workspace, Monitor is where you read what has happened to it. An
 * audit log is only ever read. It sits beside Runs (what each execution did)
 * and AI activity (what the models did) as the third answer to "what happened".
 *
 * READ-ONLY, so `usePolledResource` rather than `useGuardedLoad`: the two hooks
 * have opposite drop rules and `usePolledResource`'s docblock states the split
 * — it drops the NEW load while one is in flight, which is right for a page
 * with no mutations to race and wrong for a post-mutation refresh. There is no
 * mutation on this page and there never should be; an append-only log with a
 * button that changed it would not be an audit log. No `intervalMs` either:
 * this is the hook's load-on-mount-plus-manual-refresh form. The log only moves
 * when the operator acts elsewhere in the app, so a timer would issue requests
 * for a page that cannot have changed since they last looked at it.
 */
export function AuditPage() {
  const fetcher = useCallback((signal: AbortSignal) => listWorkspaceAudit(signal), []);
  const { data, error, loading, lastUpdatedAt, refresh } = usePolledResource(fetcher);

  /**
   * NEWEST FIRST. The server orders ascending and offers no descending mode, so
   * the api wrapper returns the log in append order and the reversal happens
   * here. It is exact rather than approximate: `seq` is monotonic per owner, so
   * reversing the ascending walk IS the descending order — no re-sort on
   * `createdAt`, whose wall clock is not the log's ordering authority.
   */
  const newestFirst = useMemo(() => (data === null ? null : [...data].reverse()), [data]);

  return (
    <section aria-labelledby="audit-heading">
      <div className="page-header">
        <h2 id="audit-heading">Audit</h2>
        {/* Named, like every other refresh control in the app ("Refresh
            quota", "Refresh diagnostics") — a bare "Refresh" makes the reader
            infer the target. `disabled` only ever bites during the FIRST load
            (`usePolledResource` never re-arms `loading`), which is exactly when
            there is nothing yet to refresh and a click would abort the load it
            was waiting for. */}
        <button type="button" onClick={refresh} disabled={loading}>
          Refresh audit log
        </button>
      </div>

      <p className="page-hint">
        What has happened to this workspace: repositories connected, pipelines archived and
        restored, imports applied, versions published. Runs are not here — a run is what a pipeline
        did, and lives under Runs.
      </p>

      {error !== null && (
        <p role="alert" className="error">
          Could not load the audit log: {error}
        </p>
      )}

      {loading && newestFirst === null && error === null && (
        <p className="notice">Loading the audit log…</p>
      )}

      {newestFirst !== null && newestFirst.length === 0 && (
        <p role="status" className="notice">
          Nothing has happened to this workspace yet. Connecting a repository, archiving a pipeline
          or applying an import records an entry here.
        </p>
      )}

      {newestFirst !== null && newestFirst.length > 0 && (
        <table>
          <caption className="visually-hidden">
            Workspace audit log, most recent entry first
          </caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">What happened</th>
            </tr>
          </thead>
          <tbody>
            {newestFirst.map((row) => (
              <AuditRow key={row.id} row={row} />
            ))}
          </tbody>
        </table>
      )}

      {lastUpdatedAt !== null && (
        <p className="page-hint">Audit log as of {formatWhen(lastUpdatedAt)}.</p>
      )}
    </section>
  );
}

function AuditRow({ row }: { row: WorkspaceEventRow }) {
  const { summary, detail } = describeWorkspaceEvent(row.payload);
  return (
    <tr>
      <td>{formatWhen(row.createdAt)}</td>
      {/* The actor is a single local principal today, so this column reads the
          same on every row. It stays because the field is half the log's reason
          to exist ("who?") and a column added later would leave the history
          before it unattributed — the page hint does not claim more than the
          one principal the server currently stamps. */}
      <td>{row.payload.by}</td>
      <td>
        {summary}
        {detail !== null && detail !== '' && <span className="audit-detail">{detail}</span>}
      </td>
    </tr>
  );
}
