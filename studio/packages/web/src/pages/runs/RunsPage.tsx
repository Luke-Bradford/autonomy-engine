import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Menu,
  MenuItemCheckbox,
  MenuList,
  MenuPopover,
  MenuTrigger,
  ToggleButton,
  Tooltip,
} from '@fluentui/react-components';
import {
  RUN_TRIGGERED_BY_KINDS,
  RUN_SEARCH_MAX_CHARS,
  RUN_TRIGGERED_BY_LABELS,
  RunSearchSchema,
  RunStatusSchema,
  RUN_PAGE_SIZES,
  RUN_SORT_DEFAULT_KEY,
  RUN_SORT_NATURAL_DIR,
  type RunSortKey,
  type PipelineCostRollup,
  type RunSummary,
  type TriggerPublic,
} from '@autonomy-studio/shared';
import { useStore } from 'zustand';
import { useSearchParams } from 'react-router';
import { listRunAnnotations, listRuns } from '../../api/runs';
import { usePagedList } from '../../hooks/usePagedList';
import { getPipelineCost } from '../../api/pipelines';
import { ApiError, messageOf } from '../../api/client';
import { pipelineCostSummary, type PipelineCostSummary } from './pipelineCostSummary';
import { listTriggers } from '../../api/triggers';
import { pipelinesStore, type PipelinesStore } from '../../stores/pipelinesStore';
import { runStatusLabel } from './runStatus';
import { RunTimeline } from './RunTimeline';
import { RunGridColumnsMenu, RunsGrid } from './RunsGrid';
import { uiStore, type UiStore } from '../../stores/uiStore';
import {
  canonicalKindParam,
  dayRangeBounds,
  hasActiveRunFilters,
  hasRunFilterParams,
  isDefaultRunSort,
  nextRunSort,
  NO_RUNS_YET,
  readKinds,
  readRunFilters,
  readRunSort,
  runSortParams,
  RUN_FILTER_PARAMS,
  RUN_SINCE_LABEL,
  RUN_SINCE_OPTIONS,
  startedModeOf,
} from './runFilters';
import { dayOf, shiftDay } from '../../lib/displayTime';
import { LabelledControl } from '../../lib/LabelledControl';
import { useDisplayTimeZone } from '../../lib/useDisplayTimeZone';
import { FilterPicker } from './FilterPicker';
import { RUN_GROUP_BYS, type RunGroupBy } from './runBars';
import {
  RUNS_LIVE_FAILING_LABEL,
  RUNS_LIVE_PAUSE_LABEL,
  RUNS_LIVE_UPDATING_LABEL,
  useRunsLive,
} from './useRunsLive';

/**
 * U29 (#1015) — which rendering of the SAME filtered rows is on screen. A view,
 * not a filter: it changes nothing about which runs are in scope, which is why
 * it lives here rather than inside `runFilters.ts`.
 */
type RunView = 'list' | 'timeline';

/**
 * #1016 — the timeline's lane key, under the same URL rules as `?view=`: absent
 * is `pipeline`, anything unrecognised falls back to it. Another view setting,
 * not a filter, so it is NOT in `RUN_FILTER_PARAMS` and "Clear filters" keeps it;
 * and it survives a switch to List, so returning to the timeline restores it.
 */
const GROUP_PARAM = 'group';

function readGroupBy(params: URLSearchParams): RunGroupBy {
  const raw = params.get(GROUP_PARAM);
  return RUN_GROUP_BYS.find((by) => by === raw) ?? 'pipeline';
}

/**
 * #931 (U27 slice 2) — the filtered pipeline's lifetime spend, above the rows,
 * as ONE dense line (#1484: summary numbers go in a line, not tiles, and
 * explanations go in a tooltip, not a paragraph). The figure and its tokens come
 * from `pipelineCostSummary`, the same reading the tiles drew.
 *
 * The line LEADS with "Lifetime", which is the part of the old scope sentence
 * that stops the figure being read as the total of the rows underneath; the rest
 * of the caveats (what the figure covers, what it leaves out) are the `?`
 * button's description, reachable by keyboard focus as well as hover.
 */
