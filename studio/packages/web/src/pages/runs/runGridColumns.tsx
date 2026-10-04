import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { RunSortKey, RunSummary } from '@autonomy-studio/shared';
import {
  RUN_GRID_COLUMNS,
  RUN_GRID_REQUIRED_COLUMNS,
  type RunGridColumnId,
} from '../../stores/uiStore';
import { CopyableId } from '../../lib/CopyableId';
import { shortId } from '../../lib/ids';
import { RunTriggeredByName } from '../../lib/KindName';
import { versionLabel } from '../../lib/versionLabel';
import { runVersionPath } from '../author/pipelinePath';
import { activitiesCell, rowsWrittenCell } from './activitiesColumn';
import { costCell } from './costColumn';
import { formatRunDuration, formatWhen } from './format';
import { runDetailPath, runLinkLabel } from './runPath';
import { runStatusLabel } from './runStatus';
import { When } from '../../lib/When';
import { LiveElapsed } from './NodeDuration';
import type { DisplayTimeZone } from '../../lib/displayTime';

/** What a cell needs besides its run. */
export interface CellContext {
  /** When the list was read, for an unfinished run's duration "so far". */
  loadedAt: number;
  /**
   * #1484 — the list is live and polling, so an unfinished run's duration may
   * COUNT. Only then: a count is honest only while the page would hear the run
   * finish, so a paused or static list stays frozen at `loadedAt`.
   */
  ticking: boolean;
  /** The run's detail route, for the Run ID column's real link. */
  path: string;
  /** The viewer's display time zone (#1484), for timestamps inside a title. */
  zone: DisplayTimeZone;
}

/**
 * #1484 OR35 M1 — one column of the runs grid. Keyed by the store's
 * `RunGridColumnId` (`RUN_GRID_COLUMNS` owns the order), so a column added
 * there without a definition here fails the typecheck. `sort` names the
 * server's sort key where the column has one; `numeric` right-aligns it;
 * `zoned` names the display zone in the header, for a time without one.
 */
interface RunGridColumn {
  label: string;
  sort?: RunSortKey;
  numeric?: boolean;
  zoned?: boolean;
  cell: (run: RunSummary, ctx: CellContext) => ReactNode;
}

/**
 * One Cost cell. Its own function rather than an inline expression so the decision
 * (`costCell`) stays a pure function this file merely renders — and so the
 * unsettled qualifier has somewhere to be marked up rather than concatenated into
 * a string, which is what lets it read as secondary while staying VISIBLE text
 * rather than a hover.
 */
function costTd(run: RunSummary): ReactNode {
  const cell = costCell(run);
  return (
    <td className="run-cost" {...(cell.note === null ? {} : { title: cell.note })}>
      {cell.figure}
      {cell.unsettled ? <span className="run-cost-unsettled"> so far</span> : null}
    </td>
  );
}

/**
 * #1484 — one Activities cell. The glyph form is drawn but hidden from assistive
 * tech, which reads the same counts in words instead ("1 failed", not "1 ✗").
 */
function activitiesTd(run: RunSummary): ReactNode {
  const cell = activitiesCell(run);
  return (
    <td className="runs-grid__activities" title={cell.title}>
      <span aria-hidden="true">{cell.figure}</span>
      <span className="visually-hidden">{cell.words}</span>
    </td>
  );
}

