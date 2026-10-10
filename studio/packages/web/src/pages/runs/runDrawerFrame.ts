import type { CSSProperties } from 'react';

/**
 * #1594 OR40 S3e — what the run page and its detail drawer (`RunDrawer`) share:
 * the drawer's width, which the page carries, and the window width from which
 * the drawer pushes the page rather than lying over it.
 */
export const RUN_DRAWER_WIDTH_VAR = '--run-drawer-width';
/** The run page, which carries the width and keeps the pushed gutter. */
export const RUN_PAGE_SELECTOR = '.run-page';

/**
 * The widest the drawer may be: most of the window, never all of it. The
 * splitter's range; `index.css` caps the rendered box at the same `80vw`
 * (`--run-drawer-box`), for a window narrowed after the width was kept.
 */
export const RUN_DRAWER_MAX_SHARE = 0.8;
/** From this window width there is room to push the page. */
export const RUN_DRAWER_PUSH_MIN = 1280;
/**
 * Pushing, the drawer takes at most this share of the window. Dragged wider, it
 * lies over the page instead, which a push would otherwise leave a sliver.
 */
export const RUN_DRAWER_PUSH_MAX_SHARE = 0.5;

/** Whether the drawer pushes the page: the window has room for both. */
export function runDrawerPushes(windowWidth: number, width: number | null): boolean {
  // The default width is under half the window (`index.css`, 45vw at most).
  return (
    windowWidth >= RUN_DRAWER_PUSH_MIN &&
    (width === null || width <= windowWidth * RUN_DRAWER_PUSH_MAX_SHARE)
  );
}

/**
 * The operator's drawer width, as the run page carries it (`.run-page`). On the
 * page, not the drawer, so that the page's gutter (which keeps the grid out
 * from under a pushing drawer) and the drawer are one width, during a drag too.
 */
export function runDrawerWidthStyle(width: number | null): CSSProperties | undefined {
  return width === null ? undefined : ({ [RUN_DRAWER_WIDTH_VAR]: `${width}px` } as CSSProperties);
}
