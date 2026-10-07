import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import { Link } from 'react-router';
import {
  PIPELINE_SUMMARY_WINDOW_DAYS,
  runStartIsReal,
  TRIGGER_MODE_LABELS,
  type Pipeline,
  type PipelineSummary,
} from '@autonomy-studio/shared';
import { When } from '../../lib/When';
import { GridColumnHeader, GridColumnsMenu } from '../../lib/GridColumns';
import { useGridColumnWidths } from '../../lib/useGridColumnWidths';
import { useRowOpen } from '../../lib/useRowOpen';
import { visibleGridColumns } from '../../stores/gridColumns';
import { PIPELINE_GRID_SPEC, type PipelineGridColumnId, type UiStore } from '../../stores/uiStore';
import { formatElapsed } from '../runs/format';
import { runDetailPath } from '../runs/runPath';
import { runStatusLabel } from '../runs/runStatus';
import { triggersPath } from '../triggers/triggersPath';
import { pipelinePath } from './pipelinePath';
import { percentOf } from './successPercent';
import type { PipelineSort, PipelineSortKey } from './pipelinesGridSort';

const DAYS = String(PIPELINE_SUMMARY_WINDOW_DAYS);

interface Column {
  label: string;
  sort?: PipelineSortKey;
  numeric?: boolean;
  /** The header's hover text, where the label alone is terse. */
  title?: string;
}

/**
 * #1569 OR37 — each column's header, keyed by the store's ids
 * (`PIPELINE_GRID_COLUMNS` owns the order and the widths), so a column added
 * there without a definition here fails the typecheck.
 */
const PIPELINE_GRID_COLUMN_DEFS: Record<PipelineGridColumnId, Column> = {
  name: { label: 'Name', sort: 'name' },
  description: { label: 'Description' },
  lastRun: { label: 'Last run', sort: 'lastRun' },
  successRate: {
    label: `Success % (${DAYS}d)`,
    sort: 'successRate',
    numeric: true,
    title: `Succeeded ÷ (succeeded + failed) over the runs started in the last ${DAYS} days. Cancelled and skipped runs are not counted; Debug runs are not included.`,
  },
  runs: {
    label: `Runs (${DAYS}d)`,
    sort: 'runs',
    numeric: true,
    title: `Runs started in the last ${DAYS} days, finished or not. Debug runs are not included.`,
  },
  duration: {
    label: 'p50 / p95',
    sort: 'duration',
    numeric: true,
    title: `Median and 95th-percentile duration of the runs that succeeded or failed in the last ${DAYS} days. Sorts by the median.`,
  },
  nextRun: { label: 'Next run', sort: 'nextRun' },
  triggers: { label: 'Triggers', sort: 'triggers' },
  live: { label: 'Live state' },
  activities: {
    label: 'Activities',
    sort: 'activities',
    numeric: true,
    title: 'Activities in the latest saved version.',
  },
  modified: { label: 'Modified', sort: 'modified' },
  annotations: { label: 'Annotations' },
  concurrency: {
    label: 'Concurrency',
    numeric: true,
    title: "The pipeline's cap on runs at once, across all its triggers.",
  },
};

/** The ⋯ column's floor: outside the spec, not resizable, and never squeezed out. */
const ACTIONS_WIDTH = 48;

/** `75%`, from a rate; an em-dash when nothing finished in the window. */
function successCell(s: PipelineSummary | undefined): ReactNode {
  const w = s?.window;
  if (w === undefined || w.successRate === null) return '—';
  return (
    <span
      title={`${String(w.succeeded)} succeeded, ${String(w.failed)} failed — ${String(w.runs)} runs in the last ${DAYS} days`}
    >
      {`${String(percentOf(w.succeeded, w.failed, w.successRate))}%`}
    </span>
  );
}

function lastRunCell(s: PipelineSummary | undefined, asOf: number | undefined): ReactNode {
  const run = s?.lastRun;
  if (run === undefined || run === null) return '—';
  return (
    <Link to={runDetailPath(run.runId)} className="pipelines-grid__run">
      {/* #870 — the Monitor's one run-status vocabulary and hue. */}
      <span className={`run-status run-status-${run.status}`}>
        {runStatusLabel(run.status)}
      </span>{' '}
      {/* A queued run's start is an enqueue placeholder, not a start. */}
      {runStartIsReal(run) && <When ms={run.startedAt} compact asOf={asOf} />}
    </Link>
  );
}

