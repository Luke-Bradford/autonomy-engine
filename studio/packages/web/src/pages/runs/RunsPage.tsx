import { useEffect, useMemo, useRef, useState } from 'react';
import { Tab, TabList } from '@fluentui/react-components';
import { RunStatusSchema, type RunSummary, type TriggerPublic } from '@autonomy-studio/shared';
import { useStore } from 'zustand';
import { Link, useSearchParams } from 'react-router';
import { listRuns } from '../../api/runs';
import { costCell } from './costColumn';
import { listTriggers } from '../../api/triggers';
import { pipelinesStore, type PipelinesStore } from '../../stores/pipelinesStore';
import { formatRunDuration, formatWhen } from './format';
import { runDetailPath } from './runPath';
import { runStatusLabel } from './runStatus';
import {
  hasActiveRunFilters,
  readRunFilters,
  RUN_FILTER_PARAMS,
  RUN_SINCE_LABEL,
  RUN_SINCE_OPTIONS,
} from './runFilters';
import {
  filterRunsByTab,
  isRunTab,
  RUN_TAB_HINT,
  RUN_TAB_LABEL,
  RUN_TABS,
  type RunTab,
} from './runOrigin';

/**
 * One Cost cell. A component rather than an inline expression so the decision
 * (`costCell`) stays a pure function this file merely renders — and so the
 * unsettled qualifier has somewhere to be marked up rather than concatenated into
 * a string, which is what lets it read as secondary while staying VISIBLE text
 * rather than a hover.
 */
function RunCostCell({ run }: { run: RunSummary }) {
  const cell = costCell(run);
  return (
    <td className="run-cost" {...(cell.note === null ? {} : { title: cell.note })}>
      {cell.figure}
      {cell.unsettled ? <span className="run-cost-unsettled"> so far</span> : null}
    </td>
  );
}

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
 *
 * U26 — and above that strip, the SERVER-side filter pane: status, pipeline,
 * trigger and a relative time window, each an optional query param on
 * `GET /api/runs`. Two filters with two authorities is forced rather than
 * chosen, and `runFilters.ts` records why (the origin axis needs an `isNull`
 * predicate the repo layer has no arm for) along with what follows from it —
 * the tab counts describe the server-filtered set.
 */
