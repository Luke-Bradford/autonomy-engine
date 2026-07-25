import { lazy } from 'react';

/**
 * #698 — the on-demand wrapper around `PipelineCanvasRoute`.
 *
 * The production build shipped as ONE ~560 kB entry chunk (over Rollup's own
 * 500 kB warning), and `@xyflow/react` — reachable only from this one route —
 * was the largest single slice of it. Everyone paid React Flow's download to
 * look at a list of runs. Splitting just this route cut the entry chunk from
 * 169.39 to 109.45 kB gzip; the measurements live in `vite.config.ts` beside
 * the chunking rules that produce them.
 *
 * `React.lazy` rather than react-router's own `lazy` route property, for two
 * independent reasons. `routes.test.tsx` inspects
 * `createMemoryRouter(ROUTES).state.matches` WITHOUT rendering, and a native
 * `lazy` route leaves the data router uninitialised (and demands a
 * `HydrateFallback`), whereas `React.lazy` keeps route matching purely
 * path-based. And a native `lazy` route blocks the NAVIGATION — the shell would
 * sit on the old view — where the `<Suspense>` boundary in `AppShell` swaps
 * only the workspace and leaves the chrome painted.
 *
 * WHY ITS OWN FILE: `routes.tsx` exports constants (`ROUTES`,
 * `LEGACY_REDIRECTS`), and eslint's `react-refresh/only-export-components`
 * fires when such a file also defines a component — the same rule that already
 * keeps `LegacyRunRedirect` out of it. The named export is mapped to `default`
 * because `lazy()` requires a default export and this codebase exports by name.
 */
export const PipelineCanvasRoute = lazy(() =>
  import('./PipelineCanvasRoute.js').then((m) => ({ default: m.PipelineCanvasRoute })),
);
