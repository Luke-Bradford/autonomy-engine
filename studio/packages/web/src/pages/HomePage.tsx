import { Link } from 'react-router';
import type { Paginated, RunSummary } from '@autonomy-studio/shared';
import { HUBS } from '../shell/hubs';
import { listRuns } from '../api/runs';
import { usePagedList } from '../hooks/usePagedList';
import { runStatusLabel } from './runs/runStatus';
import { runDetailPath } from './runs/runPath';
import { formatWhen } from './runs/format';

/**
 * How many recent runs Home shows.
 *
 * Reaches the WIRE as `limit` rather than slicing a full page client-side —
 * `listRuns`'s docblock owns that argument. Exported so the tests and the e2e
 * spec assert against the real value instead of re-literalling it.
 */
export const HOME_RECENT_RUNS = 5;

/**
 * Module-level, NOT an inline arrow. `usePagedList` treats fetcher identity as
 * "this is a different list" and resets on it (`usePagedList.ts:80-100`), so a
 * fetcher rebuilt every render would blank the list every render. Home has no
 * filter axes, so there is nothing to memoize on — one constant fetcher is the
 * honest expression of "this list never varies".
 */
const fetchRecentRuns = (
  cursor: string | undefined,
  signal: AbortSignal,
): Promise<Paginated<RunSummary>> => listRuns({}, cursor, signal, HOME_RECENT_RUNS);

/**
 * The Home hub's landing page (U15 slice 1, #1085).
 *
 * `/` is both the app's entry point and the router's CATCH-ALL, so this is the
 * first thing a new operator and a stale bookmark both land on. It used to
 * signpost the hubs and say nothing whatever about the workspace.
 *
 * What it shows is a PREFIX, not a census: the newest few runs, with no counts
 * and no totals anywhere on the page. The distinction is one this repo has
 * already paid for — `RunsPage`'s origin tabs render `12+` rather than a count
 * over the rows that happen to be loaded, because a derived display must say
 * something about the DATA, not about what the client fetched. Home fetches
 * exactly one page and never walks: there is deliberately no "load more" here,
 * and `hasMore` is ignored rather than surfaced.
 *
 * Settings (`#/settings`, theme + master-key status) is U15 slice 2 and is not
 * built here.
 */
export function HomePage() {
  const hubs = HUBS.filter((hub) => hub.id !== 'home');
  const { items: runs, error, loading } = usePagedList(fetchRecentRuns);

  return (
    <>
      <div className="page-header">
        <h2>Home</h2>
      </div>
      <p className="page-hint">
        Author pipelines, watch them run, and manage the connections and triggers that drive them.
      </p>

      <section aria-labelledby="home-recent-runs" className="home-section">
        {/* An `h3` under the page's one `h2`. A second `h2` would make
            `getByRole('heading', {name: 'Home'})` ambiguous, which both
            `App.test.tsx` and `e2e/hub-nav.spec.ts` assert on. */}
        <h3 id="home-recent-runs">Recent runs</h3>

        {error !== null && (
          <p role="alert" className="error">
            {error.message}
          </p>
        )}

        {/* `items === null` means "the first page has not answered yet" and is
            NOT the same fact as "this workspace has no runs". Rendering the
            empty line while pending would manufacture an absent fact as a
            benign default — the shape of #473, and the reason `usePagedList`
            draws the null/`[]` distinction at all. */}
        {loading && error === null && <p>Loading runs…</p>}

        {runs !== null && runs.length === 0 && error === null && (
          <p>No runs yet. Fire a trigger on the Triggers page to start one.</p>
        )}

        {runs !== null && runs.length > 0 && (
          <ul className="recent-runs">
            {runs.map((r) => (
              <li key={r.id}>
                <Link to={runDetailPath(r.id)}>
                  {/* The WORD comes from the Monitor's one run-status
                      vocabulary (#870); the CLASS comes from the status. */}
                  <span className={`run-status run-status-${r.status}`}>
                    {runStatusLabel(r.status)}
                  </span>
                  <span className="recent-runs-pipeline">
                    {r.pipelineName} v{r.pipelineVersion}
                  </span>
                  {/* Absolute, exactly as the run list renders it. NOT a
                      relative "3m ago": a queued run's `startedAt` is an
                      enqueue placeholder that admission re-stamps, so a
                      relative string would print queue age as a start time. */}
                  <span className="recent-runs-when">{formatWhen(r.startedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="home-hubs" className="home-section">
        <h3 id="home-hubs">Go to</h3>
        <ul className="hub-cards">
          {hubs.map((hub) => (
            <li key={hub.id}>
              <Link to={hub.path}>{hub.label}</Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
