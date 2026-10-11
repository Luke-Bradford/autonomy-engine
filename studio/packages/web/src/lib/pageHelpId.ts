/**
 * #1594 OR40 S6d — the id of a page's `?` note (`PageHeader`'s `help`), from
 * its heading's id, so the page's own `<section aria-labelledby>` can take it as
 * `aria-describedby`, the way a `Section` is described by its note. Its own
 * module, so `PageHeader.tsx` exports components only.
 */
export function pageHelpId(headingId: string): string {
  return `${headingId}-about`;
}