function triggersCell(s: PipelineSummary | undefined): ReactNode {
  if (s === undefined || s.triggers.total === 0) return '—';
  const names = s.triggers.items
    .map((t) => `${t.name} · ${TRIGGER_MODE_LABELS[t.mode]}${t.enabled ? '' : ' (off)'}`)
    .join('\n');
  // The pipeline's triggers, listed: Manage → Triggers under `?pipeline=`, the
  // editor's Trigger ▾ → View triggers.
  return (
    <Link
      to={triggersPath(s.pipelineId)}
      title={names}
    >{`${String(s.triggers.enabled)} active / ${String(s.triggers.total)}`}</Link>
  );
}

/** `1.2s / 4.5s`; an em-dash when nothing finished in the window. */
function durationCell(s: PipelineSummary | undefined): ReactNode {
  const w = s?.window;
  if (w === undefined || w.p50Ms === null || w.p95Ms === null) return '—';
  return `${formatElapsed(w.p50Ms)} / ${formatElapsed(w.p95Ms)}`;
}

/** One line with the full text on hover; newlines fold under `nowrap`. */
function textCell(text: string | undefined): { content: ReactNode; title?: string } {
  return text === undefined || text === '' ? { content: '—' } : { content: text, title: text };
}

/**
 * #1569 OR37 — the pipelines list as an engineer's grid: dense 32px rows of
 * 13px data (the runs grid's density classes), sortable headers whose order
 * lives in the URL. The row facts come from one batched read
 * (`GET /api/pipelines/summaries`); a cell whose fact is not loaded yet reads
 * as an em-dash, the same as a fact that is absent.
 *
 * Slice 4: the columns are the viewer's (`PipelineGridColumnsMenu`), at the
 * widths they drag or step each header's edge to, both kept per viewer in `ui`;
 * the column the grid is sorted by is always drawn. The Archived view passes
 * fixed `columns` instead.
 */
