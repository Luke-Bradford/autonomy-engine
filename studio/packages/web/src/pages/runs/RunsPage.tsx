import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  ToggleButton,
  Tooltip,
} from '@fluentui/react-components';
import { AddRegular } from '@fluentui/react-icons';
import {
  RUN_TRIGGERED_BY_KINDS,
  RUN_SEARCH_MAX_CHARS,
  RUN_TRIGGERED_BY_LABELS,
  RunStatusSchema,
  RUN_PAGE_SIZES,
  RUN_SORT_DEFAULT_KEY,
  RUN_SORT_NATURAL_DIR,
  type RunSortKey,
  type PipelineCostRollup,
  type Paginated,
  type RunSummary,
  type RunSummaryPage,
  type TriggerPublic,
} from '@autonomy-studio/shared';
import { useStore } from 'zustand';
import { Navigate } from 'react-router';
import { useLatestSearchParams } from '../../lib/useLatestSearchParams';
import { listRunAnnotations, listRuns, type ListRunsQuery } from '../../api/runs';
import { RunsExportButton, RunsExportNote } from './RunsExportButton';
import { useRunsExport } from './useRunsExport';
import { PAGE_STALLED_LABEL, usePagedList } from '../../hooks/usePagedList';
import { getPipelineCost } from '../../api/pipelines';
import { ApiError, messageOf } from '../../api/client';
import { pipelineCostSummary, type PipelineCostSummary } from './pipelineCostSummary';
import { listTriggers } from '../../api/triggers';
import { pipelinesStore, type PipelinesStore } from '../../stores/pipelinesStore';
import { runStatusLabel } from './runStatus';
import { RunTimeline } from './RunTimeline';
import { RunGridColumnsMenu, RunsGrid } from './RunsGrid';
import {
  RUN_GRID_DEFAULT_HIDDEN,
  uiStore,
  type RunGridColumnId,
  type UiStore,
} from '../../stores/uiStore';
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
  readRunGridHiddenParam,
  hasRunsListParams,
  readRunSort,
  rememberedRunsQuery,
  runGridHiddenParam,
  runSortParams,
  RUN_CHILDREN_OFF,
  RUN_CHILDREN_PARAM,
  RUN_FILTER_PARAMS,
  RUN_GRID_HIDDEN_PARAM,
  RUN_SINCE_LABEL,
  RUN_SINCE_OPTIONS,
  startedModeOf,
} from './runFilters';
import { dayOf, shiftDay } from '../../lib/displayTime';
import { LabelledControl } from '../../lib/LabelledControl';
import { useDisplayTimeZone } from '../../lib/useDisplayTimeZone';
import { withParams } from '../../lib/withParams';
import { useSearchBox } from '../../lib/useSearchBox';
import { FilterMenu } from './FilterMenu';
import { FilterPicker } from './FilterPicker';
import { RUN_GROUP_BYS, type RunGroupBy } from './runBars';
import {
  RUNS_LIVE_FAILING_LABEL,
  RUNS_LIVE_PAUSE_LABEL,
  RUNS_LIVE_UPDATING_LABEL,
  useRunsLive,
} from './useRunsLive';
import { PageHeader, ToolbarDivider } from '../../lib/PageHeader';
import { FilterPill } from '../../lib/FilterPill';

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

/**
 * A page with its `descendants` folded into `items`, so the paged list holds one
 * flat set of runs and the grid nests it. `usePagedList`'s `runKey` keeps a run
 * that arrives twice (as one page's descendant and a later page's match) once.
 * The server sends `descendants` whenever it was asked; an answer without it is a
 * broken read, and treating it as "no children" would draw a parent as if it had
 * called nothing — so it fails the load instead.
 */
function withDescendants(page: RunSummaryPage): Paginated<RunSummary> {
  if (page.descendants === undefined) {
    throw new Error('The server did not return the child runs this list asked for.');
  }
  return { items: [...page.items, ...page.descendants], nextCursor: page.nextCursor };
}

