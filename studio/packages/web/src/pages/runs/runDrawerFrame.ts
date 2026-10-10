import type { CSSProperties } from 'react';

/**
 * #1594 OR40 S3e — what the run page and its detail drawer (`RunDrawer`) share:
 * the drawer's width, which the page carries, and the window width from which
 * the drawer pushes the page rather than lying over it.
 */
export const RUN_DRAWER_WIDTH_VAR = '--run-drawer-width';

/** From this window width there is room to push the page. */
export const RUN_DRAWER_PUSH_MIN = 1280;

/**
 * The operator's drawer width, as the run page carries it (`.run-page`). On the
 * page, not the drawer, so that the page's gutter (which keeps the grid out
 * from under a pushing drawer) and the drawer are one width, during a drag too.
 */
export function runDrawerWidthStyle(width: number | null): CSSProperties | undefined {
  return width === null ? undefined : ({ [RUN_DRAWER_WIDTH_VAR]: `${width}px` } as CSSProperties);
}
