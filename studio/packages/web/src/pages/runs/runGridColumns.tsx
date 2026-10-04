import type { ReactNode } from 'react';
import { ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';
import { Link } from 'react-router';
import type { RunSortKey, RunSummary } from '@autonomy-studio/shared';
import {
  canonicalHidden,
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
import { RUN_GRID_HIDDEN_PARAM } from './runFilters';
import { runStatusLabel } from './runStatus';
import { When } from '../../lib/When';
import type { DisplayTimeZone } from '../../lib/displayTime';

/** What a cell needs besides its run. */
export interface CellContext {
  /** The clock an unfinished run's duration "so far" is measured against: when
   *  the list was read, or the grid's own count while it is live (#1484). */
  loadedAt: number;

  /** The run's detail route, for the Run ID column's real link. */
  path: string;
  /** The viewer's display time zone (#1484), for timestamps inside a title. */
  zone: DisplayTimeZone;
  /** #1484 — where the row sits under "Include child runs"; absent while the
   *  grid is flat. */
  nest?: RunNest;
}

/** #1484 — one row's place in the nested grid (`nestRuns`). */
export interface RunNest {
  depth: number;
  /** The run's children that are loaded, and so drawn under it when expanded. */
  shown: number;
  /** Every run it called (`RunSummary.childRunCount`). */
  total: number;
  expanded: boolean;
  onToggle: () => void;
}

/** "1 child run" / "3 child runs". */
function childRuns(n: number): string {
  return `${n} child run${n === 1 ? '' : 's'}`;
}

/**
 * #1484 — the Pipeline cell's lead under "Include child runs": an indent per
 * level, the disclosure on a run whose children are loaded, and how many runs it
 * called. When fewer are loaded than it called (`RUN_DESCENDANTS_MAX` cut the
 * walk), the count says "2 of 7" rather than passing 2 off as all of them.
 *
 * The disclosure's name is stable ("2 child runs of Nightly") and `aria-expanded`
 * carries the state, so a screen reader never hears "Show …, expanded". A child
 * says what called it in words, because the indent alone is invisible to one and
 * the Parent column may be hidden.
 */
function NestLead({ run, nest }: { run: RunSummary; nest: RunNest }) {
  const cut = nest.shown < nest.total;
  return (
    <span className="runs-grid__nest" style={{ paddingInlineStart: `${nest.depth}rem` }}>
      {nest.shown > 0 ? (
        <button
          type="button"
          className="icon-button runs-grid__disclosure"
          aria-expanded={nest.expanded}
          aria-label={`${childRuns(nest.shown)} of ${run.pipelineName}`}
          onClick={nest.onToggle}
        >
          {nest.expanded ? (
            <ChevronDownRegular aria-hidden="true" />
          ) : (
            <ChevronRightRegular aria-hidden="true" />
          )}
        </button>
      ) : (
        <span className="runs-grid__disclosure" aria-hidden="true" />
      )}
      {nest.total > 0 && (
        <span
          className="runs-grid__child-count"
          title={cut ? `${nest.shown} of ${childRuns(nest.total)} loaded` : childRuns(nest.total)}
        >
          {cut ? `${nest.shown} of ${nest.total}` : nest.total}
          {/* The button already names the count; a leaf with calls cut off has
              no button, so the words are here instead. */}
          {nest.shown === 0 && <span className="visually-hidden"> child runs</span>}
        </span>
      )}
      {nest.depth > 0 && (
        <span className="visually-hidden">
          Called by {run.parentPipelineName ?? run.parentRunId}:{' '}
        </span>
      )}
    </span>
  );
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
    cell: (r, ctx) => (
      <td className="runs-grid__pipeline">
        {ctx.nest && <NestLead run={r} nest={ctx.nest} />}
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
    cell: (r, { loadedAt, zone }) => (
      <td className="num" title={formatWhen(r.finishedAt, zone)}>
        {formatRunDuration(r, loadedAt)}
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

/** `hide`'s spelling of "no column hidden". */
const RUN_GRID_HIDDEN_NONE = 'none';

/**
 * #1484 principle 5 — the hidden set a link carries in `hide`, or `undefined`
 * when it carries none (absent, empty, or no known column), so the viewer's
 * own stored choice applies. Read through the store's `canonicalHidden`, so a
 * link can never hide a required column or hold a set the picker could not.
 */
export function readRunGridHiddenParam(params: URLSearchParams): RunGridColumnId[] | undefined {
  const raw = params.get(RUN_GRID_HIDDEN_PARAM);
  if (raw === null || raw === '') return undefined;
  if (raw === RUN_GRID_HIDDEN_NONE) return [];
  const hidden = canonicalHidden(raw.split(','));
  return hidden.length === 0 ? undefined : hidden;
}

/** The `hide` value for a hidden set: `none` for the empty one. */
export function runGridHiddenParam(hidden: readonly RunGridColumnId[]): string {
  return hidden.length === 0 ? RUN_GRID_HIDDEN_NONE : canonicalHidden(hidden).join(',');
}