export const RUN_GRID_COLUMN_DEFS: Record<RunGridColumnId, RunGridColumn> = {
  pipeline: {
    label: 'Pipeline',
    sort: 'pipeline',
    cell: (r) => (
      <td className="runs-grid__pipeline">
        {/* R2 — the pipeline's NAME, which is the only thing here an operator
            recognises. The version id stays reachable as the cell's title.
            #1484 — it links to the version that RAN, not the latest, and the
            version chip is inside the link so its name says which one. */}
        <span title={r.pipelineVersionId}>
          <Link to={runVersionPath(r.pipelineId, r.pipelineVersion, r.debug)}>
            {r.pipelineName}{' '}
            <span className="run-version">{versionLabel(r.pipelineVersion, r.debug)}</span>
          </Link>
        </span>
      </td>
    ),
  },
  status: {
    label: 'Status',
    sort: 'status',
    cell: (r) => (
      <td>
        {/* #870 — the WORD comes from the Monitor's one run-status vocabulary;
            the CLASS from the status itself, so hue and label cannot drift. */}
        <span className={`run-status run-status-${r.status}`}>{runStatusLabel(r.status)}</span>
      </td>
    ),
  },
  triggeredBy: {
    label: 'Triggered by',
    sort: 'triggeredBy',
    /* #1484 — the server's `triggeredByKind`, plus the trigger's name when it
       still exists. A rerun names its source run in the title (RS6). */
    cell: (r) => (
      <td title={r.rerunOf !== null ? `Rerun of run ${r.rerunOf}` : undefined}>
        <RunTriggeredByName kind={r.triggeredByKind} />
        {r.triggerName !== null && <span className="runs-grid__trigger"> · {r.triggerName}</span>}
      </td>
    ),
  },
  started: {
    label: 'Started',
    sort: 'started',
    /* #1484 — compact (`10-04 13:05:07`) to fit the 124px column; the full
       form, the zone and the relative time are the hover title. */
    zoned: true,
    cell: (r, { zone, loadedAt }) => (
      <td>
        <When ms={r.startedAt} compact zone={zone} asOf={loadedAt} />
      </td>
    ),
  },
  duration: {
    label: 'Duration',
    sort: 'duration',
    numeric: true,
    /* The finish TIMESTAMP is the cell's title (U10 fixed the column set). */
    cell: (r, { loadedAt, ticking, zone }) => (
      <td className="num" title={formatWhen(r.finishedAt, zone)}>
        {ticking && r.finishedAt === null && r.status !== 'queued' ? (
          <LiveElapsed startedAtMs={r.startedAt} />
        ) : (
          formatRunDuration(r, loadedAt)
        )}
      </td>
    ),
  },
  activities: {
    label: 'Activities',
    cell: activitiesTd,
  },
  rowsWritten: {
    label: 'Rows written',
    numeric: true,
    /* #1484 — this run's OWN rows; a child's are on the child's row. */
    cell: (r) => (
      <td className="num" title="Rows this run's successful activities wrote">
        {rowsWrittenCell(r)}
      </td>
    ),
  },
  cost: {
    label: 'Cost',
    numeric: true,
    /* U27 slice 2 — the run detail page's own cost authority. */
    cell: costTd,
  },
  runId: {
    label: 'Run ID',
    cell: (r, { path }) => (
      <td>
        <CopyableId id={r.id} noun="run" link={{ to: path, label: runLinkLabel('Open', r.id) }} />
      </td>
    ),
  },
  parent: {
    label: 'Parent',
    /* #1484 — the run that called this one, by its pipeline's NAME. The short
       id stands in when the name cannot be read for this viewer. */
    cell: (r) => (
      <td title={r.parentRunId ?? undefined}>
        {r.parentRunId === null ? (
          '—'
        ) : (
          <Link
            to={runDetailPath(r.parentRunId)}
            /* The name AND the run, so a list of children of one pipeline does
               not read as many identical links. */
            aria-label={
              r.parentPipelineName === null
                ? runLinkLabel('Parent', r.parentRunId)
                : `${r.parentPipelineName}, ${runLinkLabel('parent', r.parentRunId)}`
            }
          >
            {r.parentPipelineName ?? shortId(r.parentRunId)}
          </Link>
        )}
      </td>
    ),
  },
  annotations: {
    label: 'Annotations',
    /* #1016 — the tags of the version this run bound, as the annotation filter
       matches them. */
    cell: (r) => (
      <td title={r.annotations.length > 0 ? r.annotations.join(', ') : undefined}>
        {r.annotations.length > 0 ? r.annotations.join(', ') : '—'}
      </td>
    ),
  },
};

/** The column the grid is sorted by: drawn, whatever the operator hid. */
function isSortColumn(column: RunGridColumnId, sortKey: RunSortKey): boolean {
  return RUN_GRID_COLUMN_DEFS[column].sort === sortKey;
}

/**
 * Whether the picker may turn `column` off: never a required column, nor the
 * one the grid is sorted by (`visibleRunGridColumns` draws that one anyway, so
 * a box that could be unticked would claim a choice the grid ignores).
 */
export function isPinnedRunGridColumn(column: RunGridColumnId, sortKey: RunSortKey): boolean {
  return RUN_GRID_REQUIRED_COLUMNS.includes(column) || isSortColumn(column, sortKey);
}

/**
 * The columns the grid draws, in column order: every column the operator has
 * not turned off, AND the column the grid is sorted by, always. A sort whose
 * column is hidden would order the rows by something nobody can see — and a
 * shared link can carry any `?sort=`, so this is decided here, at the draw,
 * rather than by stopping the picker alone. The operator's hidden set is left
 * as they chose it: sorting by another column hides this one again.
 */
export function visibleRunGridColumns(
  hidden: readonly RunGridColumnId[],
  sortKey: RunSortKey,
): RunGridColumnId[] {
  return RUN_GRID_COLUMNS.filter(
    (column) => !hidden.includes(column) || isSortColumn(column, sortKey),
  );
}
