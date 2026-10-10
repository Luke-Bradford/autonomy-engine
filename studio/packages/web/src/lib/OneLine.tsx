import type { ReactNode } from 'react';

/**
 * #1594 OR40 S3d — a table cell's text cut to one line, whole in its tooltip.
 *
 * Every table row is `--row-h` tall (the one table style, `index.css`), so a
 * free-text cell that can be long (a name, a path, an event's detail) must not
 * wrap. It ellipsises instead, and `title` carries the full text so nothing is
 * lost: the tooltip is how the cut value is read, and an edit form or detail
 * page is how it is changed.
 *
 * `title` is required rather than derived from `children` because a cell's
 * content is often not plain text (a link, a muted detail after the act). It
 * must contain the visible text, which `e2e/table-style.spec.ts` checks.
 * `as="code"` keeps a value or path in the mono face. `wide` is for a table's
 * one long column (an audit entry, an event's detail), where the default cap
 * would cut a sentence that the column has room for.
 */
export function OneLine({
  title,
  as = 'span',
  wide = false,
  className,
  children,
}: {
  title: string;
  as?: 'span' | 'code';
  wide?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const Tag = as;
  const classes = ['cell-one-line', wide && 'cell-one-line--wide', className]
    .filter(Boolean)
    .join(' ');
  return (
    <Tag className={classes} title={title}>
      {children}
    </Tag>
  );
}
