import { useEffect, useMemo, useState } from 'react';
import { Tab, TabList } from '@fluentui/react-components';
import type { RunSummary } from '@autonomy-studio/shared';
import { Link, useSearchParams } from 'react-router';
import { listRuns } from '../../api/runs';
import { formatRunDuration, formatWhen } from './format';
import { runDetailPath } from './runPath';
import { runStatusLabel } from './runStatus';
import {
  filterRunsByTab,
  isRunTab,
  RUN_TAB_HINT,
  RUN_TAB_LABEL,
  RUN_TABS,
  type RunTab,
} from './runOrigin';

/**
 * The Runs list — the entry to the P6 live monitor. Runs are created by the
 * engine/scheduler (fire a trigger, or a scheduled window), never here, so this
 * page is read-only: it lists what has run and links each to its live detail
 * view. A run that is still executing is watched live on the detail page (the
 * WebSocket tail); this list itself is a point-in-time snapshot, refreshed on
 * demand.
 *
 * R2 + U10 — each row is a `RunSummary`, so the identity column reads the
 * PIPELINE'S NAME rather than the opaque `pv_…` version id it used to render,
 * and the trigger reads its name. The tab strip filters by where a run came
 * from (`runOrigin.ts`), client-side over the single fetched list, which is
 * exactly the "client-side small-data v1" U10 specifies.
 */
export function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The clock the Duration column measures an UNFINISHED run against, captured
   * once when a load resolves rather than read per render. The page is a
   * snapshot refreshed on demand (there is no ticking here by design), so every
   * row's "so far" is as-of the same instant — and rendering stays pure, which
   * a bare `Date.now()` in the row map would not be.
   */
  const [loadedAt, setLoadedAt] = useState(0);
  // Bumped by "Refresh" to re-run the load effect (re-fetch on demand). The
  // effect owns the fetch so its AbortController cleanly cancels an in-flight
  // request on unmount or a re-refresh.
  const [reloadKey, setReloadKey] = useState(0);

  /**
   * U10 — the selected tab lives in the URL, which the Shell section names as a
   * slot this ticket owns ("monitor filter tab (U10)"). Component state would
   * make the filtered view unlinkable, lost on reload, and invisible to Back.
   * The URL is the single authority here — there is no `useState` mirror of it
   * to disagree with, which is the same reason `SecondaryPane` refused a
   * component that wanted its own `selectedValue`.
   *
   * An unrecognised `?tab=` is not an error to shout about: it falls back to
   * `all`, so a hand-edited or stale link still shows the operator their runs.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tab: RunTab = isRunTab(rawTab) ? rawTab : 'all';

  function selectTab(next: RunTab) {
    const params = new URLSearchParams(searchParams);
    // `all` is the default view, so it is expressed by the ABSENCE of the param
    // rather than by `?tab=all` — one canonical URL per view.
    if (next === 'all') params.delete('tab');
    else params.set('tab', next);
    // A push, not a replace: Back undoing a filter change is the behaviour a
    // URL-addressable tab is for.
    setSearchParams(params);
  }

  useEffect(() => {
    const controller = new AbortController();
    listRuns(controller.signal)
      .then((rows) => {
        setRuns(rows);
        setLoadedAt(Date.now());
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [reloadKey]);

  // Both derived by the SAME predicate, so a tab can never advertise a number
  // of rows it then declines to show — but keyed separately, because the counts
  // describe every tab and so do not change when the selected one does.
  const counts = useMemo(
    () =>
      Object.fromEntries(
        RUN_TABS.map((key) => [key, filterRunsByTab(runs ?? [], key).length]),
      ) as Record<RunTab, number>,
    [runs],
  );
  const visible = useMemo(() => filterRunsByTab(runs ?? [], tab), [runs, tab]);

  return (
    <section aria-labelledby="runs-heading">
      <div className="page-header">
        <h2 id="runs-heading">Runs</h2>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)}>
          Refresh
        </button>
      </div>

      <p className="page-hint">
        Every fire of a trigger (or a scheduled window) creates a run. Open one to watch it unfold
        live — its nodes and events stream in as the engine executes.
      </p>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {runs === null && !error && <p>Loading runs…</p>}

      {runs !== null && runs.length === 0 && (
        <p>No runs yet. Fire a trigger on the Triggers page to start one.</p>
      )}

      {runs !== null && runs.length > 0 && (
        <>
          {/* Fluent's own TabList, not a hand-rolled strip: it brings the roving
              tabindex and arrow-key movement the `tab` role advertises, which a
              row of plain buttons claims and does not implement. */}
          <TabList
            selectedValue={tab}
            // Fluent types `data.value` as `unknown`, so it is narrowed by the
            // same guard the URL param uses rather than asserted to be a tab.
            onTabSelect={(_, data) => {
              if (isRunTab(data.value)) selectTab(data.value);
            }}
            aria-label="Filter runs by origin"
          >
            {RUN_TABS.map((key) => (
              <Tab key={key} value={key} id={`run-tab-${key}`} title={RUN_TAB_HINT[key]}>
                {RUN_TAB_LABEL[key]} <span className="run-tab-count">{counts[key]}</span>
              </Tab>
            ))}
          </TabList>

          <div role="tabpanel" aria-labelledby={`run-tab-${tab}`}>
            {visible.length === 0 ? (
              <p>No {RUN_TAB_LABEL[tab].toLowerCase()} runs.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Pipeline</th>
                    <th scope="col">Trigger</th>
                    <th scope="col">Status</th>
                    <th scope="col">Started</th>
                    <th scope="col">Duration</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <code>{r.id}</code>
                      </td>
                      <td>
                        {/* R2 — the pipeline's NAME, which is the only thing here
                            an operator recognises. The version id it replaced is
                            not lost: it stays reachable as the cell's title, for
                            the rare case someone needs the opaque key. */}
                        <span title={r.pipelineVersionId}>
                          {r.pipelineName} <span className="run-version">v{r.pipelineVersion}</span>
                        </span>
                      </td>
                      {/* `null` for a rerun, or a run whose trigger was deleted —
                          an em-dash, never a manufactured name. */}
                      <td>{r.triggerName ?? '—'}</td>
                      <td>
                        {/* #870 — the WORD comes from the Monitor's one run-status
                            vocabulary; the CLASS still comes from the status itself,
                            so the pill's hue and its label cannot drift apart (and
                            `palette.test.ts` keeps a rule for every member). No park
                            reason is passed: this list reads the DB row, which has no
                            such column — `runStatusLabel` owns that argument. */}
                        <span className={`run-status run-status-${r.status}`}>
                          {runStatusLabel(r.status)}
                        </span>
                      </td>
                      <td>{formatWhen(r.startedAt)}</td>
                      {/* Duration replaced the Finished column (U10 fixes the column
                          set). The finish TIMESTAMP is not lost with it — it is the
                          cell's title, the same demotion the pipeline cell applies to
                          the version id. */}
                      <td title={formatWhen(r.finishedAt)}>{formatRunDuration(r, loadedAt)}</td>
                      <td>
                        {/* A real link, not `useNavigate()` on a button: the Shell
                            section records that U10 owns this conversion. It gives
                            the row action a hoverable/copyable/middle-clickable
                            target, which a button never had. */}
                        <Link to={runDetailPath(r.id)} aria-label={`Watch run ${r.id}`}>
                          Watch
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </section>
  );
}
