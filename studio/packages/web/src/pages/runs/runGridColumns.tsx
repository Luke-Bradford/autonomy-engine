import type { ReactNode } from 'react';
import { ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';
import { Link, useNavigate } from 'react-router';
import { RUN_TRIGGERED_BY_LABELS, type RunSortKey, type RunSummary } from '@autonomy-studio/shared';
import {
  RUN_GRID_REQUIRED_COLUMNS,
  RUN_GRID_SPEC,
  type RunGridColumnId,
} from '../../stores/uiStore';
import { visibleGridColumns } from '../../stores/gridColumns';
import { CopyableId } from '../../lib/CopyableId';
import { RowMoreMenu } from '../../lib/RowMoreMenu';
import { shortId } from '../../lib/ids';
import { RunTriggeredByName } from '../../lib/KindName';
import { versionLabel } from '../../lib/versionLabel';
import { runVersionPath } from '../author/pipelinePath';
import { RunEditorLink } from './RunEditorLink';
import { activitiesCell, rowsWrittenCell } from './activitiesColumn';
import { costCell } from './costColumn';
import { formatRunDuration, formatWhen } from './format';
import { runDetailPath, runLinkLabel } from './runPath';
import { runStatusLabel } from './runStatus';
import { When } from '../../lib/When';
import { withParams } from '../../lib/withParams';
import { RUN_FILTER_PARAMS, triggerRunsPath } from './runFilters';
import type { DisplayTimeZone } from '../../lib/displayTime';
import { RunStatusPill } from './RunStatusPill';

/** What a cell needs besides its run. */
export interface CellContext {
  /** The clock an unfinished run's duration "so far" is measured against: when
   *  the list was read, or the grid's own count while it is live (#1484). */
  loadedAt: number;

  /** The run's detail route, for the Run ID column's real link. */
  path: string;
  /** The runs list's own query, so a cell can link to one more filter while
   *  keeping the rest (#1521). */
  search: string;
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
  // #1594 OR40 S3d — the column is narrow and three readings are words, so the
  // cell can cut its figure: the tooltip leads with it whole, then the note.
  const figure = `${cell.figure}${cell.unsettled ? ' so far' : ''}`;
  return (
    <td className="num run-cost" title={cell.note === null ? figure : `${figure}\n${cell.note}`}>
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

/** #1594 OR40 S3d — the Parent cell's tooltip: the name it can cut, then the run. */
function parentTitle(r: RunSummary): string | undefined {
  if (r.parentRunId === null) return undefined;
  return r.parentPipelineName === null
    ? r.parentRunId
    : `${r.parentPipelineName} · ${r.parentRunId}`;
}

/**
 * #1594 OR40 S3d — the Triggered by cell's tooltip: its whole text (the cell
 * can cut a long trigger name), then a rerun's source run (RS6).
 */
function triggeredByTitle(r: RunSummary): string {
  const label = RUN_TRIGGERED_BY_LABELS[r.triggeredByKind];
  const text = r.triggerName !== null ? `${label} · ${r.triggerName}` : label;
  return r.rerunOf !== null ? `${text}\nRerun of run ${r.rerunOf}` : text;
}

/**
 * The Pipeline cell. R2 — the pipeline's NAME, the only thing here an operator
 * recognises; the version id stays reachable as its title.
 *
 * #1566 — the name opens the RUN, as the rest of the row does: in the Monitor
 * the run is the primary destination (ADF's behaviour), and the name is the
 * most natural thing to click. The editor, at the version that ran, is the
 * labelled icon beside it and the row's ⋯ menu, never the name.
 */
function PipelineCell({ run: r, ctx }: { run: RunSummary; ctx: CellContext }) {
  const navigate = useNavigate();
  const editor = runVersionPath(r.pipelineId, r.pipelineVersion, r.debug);
  const triggerId = r.triggerId;
  return (
    <span className="runs-grid__pipeline-line">
      {ctx.nest && <NestLead run={r} nest={ctx.nest} />}
      {/* #1594 OR40 S3d — the cell can cut the name, so the tooltip leads
          with the whole name and version, then the version id it demotes. */}
      <Link
        className="runs-grid__pipeline-name"
        to={ctx.path}
        title={`${r.pipelineName} ${versionLabel(r.pipelineVersion, r.debug)} · ${r.pipelineVersionId}`}
      >
        {r.pipelineName}{' '}
        <span className="run-version">{versionLabel(r.pipelineVersion, r.debug)}</span>
      </Link>
      <RunEditorLink
        pipelineId={r.pipelineId}
        version={r.pipelineVersion}
        debug={r.debug}
        pipelineName={r.pipelineName}
      />
      <RowMoreMenu
        name={r.pipelineName}
        label={`Actions for run ${r.id}`}
        actions={[
          { label: 'Open pipeline in editor', onSelect: () => void navigate(editor) },
          ...(triggerId !== null && r.triggerName !== null
            ? [
                {
                  label: "Show this trigger's runs",
                  onSelect: () => void navigate(triggerRunsPath(triggerId)),
                },
              ]
            : []),
        ]}
      />
    </span>
  );
}

export const RUN_GRID_COLUMN_DEFS: Record<RunGridColumnId, RunGridColumn> = {
  pipeline: {
    label: 'Pipeline',
    sort: 'pipeline',
    cell: (r, ctx) => (
      <td className="runs-grid__pipeline">
        <PipelineCell run={r} ctx={ctx} />
      </td>
    ),
  },
  status: {
    label: 'Status',
    sort: 'status',
    /* #1626 — a narrow column cuts the pill's word (`waiting (callback)` is
       wider than the default), so the cell says it whole as its tooltip. */
    cell: (r) => (
      <td title={runStatusLabel(r.status)}>
        {/* #870 — the WORD comes from the Monitor's one run-status vocabulary;
            the CLASS from the status itself, so hue and label cannot drift. */}
        <RunStatusPill status={r.status} />
      </td>
    ),
  },
  triggeredBy: {
    label: 'Triggered by',
    sort: 'triggeredBy',
    /* #1484 — the server's `triggeredByKind`, plus the trigger's name when it
       still exists. A rerun names its source run in the title (RS6). */
    cell: (r) => (
      <td title={triggeredByTitle(r)}>
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
    /* The finish TIMESTAMP is in the cell's title (U10 fixed the column set),
       after the duration the narrow column can cut (#1594 OR40 S3d). */
    cell: (r, { loadedAt, zone }) => {
      const text = formatRunDuration(r, loadedAt);
      return (
        <td
          className="num"
          title={
            r.finishedAt === null ? text : `${text} · finished ${formatWhen(r.finishedAt, zone)}`
          }
        >
          {text}
        </td>
      );
    },
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
      <td title={parentTitle(r)}>
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
       matches them. #1521 — each one links to that filter, keeping the others. */
    cell: (r, { search }) => (
      <td title={r.annotations.length > 0 ? r.annotations.join(', ') : undefined}>
        {r.annotations.length > 0
          ? r.annotations.map((tag, i) => (
              <span key={tag}>
                {i > 0 ? ', ' : null}
                <Link
                  to={{
                    search: withParams(new URLSearchParams(search), {
                      [RUN_FILTER_PARAMS.annotation]: tag,
                    }).toString(),
                  }}
                >
                  {tag}
                </Link>
              </span>
            ))
          : '—'}
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
  return visibleGridColumns(RUN_GRID_SPEC, hidden, (column) => isSortColumn(column, sortKey));
}
