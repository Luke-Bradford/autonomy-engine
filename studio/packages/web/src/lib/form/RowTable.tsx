import type { ReactNode } from 'react';

/** One column of a `RowTable`: its header and how wide its cells want to be. */
export interface RowTableColumn {
  key: string;
  header: ReactNode;
  /** `check` is a tick box, `short` a type or number, `long` free text. Default `long`. */
  width?: 'check' | 'short' | 'long';
}

/**
 * #1477 OR29 — a list of authored rows as a compact table: column headers once,
 * a row per entry, its controls in cells. It replaced the stacked `.contract-row`
 * card, which repeated every label on every row and spent five lines on a
 * declaration that reads as one.
 *
 * Each control keeps its OWN accessible name (`param 1 name`, `mapping row 2
 * sink`): a header names the column for a sighted reader and, through table
 * semantics, for a screen reader moving cell to cell, but a spec or a voice user
 * addresses one control, and that name is what tells two `sink` boxes apart.
 *
 * The last column holds the row's actions and has no visible header. The table
 * scrolls sideways inside its wrapper rather than crushing its columns, so a
 * narrow dock (the right-hand dock is 302–463px) still gets usable cells.
 *
 * A row's notes — its errors and advisories — go in a `RowNotes` row after it,
 * spanning the table, so they never widen a cell.
 */
export function RowTable({
  columns,
  label,
  labelledBy,
  children,
}: {
  columns: readonly RowTableColumn[];
  /** What the list is called, when no element on the page names it. */
  label?: string;
  /** The id of the heading or label that names the list. */
  labelledBy?: string;
  children: ReactNode;
}) {
  return (
    <div className="row-table-scroll">
      <table className="row-table" aria-label={label} aria-labelledby={labelledBy}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" data-width={c.width ?? 'long'}>
                {c.header}
              </th>
            ))}
            <th scope="col" data-width="actions">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** A row's last cell, under the header-less Actions column. */
export function RowActions({ children }: { children: ReactNode }) {
  return <td className="row-table__actions">{children}</td>;
}

/**
 * A row's ✕. `label` is its whole name (`remove param 1`), which says WHICH
 * row; the glyph alone is what shows.
 */
export function RemoveRowButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button type="button" aria-label={label} onClick={onRemove}>
      ✕
    </button>
  );
}

/** A row's errors and advisories, on a row of their own under it (see `RowTable`). */
export function RowNotes({ span, children }: { span: number; children: ReactNode }) {
  return (
    <tr className="row-table__notes">
      <td colSpan={span}>{children}</td>
    </tr>
  );
}

/**
 * #1477 — a list of authored rows with its frame: "None declared." when empty,
 * otherwise the `RowTable`, then the Add button. Shared by the pipeline contract
 * sections (`ContractSection`) and the annotation lists (`AnnotationRows`), so
 * the empty state and the Add control are one thing, whatever section chrome
 * (`DockSection`, `FormSection`) holds them. `addDisabled` is for a list with a
 * write-schema limit.
 */
export function RowList({
  columns,
  label,
  count,
  addLabel,
  onAdd,
  addDisabled = false,
  children,
}: {
  columns: readonly RowTableColumn[];
  label: string;
  count: number;
  addLabel: string;
  onAdd: () => void;
  addDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {count === 0 ? (
        <p className="page-hint">None declared.</p>
      ) : (
        <RowTable columns={columns} label={label}>
          {children}
        </RowTable>
      )}
      <button type="button" onClick={onAdd} disabled={addDisabled}>
        {addLabel}
      </button>
    </>
  );
}
