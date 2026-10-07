import type { ReactNode } from 'react';
import { Link } from 'react-router';
import {
  PIPELINE_SUMMARY_WINDOW_DAYS,
  runStartIsReal,
  TRIGGER_MODE_LABELS,
  type Pipeline,
  type PipelineSummary,
} from '@autonomy-studio/shared';
import { ariaSortOf } from '../../lib/urlSort';
import { When } from '../../lib/When';
import { SortButton } from '../runs/SortButton';
import { runDetailPath } from '../runs/runPath';
import { runStatusLabel } from '../runs/runStatus';
import { pipelinePath } from './pipelinePath';
import { percentOf } from './successPercent';
import type { PipelineSort, PipelineSortKey } from './pipelinesGridSort';

const DAYS = String(PIPELINE_SUMMARY_WINDOW_DAYS);

export type ColumnId = 'name' | 'lastRun' | 'successRate' | 'nextRun' | 'triggers' | 'live' | 'modified';

interface Column {
  id: ColumnId;
  label: string;
  /** The `<col>` width; the last column before the menu takes what is left. */
  width: number;
  sort?: PipelineSortKey;
  numeric?: boolean;
  /** The header's hover text, where the label alone is terse. */
  title?: string;
}

/**
 * #1569 OR37 — the issue's default columns. There is no Version column on
 * purpose: versions live in the editor's badge and its history.
 */
const COLUMNS: readonly Column[] = [
  { id: 'name', label: 'Name', width: 280, sort: 'name' },
  { id: 'lastRun', label: 'Last run', width: 200, sort: 'lastRun' },
  {
    id: 'successRate',
    label: `Success % (${DAYS}d)`,
    width: 128,
    sort: 'successRate',
    numeric: true,
    title: `Succeeded ÷ (succeeded + failed) over the runs started in the last ${DAYS} days. Cancelled and skipped runs are not counted; Debug runs are not included.`,
  },
  { id: 'nextRun', label: 'Next run', width: 150, sort: 'nextRun' },
  { id: 'triggers', label: 'Triggers', width: 116, sort: 'triggers' },
  { id: 'live', label: 'Live state', width: 180 },
  { id: 'modified', label: 'Modified', width: 150, sort: 'modified' },
];

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
  return (
    <span
      title={names}
    >{`${String(s.triggers.enabled)} active / ${String(s.triggers.total)}`}</span>
  );
}

/**
 * #1569 OR37 — the pipelines list as an engineer's grid: dense 32px rows of
 * 13px data (the runs grid's density classes), sortable headers whose order
 * lives in the URL. The row facts come from one batched read
 * (`GET /api/pipelines/summaries`); a cell whose fact is not loaded yet reads
 * as an em-dash, the same as a fact that is absent.
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
  /** The columns to draw, by id; every column when absent. The archived view
   * draws only the ones it has facts for. */
  columns?: readonly ColumnId[];
}) {
  const shown = columns === undefined ? COLUMNS : COLUMNS.filter((c) => columns.includes(c.id));
  const cellOf = (id: ColumnId, p: Pipeline, s: PipelineSummary | undefined): ReactNode => {
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
    }
  };
  return (
    <div className="runs-grid-scroll">
      <table className="runs-grid pipelines-grid">
        <colgroup>
          {shown.map((c) => (
            <col key={c.id} style={{ width: `${String(c.width)}px` }} />
          ))}
          <col className="pipelines-grid__actions-col" />
        </colgroup>
        <thead>
          <tr>
            {shown.map((c) => {
              const dir = c.sort !== undefined && sort.key === c.sort ? sort.dir : null;
              return (
                <th
                  key={c.id}
                  scope="col"
                  className={c.numeric === true ? 'num' : undefined}
                  title={c.title}
                  aria-sort={ariaSortOf(dir)}
                >
                  {c.sort === undefined ? (
                    c.label
                  ) : (
                    <SortButton dir={dir} onClick={() => onSort(c.sort!)}>
                      {c.label}
                    </SortButton>
                  )}
                </th>
              );
            })}
            <th scope="col" aria-label="actions" />
          </tr>
        </thead>
        <tbody>
          {pipelines.map((p) => {
            const s = summaries?.get(p.id);
            return (
              <tr key={p.id}>
                {shown.map((c) => cellOf(c.id, p, s))}
                <td className="pipelines-grid__actions">{actions(p)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