/**
 * #1594 OR40 S3 — the filters the bar keeps behind "Add filter" until one is
 * added or its param is in the URL, as the ADF Monitor keeps its rarer axes.
 * Status, Pipeline, Triggered by and Started are always on the row.
 */
const OPTIONAL_RUN_FILTERS = [
  { param: RUN_FILTER_PARAMS.triggerId, label: 'Trigger' },
  { param: RUN_FILTER_PARAMS.annotation, label: 'Annotation' },
] as const;
type OptionalRunFilter = (typeof OPTIONAL_RUN_FILTERS)[number]['param'];

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
  /** #1484 — the list's per-viewer preferences (columns, Live, page size,
   * the last-used query); injected by tests. */
  ui?: UiStore;
} = {}) {
  const [searchParams] = useLatestSearchParams();
  /*
   * #1484 OR35 M1 principle 5 — the viewer's last-used query, restored into a
   * BARE visit to the list (one whose URL names no list state at all,
   * `hasRunsListParams`). Decided once, when the page MOUNTS: a URL that turns
   * bare while the page is open — Clear, or Back to an entry before the first
   * filter — is the viewer's own doing and is never filled back in, so Back is
   * never trapped. A link that names anything (`?pipeline=` from Triggers, a
   * shared URL) is honoured exactly, with nothing stored merged into it.
   *
   * A `replace`, so the restored URL is the visit's one history entry, and the
   * list never mounts on the bare URL, so it never fetches the unfiltered page
   * only to throw it away. The stored text is re-read through
   * `rememberedRunsQuery`, so a value the page would not have written is
   * dropped before it reaches the URL.
   *
   * The viewer's own column choice rides along as `hide` when it is not the
   * default, so the address of what is on screen is a link that shows it.
   */
  const [restore, setRestore] = useState(() => {
    if (hasRunsListParams(searchParams)) return '';
    const { runsLastQuery, runsGridHidden } = ui.getState();
    const params = new URLSearchParams(rememberedRunsQuery(new URLSearchParams(runsLastQuery)));
    const hide = runGridHiddenParam(runsGridHidden);
    if (hide !== runGridHiddenParam(RUN_GRID_DEFAULT_HIDDEN)) {
      params.set(RUN_GRID_HIDDEN_PARAM, hide);
    }
    return params.toString();
  });
  const bare = !hasRunsListParams(searchParams);
  // Spent once the URL holds it — adjusted during render, as `syncedQ` is, so a
  // later bare URL can never see it.
  if (restore !== '' && !bare) setRestore('');
  if (restore !== '' && bare) {
    const params = new URLSearchParams(searchParams);
    for (const [param, value] of new URLSearchParams(restore)) params.set(param, value);
    return <Navigate replace to={{ search: `?${params.toString()}` }} />;
  }
  return <RunsList store={store} ui={ui} />;
}

