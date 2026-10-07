import type { ReactNode } from 'react';
import {
  Menu,
  MenuDivider,
  MenuItem,
  MenuItemCheckbox,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
import { ariaSortOf, type SortDir } from './urlSort';
import { PaneSplitter } from '../shell/PaneSplitter';
import { SortButton } from './SortButton';
import { visibleGridColumns, type GridColumnSpec } from '../stores/gridColumns';

/* The class names are the runs grid's, which drew these first: `.runs-grid`,
   `.runs-grid-scroll` and `.runs-grid__resizer` are the shared grid styles. */

/**
 * A resizable column header. The `<th>`'s `aria-label` is its name, so the
 * resize handle inside it does not become part of the header every cell is
 * announced under. A sortable header's button is the control (`sortDir` is
 * given, `null` when another column is sorted), and `aria-sort` is set only on
 * the sorted column, as ARIA asks. The handle is a SIBLING of the sort button,
 * never inside it, so a drag never sorts; arrow keys step it and a
 * double-click returns the column to its default.
 */
export function GridColumnHeader({
  id,
  label,
  note,
  title,
  numeric = false,
  sortDir,
  onSort,
  width,
  min,
  max,
  step,
  onPreviewWidth,
  onCommitWidth,
}: {
  /** The `<th>`'s id, which the handle names as the element it resizes. */
  id: string;
  label: string;
  /** Shown after the label, outside the accessible name. */
  note?: ReactNode;
  /** Hover text, where the label alone is terse. */
  title?: string;
  numeric?: boolean;
  /** Absent: not sortable. */
  sortDir?: SortDir | null;
  onSort?: () => void;
  width: number;
  min: number;
  max: number;
  step: number;
  onPreviewWidth: (width: number) => void;
  onCommitWidth: (width: number | null) => void;
}) {
  return (
    <th
      id={id}
      scope="col"
      aria-label={label}
      {...(numeric ? { className: 'num' } : {})}
      {...(title === undefined ? {} : { title })}
      aria-sort={ariaSortOf(sortDir ?? null)}
    >
      {sortDir === undefined ? (
        <>
          {label}
          {note}
        </>
      ) : (
        <SortButton dir={sortDir} onClick={() => onSort?.()}>
          {label}
          {note}
        </SortButton>
      )}
      <PaneSplitter
        value={width}
        min={min}
        max={max}
        step={step}
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
 * A grid's column picker: Fluent's checkbox menu, as the Triggered-by filter
 * uses. A required column is listed checked and disabled, so the viewer can see
 * why it cannot go; so is a `pinned` one (the column the grid is sorted by),
 * which `visibleGridColumns` draws anyway.
 */
export function GridColumnsMenu<Id extends string>({
  spec,
  hidden,
  pinned,
  labelOf,
  onHiddenChange: setHidden,
  onReset: reset,
}: {
  spec: GridColumnSpec<Id>;
  /** The set the grid is drawing. */
  hidden: readonly Id[];
  pinned: (column: Id) => boolean;
  labelOf: (column: Id) => string;
  onHiddenChange: (hidden: readonly Id[]) => void;
  onReset: () => void;
}) {
  const shown = visibleGridColumns(spec, hidden, pinned);
  const required = (column: Id) => spec.required.includes(column);
  const locked = (column: Id) => required(column) || pinned(column);
  return (
    <Menu
      checkedValues={{ columns: shown }}
      onCheckedValueChange={(_, data) =>
        setHidden(
          spec.columns.filter(
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
          {spec.columns.map((column) => (
            <MenuItemCheckbox
              key={column}
              name="columns"
              value={column}
              disabled={locked(column)}
              {...(locked(column)
                ? {
                    title: required(column)
                      ? 'Always shown'
                      : 'Shown while the grid is sorted by it',
                  }
                : {})}
            >
              {labelOf(column)}
            </MenuItemCheckbox>
          ))}
          <MenuDivider />
          <MenuItem onClick={reset}>Reset columns</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
