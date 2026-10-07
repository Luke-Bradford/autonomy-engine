import { useRef } from 'react';
import { gridWidthOf, type GridColumnSpec, type GridWidths } from '../stores/gridColumns';

/**
 * #1569 OR37 — a resizable grid's widths, as the runs grid (#1484) draws them.
 * Every column is a fixed px width in a `table-layout: fixed` table whose
 * `min-width` is their sum plus `reserve` (any column the grid adds outside the
 * spec), so once the columns outgrow the page the GRID scrolls sideways inside
 * `.runs-grid-scroll`, never the page. A drag previews straight onto the
 * `<col>` and the table, bypassing React, and commits on release.
 */
export function useGridColumnWidths<Id extends string>(
  spec: GridColumnSpec<Id>,
  widths: GridWidths<Id>,
  columns: readonly Id[],
  reserve = 0,
) {
  const widthOf = (column: Id) => gridWidthOf(spec, widths, column);
  const total = columns.reduce((sum, column) => sum + widthOf(column), reserve);
  const tableRef = useRef<HTMLTableElement>(null);
  const colRefs = useRef<Partial<Record<Id, HTMLTableColElement | null>>>({});
  return {
    widthOf,
    total,
    tableRef,
    colRef: (column: Id) => (el: HTMLTableColElement | null) => {
      colRefs.current[column] = el;
    },
    preview: (column: Id, width: number) => {
      const col = colRefs.current[column];
      if (col) col.style.width = `${String(width)}px`;
      if (tableRef.current) {
        tableRef.current.style.minWidth = `${String(total - widthOf(column) + width)}px`;
      }
    },
  };
}
