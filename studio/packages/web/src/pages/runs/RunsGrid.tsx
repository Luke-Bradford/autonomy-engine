import { Fragment, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Menu,
  MenuDivider,
  MenuItem,
  MenuItemCheckbox,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
import { useStore } from 'zustand';
import { useHref, useLocation, useNavigate } from 'react-router';
import type { RunSortKey, RunSummary } from '@autonomy-studio/shared';
import {
  RUN_GRID_COLUMNS,
  RUN_GRID_COLUMN_MAX_WIDTH,
  RUN_GRID_COLUMN_WIDTHS,
  RUN_GRID_REQUIRED_COLUMNS,
  RUN_GRID_RESIZE_STEP,
  type RunGridColumnId,
  type UiStore,
} from '../../stores/uiStore';
import { ariaSortOf } from '../../lib/urlSort';
import { PaneSplitter } from '../../shell/PaneSplitter';
import { runDetailPath } from './runPath';
import { SortButton } from './SortButton';
import { nestRuns } from './runTree';
import {
  isPinnedRunGridColumn,
  RUN_GRID_COLUMN_DEFS,
  visibleRunGridColumns,
  type CellContext,
  type RunNest,
} from './runGridColumns';
import type { RunSortState } from './runFilters';
import { zoneLabel, type DisplayTimeZone } from '../../lib/displayTime';
import { useDisplayTimeZone } from '../../lib/useDisplayTimeZone';
import { useTickingNow } from '../../hooks/useTickingNow';
import { DURATION_TICK_MS } from './format';

/** A column's drawn width: the operator's, else its default. */
function widthOf(widths: Partial<Record<RunGridColumnId, number>>, column: RunGridColumnId) {
  return widths[column] ?? RUN_GRID_COLUMN_WIDTHS[column].default;
}

/**
 * A column header. The `<th>`'s `aria-label` is its name, so the resize handle
 * inside it does not become part of the header every cell is announced under.
 * A sortable header's button is the control, so a keyboard reaches it and a
 * screen reader announces the column's name and its order; `aria-sort` is set
 * only on the sorted column, as ARIA asks. The order is the SERVER's
 * (`?sort=`), so it holds across every page rather than only the rows loaded.
 */
function ColumnHeader({
  column,
  sort,
  onSort,
  width,
  onPreviewWidth,
  onCommitWidth,
  zoneNote,
}: {
  column: RunGridColumnId;
  /** The display zone's short name, shown after a `zoned` column's label. */
  zoneNote: string;
  sort: RunSortState;
  onSort: (column: RunSortKey) => void;
  width: number;
  onPreviewWidth: (width: number) => void;
  onCommitWidth: (width: number | null) => void;
}) {
  const { label, sort: sortKey, numeric = false, zoned = false } = RUN_GRID_COLUMN_DEFS[column];
  /* #1484 — a compact time column names its zone in the header, so the zone is
     visible without a hover. Outside the `aria-label`, which stays the name. */
  const note =
    zoned && zoneNote !== '' ? <span className="runs-grid__zone"> {zoneNote}</span> : null;
  const active = sortKey !== undefined && sort.key === sortKey;
  const id = `runs-grid-col-${column}`;
  return (
    <th
      id={id}
      scope="col"
      aria-label={label}
      {...(numeric ? { className: 'num' } : {})}
      aria-sort={ariaSortOf(active ? sort.dir : null)}
    >
      {sortKey === undefined ? (
        <>
          {label}
          {note}
        </>
      ) : (
        <SortButton dir={active ? sort.dir : null} onClick={() => onSort(sortKey)}>
          {label}
          {note}
        </SortButton>
      )}
      {/* A sibling of the sort button, never inside it, so a drag never sorts.
          Arrow keys step it; a double-click returns the column to its default. */}
      <PaneSplitter
        value={width}
        min={RUN_GRID_COLUMN_WIDTHS[column].min}
        max={RUN_GRID_COLUMN_MAX_WIDTH}
        step={RUN_GRID_RESIZE_STEP}
        label={`Resize ${label} column`}
        className="runs-grid__resizer"
        onPreview={onPreviewWidth}
        onCommit={onCommitWidth}
        onDoubleClick={() => onCommitWidth(null)}
        controls={id}
      />
    </th>
  );
}

/**
 * #1484 OR35 M1 — one row of the runs grid, and the whole row is the way into
 * the run. The Run ID cell holds the REAL link to it (keyboard focus, Enter, the
 * browser's own middle-click and context menu); the row's click handlers only
 * extend that target to the rest of the row for a mouse. They stand down when
 * the click landed on a control of its own (any link — Parent and the editor
 * icon go elsewhere — the copy button, or the Pipeline cell's ⋯ menu)
 * or ended a text selection, so copying a pipeline name never navigates. A
 * middle click or a modified click opens the run in a new tab, as the link
 * would.
 */
function RunRow({
  run: r,
  columns,
  loadedAt,
  zone,
  nest,
}: {
  run: RunSummary;
  columns: readonly RunGridColumnId[];
  loadedAt: number;
  zone: DisplayTimeZone;
  nest?: RunNest;
}) {
  const navigate = useNavigate();
  const { search } = useLocation();
  const path = runDetailPath(r.id);
  const href = useHref(path);
  const open = (e: ReactMouseEvent<HTMLTableRowElement>, newTab: boolean): void => {
    if (e.target instanceof Element && e.target.closest('a, button, input, select, textarea')) {
      return;
    }
    // #1566 — React bubbles a click through a PORTAL to this row too: the
    // Pipeline cell's ⋯ menu renders in the body, so a click on one of its
    // items is not in the row's DOM and must not also open the run.
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    // Only a selection INSIDE this row means "I was selecting text"; a stale one
    // elsewhere on the page must not make every row click do nothing.
    const selection = window.getSelection();
    if (
      selection !== null &&
      !selection.isCollapsed &&
      selection.anchorNode !== null &&
      e.currentTarget.contains(selection.anchorNode)
    ) {
      return;
    }
    if (newTab) window.open(href, '_blank', 'noopener');
    else void navigate(path);
  };
  const ctx: CellContext = { loadedAt, path, search, zone, ...(nest ? { nest } : {}) };
  return (
    <tr
      className={
        nest !== undefined && nest.depth > 0
          ? 'runs-grid__row runs-grid__row--child'
          : 'runs-grid__row'
      }
      onClick={(e) => open(e, e.metaKey || e.ctrlKey || e.shiftKey)}
      onAuxClick={(e) => {
        if (e.button === 1) open(e, true);
      }}
    >
      {columns.map((column) => (
        <Fragment key={column}>{RUN_GRID_COLUMN_DEFS[column].cell(r, ctx)}</Fragment>
      ))}
      <td className="runs-grid__filler" aria-hidden="true" />
    </tr>
  );
}

/**
 * #1484 OR35 M1 — the runs grid: one row per run, the columns the operator
 * chose (`RunGridColumnsMenu`) at the widths they set, and the server's sort.
 *
 * WIDTHS. Every column is a fixed px width in a `table-layout: fixed` table, and
 * a trailing FILLER column takes whatever the page has left. So widening a
 * column moves its right edge, and the handle on it, exactly with the pointer:
 * had a real column absorbed the slack instead, widening any column left of it
 * would take the width from that one, and the edge under the pointer would stay
 * put. The table's `min-width` is the sum of the columns, so once they outgrow
 * the page the filler is gone and the GRID scrolls sideways inside
 * `.runs-grid-scroll` — never the page.
 *
 * A drag previews straight onto the `<col>` and the table, bypassing React
 * (`PaneSplitter`'s drag path), and commits to the store on release.
 */
export function RunsGrid({
  runs,
  loadedAt,
  ticking = false,
  sort,
  onSort,
  hidden,
  ui,
  nested = false,
}: {
  runs: readonly RunSummary[];
  loadedAt: number;
  /**
   * #1484 — the list is live and polling, so an unfinished run's duration may
   * COUNT. Only then: a count is honest only while the page would hear the run
   * finish. ONE clock for the grid rather than one per cell, running only while
   * something is unfinished; paused, it HOLDS its reading, so a duration stops
   * where it was instead of rewinding to `loadedAt`.
   */
  ticking?: boolean;
  sort: RunSortState;
  onSort: (column: RunSortKey) => void;
  /** #1484 — the columns turned off: the URL's `hide` when a link carries one,
   * else the viewer's stored choice (`RunsPage` decides which). */
  hidden: readonly RunGridColumnId[];
  ui: UiStore;
  /**
   * #1484 — "Include child runs": draw each run a loaded run called under it
   * (`nestRuns`), with a disclosure to collapse it. Which runs are collapsed is
   * this grid's own state: a new list (a filter change) starts expanded.
   */
  nested?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(
    () =>
      nested
        ? nestRuns(runs, collapsed)
        : runs.map((run) => ({ run, depth: 0, shown: 0, expanded: true })),
    [nested, runs, collapsed],
  );
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const widths = useStore(ui, (s) => s.runsGridWidths);
  const setWidth = useStore(ui, (s) => s.setRunsGridWidth);
  const zone = useDisplayTimeZone(ui);
  const counting = useTickingNow(
    DURATION_TICK_MS,
    ticking && runs.some((r) => r.finishedAt === null),
  );
  /* Never behind the read: a static list measures against `loadedAt` exactly as
     before, and a fresh poll moves a held clock forward. */
  const clock = Math.max(counting, loadedAt);
  const columns = visibleRunGridColumns(hidden, sort.key);
  const total = columns.reduce((sum, column) => sum + widthOf(widths, column), 0);
  const tableRef = useRef<HTMLTableElement>(null);
  const colRefs = useRef<Partial<Record<RunGridColumnId, HTMLTableColElement | null>>>({});

  function preview(column: RunGridColumnId, width: number) {
    const col = colRefs.current[column];
    if (col) col.style.width = `${width}px`;
    if (tableRef.current) {
      tableRef.current.style.minWidth = `${total - widthOf(widths, column) + width}px`;
    }
  }

  return (
    <div className="runs-grid-scroll">
      <table ref={tableRef} className="runs-grid" style={{ minWidth: `${total}px` }}>
        <colgroup>
          {columns.map((column) => (
            <col
              key={column}
              ref={(el) => {
                colRefs.current[column] = el;
              }}
              className={`runs-grid__col--${column}`}
              style={{ width: `${widthOf(widths, column)}px` }}
            />
          ))}
          <col className="runs-grid__col--filler" />
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <ColumnHeader
                key={column}
                column={column}
                sort={sort}
                onSort={onSort}
                width={widthOf(widths, column)}
                onPreviewWidth={(width) => preview(column, width)}
                onCommitWidth={(width) => setWidth(column, width)}
                zoneNote={zoneLabel(loadedAt, zone)}
              />
            ))}
            <th className="runs-grid__filler" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ run: r, depth, shown, expanded }) => (
            <RunRow
              key={r.id}
              run={r}
              columns={columns}
              loadedAt={clock}
              zone={zone}
              {...(nested
                ? {
                    nest: {
                      depth,
                      shown,
                      total: r.childRunCount,
                      expanded,
                      onToggle: () => toggle(r.id),
                    },
                  }
                : {})}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * #1484 OR35 M1 — the grid's column picker. Fluent's checkbox menu, as the
 * Triggered-by filter uses. A required column (`RUN_GRID_REQUIRED_COLUMNS`) is
 * listed checked and disabled, so the operator can see why it cannot go; so is
 * the column the grid is sorted by, for `visibleRunGridColumns`' reason.
 */
export function RunGridColumnsMenu({
  hidden,
  sortKey,
  onHiddenChange: setHidden,
  onReset: reset,
}: {
  /** As `RunsGrid`'s `hidden`: the set the grid is drawing. */
  hidden: readonly RunGridColumnId[];
  sortKey: RunSortKey;
  onHiddenChange: (hidden: readonly RunGridColumnId[]) => void;
  onReset: () => void;
}) {
  const shown = visibleRunGridColumns(hidden, sortKey);
  const locked = (column: RunGridColumnId) => isPinnedRunGridColumn(column, sortKey);
  return (
    <Menu
      checkedValues={{ columns: shown }}
      onCheckedValueChange={(_, data) =>
        setHidden(
          RUN_GRID_COLUMNS.filter(
            // A locked column's box cannot change, so its stored choice is kept
            // as it was: a column hidden before the grid was sorted by it hides
            // again once the sort moves on.
            (column) =>
              locked(column) ? hidden.includes(column) : !data.checkedItems.includes(column),
          ),
        )
      }
    >
      <MenuTrigger disableButtonEnhancement>
        <button type="button">
          Columns <span aria-hidden="true">▾</span>
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {RUN_GRID_COLUMNS.map((column) => (
            <MenuItemCheckbox
              key={column}
              name="columns"
              value={column}
              disabled={locked(column)}
              {...(locked(column)
                ? {
                    title: RUN_GRID_REQUIRED_COLUMNS.includes(column)
                      ? 'Always shown'
                      : 'Shown while the grid is sorted by it',
                  }
                : {})}
            >
              {RUN_GRID_COLUMN_DEFS[column].label}
            </MenuItemCheckbox>
          ))}
          <MenuDivider />
          <MenuItem onClick={reset}>Reset columns</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
