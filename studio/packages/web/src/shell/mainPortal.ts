import { createContext, useContext } from 'react';

/**
 * #1594 OR40 S5b — an element at the end of `<main>` that a popup can be
 * portalled into, so it stays inside the page's `main` landmark.
 *
 * Fluent portals a popup to the end of `<body>` by default, which is outside
 * every landmark: axe's `region` rule flags it, and a screen reader that moves
 * by landmark cannot reach the open list. Mounting it here keeps it in `main`
 * while keeping what the portal is for — the popup is still OUTSIDE the dock,
 * whose scroll container would clip it. (`inlinePopup` cannot do that: the dock
 * tab is a size container, and containment makes it the containing block even
 * for a `fixed` popup.)
 *
 * `main` (`.content`) scrolls and clips too, so a popup mounted here must use
 * `strategy: 'fixed'`, which places it against the viewport. Nothing between
 * here and the viewport is a containing block for it.
 *
 * `null` until the shell has mounted the element, and outside the shell (a unit
 * test rendering a panel on its own), where Fluent's default applies.
 */
export const MainPortalContext = createContext<HTMLElement | null>(null);

export function useMainPortal(): HTMLElement | null {
  return useContext(MainPortalContext);
}