export function PipelinesGrid({
  pipelines,
  summaries,
  sort,
  onSort,
  liveState,
  actions,
  loadedAt,
  columns,
  ui,
}: {
  /** Already in display order. */
  pipelines: readonly Pipeline[];
  summaries: ReadonlyMap<string, PipelineSummary> | undefined;
  sort: PipelineSort;
  onSort: (key: PipelineSortKey) => void;
  liveState: (p: Pipeline) => ReactNode;
  actions: (p: Pipeline) => ReactNode;
  /** When the summaries were read: the compact timestamps' "same year?". */
  loadedAt: number | undefined;
  /** Fixed columns, by id, in place of the viewer's choice: the archived view
   * draws only the ones it has facts for. */
  columns?: readonly PipelineGridColumnId[];
  /** The viewer's column choice and widths live here. */
  ui: UiStore;
}) {
  const hidden = useStore(ui, (st) => st.pipelinesGridHidden);
  const widths = useStore(ui, (st) => st.pipelinesGridWidths);
  const setWidth = useStore(ui, (st) => st.setPipelinesGridWidth);
  const shown =
    columns === undefined
      ? visibleGridColumns(PIPELINE_GRID_SPEC, hidden, (c) => isSortedColumn(c, sort.key))
      : PIPELINE_GRID_SPEC.columns.filter((c) => columns.includes(c));
  const { widthOf, total, tableRef, colRef, preview } = useGridColumnWidths(
    PIPELINE_GRID_SPEC,
    widths,
    shown,
    ACTIONS_WIDTH,
  );
  const cellOf = (
    id: PipelineGridColumnId,
    p: Pipeline,
    s: PipelineSummary | undefined,
  ): ReactNode => {
    switch (id) {
      case 'name':
        return (
          <td
            key={id}
            className="pipelines-grid__name"
            title={p.folder === null ? p.name : `${p.folder} / ${p.name}`}
          >
            {p.folder !== null && <span className="pipelines-grid__folder">{p.folder} / </span>}
            {/* A link, so it can be middle-clicked, copied and bookmarked
                (U2's navigation idiom). Its name keeps the "Open …" verb the
                row has always had. */}
            <Link to={pipelinePath(p.id)} aria-label={`Open ${p.name}`}>
              {p.name}
            </Link>
          </td>
        );
      case 'lastRun':
        return <td key={id}>{lastRunCell(s, loadedAt)}</td>;
      case 'successRate':
        return (
          <td key={id} className="num">
            {successCell(s)}
          </td>
        );
      case 'nextRun':
        return (
          <td key={id}>
            {s?.nextFireAt == null ? '—' : <When ms={s.nextFireAt} compact asOf={loadedAt} />}
          </td>
        );
      case 'triggers':
        return <td key={id}>{triggersCell(s)}</td>;
      case 'live':
        return <td key={id}>{liveState(p)}</td>;
      case 'modified':
        // Until the summaries answer, the row's own last change.
        return (
          <td key={id}>
            <When ms={s?.modifiedAt ?? p.updatedAt} compact asOf={loadedAt} />
          </td>
        );
      case 'description': {
        const { content, title } = textCell(s?.description);
        return (
          <td key={id} {...(title === undefined ? {} : { title })}>
            {content}
          </td>
        );
      }
      case 'runs':
        return (
          <td key={id} className="num">
            {s === undefined ? '—' : String(s.window.runs)}
          </td>
        );
      case 'duration':
        return (
          <td key={id} className="num">
            {durationCell(s)}
          </td>
        );
      case 'activities':
        return (
          <td key={id} className="num">
            {s?.activities == null ? '—' : String(s.activities)}
          </td>
        );
      case 'annotations': {
        const { content, title } = textCell(s?.annotations.join(', '));
        return (
          <td key={id} {...(title === undefined ? {} : { title })}>
            {content}
          </td>
        );
      }
      case 'concurrency':
        // The row's own fact; `null` is uncapped, not unknown.
        return p.concurrency === null ? (
          <td key={id} className="num" title="No cap">
            —
          </td>
        ) : (
          <td key={id} className="num">
            {String(p.concurrency)}
          </td>
        );
    }
  };
  return (
    <div className="runs-grid-scroll">
      <table
        ref={tableRef}
        className="runs-grid pipelines-grid"
        style={{ minWidth: `${String(total)}px` }}
      >
        <colgroup>
          {shown.map((c) => (
            <col key={c} ref={colRef(c)} style={{ width: `${String(widthOf(c))}px` }} />
          ))}
          {/* Takes what the columns leave, so the ⋯ sits at the right edge;
              never under `ACTIONS_WIDTH`, which the table's min-width holds. */}
          <col />
        </colgroup>
        <thead>
          <tr>
            {shown.map((c) => {
              const def = PIPELINE_GRID_COLUMN_DEFS[c];
              const sortKey = def.sort;
              return (
                <GridColumnHeader
                  key={c}
                  id={`pipelines-grid-col-${c}`}
                  label={def.label}
                  {...(def.title === undefined ? {} : { title: def.title })}
                  numeric={def.numeric === true}
                  {...(sortKey === undefined
                    ? {}
                    : {
                        sortDir: sort.key === sortKey ? sort.dir : null,
                        onSort: () => onSort(sortKey),
                      })}
                  width={widthOf(c)}
                  min={PIPELINE_GRID_SPEC.widths[c].min}
                  max={PIPELINE_GRID_SPEC.maxWidth}
                  step={PIPELINE_GRID_SPEC.step}
                  onPreviewWidth={(width) => preview(c, width)}
                  onCommitWidth={(width) => setWidth(c, width)}
                />
              );
            })}
            <th scope="col" aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {pipelines.map((p) => {
            const s = summaries?.get(p.id);
            return (
              <PipelineGridRow key={p.id} pipelineId={p.id}>
                {shown.map((c) => cellOf(c, p, s))}
                <td className="pipelines-grid__actions">{actions(p)}</td>
              </PipelineGridRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * #1569 OR37 slice 7 — a click anywhere on the row that is not one of its own
 * controls opens the editor (`useRowOpen`, the runs grid's rule). The Name link
 * stays the keyboard path.
 */
function PipelineGridRow({ pipelineId, children }: { pipelineId: string; children: ReactNode }) {
  const { onClick, onAuxClick } = useRowOpen(pipelinePath(pipelineId));
  return (
    <tr className="runs-grid__row" onClick={onClick} onAuxClick={onAuxClick}>
      {children}
    </tr>
  );
}

/** The column the grid is sorted by: drawn, whatever the viewer hid. */
function isSortedColumn(column: PipelineGridColumnId, sortKey: PipelineSortKey): boolean {
  return PIPELINE_GRID_COLUMN_DEFS[column].sort === sortKey;
}

/**
 * #1569 OR37 — the pipelines grid's column picker (`GridColumnsMenu`). The
 * choice and Reset are the viewer's own, in `ui`; not in the URL, which holds
 * the sort and the filters.
 */
export function PipelineGridColumnsMenu({
  sortKey,
  ui,
}: {
  sortKey: PipelineSortKey;
  ui: UiStore;
}) {
  const hidden = useStore(ui, (st) => st.pipelinesGridHidden);
  const setHidden = useStore(ui, (st) => st.setPipelinesGridHidden);
  const reset = useStore(ui, (st) => st.resetPipelinesGridColumns);
  return (
    <GridColumnsMenu
      spec={PIPELINE_GRID_SPEC}
      hidden={hidden}
      pinned={(column) => isSortedColumn(column, sortKey)}
      labelOf={(column) => PIPELINE_GRID_COLUMN_DEFS[column].label}
      onHiddenChange={setHidden}
      onReset={reset}
    />
  );
}
