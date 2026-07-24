import { Navigate, type RouteObject } from 'react-router';
import { AppShell } from './shell/AppShell';
import { HomePage } from './pages/HomePage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { PipelinesPage } from './pages/PipelinesPage';
import { TriggersPage } from './pages/TriggersPage';
import { RunsPage } from './pages/runs/RunsPage';
import { RunDetailRoute } from './pages/runs/RunDetailRoute';

/**
 * The hash-router route tree (U2).
 *
 * Shape: one layout route (`AppShell`, which draws the hub rail and hosts the
 * `<Outlet/>`) with a section per hub. Each hub's own path redirects to its
 * default child, so `#/monitor` is a valid, shareable URL rather than a blank
 * hub. `replace` on those redirects keeps the Back button useful — otherwise
 * going back from `/monitor/runs` would land on `/monitor` and immediately
 * bounce forward again, trapping the user.
 *
 * Exported (rather than a router being built here) so tests can mount the exact
 * same tree under `createMemoryRouter` at any initial entry.
 *
 * NOT here, deliberately:
 * - Legacy `#/connections`-era redirects — ticket U3r owns those, and the
 *   catch-all below keeps an old bookmark landing somewhere real meanwhile.
 * - `/author/pipelines/:pipelineId` — opening a pipeline on the canvas is still
 *   local state inside `PipelinesPage`; U4 (Factory Resources) is where that
 *   becomes URL state. See the URL-state block in the UI design doc.
 */
export const ROUTES: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },

      {
        path: 'author',
        children: [
          { index: true, element: <Navigate to="/author/pipelines" replace /> },
          { path: 'pipelines', element: <PipelinesPage /> },
        ],
      },

      {
        path: 'monitor',
        children: [
          { index: true, element: <Navigate to="/monitor/runs" replace /> },
          { path: 'runs', element: <RunsPage /> },
          { path: 'runs/:runId', element: <RunDetailRoute /> },
        ],
      },

      {
        path: 'manage',
        children: [
          { index: true, element: <Navigate to="/manage/connections" replace /> },
          { path: 'connections', element: <ConnectionsPage /> },
          { path: 'triggers', element: <TriggersPage /> },
        ],
      },

      /* Catch-all. An unknown path renders Home rather than a dead end — and
         `replace` so the bad URL does not sit in history waiting for Back.
         U3r replaces this blanket fallback with real redirects for the MVP's
         old paths (`#/runs/:id` should reach that run, not Home). */
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];
