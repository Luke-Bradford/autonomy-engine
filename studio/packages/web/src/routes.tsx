import { Navigate, type RouteObject } from 'react-router';
import { AppShell } from './shell/AppShell';
import { sectionLabel } from './shell/hubs';
import type { ShellRouteHandle } from './shell/routeHandle';
import { HomePage } from './pages/HomePage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { PipelinesPage } from './pages/PipelinesPage';
// #698 — loaded on demand (React Flow is reachable only from this route); the
// `<Suspense>` boundary is in `AppShell`, inside `<main>`.
import { PipelineCanvasRoute } from './pages/author/PipelineCanvasRoute.lazy';
import { TriggersPage } from './pages/TriggersPage';
import { WorkspaceGitPage } from './pages/WorkspaceGitPage';
import { RunsPage } from './pages/runs/RunsPage';
import { AiActivityPage } from './pages/monitor/AiActivityPage';
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
 * U3 — the shell chrome's metadata, carried on the routes themselves.
 *
 * `handle` is react-router's extension point, and `useMatches()` reads it back;
 * `AppShell` is the only consumer. Two kinds of entry:
 *
 * - `{ hub }` marks a hub root. It selects the secondary pane's contents and
 *   contributes a breadcrumb whose LABEL comes from `HUBS` — so a renamed hub
 *   changes the rail tooltip, the pane heading and the crumb together.
 * - `{ crumb }` is a leaf's own breadcrumb label, or a function of the params
 *   for a route whose label IS part of the URL.
 *
 * `satisfies` on every declaration, not a bare object literal: react-router
 * types `RouteObject.handle` as `any`, so `{ hub: 'moniter' }` would otherwise
 * compile, render a shell with no pane, and look merely empty.
 *
 * Section crumbs read their label from `HUBS` via `sectionLabel()` rather than
 * repeating the string here: the shell already resolves HUB labels out of that
 * same list, so doing it one level down keeps every hub and section name in
 * exactly one place. `sectionLabel` throws at module-eval time for a path no
 * hub declares, which makes a pane-unreachable section a boot failure.
 */
const HUB_HANDLE = {
  author: { hub: 'author' } satisfies ShellRouteHandle,
  monitor: { hub: 'monitor' } satisfies ShellRouteHandle,
  manage: { hub: 'manage' } satisfies ShellRouteHandle,
  home: { hub: 'home' } satisfies ShellRouteHandle,
};

/**
 * The hash-router route tree (U2).
 *
 * Shape: one layout route (`AppShell`, which draws the shell chrome and hosts
 * the `<Outlet/>`) with a section per hub. Each hub's own path redirects to its
 * default child, so `#/monitor` is a valid, shareable URL rather than a blank
 * hub. `replace` on those redirects keeps the Back button useful — otherwise
 * going back from `/monitor/runs` would land on `/monitor` and immediately
 * bounce forward again, trapping the user.
 *
 * Exported (rather than a router being built here) so tests can mount the exact
 * same tree under `createMemoryRouter` at any initial entry.
 *
 * U4 added `/author/pipelines/:pipelineId`: opening a pipeline on the canvas
 * used to be local state inside `PipelinesPage`, so the canvas had no address
 * to link to, bookmark, or go Back from.
 */
export const ROUTES: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage />, handle: HUB_HANDLE.home },

      {
        path: 'author',
        handle: HUB_HANDLE.author,
        children: [
          { index: true, element: <Navigate to="/author/pipelines" replace /> },
          /* `:pipelineId` is a CHILD of `pipelines`, not its sibling, so the
             breadcrumb reads Author › Pipelines › pl_42 with a linkable middle
             crumb — the same shape (and the same reasoning) as `runs/:runId`.
             `pipelines` itself has no `element`, so react-router renders its
             `<Outlet/>`. */
          {
            path: 'pipelines',
            handle: { crumb: sectionLabel('/author/pipelines') } satisfies ShellRouteHandle,
            children: [
              { index: true, element: <PipelinesPage /> },
              {
                path: ':pipelineId',
                element: <PipelineCanvasRoute />,
                /* The id, not the pipeline's NAME. A name crumb would need the
                   shell to subscribe to a page-domain store (or a route loader)
                   to know it, and to re-render when it arrived — a coupling the
                   shell has deliberately avoided, for a label the canvas's own
                   heading already shows. `:runId` sets the precedent. U9 owns
                   the command bar's per-pipeline region and can carry the name
                   there. `useParams` has already decoded this. */
                handle: {
                  crumb: (params) => params.pipelineId ?? '',
                } satisfies ShellRouteHandle,
              },
            ],
          },
        ],
      },

      {
        path: 'monitor',
        handle: HUB_HANDLE.monitor,
        children: [
          { index: true, element: <Navigate to="/monitor/runs" replace /> },
          /* `:runId` is a CHILD of `runs`, not its sibling, so the breadcrumb
             reads Monitor › Runs › run_42 and the middle crumb has a real
             pathname to link back to. The URLs are byte-identical either way.
             `runs` itself has no `element`, so react-router renders its
             `<Outlet/>` — the same defaulting the hub routes already rely on. */
          {
            path: 'runs',
            handle: { crumb: sectionLabel('/monitor/runs') } satisfies ShellRouteHandle,
            children: [
              { index: true, element: <RunsPage /> },
              {
                path: ':runId',
                element: <RunDetailRoute />,
                /* The label IS the URL segment. `useParams` has already decoded
                   it, so this is the id as the page shows it. */
                handle: {
                  crumb: (params) => params.runId ?? '',
                } satisfies ShellRouteHandle,
              },
            ],
          },
          {
            path: 'ai',
            element: <AiActivityPage />,
            handle: { crumb: sectionLabel('/monitor/ai') } satisfies ShellRouteHandle,
          },
        ],
      },

      {
        path: 'manage',
        handle: HUB_HANDLE.manage,
        children: [
          { index: true, element: <Navigate to="/manage/connections" replace /> },
          {
            path: 'connections',
            element: <ConnectionsPage />,
            handle: { crumb: sectionLabel('/manage/connections') } satisfies ShellRouteHandle,
          },
          {
            path: 'triggers',
            element: <TriggersPage />,
            handle: { crumb: sectionLabel('/manage/triggers') } satisfies ShellRouteHandle,
          },
          {
            path: 'git',
            element: <WorkspaceGitPage />,
            handle: { crumb: sectionLabel('/manage/git') } satisfies ShellRouteHandle,
          },
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
