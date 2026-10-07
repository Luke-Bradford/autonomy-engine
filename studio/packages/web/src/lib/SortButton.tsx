import type { ReactNode } from 'react';

/**
 * #1484 — a sortable column header's control: a button that looks like the
 * header text, with the direction's arrow after it. One for the runs grid and a
 * run's activity runs. The `<th>` around it carries `aria-sort`.
 */
export function SortButton({
  dir,
  onClick,
  children,
}: {
  /** `null` when this column is not the sorted one. */
  dir: 'asc' | 'desc' | null;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="sort-button" onClick={onClick}>
      {children}
      {/* The arrow's box is always there, so sorting never moves a label. */}
      <span className="sort-button__arrow" aria-hidden="true">
        {dir === null ? '' : dir === 'asc' ? '▲' : '▼'}
      </span>
    </button>
  );
}
