import { Navigate, useParams } from 'react-router';
import { RunDetailPage } from './RunDetailPage';

/**
 * Reads `:runId` out of the URL and hands it to the page as a prop.
 *
 * Two things here are load-bearing and easy to lose:
 *
 * 1. `key={runId}` — `RunDetailPage` holds per-run state (its event stream and
 *    fetch), and React Router REUSES a route's component instance when only a
 *    param changes. Without the key, navigating run→run would keep the previous
 *    run's state mounted under a new id. The pre-router shell had this same key
 *    for the same reason.
 * 2. NO `decodeURIComponent` — `useParams` returns params already decoded. The
 *    pre-router shell decoded manually because it sliced the raw hash itself;
 *    carrying that call over would double-decode. `routes.test.tsx` pins this
 *    with an id that is not idempotent under a second decode.
 *
 * The page keeps taking `runId` as a PROP rather than reading the param itself,
 * so it stays renderable in isolation by its own unit tests.
 */
export function RunDetailRoute() {
  const { runId } = useParams();
  // The route only matches with a non-empty `:runId`, so this is defensive.
  if (!runId) return <Navigate to="/monitor/runs" replace />;
  return <RunDetailPage key={runId} runId={runId} />;
}
