import { useCallback, useRef, type CSSProperties } from 'react';
import { Outlet, useMatches } from 'react-router';
import { useStore } from 'zustand';
import { HubRail } from './HubRail';
import { CommandBar } from './CommandBar';
import { PaneSplitter } from './PaneSplitter';
import { PANE_ELEMENT_ID, SecondaryPane } from './SecondaryPane';
import { hubById } from './hubs';
import { activeHubId, crumbsFrom } from './routeHandle';
import { uiStore, type UiStore } from '../stores/uiStore';

/** The custom property the shell's grid reads its pane track from. */
const PANE_WIDTH_VAR = '--pane-width';

interface AppShellProps {
  /** Injectable for tests; the app uses the singleton, as `ThemeToggle` does. */
  store?: UiStore;
}

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
 * PANE TRACK. The grid's middle column is `var(--pane-width)`, written here as
 * an inline custom property. It is `0px` whenever there is no pane to show —
 * the hub declares no sections (Home), or the user collapsed it — because a
 * fixed track does NOT collapse on its own: leaving it at 240px would inset the
 * workspace behind an empty box. `index.css` declares a fallback for the same
 * property, since an undefined custom property makes `grid-template-columns`
 * invalid at computed-value time, which drops the whole template to `none` and
 * stacks the shell into one column.
 *
 * The workspace keeps the `content` class deliberately. `index.css` hangs three
 * behaviours off it — page padding, a 900px reading cap for forms and lists,
 * and `:has(.canvas-page)` which REMOVES that cap so the authoring canvas is
 * full-bleed. Renaming it here would silently re-cap the canvas at 900px, which
 * no unit test can see (jsdom computes no layout).
 */
export function AppShell({ store = uiStore }: AppShellProps) {
  const matches = useMatches();
  const hub = hubById(activeHubId(matches));
  const crumbs = crumbsFrom(matches);

  const paneWidth = useStore(store, (s) => s.paneWidth);
  const paneCollapsed = useStore(store, (s) => s.paneCollapsed);
  const setPaneWidth = useStore(store, (s) => s.setPaneWidth);
  const setPaneCollapsed = useStore(store, (s) => s.setPaneCollapsed);

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
  const paneTrack = { [PANE_WIDTH_VAR]: paneShown ? `${paneWidth}px` : '0px' } as CSSProperties;

  return (
    <div className="app-shell" ref={shellRef} style={paneTrack}>
      {/* No `store` seam passed down to the rail: it takes one for its own unit
          tests, and the composed tree deliberately runs on the `uiStore`
          singleton — which is what `App.test.tsx` asserts the theme provider
          shares. */}
      <HubRail />

      {/* Mounted-but-`hidden` when collapsed, so the toggle's `aria-controls`
          keeps naming an element that exists. The zeroed track above is what
          actually reclaims the space. */}
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
              ? {
                  collapsed: paneCollapsed,
                  onToggle: () => setPaneCollapsed(!paneCollapsed),
                }
              : undefined
          }
        />
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