function PipelineSpend({ summary }: { summary: PipelineCostSummary }) {
  const caveats = [summary.scope, summary.reading, summary.incomplete, summary.excludes]
    .filter((part) => part !== null && part !== '')
    .join(' ');
  return (
    <section className="runs-summary-line" aria-label="Lifetime spend">
      <span className="runs-summary-line__label">Lifetime spend</span>{' '}
      {/* A pipeline that has never run has no figure: a dash, never a $0.00
          that would read as a measurement. */}
      <span className="run-cost">{summary.figure ?? '—'}</span>
      {summary.tokens !== null && <span> · {summary.tokens}</span>}
      <Tooltip content={caveats} relationship="description">
        <button type="button" className="runs-summary-line__help" aria-label="About lifetime spend">
          ?
        </button>
      </Tooltip>
    </section>
  );
}

/** A run's identity, for `usePagedList` to drop a row a sorted walk repeats. */
const runKey = (run: RunSummary) => run.id;

/** `prev` with each of `next` set, or deleted where its value is `''`. */
function withParams(prev: URLSearchParams, next: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams(prev);
  for (const [param, value] of Object.entries(next)) {
    if (value === '') params.delete(param);
    else params.set(param, value);
  }
  return params;
}

/**
 * The Runs list — the entry to the P6 live monitor. Runs are created elsewhere
 * (a trigger, a scheduled window, or the editor's Run — #1395), never here, so this
 * page is read-only: it lists what has run and links each to its live detail
 * view. A run that is still executing is watched live on the detail page (the
 * WebSocket tail); this list itself is a point-in-time snapshot, refreshed on
 * demand — or, with Live on (#1484, `useRunsLive`), re-read every few seconds
 * while the reader is not scrolled into it or selecting from it.
 *
 * R2 + U10 — each row is a `RunSummary`, so the identity column reads the
 * PIPELINE'S NAME rather than the opaque `pv_…` version id it used to render,
 * and the trigger reads its name.
 *
 * #1484 OR35 M1 — ONE filter row above the grid, every axis server-side and in
 * the URL (`runFilters.ts`): status, pipeline, what started the run (a
 * multi-select over `RUN_TRIGGERED_BY_KINDS`, which replaced U10's client-side
 * origin tabs), trigger, annotation, when it started (a relative window, one
 * day, or a range of days) and a search box. Because every axis is answered by
 * the server, a paged list filters every run, not just the pages loaded.
 */
