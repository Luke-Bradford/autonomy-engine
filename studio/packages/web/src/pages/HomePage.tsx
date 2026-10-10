import { Link, useNavigate } from 'react-router';
import type { Paginated, RunSummary } from '@autonomy-studio/shared';
import { HUBS } from '../shell/hubs';
import { listRuns } from '../api/runs';
import { usePagedList } from '../hooks/usePagedList';
import { runStatusLabel } from './runs/runStatus';
import { NO_RUNS_YET } from './runs/runFilters';
import { runDetailPath } from './runs/runPath';
import { versionLabel } from '../lib/versionLabel';
import { DemoPanel } from './DemoPanel';
import { When } from '../lib/When';
import { PageHeader } from '../lib/PageHeader';
import { Section } from '../lib/Section';
import { OneLine } from '../lib/OneLine';
import { FORM_SECTION_HINTS } from '../lib/form/sectionHints';
import { RunStatusPill } from './runs/RunStatusPill';

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
 * already paid for — `RunsPage` once counted its origin tabs over the rows that
 * happened to be loaded, and had to render `12+` to stay honest, because a
 * derived display must say something about the DATA, not about what the client
 * fetched (#1484 moved that filter to the server). Home fetches
 * exactly one page and never walks: there is deliberately no "load more" here,
 * and `hasMore` is ignored rather than surfaced.
 *
 * Settings (`#/settings`, theme + master-key status) is U15 slice 2 and is not
 * built here.
 */
export function HomePage() {
  const hubs = HUBS.filter((hub) => hub.id !== 'home');
  const { items: runs, error, loading } = usePagedList(fetchRecentRuns);
  const navigate = useNavigate();

  return (
    <>
      <PageHeader title="Home" />

      {/* #1594 OR40 S6 — Home's sections are the one `Section`, a named
          region each (the e2e reaches them by name), and the runs are a row
          of the one table style rather than a stack of cards. */}
      <Section level={2} landmark heading="Recent runs" help={FORM_SECTION_HINTS.home.recentRuns}>
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

        {runs !== null && runs.length === 0 && error === null && <p>{NO_RUNS_YET}</p>}

        {runs !== null && runs.length > 0 && (
          <table className="recent-runs" aria-label="Recent runs">
            <thead>
              <tr>
                <th scope="col">Pipeline</th>
                <th scope="col">Status</th>
                <th scope="col">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const version = versionLabel(r.pipelineVersion, r.debug);
                return (
                  <tr key={r.id}>
                    <td>
                      {/* The cell can cut a long name, so the tooltip holds
                          it whole — the Runs grid's pipeline cell does the same. */}
                      <OneLine title={`${r.pipelineName} ${version}`}>
                        <Link to={runDetailPath(r.id)}>
                          {r.pipelineName} <span className="run-version">{version}</span>
                        </Link>
                      </OneLine>
                    </td>
                    <td title={runStatusLabel(r.status)}>
                      <RunStatusPill status={r.status} />
                    </td>
                    {/* Absolute, exactly as the run list renders it. NOT a
                        relative "3m ago": a queued run's `startedAt` is an
                        enqueue placeholder that admission re-stamps, so a
                        relative string would print queue age as a start time. */}
                    <td>
                      <When ms={r.startedAt} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      {/* #1481 OR32 — a workspace that has never run anything is offered the
          demo, and taken to the pipelines it loaded. Load only: Remove lives on
          the pipelines list, not on the landing page. */}
      {runs !== null && runs.length === 0 && error === null && (
        <DemoPanel allowRemove={false} onChanged={() => void navigate('/author/pipelines')} />
      )}

      <Section level={2} landmark heading="Go to" help={FORM_SECTION_HINTS.home.goTo}>
        <ul className="hub-links">
          {hubs.map((hub) => (
            <li key={hub.id}>
              <Link to={hub.path}>{hub.label}</Link>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
