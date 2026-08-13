import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tab, TabList, ToggleButton } from '@fluentui/react-components';
import {
  RunStatusSchema,
  type PipelineCostRollup,
  type RunSummary,
  type TriggerPublic,
} from '@autonomy-studio/shared';
import { useStore } from 'zustand';
import { Link, useSearchParams } from 'react-router';
import { listRuns } from '../../api/runs';
import { usePagedList } from '../../hooks/usePagedList';
import { getPipelineCost } from '../../api/pipelines';
import { ApiError, messageOf } from '../../api/client';
import { costCell } from './costColumn';
import { pipelineCostSummary, type PipelineCostSummary } from './pipelineCostSummary';
import { listTriggers } from '../../api/triggers';
import { pipelinesStore, type PipelinesStore } from '../../stores/pipelinesStore';
import { formatRunDuration, formatWhen } from './format';
import { runDetailPath } from './runPath';
import { runStatusLabel } from './runStatus';
import { RunTimeline } from './RunTimeline';
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
 * U29 (#1015) — which rendering of the SAME filtered rows is on screen. A view,
 * not a filter: it changes nothing about which runs are in scope, which is why
 * it lives beside the tab rather than inside `runFilters.ts`.
 */
type RunView = 'list' | 'timeline';

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
 * #931 (U27 slice 2) — the filtered pipeline's lifetime spend, above the rows.
 *
 * The tile strip is `AiActivityPage`'s (`.monitor-tiles`), not a second one: that
 * page already pairs `costFigure`/`tokenSummary` from a bounded SQL aggregate in
 * exactly this markup, and a per-page summary that looked different would imply a
 * different kind of number.
 *
 * The caveats sit in ONE paragraph rather than a stack of notices because they
 * qualify one figure, and because `FlowCanvas` records that this app already runs
 * as many live regions as it should — this is static text, announced by nothing.
 * Scope comes FIRST: it is the sentence that stops the figure being read as the
 * total of the rows underneath it.
 */
function PipelineSpend({ summary }: { summary: PipelineCostSummary }) {
  return (
    <section className="lifetime-spend" aria-labelledby="lifetime-spend-heading">
      <h3 id="lifetime-spend-heading">Lifetime spend</h3>
      {/* No tiles for a pipeline that has never run: every figure would be a
          reading of a measurement nobody took, which is what `figure: null` says. */}
      {summary.figure !== null && (
        <dl className="monitor-tiles">
          <div>
            <dt>Spend</dt>
            <dd className="run-cost">{summary.figure}</dd>
          </div>
          {summary.tokens !== null && (
            <div>
              <dt>Tokens</dt>
              <dd>{summary.tokens}</dd>
            </div>
          )}
        </dl>
      )}
      <p className="page-hint">
        {summary.scope} {summary.reading}
        {summary.incomplete === null ? null : ` ${summary.incomplete}`}
        {summary.excludes === null ? null : ` ${summary.excludes}`}
      </p>
    </section>
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
 * from (`runOrigin.ts`), client-side over the rows fetched so far.
 *
 * U26 — and above that strip, the SERVER-side filter pane: status, pipeline,
 * trigger and a relative time window, each an optional query param on
 * `GET /api/runs`. Two filters with two authorities is forced rather than
 * chosen, and `runFilters.ts` records why (the origin axis needs an `isNull`
 * predicate the repo layer has no arm for).
 *
 * PAGED SINCE #1083, and that changed what the ORIGIN STRIP can honestly say.
 * The page used to fetch every run the filters matched, so a tab count was a
 * census: `Child 0` meant the workspace held none. Now it counts the rows
 * LOADED, and an unqualified `0` beside "No child runs" would assert something
 * a Load more can immediately falsify. So while older pages remain, a count
 * renders open-ended (`12+`) and the empty-tab line says "in the runs loaded so
 * far". Once the walk is exhausted both revert to the plain, complete claim —
 * which is the ordinary case, since the first page holds `RUNS_PAGE_SIZE` runs.
 *
 * The alternative — moving the origin axis server-side and counting in SQL — is
 * a bigger change than it looks (`runOriginOf` is expressible as a CASE, but
 * honest per-tab totals need their own grouped query and a place in the response
 * envelope) and is deliberately NOT bundled here. What is fixed here is that the
 * strip stops making claims it cannot support.
 */
export function RunsPage({ store = pipelinesStore }: { store?: PipelinesStore } = {}) {
  /**
   * Bumped by "Refresh" so BOTH panels re-fetch from one button. Since #1083
   * the run list itself is refreshed through `usePagedList` rather than by this
   * key (a paged list has its own notion of "re-read the first page and drop the
   * tail"), so this now drives the #931 cost panel alone — kept, because one
   * button that freshens half the screen is worse than no button.
   */
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
  /**
   * U29 (#1015) — List or Timeline, under exactly the rules `?tab=` follows: the
   * URL is the only authority, the default is the param's ABSENCE, and anything
   * unrecognised falls back to the default rather than erroring. That makes a
   * timeline link shareable and Back a working undo.
   *
   * It costs nothing to keep across the other URL writers: `selectTab`,
   * `setFilter` and `clearFilters` all COPY `searchParams` and `clearFilters`
   * deletes only `RUN_FILTER_PARAMS`, so switching a filter keeps the view.
   */
  const view: RunView = searchParams.get('view') === 'timeline' ? 'timeline' : 'list';

  function selectView(next: RunView) {
    const params = new URLSearchParams(searchParams);
    if (next === 'list') params.delete('view');
    else params.set('view', next);
    setSearchParams(params);
  }

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
   * #1083 — the `filterKey` stamping this replaced is gone. It existed because
   * the page owned the rows and had to decide whether an arriving answer still
   * belonged to the filter on screen; `usePagedList` now owns them and keys that
   * decision on the FETCHER's identity, which changes with exactly these four
   * axes. One authority instead of a key and a fetcher that could disagree.
   */

  /**
   * #1083 — ONE page of runs, extended on demand, instead of every run the
   * filters matched. The fetcher is memoized on the filter PRIMITIVES (never the
   * `filters` object, which is a fresh literal every render), and that identity
   * is load-bearing twice over: it is the dependency of the hook's first-page
   * effect, and it is what tells `usePagedList` the list has CHANGED rather than
   * merely needing a refresh — so a filter change blanks the rows and drops the
   * cursor, where a Refresh keeps the rows on screen. The hand-rolled
   * `latestLoad` counter this replaced is gone with it; `useGuardedLoad`, which
   * the hook wraps, is that counter with its rules written down and tested.
   */
  const fetchPage = useCallback(
    (cursor: string | undefined, signal: AbortSignal) =>
      listRuns({ status: statusFilter, pipelineId, triggerId, since }, cursor, signal),
    [statusFilter, pipelineId, triggerId, since],
  );
  const {
    items: runs,
    error: pageError,
    loading,
    busy,
    hasMore,
    lastUpdatedAt,
    loadMore,
    refresh,
  } = usePagedList(fetchPage);
  /* The clock an UNFINISHED row's duration is measured against — captured when
     the first page was requested rather than read per render, so every row's "so
     far" is as-of the same instant and rendering stays pure. `0` before the
     first answer, which `formatRunDuration` already handles. */
  const loadedAt = lastUpdatedAt ?? 0;

  /**
   * #931 (U27 slice 2) — the filtered pipeline's LIFETIME spend, stamped with the
   * pipeline it answers for exactly the reason the rows above are stamped: an
   * answer for the previous pipeline must not sit under the new one's controls.
   *
   * Its own latest-wins ref, deliberately not the run list's. A counter is
   * monotonic across every load it guards, so sharing one would make each of the
   * two fetches discard the other's result — whichever started second would win
   * twice. (The run list's own counter now lives inside `usePagedList`, which is
   * the same rule expressed once: one counter per state target.)
   *
   * A 404 renders NOTHING. `listRuns` answers an unowned or deleted pipeline id
   * with an empty list by design (`runFilters.ts`), and the picker already shows
   * it as "(unavailable)", so shouting here would make the same URL both handled
   * and broken. Any OTHER failure gets a quiet hint rather than a second
   * `role="alert"` beside the list's own — same call, and same reason, as the
   * trigger picker's silent degrade below.
   */
  const [loadedCost, setLoadedCost] = useState<{ key: string; rollup: PipelineCostRollup } | null>(
    null,
  );
  const [costFailed, setCostFailed] = useState<{ key: string; message: string } | null>(null);
  const latestCostLoad = useRef(0);
  useEffect(() => {
    if (pipelineId === undefined) return;
    const controller = new AbortController();
    const load = (latestCostLoad.current += 1);
    getPipelineCost(pipelineId, controller.signal)
      .then((rollup) => {
        if (load !== latestCostLoad.current) return;
        setLoadedCost({ key: pipelineId, rollup });
        setCostFailed(null);
      })
      .catch((err: unknown) => {
        if (load !== latestCostLoad.current || controller.signal.aborted) return;
        setCostFailed(
          err instanceof ApiError && err.status === 404
            ? null
            : { key: pipelineId, message: `Lifetime spend unavailable: ${messageOf(err)}` },
        );
      });
    return () => controller.abort();
    // `reloadKey` is in the deps so Refresh re-fetches BOTH panels — one button
    // that freshens half the screen is worse than no button.
  }, [reloadKey, pipelineId]);
  const costSummary =
    pipelineId !== undefined && loadedCost?.key === pipelineId
      ? pipelineCostSummary(loadedCost.rollup)
      : null;
  const costError =
    pipelineId !== undefined && costFailed?.key === pipelineId ? costFailed.message : null;

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
        {/* A `role="group"` of toggles rather than a second Fluent `TabList`:
            the panel below is already labelled by the ORIGIN tab, and two
            `role="tab"` sets over one panel is a claim about the markup that
            is not true. */}
        <div role="group" aria-label="Runs view" className="run-view-toggle">
          <ToggleButton size="small" checked={view === 'list'} onClick={() => selectView('list')}>
            List
          </ToggleButton>
          <ToggleButton
            size="small"
            checked={view === 'timeline'}
            onClick={() => selectView('timeline')}
          >
            Timeline
          </ToggleButton>
        </div>
        {/* Drives BOTH panels: the paged run list re-reads its first page (and
            drops any accumulated tail — a refreshed head glued to a stale tail
            would skip whatever was appended in between), and the key bump
            re-fetches the lifetime-spend panel. Disabled while any run-list
            request is in flight, since `usePagedList` is latest-wins rather than
            drop-the-new, so a second click would abort and re-issue a request
            already on its way. */}
        <button
          type="button"
          onClick={() => {
            refresh();
            setReloadKey((k) => k + 1);
          }}
          disabled={busy}
        >
          Refresh
        </button>
      </div>

      <p className="page-hint">
        Every fire of a trigger (or a scheduled window) creates a run. Open one to watch it unfold
        live — its nodes and events stream in as the engine executes.
      </p>

      {/* Worded apart because they are different news: a failed FIRST page
          means there are no runs on screen, while a failed older page means the
          runs on screen are real and merely stop short of where the reader
          asked. */}
      {pageError !== null && (
        <p role="alert" className="error">
          {pageError.scope === 'more'
            ? `Could not load older runs: ${pageError.message}`
            : pageError.message}
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

      {/* OUTSIDE the rows guard and outside the list/timeline switch below, for
          the same reason the filter pane is: this figure is all-time, so the two
          places it would otherwise vanish — a filter that matches no rows, and
          the timeline view — are precisely where it is the only spend on screen. */}
      {costSummary && <PipelineSpend summary={costSummary} />}
      {costError && <p className="page-hint">{costError}</p>}

      {loading && pageError === null && <p>Loading runs…</p>}

      {/* Three distinct empty states, because they call for three different
          things. "You have none" sends the operator to the Triggers page;
          "none MATCH" sends them to the Clear control right above, and saying
          the first when the second is true is simply false. */}
      {runs !== null && runs.length === 0 && pageError === null && !filtered && (
        <p>No runs yet. Fire a trigger on the Triggers page to start one.</p>
      )}
      {runs !== null && runs.length === 0 && pageError === null && filtered && (
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
                {RUN_TAB_LABEL[key]}{' '}
                {/* #1083 — OPEN-ENDED while older pages remain. This counts the
                    runs loaded, not the runs that exist, and a bare `0` next to
                    "No child runs" would state as fact something the very next
                    click can falsify. `12+` is the honest form of a lower
                    bound; once the walk is exhausted it is a complete count
                    again and the marker goes. */}
                <span className="run-tab-count">
                  {counts[key]}
                  {hasMore ? '+' : ''}
                </span>
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
                  {filtered ? ' match these filters' : ''}
                  {/* Scoped to what has been LOADED while older pages remain —
                      the unqualified sentence claims the workspace holds none,
                      which is only true once the walk has ended. */}
                  {hasMore ? ' in the runs loaded so far' : ''}.
                </p>
              )
            ) : view === 'timeline' ? (
              /* One panel, one rendering — the timeline REPLACES the table
                 rather than sitting above it. Showing both would put every run
                 id and pipeline name on screen twice, which is the ambiguity
                 `AttemptTimeline` records for its own untimed list, and would
                 make the table's existing row queries match two things. */
              <RunTimeline runs={visible} />
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

      {/* Rendered only when the server said there IS an older page. An
          always-present button that sometimes did nothing would make the end of
          the history indistinguishable from a list that had stopped loading —
          and where the history ends is exactly what a reader is checking.
          OUTSIDE the "are there rows" guard above, because a tab holding none of
          the loaded rows is precisely when the reader needs to reach further
          back rather than being told there is nothing there. */}
      {hasMore && (
        <button type="button" onClick={loadMore} disabled={busy}>
          Load older runs
        </button>
      )}
    </section>
  );
}
