import { Navigate, type RouteObject } from 'react-router';
import { AppShell } from './shell/AppShell';
import { HomePage } from './pages/HomePage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { PipelinesPage } from './pages/PipelinesPage';
import { TriggersPage } from './pages/TriggersPage';
import { RunsPage } from './pages/runs/RunsPage';
import { RunDetailRoute } from './pages/runs/RunDetailRoute';
import { LegacyRunRedirect } from './pages/runs/LegacyRunRedirect';

/**
 * U3r — compatibility redirects for the MVP's pre-hub paths.
 *
 * The MVP shipped a flat route space (`#/connections`, `#/pipelines`,
 * `#/triggers`, `#/runs`, `#/runs/:id`); U2 moved every page under a hub. Until
 * this table existed the catch-all swallowed all of them and sent an old
 * bookmark to Home — losing the run id on `#/runs/:id`, the one legacy URL a
 * user is actually likely to have shared.
 *
 * The compatibility layer is exactly three things, so retiring it once the
 * window for old bookmarks has closed is a small, findable job: this table, the
 * routes built from it near the bottom of `ROUTES`, and the `LegacyRunRedirect`
 * component (which lives with the run pages because a file exporting constants
 * must not also define components — eslint's `react-refresh` rule).
 *
 * `/` is deliberately absent. The MVP rendered Connections at `/`, but `/` is
 * now the Home hub; honouring the old default would break Home for everyone to
 * humour a stale bookmark.
 *
 * `from` is typed as a rooted path rather than a bare `string`: the route
 * builder below strips the leading `/`, so an entry that forgot it would not
 * fail to compile, it would silently register a route missing its first letter.
 */
export const LEGACY_REDIRECTS: readonly { from: `/${string}`; to: string }[] = [
  { from: '/connections', to: '/manage/connections' },
  { from: '/pipelines', to: '/author/pipelines' },
  { from: '/triggers', to: '/manage/triggers' },
  { from: '/runs', to: '/monitor/runs' },
];

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

      /* U3r compatibility layer. `replace` throughout: a legacy path that
         pushed would leave the dead URL in history, so Back from the hub page
         would return to it and be bounced forward again — the same trap the
         hub indexes above avoid. Listed before the catch-all for readability
         only; react-router RANKS matches, so `*` loses to a concrete path
         wherever it sits. */
      ...LEGACY_REDIRECTS.map(({ from, to }) => ({
        path: from.slice(1),
        element: <Navigate to={to} replace />,
      })),
      { path: 'runs/:runId', element: <LegacyRunRedirect /> },

      /* Catch-all. A genuinely unknown path renders Home rather than a dead
         end — and `replace` so the bad URL does not sit in history waiting for
         Back. */
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];