export function RunsPage({ store = pipelinesStore }: { store?: PipelinesStore } = {}) {
  /**
   * The last answer, STAMPED with the filter it answers. `loadedAt` rides along
   * for the same reason it always did: the clock the Duration column measures an
   * UNFINISHED run against, captured once when the load resolves rather than
   * read per render, so every row's "so far" is as-of the same instant and
   * rendering stays pure.
   *
   * Stamped rather than cleared, and that is U26's doing. The rows on screen
   * were fetched under the PREVIOUS filter, so a filter change must not leave
   * them sitting under the new controls — briefly, but long enough to be read as
   * the answer. Clearing them in the load effect would be a synchronous
   * `setState` inside an effect (a cascading render, and the lint rule that
   * names it is right); DERIVING staleness costs no render at all. A `Refresh`
   * of the SAME filter deliberately does not go through this — the key is
   * unchanged, so the current rows stay up until their replacements land.
   */
  const [loaded, setLoaded] = useState<{
    key: string;
    rows: RunSummary[];
    at: number;
  } | null>(null);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
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

  /**
   * U26 — the server-side axes, read from the URL under the same rules `?tab=`
   * follows: the URL is the only authority, a default is the param's ABSENCE,
   * and anything unrecognised falls back to unfiltered rather than erroring.
   */
  const filters = useMemo(() => readRunFilters(searchParams), [searchParams]);
  const { status: statusFilter, pipelineId, triggerId, since } = filters;
  const filtered = hasActiveRunFilters(filters);

  function setFilter(param: string, next: string) {
    const params = new URLSearchParams(searchParams);
    if (next === '') params.delete(param);
    else params.set(param, next);
    setSearchParams(params);
  }

  function clearFilters() {
    const params = new URLSearchParams(searchParams);
    for (const param of Object.values(RUN_FILTER_PARAMS)) params.delete(param);
    setSearchParams(params);
  }

  /**
   * The identity of the QUESTION currently being asked. An answer stamped with a
   * different key belongs to a filter that is no longer on screen, so it reads
   * as "still loading" rather than as this filter's result.
   *
   * `reloadKey` is deliberately NOT part of it — a Refresh asks the same
   * question again, and blanking the list to re-answer it identically would be a
   * flash for nothing.
   */
  const filterKey = `${statusFilter ?? ''}|${pipelineId ?? ''}|${triggerId ?? ''}|${since ?? ''}`;
  const runs = loaded?.key === filterKey ? loaded.rows : null;
  const loadedAt = loaded?.key === filterKey ? loaded.at : 0;
  const error = failed?.key === filterKey ? failed.message : null;

  /**
   * Monotonic id of the most recently STARTED load — `pipelinesStore`'s
   * `latestLoad` guard, for the same reason it has one. `filterKey` settles which
   * QUESTION an answer belongs to, but two loads can share a key (a Refresh, or
   * a double-Refresh) and abort does not fully cover them: a request whose
   * response has already arrived can still resolve its `.then` after the
   * controller aborts, so the older answer would win on completion order.
   * A superseded load drops its result, success AND failure alike — a late
   * rejection from an abandoned request must not bury the fresher answer that
   * replaced it under an error banner.
   */
  const latestLoad = useRef(0);

  // Deps are PRIMITIVES, never the `filters` object: a fresh object literal every
  // render would make this effect re-run forever.
  useEffect(() => {
    const controller = new AbortController();
    const load = (latestLoad.current += 1);
    listRuns({ status: statusFilter, pipelineId, triggerId, since }, controller.signal)
      .then((rows) => {
        if (load !== latestLoad.current) return;
        setLoaded({ key: filterKey, rows, at: Date.now() });
        setFailed(null);
      })
      .catch((err: unknown) => {
        if (load !== latestLoad.current || controller.signal.aborted) return;
        setFailed({ key: filterKey, message: err instanceof Error ? err.message : String(err) });
      });
    return () => controller.abort();
  }, [reloadKey, filterKey, statusFilter, pipelineId, triggerId, since]);

  /**
   * The pipeline picker's options come from the shared `pipelinesStore`, not a
   * local fetch: it keeps the last good list through a failed refresh, so a
   * picker that cannot reload can never blank out and silently drop the filter
   * the operator is currently looking at.
   */
  const pipelines = useStore(store, (s) => s.pipelines);
  const ensureFresh = useStore(store, (s) => s.ensureFresh);
  useEffect(() => {
    ensureFresh();
  }, [ensureFresh]);

  // Triggers have no store (nothing else needs one yet), so this is the plain
  // fetch — failing SILENTLY on purpose: the picker degrades to "All triggers"
  // plus whatever the URL already selects, and a filter list that cannot load is
  // not worth an error banner over the runs the operator came here to read.
  const [triggers, setTriggers] = useState<TriggerPublic[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    listTriggers(controller.signal)
      .then(setTriggers)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

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

      {/* U26 — OUTSIDE the "are there rows" guard below, and that placement is
          the point: under a filter an empty result is the ordinary case, so a
          pane that renders only when rows exist would vanish exactly when the
          operator needs it to undo the filter that emptied the list. */}
      <div className="run-filters" role="group" aria-label="Filter runs">
        <label>
          Status
          <select
            value={statusFilter ?? ''}
            onChange={(e) => setFilter(RUN_FILTER_PARAMS.status, e.target.value)}
          >
            <option value="">All statuses</option>
            {RunStatusSchema.options.map((s) => (
              <option key={s} value={s}>
                {runStatusLabel(s)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Pipeline
          <select
            value={pipelineId ?? ''}
            onChange={(e) => setFilter(RUN_FILTER_PARAMS.pipelineId, e.target.value)}
          >
            <option value="">All pipelines</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {/* The orphan guard. A `<select>` whose value matches no option
                renders the FIRST one — so a link to a deleted pipeline (or a
                render before the list has loaded) would say "All pipelines"
                while the list stayed filtered: the control lying about what is
                applied. A disabled option makes the mismatch visible instead. */}
            {pipelineId !== undefined && !pipelines.some((p) => p.id === pipelineId) && (
              <option value={pipelineId} disabled>
                {pipelineId} (unavailable)
              </option>
            )}
          </select>
        </label>

        <label>
          Trigger
          <select
            value={triggerId ?? ''}
            onChange={(e) => setFilter(RUN_FILTER_PARAMS.triggerId, e.target.value)}
          >
            <option value="">All triggers</option>
            {triggers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            {triggerId !== undefined && !triggers.some((t) => t.id === triggerId) && (
              <option value={triggerId} disabled>
                {triggerId} (unavailable)
              </option>
            )}
          </select>
        </label>

        <label>
          Started
          <select
            value={since ?? ''}
            onChange={(e) => setFilter(RUN_FILTER_PARAMS.since, e.target.value)}
          >
            <option value="">Any time</option>
            {RUN_SINCE_OPTIONS.map((w) => (
              <option key={w} value={w}>
                {RUN_SINCE_LABEL[w]}
              </option>
            ))}
          </select>
        </label>

        {filtered && (
          <button type="button" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {runs === null && !error && <p>Loading runs…</p>}

      {/* Three distinct empty states, because they call for three different
          things. "You have none" sends the operator to the Triggers page;
          "none MATCH" sends them to the Clear control right above, and saying
          the first when the second is true is simply false. */}
      {runs !== null && runs.length === 0 && !filtered && (
        <p>No runs yet. Fire a trigger on the Triggers page to start one.</p>
      )}
      {runs !== null && runs.length === 0 && filtered && (
        <p>No runs match these filters. Widen them, or clear them, to see more.</p>
      )}

      {runs !== null && (runs.length > 0 || filtered) && (
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
              /* Only when the SERVER returned rows and this tab holds none of
                 them — otherwise the "no runs match these filters" line above
                 has already said it, and saying it twice in different words
                 reads as two separate findings. */
              runs.length > 0 && (
                <p>
                  No {RUN_TAB_LABEL[tab].toLowerCase()} runs
                  {filtered ? ' match these filters' : ''}.
                </p>
              )
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
                    <th scope="col">Cost</th>
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
                      {/* U27 slice 2 — the same headline authority the run detail
                          page uses, so the two surfaces cannot say different things
                          about one run's money. `costCell` owns which caveats
                          survive the compression into one cell, and why. */}
                      <RunCostCell run={r} />
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
