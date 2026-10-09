import type { ReactNode } from 'react';

/**
 * #1477 OR29 — a run of form fields that the compact property dock lays out as
 * a grid: a `short` cell (a number, a checkbox, a short choice) packs beside the
 * next, anything else takes the row. Both classes are the dock's
 * (`index.css`, `@container dock-tab`); everywhere else a cell generates no box
 * and the fields keep their column.
 *
 * The group role and name are OPTIONAL: inside a tab panel, which is already a
 * named region, a second name is noise, and one shared with a tab or a field
 * makes every label query ambiguous.
 */
export function FieldGrid({
  className,
  label,
  children,
}: {
  className?: string;
  /** The group's accessible name; with it the grid is a `group`. */
  label?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={className === undefined ? 'config-editor' : `config-editor ${className}`}
      {...(label === undefined ? {} : { role: 'group', 'aria-label': label })}
    >
      {children}
    </div>
  );
}

/** One field's box in a `FieldGrid`; a DIRECT child of it, or the grid misses it. */
export function FieldCell({ span, children }: { span: 'short' | 'long'; children: ReactNode }) {
  return (
    <div className="config-cell" data-field-span={span}>
      {children}
    </div>
  );
}
