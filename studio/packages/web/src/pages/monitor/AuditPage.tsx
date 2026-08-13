import { useCallback } from 'react';
import type { WorkspaceEventRow } from '@autonomy-studio/shared';
import { fetchWorkspaceAuditPage } from '../../api/workspaceAudit';
import { usePagedList } from '../../hooks/usePagedList';
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
 * READ-ONLY, and PAGED since #1076. It shipped on `usePolledResource`, which
 * owns one value a later fetch replaces; this page's value accumulates instead
 * — a page of newest entries, then older ones on demand — so it uses
 * `usePagedList`, whose docblock states the split between the three load
 * shapes. There is still no mutation on this page and there never should be; an
 * append-only log with a button that changed it would not be an audit log. No
 * polling either: the log only moves when the operator acts elsewhere in the
 * app, so a timer would issue requests for a page that cannot have changed
 * since they last looked at it.
 *
 * NEWEST FIRST, DECIDED BY THE SERVER (#1076). This page used to walk the log
 * to its end and reverse it client-side, because the route was ascending-only.
 * It now asks for `order=desc` and renders what arrives: the newest page costs
 * one request no matter how long the history is. The order is exact rather than
 * approximate in either design — `seq` is the per-owner append order, and it is
 * `seq` the server sorts on, not the wall-clock `createdAt`.
 */
export function AuditPage() {
  const fetchPage = useCallback(
    (cursor: string | undefined, signal: AbortSignal) => fetchWorkspaceAuditPage(cursor, signal),
    [],
  );
  const { items, error, loading, busy, hasMore, lastUpdatedAt, loadMore, refresh } =
    usePagedList(fetchPage);

  return (
    <section aria-labelledby="audit-heading">
      <div className="page-header">
        <h2 id="audit-heading">Audit</h2>
        {/* Named, like every other refresh control in the app ("Refresh
            quota", "Refresh diagnostics") — a bare "Refresh" makes the reader
            infer the target. Disabled while ANY request is in flight, which
            since #1076 includes a refresh and an older page: `usePagedList` is
            latest-wins rather than drop-the-new, so a second click would abort
            and re-issue a request that was already on its way. */}
        <button type="button" onClick={refresh} disabled={busy}>
          Refresh audit log
        </button>
      </div>

      <p className="page-hint">
        What has happened to this workspace: repositories connected, pipelines archived and
        restored, imports applied, versions published. Runs are not here — a run is what a pipeline
        did, and lives under Runs.
      </p>

      {/* The two failures are worded apart because they are different news: one
          means there is no history on screen, the other means the history on
          screen is real and merely stops short of where the reader asked. */}
      {error !== null && (
        <p role="alert" className="error">
          {error.scope === 'more'
            ? `Could not load older entries: ${error.message}`
            : `Could not load the audit log: ${error.message}`}
        </p>
      )}

      {loading && error === null && <p className="notice">Loading the audit log…</p>}

      {items !== null && items.length === 0 && (
        <p role="status" className="notice">
          Nothing has happened to this workspace yet. Connecting a repository, archiving a pipeline
          or applying an import records an entry here.
        </p>
      )}

      {items !== null && items.length > 0 && (
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
            {items.map((row) => (
              <AuditRow key={row.id} row={row} />
            ))}
          </tbody>
        </table>
      )}

      {/* Rendered only when the server said there IS an older page. An
          always-present button that sometimes did nothing would make the end of
          the log indistinguishable from a log that had stopped loading — and
          the end of the history is exactly the fact a reader is checking. */}
      {hasMore && (
        <button type="button" onClick={loadMore} disabled={busy}>
          Load older entries
        </button>
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
