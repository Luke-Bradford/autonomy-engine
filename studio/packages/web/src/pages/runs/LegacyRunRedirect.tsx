import { Navigate, useParams } from 'react-router';

/**
 * U3r — the one legacy MVP path that carries state: `#/runs/:runId` → the run's
 * page under the Monitor hub. Before this existed, the route tree's catch-all
 * swallowed it and sent the user to Home, silently dropping the run id, which
 * is the entire payload of a shared run URL.
 *
 * The id is RE-ENCODED on the way out. `useParams` returns it already decoded
 * (see `RunDetailRoute`), and react-router does not re-encode a string `to`, so
 * interpolating the raw param would ship a half-decoded path that
 * `RunDetailRoute` then decodes a SECOND time. Encoding here matches what
 * `RunsPage`/`TriggersPage` do at the call sites where they build a run path.
 * `routes.test.tsx` pins this with an id that is not idempotent under an extra
 * decode — a plain id would let the bug through.
 *
 * Lives in its own module rather than in `routes.tsx` because a file that
 * exports constants (the route tree, the redirect table) must not also define
 * components: it breaks Fast Refresh, and eslint's `react-refresh` rule says so.
 */
export function LegacyRunRedirect() {
  const { runId } = useParams();
  // The route only matches with a non-empty `:runId`, so this is defensive —
  // the same guard, for the same reason, as `RunDetailRoute`.
  if (!runId) return <Navigate to="/monitor/runs" replace />;
  return <Navigate to={`/monitor/runs/${encodeURIComponent(runId)}`} replace />;
}
