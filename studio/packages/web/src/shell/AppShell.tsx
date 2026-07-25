import { Suspense, useCallback, useRef, type CSSProperties } from 'react';
import { Outlet, useMatches } from 'react-router';
import { useStore } from 'zustand';
import { HubRail } from './HubRail';
import { CommandBar } from './CommandBar';
import { PaneSplitter } from './PaneSplitter';
import { PANE_ELEMENT_ID, SecondaryPane } from './SecondaryPane';
import { hubById } from './hubs';
import { activeHubId, crumbsFrom } from './routeHandle';
import { uiStore } from '../stores/uiStore';

/** The custom property the secondary pane takes its width from. */
const PANE_WIDTH_VAR = '--pane-width';

/**
 * The shell layout route (U1–U3): the 48px hub rail, the active hub's
 * secondary pane and its splitter, then a workspace column of command bar over
 * the routed page.
 *
 * This is the ONE place that asks the router where it is. `useMatches()` plus
 * route `handle` is react-router's own documented idiom for exactly this, and
 * asking the router directly is not the parallel path-matcher U2 deleted — it
 * is the same single source, read rather than re-derived. Everything below
 * takes what it needs as props, so each shell part stays unit-testable without
 * a data router.
 *
 * PANE WIDTH. Written here as one inline custom property that the pane ELEMENT
 * consumes (`index.css`: `.secondary-pane { width: var(--pane-width, 240px) }`),
 * NOT as a grid track. That is deliberate: the shell's pane column is `auto`,
 * so it is sized by the pane when there is one and collapses to 0 by itself
 * when there is not — a hub with no sections renders no pane, and a collapsed
 * pane is `hidden`, i.e. not a grid item. Neither case needs a special value
 * here, which is why this is unconditional.
 *
 * The workspace keeps the `content` class deliberately. `index.css` hangs three
 * behaviours off it — page padding, a 900px reading cap for forms and lists,
 * and `:has(.canvas-page)` which REMOVES that cap so the authoring canvas is
 * full-bleed. Renaming it here would silently re-cap the canvas at 900px, which
 * no unit test can see (jsdom computes no layout).
 */
export function AppShell() {
  const matches = useMatches();
  const hub = hubById(activeHubId(matches));
  const crumbs = crumbsFrom(matches);

  /* The singleton, with no injectable seam. `HubRail`/`ThemeToggle` take one
     because their own unit tests render them in isolation; the shell is only
     ever exercised through the real route tree (`routes.test.tsx`), which
     drives this same singleton directly. An unused seam is API that drifts. */
  const paneWidth = useStore(uiStore, (s) => s.paneWidth);
  const paneCollapsed = useStore(uiStore, (s) => s.paneCollapsed);
  const setPaneWidth = useStore(uiStore, (s) => s.setPaneWidth);
  const setPaneCollapsed = useStore(uiStore, (s) => s.setPaneCollapsed);

  const shellRef = useRef<HTMLDivElement>(null);

  const hasPane = (hub?.sections.length ?? 0) > 0;
  const paneShown = hasPane && !paneCollapsed;

  /* Mid-drag width, written straight onto the element. See `PaneSplitter` for
     why the drag deliberately bypasses React: ~60 store writes a second would
     re-render the whole shell and persist to localStorage on every frame. */
  const previewPaneWidth = useCallback((width: number) => {
    shellRef.current?.style.setProperty(PANE_WIDTH_VAR, `${width}px`);
  }, []);

  /* Cast because React's `CSSProperties` is the typed CSS property set and has
     no index signature for custom properties — a `--foo` key is valid CSS and
     valid at runtime, but not expressible in that type. */
  const paneStyle = { [PANE_WIDTH_VAR]: `${paneWidth}px` } as CSSProperties;

  return (
    <div className="app-shell" ref={shellRef} style={paneStyle}>
      {/* The rail runs on the `uiStore` singleton too — which is what
          `App.test.tsx` asserts the theme provider shares. */}
      <HubRail />

      {/* Mounted-but-`hidden` when collapsed, so the toggle's `aria-controls`
          keeps naming an element that exists. `display: none` also takes it out
          of the grid, which is what reclaims its column. */}
      {hasPane && <SecondaryPane hub={hub!} collapsed={paneCollapsed} />}
      {paneShown && (
        <PaneSplitter
          width={paneWidth}
          onPreview={previewPaneWidth}
          onCommit={setPaneWidth}
          controls={PANE_ELEMENT_ID}
        />
      )}

      <div className="workspace">
        <CommandBar
          crumbs={crumbs}
          pane={
            hasPane
              ? { collapsed: paneCollapsed, onToggle: () => setPaneCollapsed(!paneCollapsed) }
              : undefined
          }
        />
        {/* #698 — the code-splitting boundary sits INSIDE `<main>`, not around
            the shell. Two reasons. Rendered: the rail, command bar and pane stay
            painted while a lazy route's chunk loads, so only the workspace
            swaps — a shell that blanks entirely would be a worse experience
            than the eager import it replaced. Structural: `routes.test.tsx`
            reads `<main>` SYNCHRONOUSLY via `getByRole('main')`, so hoisting
            the boundary above `AppShell` would suspend the chrome those tests
            query. The fallback is deliberately empty — a spinner here would
            flash on a local-first app whose chunks load in milliseconds. */}
        <main className="content">
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