export function RunsPage({
  store = pipelinesStore,
  ui = uiStore,
}: {
  store?: PipelinesStore;
  /** #1484 — the grid's per-viewer column preferences; injected by tests. */
  ui?: UiStore;
} = {}) {
  const zone = useDisplayTimeZone(ui);
  const live = useStore(ui, (s) => s.runsLive);
  const setLive = useStore(ui, (s) => s.setRunsLive);
  const pageSize = useStore(ui, (s) => s.runsPageSize);
  const setPageSize = useStore(ui, (s) => s.setRunsPageSize);
  const listRef = useRef<HTMLDivElement>(null);
  /**
   * Bumped by "Refresh" so BOTH panels re-fetch from one button. Since #1083
   * the run list itself is refreshed through `usePagedList` rather than by this
   * key (a paged list has its own notion of "re-read the first page and drop the
   * tail"), so this now drives the #931 cost panel alone — kept, because one
   * button that freshens half the screen is worse than no button.
   */
  const [reloadKey, setReloadKey] = useState(0);

  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * U29 (#1015) — List or Timeline, under exactly the rules every filter follows: the
   * URL is the only authority, the default is the param's ABSENCE, and anything
   * unrecognised falls back to the default rather than erroring. That makes a
   * timeline link shareable and Back a working undo.
   *
   * It costs nothing to keep across the other URL writers: `setFilter`,
   * `setFilters` and `clearFilters` all COPY `searchParams` and `clearFilters`
   * deletes only `RUN_FILTER_PARAMS`, so switching a filter keeps the view.
   */
  const view: RunView = searchParams.get('view') === 'timeline' ? 'timeline' : 'list';
  const groupBy = readGroupBy(searchParams);

  function selectView(next: RunView) {
    const params = new URLSearchParams(searchParams);
    if (next === 'list') params.delete('view');
    else params.set('view', next);
    setSearchParams(params);
  }

  const filters = useMemo(() => readRunFilters(searchParams), [searchParams]);
  const {
    status: statusFilter,
    pipelineId,
    triggerId,
    since,
    annotation,
    kind,
    q,
    on,
    from,
    to,
  } = filters;
  const filtered = hasActiveRunFilters(filters);
  /* #1484 — the grid's sort. The timeline view always asks for the default
     order: it lays runs out by time and pages "older", which a status sort would
     turn into a different question. Switching view therefore changes the fetcher
     and reloads the list, as any filter change does. */
  const urlSort = useMemo(() => readRunSort(searchParams), [searchParams]);
  const sortKey = view === 'list' ? urlSort.key : RUN_SORT_DEFAULT_KEY;
  const sortDir = view === 'list' ? urlSort.dir : RUN_SORT_NATURAL_DIR[RUN_SORT_DEFAULT_KEY];
  const sortedByDefault = isDefaultRunSort({ key: sortKey, dir: sortDir });
  function sortBy(column: RunSortKey) {
    setFilters(runSortParams(nextRunSort({ key: sortKey, dir: sortDir }, column)));
  }

  /** Write several params as ONE history entry; `''` deletes. A push, not a
   * replace, so Back undoes a filter change. */
  function setFilters(next: Record<string, string>) {
    setSearchParams((prev) => withParams(prev, next));
  }

  function setFilter(param: string, next: string) {
    setFilters({ [param]: next });
  }

  /** A date input's value, KEPT in the URL even when empty, so the Started
   * mode (`startedModeOf`) and the input survive a cleared or half-typed day. */
  function setDay(param: string, value: string) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      params.set(param, value);
      return params;
    });
  }

  /**
   * #1484 — the Started picker: a relative window, "On a day", or "Between
   * days". Each choice clears the others' params, so the URL holds one kind of
   * time bound and the picker shows exactly what was asked of the server. The
   * two day modes open on today and on the last seven days, so choosing one is
   * already a working filter rather than a half-made one.
   */
  const startedMode = startedModeOf(searchParams, since);
  function selectStartedMode(mode: string) {
    // Today and the week before it in the DISPLAY zone, by calendar arithmetic.
    const today = dayOf(Date.now(), zone);
    const weekAgo = shiftDay(today, -6);
    const cleared = {
      [RUN_FILTER_PARAMS.since]: '',
      [RUN_FILTER_PARAMS.on]: '',
      [RUN_FILTER_PARAMS.from]: '',
      [RUN_FILTER_PARAMS.to]: '',
    };
    if (mode === 'on') setFilters({ ...cleared, [RUN_FILTER_PARAMS.on]: today });
    else if (mode === 'range')
      setFilters({
        ...cleared,
        [RUN_FILTER_PARAMS.from]: weekAgo,
        [RUN_FILTER_PARAMS.to]: today,
      });
    else setFilters({ ...cleared, [RUN_FILTER_PARAMS.since]: mode });
  }

  /**
   * #1484 — the search box. What is TYPED is local; what is SEARCHED is the
   * URL's `q`, written 300ms after typing stops so a word is one request, not
   * one per letter. The first write of a search pushes a history entry and every
   * refinement replaces it, so Back leaves the search in one step rather than one
   * letter at a time — and never skips it entirely.
   *
   * When `q` changes from OUTSIDE (Clear filters, Back, a link), the box follows
   * it. The comparison is on the trimmed text, so the box does not eat a
   * trailing space the operator is mid-way through typing.
   */
  const [searchText, setSearchText] = useState(q ?? '');
  // Adjusted during render rather than in an effect (React's "storing
  // information from previous renders"), so the box never paints stale.
  const [syncedQ, setSyncedQ] = useState(q);
  if (syncedQ !== q) {
    setSyncedQ(q);
    if (searchText.trim() !== (q ?? '')) setSearchText(q ?? '');
  }
  useEffect(() => {
    const parsed = RunSearchSchema.safeParse(searchText);
    const next = parsed.success ? parsed.data : '';
    if (next === (q ?? '')) return;
    const timer = window.setTimeout(() => {
      setSearchParams((prev) => withParams(prev, { [RUN_FILTER_PARAMS.q]: next }), {
        replace: q !== undefined,
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchText, q, setSearchParams]);

  const kinds = readKinds(kind);
  const kindSummary =
    kinds.length === 0
      ? 'All'
      : kinds.length === 1
        ? RUN_TRIGGERED_BY_LABELS[kinds[0]!]
        : `${kinds.length} kinds`;

  function clearFilters() {
    const params = new URLSearchParams(searchParams);
    for (const param of Object.values(RUN_FILTER_PARAMS)) params.delete(param);
    setSearchParams(params);
  }

  /**
   * #1083 — the `filterKey` stamping this replaced is gone. It existed because
   * the page owned the rows and had to decide whether an arriving answer still
   * belonged to the filter on screen; `usePagedList` now owns them and keys that
   * decision on the FETCHER's identity, which changes with exactly these
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
      listRuns(
        {
          status: statusFilter,
          pipelineId,
          triggerId,
          since,
          annotation,
          kind,
          q,
          ...dayRangeBounds({ on, from, to }, zone),
          // The default order is not sent, so the plain list's request is
          // unchanged; any other sort is, with its direction always explicit.
          ...(sortedByDefault ? {} : { sort: sortKey, dir: sortDir }),
        },
        cursor,
        signal,
        // A new size is a new list: the cursor of a 50-row walk names nothing
        // in a 200-row one, so the fetcher changes and the list reloads.
        pageSize,
      ),
    // Primitives only — see above. `kind` is the canonical joined string.
    [
      statusFilter,
      pipelineId,
      triggerId,
      since,
      annotation,
      kind,
      q,
      on,
      from,
      to,
      zone,
      sortKey,
      sortDir,
      sortedByDefault,
      pageSize,
    ],
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
    extended,
    poll,
  } = usePagedList(fetchPage, runKey);
  /* Live re-reads the run list only; the lifetime-spend panel is all-time and
     stays on Refresh, so a tick never re-aggregates a pipeline's whole history. */
  const liveFailing = pageError?.scope === 'live';
  const { pause, ticking } = useRunsLive({
    live,
    extended,
    failing: liveFailing,
    poll,
    listRef,
  });
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

  // U26 — the annotation picker's options, the annotations of versions the
  // caller's runs are bound to. Fails silently for the triggers picker's reason.
  const [annotations, setAnnotations] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    listRunAnnotations(controller.signal)
      .then(setAnnotations)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  return (
    <section aria-labelledby="runs-heading" className="runs-page">
      <div className="page-header">
        <h2 id="runs-heading">Runs</h2>
        {/* #1484 — the search box sits on the title row, not in the filter
            bar: measured at 1440×900 beside the hub nav, the bar has ~1080px
            and its widest state (a range of days plus Clear) left the box
            no room without wrapping. It searches the same list, under every
            filter below. */}
        <div role="search" className="runs-search">
          <LabelledControl label={<span className="visually-hidden">Search runs</span>}>
            {(id) => (
              <input
                id={id}
                type="search"
                maxLength={RUN_SEARCH_MAX_CHARS}
                placeholder="Search run id, pipeline, trigger, error…"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
              />
            )}
          </LabelledControl>
        </div>
        {/* #1484 — which columns the grid draws. The Timeline has no columns,
            so it has no picker either. */}
        {view === 'list' && <RunGridColumnsMenu ui={ui} sortKey={urlSort.key} />}
        {/* A `role="group"` of toggles rather than a `TabList`: List and
            Timeline are two renderings of one set of rows, not two panels. */}
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
        {/* #1484 — keeps the list current (`useRunsLive`). The status beside it
            says why it is not updating when it is not, so a paused list is
            never mistaken for a quiet workspace. The live region is always
            mounted and only its text changes: a region inserted already
            populated is often not announced. */}
        <ToggleButton
          size="small"
          checked={live}
          onClick={() => setLive(!live)}
          title="Re-read the list every few seconds, pausing while you scroll or select"
        >
          Live
        </ToggleButton>
        <span role="status" className="runs-live-status">
          {!live
            ? ''
            : pause !== null
              ? RUNS_LIVE_PAUSE_LABEL[pause]
              : liveFailing
                ? RUNS_LIVE_FAILING_LABEL
                : RUNS_LIVE_UPDATING_LABEL}
        </span>
        {/* #1484 — how many runs a page reads. Keyset "load more" stays the
            paging model (#1083); this sizes each step of it. Per viewer, and on
            the title row so it never unmounts while the list reloads under it. */}
        <LabelledControl label={<span className="visually-hidden">Runs per page</span>}>
          {(id) => (
            <select
              id={id}
              value={pageSize}
              onChange={(e) => {
                const size = RUN_PAGE_SIZES.find((n) => String(n) === e.target.value);
                if (size !== undefined) setPageSize(size);
              }}
            >
              {RUN_PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} per page
                </option>
              ))}
            </select>
          )}
        </LabelledControl>
      </div>

      {/* Worded apart because they are different news: a failed FIRST page
          means there are no runs on screen, while a failed older page means the
          runs on screen are real and merely stop short of where the reader
          asked. */}
      {pageError !== null && (
        <p role="alert" className="error">
          {pageError.scope === 'more'
            ? `Could not load older runs: ${pageError.message}`
            : pageError.scope === 'live'
              ? `Live update failed: ${pageError.message}`
              : pageError.message}
        </p>
      )}

      {/* U26 — OUTSIDE the "are there rows" guard below, and that placement is
          the point: under a filter an empty result is the ordinary case, so a
          pane that renders only when rows exist would vanish exactly when the
          operator needs it to undo the filter that emptied the list. */}
      <div className="run-filters" role="group" aria-label="Filter runs">
        {/* #1484 — ONE row. Each control keeps its label for assistive tech but
            draws none: the "All …" first option names the axis on screen, and
            a row of stacked labels is what pushed the first run off the top. */}
        <LabelledControl label={<span className="visually-hidden">Status</span>}>
          {(id) => (
            <select
              id={id}
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
          )}
        </LabelledControl>

        {/* What started the run, several at once. Fluent's checkbox menu: it
            brings the `menuitemcheckbox` roles and arrow-key movement a
            multi-select needs, which a native `<select multiple>` draws as a
            tall list box. The button says the selection, so the label is the
            button's own text. */}
        <Menu
          checkedValues={{ kind: kinds }}
          onCheckedValueChange={(_, data) =>
            setFilter(RUN_FILTER_PARAMS.kind, canonicalKindParam(data.checkedItems) ?? '')
          }
        >
          <MenuTrigger disableButtonEnhancement>
            <button type="button" className="run-filters__menu">
              Triggered by: {kindSummary} <span aria-hidden="true">▾</span>
            </button>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {RUN_TRIGGERED_BY_KINDS.map((k) => (
                <MenuItemCheckbox key={k} name="kind" value={k}>
                  {RUN_TRIGGERED_BY_LABELS[k]}
                </MenuItemCheckbox>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>

        <FilterPicker
          label={<span className="visually-hidden">Pipeline</span>}
          allLabel="All pipelines"
          value={pipelineId}
          options={pipelines.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(next) => setFilter(RUN_FILTER_PARAMS.pipelineId, next)}
        />

        <FilterPicker
          label={<span className="visually-hidden">Trigger</span>}
          allLabel="All triggers"
          value={triggerId}
          options={triggers.map((t) => ({ value: t.id, label: t.name }))}
          onChange={(next) => setFilter(RUN_FILTER_PARAMS.triggerId, next)}
        />

        <FilterPicker
          label={<span className="visually-hidden">Annotation</span>}
          allLabel="All annotations"
          value={annotation}
          options={annotations.map((a) => ({ value: a, label: a }))}
          onChange={(next) => setFilter(RUN_FILTER_PARAMS.annotation, next)}
        />

        <LabelledControl label={<span className="visually-hidden">Started</span>}>
          {(id) => (
            <select id={id} value={startedMode} onChange={(e) => selectStartedMode(e.target.value)}>
              <option value="">Any time</option>
              {RUN_SINCE_OPTIONS.map((w) => (
                <option key={w} value={w}>
                  {RUN_SINCE_LABEL[w]}
                </option>
              ))}
              <option value="on">On a day…</option>
              <option value="range">Between days…</option>
            </select>
          )}
        </LabelledControl>

        {/* The day picker is the browser's own date input: a calendar on every
            engine, keyboard-typable, and it always yields `YYYY-MM-DD` or ''.
            A cleared input keeps its place and removes its bound. A reversed
            range is refused by `readRunFilters`, and `min`/`max` make each
            input natively `:invalid`, which the bar draws. */}
        {startedMode === 'on' && (
          <LabelledControl label={<span className="visually-hidden">Day</span>}>
            {(id) => (
              <input
                id={id}
                type="date"
                value={on ?? ''}
                onChange={(e) => setDay(RUN_FILTER_PARAMS.on, e.target.value)}
              />
            )}
          </LabelledControl>
        )}
        {startedMode === 'range' && (
          <>
            <LabelledControl label={<span className="visually-hidden">From day</span>}>
              {(id) => (
                <input
                  id={id}
                  type="date"
                  value={from ?? ''}
                  max={to}
                  onChange={(e) => setDay(RUN_FILTER_PARAMS.from, e.target.value)}
                />
              )}
            </LabelledControl>
            <LabelledControl label={<span className="visually-hidden">To day</span>}>
              {(id) => (
                <input
                  id={id}
                  type="date"
                  value={to ?? ''}
                  min={from}
                  onChange={(e) => setDay(RUN_FILTER_PARAMS.to, e.target.value)}
                />
              )}
            </LabelledControl>
          </>
        )}

        {/* "Clear" on screen to keep the bar one row; the accessible name
            keeps the whole phrase, and starts with the visible word. */}
        {hasRunFilterParams(searchParams) && (
          <button type="button" onClick={clearFilters} aria-label="Clear filters">
            Clear
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
        <p>{NO_RUNS_YET}</p>
      )}
      {runs !== null && runs.length === 0 && pageError === null && filtered && (
        <p>No runs match these filters. Widen them, or clear them, to see more.</p>
      )}

      {/* The rows, and nothing else: `useRunsLive` pauses while the reader is
          scrolled into this or selecting from it, so the search box and filters
          must stay outside. */}
      <div ref={listRef} className="runs-list">
        {runs !== null &&
          runs.length > 0 &&
          (view === 'timeline' ? (
            /* One rendering at a time — the timeline REPLACES the table rather
             than sitting above it. Showing both would put every run id and
             pipeline name on screen twice, which is the ambiguity
             `AttemptTimeline` records for its own untimed list. */
            <RunTimeline
              runs={runs}
              groupBy={groupBy}
              onGroupByChange={(next) => setFilter(GROUP_PARAM, next === 'pipeline' ? '' : next)}
            />
          ) : (
            <RunsGrid
              runs={runs}
              loadedAt={loadedAt}
              ticking={ticking}
              sort={urlSort}
              onSort={sortBy}
              ui={ui}
            />
          ))}
      </div>

      {/* Rendered only when the server said there IS an older page. An
          always-present button that sometimes did nothing would make the end of
          the history indistinguishable from a list that had stopped loading —
          and where the history ends is exactly what a reader is checking.
          OUTSIDE the "are there rows" guard above, like the filter bar. */}
      {hasMore && (
        <button type="button" onClick={loadMore} disabled={busy}>
          {sortedByDefault ? 'Load older runs' : 'Load more runs'}
        </button>
      )}
    </section>
  );
}
