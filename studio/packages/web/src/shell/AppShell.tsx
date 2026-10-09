import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Outlet, useLocation, useMatches } from 'react-router';
import { useStore } from 'zustand';
import { HubRail } from './HubRail';
import { CommandBar } from './CommandBar';
import { PaneSplitter } from './PaneSplitter';
import { PANE_ELEMENT_ID, SecondaryPane } from './SecondaryPane';
import { hubById } from './hubs';
import {
  activeHubId,
  crumbsFrom,
  documentTitle,
  normalizePath,
  type PublishedLabels,
} from './routeHandle';
import { ShellLabelContext, withLabel, type ShellLabelApi } from './shellLabel';
import { PANE_MAX_WIDTH, PANE_MIN_WIDTH, PANE_RESIZE_STEP, uiStore } from '../stores/uiStore';
import { UpdateBanner } from './UpdateBanner';

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
 * The workspace keeps the `content` class deliberately. `index.css` hangs the
 * page's content frame off it — the one page padding (#1594 OR40 S3) — and
 * `:has(.canvas-page)`, which makes the authoring canvas a full-height flex
 * column. Renaming it here would silently drop both, which no unit test can see
 * (jsdom computes no layout).
 */
export function AppShell() {
  const matches = useMatches();
  const hub = hubById(activeHubId(matches));

  /* #1392 — the names pages publish for their own paths (`shellLabel.ts`). The
     api object is created once, so a page's publishing effect does not re-run
     every time the shell re-renders. */
  const [published, setPublished] = useState<PublishedLabels>({});
  /* #1393 — the paths holding unsaved work. A path, not a flag, for the same
     reason labels are keyed by one: a page's cleanup and the next page's
     publish can land in either order. */
  const [unsavedPaths, setUnsavedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const labelApi = useMemo<ShellLabelApi>(
    () => ({
      publish: (path, label) => setPublished((prev) => withLabel(prev, path, label)),
      markUnsaved: (path, unsaved) =>
        setUnsavedPaths((prev) => {
          const key = normalizePath(path);
          if (prev.has(key) === unsaved) return prev;
          const next = new Set(prev);
          if (unsaved) next.add(key);
          else next.delete(key);
          return next;
        }),
    }),
    [],
  );
  const { pathname } = useLocation();
  const crumbs = crumbsFrom(matches, published[normalizePath(pathname)]);

  const title = documentTitle(crumbs, unsavedPaths.has(normalizePath(pathname)));
  useEffect(() => {
    document.title = title;
  }, [title]);

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
    <ShellLabelContext.Provider value={labelApi}>
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
            value={paneWidth}
            min={PANE_MIN_WIDTH}
            max={PANE_MAX_WIDTH}
            step={PANE_RESIZE_STEP}
            label="Resize navigation pane"
            className="pane-splitter"
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
          <UpdateBanner />
          <main className="content">
            <Suspense fallback={null}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>
    </ShellLabelContext.Provider>
  );
}