/** `RunsPage` once any restore has happened: the list itself. */
function RunsList({ store, ui }: { store: PipelinesStore; ui: UiStore }) {
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

  const [searchParams, setSearchParams] = useLatestSearchParams();

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
  const includeChildren =
    view === 'list' && searchParams.get(RUN_CHILDREN_PARAM) !== RUN_CHILDREN_OFF;

  /*
   * #1484 principle 5 — the columns: a link's `hide` when it carries one, else
   * the viewer's stored choice. A choice made here writes BOTH, so the viewer's
   * default follows it and the URL shows it; visiting a shared link writes
   * neither. A `replace`: a column is not a place to go Back to.
   */
  const storedHidden = useStore(ui, (s) => s.runsGridHidden);
  const setStoredHidden = useStore(ui, (s) => s.setRunsGridHidden);
  const resetColumns = useStore(ui, (s) => s.resetRunsGridColumns);
  const hidden = useMemo(
    () => readRunGridHiddenParam(searchParams) ?? storedHidden,
    [searchParams, storedHidden],
  );
  function setHidden(next: readonly RunGridColumnId[]) {
    setStoredHidden(next);
    setSearchParams(
      (prev) => withParams(prev, { [RUN_GRID_HIDDEN_PARAM]: runGridHiddenParam(next) }),
      { replace: true },
    );
  }
  function resetHidden() {
    resetColumns();
    setSearchParams((prev) => withParams(prev, { [RUN_GRID_HIDDEN_PARAM]: '' }), {
      replace: true,
    });
  }

  /* #1484 principle 5 — what `RunsPage` restores next time: the list as the
     VIEWER has made it. Arriving changes nothing — a link from Triggers or a
     shared URL is somebody else's question, and visiting it must not replace
     the viewer's standing view. From the first change made here on, every
     change is remembered, '' included (a cleared list is remembered as
     cleared). Compared with the arrival rather than skipping the first effect,
     which StrictMode runs twice. */
  const lastQuery = rememberedRunsQuery(searchParams);
  const setLastQuery = useStore(ui, (s) => s.setRunsLastQuery);
  const arrivedWith = useRef(lastQuery);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current && lastQuery === arrivedWith.current) return;
    moved.current = true;
    setLastQuery(lastQuery);
  }, [lastQuery, setLastQuery]);

  function selectView(next: RunView) {
    setSearchParams((prev) => withParams(prev, { view: next === 'list' ? '' : next }));
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

  /** #1484 — the search box over the URL's `q` (`useSearchBox`). */
  const [searchText, setSearchText] = useSearchBox(q, (next, replace) =>
    setSearchParams((prev) => withParams(prev, { [RUN_FILTER_PARAMS.q]: next }), { replace }),
  );

  const kinds = readKinds(kind);

  /**
   * #1594 OR40 S3 — the optional filters ADDED to the row and not yet set. A
   * set one is on the row because its param is in the URL, so this holds only
   * what the URL cannot: "show me this axis at All". View state, like a menu's
   * open state, so a reload drops an unset pill and keeps every set one.
   */
  const [addedFilters, setAddedFilters] = useState<readonly OptionalRunFilter[]>([]);
  const optionalValue: Record<OptionalRunFilter, string | undefined> = {
    [RUN_FILTER_PARAMS.triggerId]: triggerId,
    [RUN_FILTER_PARAMS.annotation]: annotation,
  };
  const shownFilter = (param: OptionalRunFilter) =>
    addedFilters.includes(param) || optionalValue[param] !== undefined;
  const optionalRefs = {
    [RUN_FILTER_PARAMS.triggerId]: useRef<HTMLSelectElement>(null),
    [RUN_FILTER_PARAMS.annotation]: useRef<HTMLSelectElement>(null),
  };
  /* The picker a filter just added opens on, so adding one is one step from
     choosing its value. After the menu has closed: it hands focus back to its
     own trigger as it goes, which would otherwise win. */
  const [focusFilter, setFocusFilter] = useState<OptionalRunFilter | null>(null);
  useEffect(() => {
    if (focusFilter === null) return;
    const frame = requestAnimationFrame(() => {
      optionalRefs[focusFilter].current?.focus();
      setFocusFilter(null);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the refs are stable
  }, [focusFilter]);
  function addFilter(param: OptionalRunFilter) {
    setAddedFilters((prev) => (prev.includes(param) ? prev : [...prev, param]));
    setFocusFilter(param);
  }
  function removeFilter(param: OptionalRunFilter) {
    setAddedFilters((prev) => prev.filter((p) => p !== param));
    setFilter(param, '');
  }

  function clearFilters() {
    setAddedFilters([]);
    setSearchParams((prev) =>
      withParams(prev, Object.fromEntries(Object.values(RUN_FILTER_PARAMS).map((p) => [p, '']))),
    );
  }

  /**
   * #1083 — the `filterKey` stamping this replaced is gone. It existed because
   * the page owned the rows and had to decide whether an arriving answer still
   * belonged to the filter on screen; `usePagedList` now owns them and keys that
   * decision on the FETCHER's identity, which changes with exactly these
   * axes. One authority instead of a key and a fetcher that could disagree.
   */

  /* #1484 — the request's axes, memoised on the PRIMITIVES above, so its
     identity changes exactly when a filter does. One object for the paged list
     and the CSV export, so the file is always the list on screen. */
  const listQuery = useMemo<ListRunsQuery>(
    () => ({
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
    }),
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
    ],
  );
  const exporter = useRunsExport(listQuery);
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
        includeChildren ? { ...listQuery, includeChildren: 'true' } : listQuery,
        cursor,
        signal,
        // A new size is a new list: the cursor of a 50-row walk names nothing
        // in a 200-row one, so the fetcher changes and the list reloads.
        pageSize,
      ).then((page) => (includeChildren ? withDescendants(page) : page)),
    [listQuery, pageSize, includeChildren],
  );
  const {
    items: runs,
    error: pageError,
    loading,
    busy,
    stalled,
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
      <PageHeader title="Runs" headingId="runs-heading">
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
        <ToolbarDivider />
        {/* #1484 — which columns the grid draws. The Timeline has no columns,
            so it has no picker either. */}
        {view === 'list' && (
          <RunGridColumnsMenu
            hidden={hidden}
            sortKey={urlSort.key}
            onHiddenChange={setHidden}
            onReset={resetHidden}
          />
        )}
        {/* #1484 — `RUN_CHILDREN_PARAM`. In the URL (a push), so Back undoes it. */}
        {view === 'list' && (
          <ToggleButton
            size="small"
            checked={includeChildren}
            onClick={() => setFilter(RUN_CHILDREN_PARAM, includeChildren ? RUN_CHILDREN_OFF : '')}
            title="Show the runs each run called, nested under it"
          >
            Include child runs
          </ToggleButton>
        )}
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
        <ToolbarDivider />
        {/* Drives BOTH panels: the paged run list re-reads its first page (and
            drops any accumulated tail — a refreshed head glued to a stale tail
            would skip whatever was appended in between), and the key bump
            re-fetches the lifetime-spend panel. Disabled while any run-list
            request is in flight, since `usePagedList` is latest-wins rather than
            drop-the-new, so a second click would abort and re-issue a request
            already on its way — until that request has STALLED (#1529), when a
            retry is the only way out short of reloading the page. */}
        <button
          type="button"
          onClick={() => {
            refresh();
            setReloadKey((k) => k + 1);
          }}
          disabled={busy && !stalled}
        >
          Refresh
        </button>
        {/* #1484 — every run the filters match, not just the loaded pages. */}
        <RunsExportButton exporter={exporter} />
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
        {/* A stalled load is said whether or not Live is on, and ahead of
            Live's own state: while the reader's page hangs no poll runs, so
            "Updating every 5s" would be untrue (#1529). */}
        <span role="status" className="runs-live-status">
          {stalled
            ? PAGE_STALLED_LABEL
            : !live
              ? ''
              : pause !== null
                ? RUNS_LIVE_PAUSE_LABEL[pause]
                : liveFailing
                  ? RUNS_LIVE_FAILING_LABEL
                  : RUNS_LIVE_UPDATING_LABEL}
        </span>
        <ToolbarDivider />
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
      </PageHeader>

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

      <RunsExportNote exporter={exporter} />

      {/* U26 — OUTSIDE the "are there rows" guard below, and that placement is
          the point: under a filter an empty result is the ordinary case, so a
          pane that renders only when rows exist would vanish exactly when the
          operator needs it to undo the filter that emptied the list. */}
      <div className="run-filters" role="group" aria-label="Filter runs">
        {/* #1484 — ONE row. #1594 OR40 S3 — each filter is a pill, "Status:
            All", like the ADF Monitor's: the axis named on screen, its own
            control borderless inside, and a ✕ once it narrows the list. The
            controls keep their names, so the pill is a frame and not a new
            widget. */}
        <FilterPill
          name="Status"
          active={statusFilter !== undefined}
          onRemove={
            statusFilter === undefined ? undefined : () => setFilter(RUN_FILTER_PARAMS.status, '')
          }
        >
          <LabelledControl label="Status">
            {(id) => (
              <select
                id={id}
                value={statusFilter ?? ''}
                onChange={(e) => setFilter(RUN_FILTER_PARAMS.status, e.target.value)}
              >
                <option value="">All</option>
                {RunStatusSchema.options.map((s) => (
                  <option key={s} value={s}>
                    {runStatusLabel(s)}
                  </option>
                ))}
              </select>
            )}
          </LabelledControl>
        </FilterPill>

        <FilterPill
          name="Pipeline"
          active={pipelineId !== undefined}
          onRemove={
            pipelineId === undefined ? undefined : () => setFilter(RUN_FILTER_PARAMS.pipelineId, '')
          }
        >
          <FilterPicker
            label="Pipeline"
            allLabel="All"
            value={pipelineId}
            options={pipelines.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(next) => setFilter(RUN_FILTER_PARAMS.pipelineId, next)}
          />
        </FilterPill>

        {/* What started the run, several at once (`FilterMenu`), whose button
            already reads "Triggered by: All". */}
        <FilterPill
          name="Triggered by"
          active={kinds.length > 0}
          onRemove={kinds.length === 0 ? undefined : () => setFilter(RUN_FILTER_PARAMS.kind, '')}
        >
          <FilterMenu
            label="Triggered by"
            name="kind"
            values={RUN_TRIGGERED_BY_KINDS}
            checked={kinds}
            labelOf={(k) => RUN_TRIGGERED_BY_LABELS[k]}
            countNoun="kinds"
            onChange={(items) => setFilter(RUN_FILTER_PARAMS.kind, canonicalKindParam(items) ?? '')}
          />
        </FilterPill>

        <FilterPill
          name="Started"
          active={startedMode !== ''}
          onRemove={startedMode === '' ? undefined : () => selectStartedMode('')}
        >
          <LabelledControl label="Started">
            {(id) => (
              <select
                id={id}
                value={startedMode}
                onChange={(e) => selectStartedMode(e.target.value)}
              >
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

          {/* The day picker is the browser's own date input: a calendar on
              every engine, keyboard-typable, and it always yields `YYYY-MM-DD`
              or ''. A cleared input keeps its place and removes its bound. A
              reversed range is refused by `readRunFilters`, and `min`/`max`
              make each input natively `:invalid`, which the bar draws. */}
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
        </FilterPill>

        {/* The optional filters, once added or set. Removing one takes it off
            the row as well as off the list. */}
        {shownFilter(RUN_FILTER_PARAMS.triggerId) && (
          <FilterPill
            name="Trigger"
            active={triggerId !== undefined}
            onRemove={() => removeFilter(RUN_FILTER_PARAMS.triggerId)}
          >
            <FilterPicker
              label="Trigger"
              allLabel="All"
              value={triggerId}
              options={triggers.map((t) => ({ value: t.id, label: t.name }))}
              onChange={(next) => setFilter(RUN_FILTER_PARAMS.triggerId, next)}
              selectRef={optionalRefs[RUN_FILTER_PARAMS.triggerId]}
            />
          </FilterPill>
        )}
        {shownFilter(RUN_FILTER_PARAMS.annotation) && (
          <FilterPill
            name="Annotation"
            active={annotation !== undefined}
            onRemove={() => removeFilter(RUN_FILTER_PARAMS.annotation)}
          >
            <FilterPicker
              label="Annotation"
              allLabel="All"
              value={annotation}
              options={annotations.map((a) => ({ value: a, label: a }))}
              onChange={(next) => setFilter(RUN_FILTER_PARAMS.annotation, next)}
              selectRef={optionalRefs[RUN_FILTER_PARAMS.annotation]}
            />
          </FilterPill>
        )}

        {OPTIONAL_RUN_FILTERS.some(({ param }) => !shownFilter(param)) && (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <button type="button" className="subtle run-filters__add">
                <AddRegular aria-hidden="true" />
                Add filter
              </button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {OPTIONAL_RUN_FILTERS.filter(({ param }) => !shownFilter(param)).map(
                  ({ param, label }) => (
                    <MenuItem key={param} onClick={() => addFilter(param)}>
                      {label}
                    </MenuItem>
                  ),
                )}
              </MenuList>
            </MenuPopover>
          </Menu>
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
              hidden={hidden}
              ui={ui}
              nested={includeChildren}
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
