import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ToggleButton } from '@fluentui/react-components';
import { useStore } from 'zustand';
import type {
  Pipeline,
  PipelineSummary,
  PipelineVersionState,
  WorkspaceGitSync,
} from '@autonomy-studio/shared';
import { useBusyAction } from '../hooks/useBusyAction';
import { useGuardedLoad } from '../hooks/useGuardedLoad';
import { useRefreshOnFocus } from '../hooks/useRefreshOnFocus';
import { messageOf } from '../api/client';
import { downloadPipelineExport } from '../api/pipelineExport';
import {
  archiveConfirmMessage,
  archivePipeline,
  deletePipeline,
  describeDeleteFailure,
  listArchivedPipelines,
  listPipelineSummaries,
  listPipelineVersionStates,
  restorePipeline,
} from '../api/pipelines';
import { getWorkspaceGit, readWorkspaceGitSync } from '../api/workspaceGit';
import { RowStateBadge } from './pipeline/EditorStateBadge';
import {
  LIVE_STATE_KEYS,
  LIVE_STATE_LABELS,
  listRowBadge,
  liveStateKeys,
} from './pipeline/editorState';
import { pipelinesStore, type PipelinesStore } from '../stores/pipelinesStore';
import { NewPipelineDrawer, type NewPipelineForm } from './NewPipelineDrawer';
import { PipelineImportDrawer } from './PipelineImportDrawer';
import { useDrawerForm } from '../lib/form/useDrawerForm';
import { leavesPath } from '../lib/form/leavesPath';
import { PipelineGridColumnsMenu, PipelinesGrid } from './author/PipelinesGrid';
import { uiStore, type UiStore } from '../stores/uiStore';
import { folderNamesOf } from './author/pipelineFolders';
import {
  nextPipelineSort,
  pipelineSortParams,
  readPipelineSort,
  sortPipelines,
  type PipelineSortKey,
} from './author/pipelinesGridSort';
import {
  CLEARED_PIPELINE_FILTERS,
  filterPipelines,
  filterFactsStatus,
  hasPipelineFilters,
  LAST_RUN_FILTERS,
  lastRunParam,
  liveFactsRead,
  NO_FOLDER,
  PIPELINE_FILTER_PARAMS,
  readArchivedView,
  readPipelineFilters,
  TRIGGERS_FILTER_LABELS,
  TRIGGERS_FILTERS,
  type FactsRead,
  type LastRunFilter,
} from './author/pipelinesGridFilter';
import { FilterMenu } from './runs/FilterMenu';
import { FilterPicker } from './runs/FilterPicker';
import { runStatusLabel } from './runs/runStatus';
import { LabelledControl } from '../lib/LabelledControl';
import { useSearchBox } from '../lib/useSearchBox';
import { withParams } from '../lib/withParams';
import { useConfirm } from '../lib/confirm/useConfirm';
import { useFocusAfterRemoval } from '../hooks/useFocusAfterRemoval';
import { RowMoreMenu, type RowMenuOrigin } from '../lib/RowMoreMenu';
import { pipelineDeletePlan, readPipelineDependents } from './pipelineDeleteConfirm';

/** The folder picker's options: each folder in the list, then "no folder". */
function folderOptionsOf(pipelines: readonly Pipeline[]): { value: string; label: string }[] {
  const options = folderNamesOf(pipelines).map((f) => ({ value: f, label: f }));
  return pipelines.some((p) => p.folder === null)
    ? [...options, { value: NO_FOLDER, label: '(no folder)' }]
    : options;
}

/** #1569 slice 3 — the one drawer the toolbar opens: a new pipeline, or an import. */
type PipelinesDrawer = NewPipelineForm | { kind: 'import' };

/** What the open drawer would write, for its unsaved-changes check: an import
 * holds nothing typed, so it is never dirty. */
function drawerSignature(drawer: PipelinesDrawer): string {
  return drawer.kind === 'import' ? 'import' : JSON.stringify([drawer.name, drawer.folder]);
}

/** The archived view draws only the columns it has facts for. */
const ARCHIVED_COLUMNS = ['name', 'modified'] as const;

function lastRunFilterLabel(v: LastRunFilter): string {
  return v === 'never' ? 'Never run' : runStatusLabel(v);
}

/**
 * Pipelines: list / create / delete, and open one on the authoring canvas.
 *
 * Since U4 this page is one of TWO views of the same list — the Factory
 * Resources pane beside it is the other, and both are mounted at once — so the
 * list lives in `pipelinesStore` rather than in this component. A create here
 * has to appear in the tree, and a delete in the tree has to disappear from
 * here; two independent `useState` copies could only be kept in step by luck.
 *
 * "Open" is a `<Link>` to the pipeline's own route, not local state. Before U4
 * the canvas replaced this page in place and had no address at all.
 *
 * The page is deliberately NOT reduced to a landing screen now that the pane
 * can do everything it does. The pane can be COLLAPSED (globally, and the
 * preference persists), and Author would then have no way to reach or create a
 * pipeline at all.
 */
export function PipelinesPage({
  store = pipelinesStore,
  ui = uiStore,
}: { store?: PipelinesStore; ui?: UiStore } = {}) {
  const [confirm, confirmDialog] = useConfirm();
  const status = useStore(store, (s) => s.status);
  const pipelines = useStore(store, (s) => s.pipelines);
  // #1470 — a removed row hands focus to its neighbour's ⋯, else to this.
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const { restoreFocus: removalFocus, removing: removingRow } = useFocusAfterRemoval(
    pipelines,
    newButtonRef,
  );
  const {
    form: drawerForm,
    setForm: setDrawerForm,
    openForm: openDrawer,
    seq: drawerSeq,
    guard,
    openerRef,
    ...drawer
    // Only a change of PAGE is walking away from typed input: the sort, the
    // filters and the Archived toggle are this page's own URL.
  } = useDrawerForm(drawerSignature, { holdRoute: leavesPath });
  /* A create, an import or a demo load/remove in flight: the toolbar waits, as
     the drawer's Close does, so pressing it cannot swap out the drawer whose
     answer is still coming (an import's outcome is shown only in its drawer).
     `aria-disabled`, not `disabled`: these buttons are where focus returns when
     the drawer closes and when a last row is removed, and a disabled element
     cannot take focus — the drawer closes in the same commit that ends busy. */
  const [drawerBusy, setDrawerBusy] = useState(false);
  const openFromToolbar = (opener: HTMLElement, next: PipelinesDrawer) => {
    if (!drawerBusy) drawer.openFrom(opener, () => openDrawer(next));
  };
  const liveFolderNames = useMemo(() => folderNamesOf(pipelines), [pipelines]);
  /* One removal per row at a time, spanning the dialog and the request: with
     the delete in flight the row's ⋯ still works, and a second Delete would
     ask again and 404 into the banner over a delete that succeeded (#1470).
     `ConnectionsPage.onDelete` states the race. */
  const { run: runRemove } = useBusyAction();
  const loadError = useStore(store, (s) => s.error);
  const ensureFresh = useStore(store, (s) => s.ensureFresh);
  const retryIfFailed = useStore(store, (s) => s.retryIfFailed);
  const refresh = useStore(store, (s) => s.refresh);

  /**
   * #1476 OR28 slice 8 — each row's state badge: its saved head and live
   * version, and `uncommitted` when a repo is connected and this pipeline is
   * not on the working branch. Three reads, each failing on its own into
   * absence — a row without a badge says nothing, which is not a claim. Read
   * whenever the list itself is (a create, archive or delete changes both) and
   * on focus, where a save in another tab shows up. The sync read fetches the
   * remote only when the server's copy is older than the hoster's
   * `GIT_FETCH_MAX_AGE_SECONDS`, the editor's own policy.
   */
  const [versionStates, setVersionStates] = useState<
    ReadonlyMap<string, PipelineVersionState> | undefined
  >(undefined);
  const [gitConnected, setGitConnected] = useState<boolean | undefined>(undefined);
  const [gitSync, setGitSync] = useState<WorkspaceGitSync | null | undefined>(undefined);
  // #1569 OR37 — the grid's row facts, read with the row states and refreshed
  // with them. A failed read shows em-dashes (absent), never zeros.
  const [summaries, setSummaries] = useState<
    { byId: ReadonlyMap<string, PipelineSummary>; loadedAt: number } | undefined
  >(undefined);
  // #1569 slice 2 — which of those reads FAILED, so a filter held back on one
  // says so rather than "loading" for ever. Each source its own flag: one read
  // answering must not clear another's failure.
  const [readFailed, setReadFailed] = useState({
    states: false,
    summaries: false,
    git: false,
    sync: false,
  });
  const markRead = useCallback(
    (source: 'states' | 'summaries' | 'git' | 'sync', failed: boolean) =>
      setReadFailed((prev) => (prev[source] === failed ? prev : { ...prev, [source]: failed })),
    [],
  );
  const guardedStatesLoad = useGuardedLoad();
  const guardedSummariesLoad = useGuardedLoad();
  const guardedGitLoad = useGuardedLoad();
  const guardedSyncLoad = useGuardedLoad();
  // Through the sync guard, so a sync still in flight from before the repo
  // went away is superseded rather than landing afterwards.
  const clearGitSync = useCallback(() => {
    void guardedSyncLoad(() => Promise.resolve(undefined), {
      onData: (sync) => {
        setGitSync(sync);
        markRead('sync', false);
      },
      onError: () => setGitSync(undefined),
    });
  }, [guardedSyncLoad, markRead]);
  const refreshRowStates = useCallback(() => {
    void guardedStatesLoad((signal) => listPipelineVersionStates(signal), {
      onData: (items) => {
        setVersionStates(new Map(items.map((st) => [st.pipelineId, st])));
        markRead('states', false);
      },
      onError: () => {
        setVersionStates(undefined);
        markRead('states', true);
      },
    });
    void guardedSummariesLoad((signal) => listPipelineSummaries(signal), {
      onData: (items) => {
        setSummaries({
          byId: new Map(items.map((it) => [it.pipelineId, it])),
          loadedAt: Date.now(),
        });
        markRead('summaries', false);
      },
      onError: () => {
        setSummaries(undefined);
        markRead('summaries', true);
      },
    });
    void guardedGitLoad((signal) => getWorkspaceGit(signal), {
      onData: (git) => {
        setGitConnected(git !== null);
        markRead('git', false);
        if (git === null) {
          clearGitSync();
          return;
        }
        void guardedSyncLoad((signal) => readWorkspaceGitSync(signal), {
          onData: (sync) => {
            setGitSync(sync);
            markRead('sync', false);
          },
          onError: () => {
            setGitSync(undefined);
            markRead('sync', true);
          },
        });
      },
      onError: () => {
        setGitConnected(undefined);
        markRead('git', true);
        clearGitSync();
      },
    });
  }, [
    guardedStatesLoad,
    guardedSummariesLoad,
    guardedGitLoad,
    guardedSyncLoad,
    clearGitSync,
    markRead,
  ]);
  // On the ids, not the array: a refresh hands back a new array whose rows may
  // be the same, and an empty list has no row to badge.
  const pipelineIds = pipelines.map((p) => p.id).join('\n');
  useEffect(() => {
    if (pipelineIds !== '') refreshRowStates();
  }, [pipelineIds, refreshRowStates]);
  useRefreshOnFocus(refreshRowStates);

  // #1569 — the sort lives in the URL, so a sorted list survives a reload.
  const [searchParams, setSearchParams] = useSearchParams();
  const sort = readPipelineSort(searchParams);
  // From `prev`, not the render's `sort`, so two quick clicks both count.
  const onSort = useCallback(
    (key: PipelineSortKey) =>
      setSearchParams(
        (prev) =>
          withParams(prev, pipelineSortParams(nextPipelineSort(readPipelineSort(prev), key))),
        { replace: true },
      ),
    [setSearchParams],
  );
  const { key: sortKey, dir: sortDir } = sort;

  // #1569 slice 2 — the filters and the Archived view, in the URL with the sort.
  // Memoised, so the React Compiler treats it as frozen: a plain object read
  // here and passed to calls below the later hooks counts as live (mutable)
  // across them, and costs it every `useCallback` in this component.
  const filters = useMemo(() => readPipelineFilters(searchParams), [searchParams]);
  const showArchived = filters.archived;
  const qParam = searchParams.get(PIPELINE_FILTER_PARAMS.q);
  const setFilter = useCallback(
    (param: string, next: string) => setSearchParams((prev) => withParams(prev, { [param]: next })),
    [setSearchParams],
  );
  const [searchText, setSearchText] = useSearchBox(qParam, (next, replace) =>
    setSearchParams((prev) => withParams(prev, { [PIPELINE_FILTER_PARAMS.q]: next }), {
      replace,
    }),
  );

  const [actionMsg, setActionMsg] = useState<string | null>(null);

  /**
   * #1058 — the ARCHIVED list, held here and deliberately NOT in
   * `pipelinesStore`. That store is the LIVE list, and it is shared with the
   * Factory Resources pane mounted beside this page; archived rows placed in it
   * would appear in that pane's tree as though they were still live.
   *
   * Its own status, not a bare array, for the reason the live list above is
   * gated on `status === 'ready'`: an empty list and a failed load are
   * different facts, and "No archived pipelines" is a lie about the second.
   * That matters more here than anywhere else on the page — this view IS the
   * way back out of archive, so a failure it renders as emptiness tells the
   * operator their pipeline is gone.
   *
   * `idle` doubles as "stale": archiving while the view is closed resets it,
   * so opening next refetches rather than showing a list missing the row that
   * was just archived. Nothing is fetched while it is closed.
   */
  const [archivedStatus, setArchivedStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [archived, setArchived] = useState<Pipeline[]>([]);
  const [archivedEpoch, setArchivedEpoch] = useState(0);
  const [archivedError, setArchivedError] = useState<string | null>(null);

  /**
   * #761 — this page is sticky for the same reason the Author pane was, by a
   * different route. It DOES remount on navigation, but `ensureFresh` refuses to
   * retry a failure, so the fresh mount was defeated on its own and the banner
   * survived every return to the page.
   *
   * For a route ELEMENT, a mount IS a route entry — React cannot distinguish a
   * first mount from a navigated-back one — so both calls belong in the one
   * effect. They cannot double-fetch: from `error`, `ensureFresh` stands down and
   * `retryIfFailed` loads; from `idle`/`ready`, `ensureFresh` loads and sets
   * `status:'loading'` synchronously, so `retryIfFailed` stands down. Exactly
   * one request either way.
   */
  useEffect(() => {
    ensureFresh();
    retryIfFailed();
  }, [ensureFresh, retryIfFailed]);

  /**
   * Save the pipeline's export envelope to disk (#959). The fetch happens
   * first and its failure is REPORTED — a bare `<a download>` would have
   * written a 404 body to the operator's disk as a `.json` file with nothing
   * said (see `api/download.ts`).
   */
  /* #960 — per-row single-flight. Since #1397 Export is an item in the row's
     menu, which shows it disabled while that row's export is in flight; the
     guard still refuses a second start, whatever asks. */
  const { active: exporting, run: runExport } = useBusyAction();

  const onExport = useCallback(
    (p: Pipeline) =>
      runExport(p.id, async () => {
        setActionMsg(null);
        try {
          await downloadPipelineExport(p);
        } catch (err) {
          setActionMsg(`Could not export “${p.name}”: ${messageOf(err)}`);
        }
      }),
    [runExport],
  );

  const onDelete = useCallback(
    (p: Pipeline, origin: RowMenuOrigin) =>
      runRemove(p.id, async () => {
        // #1397 — read what the delete takes with it, so the question names it.
        const plan = pipelineDeletePlan(p.name, await readPipelineDependents(p.id));
        if (plan.kind === 'refused') {
          // No dialog opened, so the menu hands focus back to ⋯ itself.
          setActionMsg(plan.message);
          return;
        }
        const confirmed = await confirm({
          message: plan.message,
          confirmLabel: 'Delete',
          ...(plan.typeToConfirm !== undefined ? { typeToConfirm: plan.typeToConfirm } : {}),
          // The menu item that asked unmounted while the read above ran.
          restoreFocus: removalFocus(origin),
        });
        if (!confirmed) return;
        const forget = removingRow(p.id, origin);
        setActionMsg(null);
        try {
          await deletePipeline(p.id);
          await refresh();
        } catch (err) {
          forget();
          // Shared with the Factory Resources row menu, which faces the same
          // 409 refusal — two hand-written copies had already drifted apart.
          setActionMsg(describeDeleteFailure(p.name, err));
        }
      }),
    [removalFocus, removingRow, runRemove, confirm, refresh],
  );

  /**
   * Monotonic id of the most recently STARTED archived load. A load whose id is
   * no longer the latest has been superseded and drops its result on the floor.
   *
   * The same guard `pipelinesStore` holds for the live list (`latestLoad`), and
   * needed here for the same reason: two loads can be in flight at once and they
   * apply in COMPLETION order, so a slower OLDER answer can overwrite a newer
   * one. The concrete sequence — open the view, close it before it answers,
   * archive a pipeline (which invalidates the cache), reopen (a second load
   * fires and lands correctly), then the FIRST load finally resolves carrying a
   * list from before the archive and overwrites it. The view then renders
   * "No archived pipelines" over a pipeline that genuinely is archived, and
   * nothing refetches to self-correct.
   *
   * That is the precise lie this view's status triple exists to prevent, on
   * the one surface that is the way back out of archive — so it is worth a
   * counter rather than a comment. Two rapid Unarchive clicks race the same way.
   */
  const latestArchivedLoad = useRef(0);

  /**
   * Invalidate the archived set: mark it stale AND supersede any load already
   * in flight. The bump is the load-bearing half. Without it a load issued
   * before the invalidation can still land afterwards, pass the staleness
   * guard (nothing moved the counter), and write `ready` over this `idle` —
   * after which reopening sees a non-idle status and never refetches, so the
   * pre-invalidation answer sticks permanently.
   */
  const invalidateArchived = useCallback(() => {
    latestArchivedLoad.current += 1;
    setArchivedStatus('idle');
    // Re-runs the opening effect even when the status was ALREADY `idle` — an
    // open view whose load this just superseded must fetch again, not sit at
    // "Loading…" with nothing in flight.
    setArchivedEpoch((n) => n + 1);
  }, []);

  /**
   * Fetch the archived set, reporting a failure AS a failure (never as empty).
   * Every setState is in a promise callback, so the opening effect below can
   * call it (the `set-state-in-effect` rule, as `useGuardedLoad`). Never
   * rejects.
   */
  const fetchArchived = useCallback(() => {
    const id = (latestArchivedLoad.current += 1);
    return listArchivedPipelines().then(
      (items) => {
        if (id !== latestArchivedLoad.current) return;
        setArchived(items);
        setArchivedStatus('ready');
        setArchivedError(null);
      },
      (err: unknown) => {
        // A superseded load's FAILURE is dropped too, not just its success: a
        // late rejection from an abandoned request must not bury the fresher
        // answer that replaced it under an error banner.
        if (id !== latestArchivedLoad.current) return;
        // The previous list is left in place: a refresh failure is not "we
        // know nothing", the same contract `pipelinesStore` holds for the live
        // list.
        setArchivedStatus('error');
        setArchivedError(`Could not load archived pipelines: ${messageOf(err)}`);
      },
    );
  }, []);

  /** Load the archived set from an event: says `loading` at once. */
  const loadArchived = useCallback(() => {
    setArchivedStatus('loading');
    setArchivedError(null);
    return fetchArchived();
  }, [fetchArchived]);

  /**
   * Whether the view is open, readable from an ASYNC callback. `onArchive`
   * runs across two awaits and must decide "refetch or invalidate" from
   * whether the view is open when it FINISHES, not when it was clicked —
   * the user can open or close it in between (the toggle, Back, a link). Reading the state variable there
   * closes over the click-time value, which chose `invalidate` for a view
   * that was open by the time the invalidation landed, leaving it at `idle`
   * while open: no rows, no error, no "Loading…", and nothing to refetch it.
   */
  const showArchivedRef = useRef(showArchived);
  useEffect(() => {
    showArchivedRef.current = showArchived;
  }, [showArchived]);

  /**
   * #1569 slice 3 — a pipeline created from the archived view is LIVE, and would
   * land out of sight, so the live list is shown. Only once the drawer has
   * CLOSED: until then its typed form is still holding route changes, and the
   * guard would block this one as though the operator were walking away.
   */
  const leaveArchivedRef = useRef(false);
  useEffect(() => {
    if (drawerForm !== null || !leaveArchivedRef.current) return;
    leaveArchivedRef.current = false;
    setSearchParams((prev) => withParams(prev, { [PIPELINE_FILTER_PARAMS.archived]: '' }));
  }, [drawerForm, setSearchParams]);

  // #1569 slice 2 — a push, so Back returns to the live list. Turning it on
  // drops the run, trigger and live-state filters: archived pipelines have none
  // of those facts, and the bar does not draw their controls there.
  const onToggleArchived = useCallback(
    () =>
      setSearchParams((prev) =>
        withParams(
          prev,
          readArchivedView(prev)
            ? { [PIPELINE_FILTER_PARAMS.archived]: '' }
            : {
                [PIPELINE_FILTER_PARAMS.archived]: '1',
                [PIPELINE_FILTER_PARAMS.last]: '',
                [PIPELINE_FILTER_PARAMS.triggers]: '',
                [PIPELINE_FILTER_PARAMS.live]: '',
              },
        ),
      ),
    [setSearchParams],
  );

  // Fetch on OPEN — a click, Back, or a link with `?archived=1` — and only when
  // there is nothing fresh to show: `idle` is both "never loaded" and
  // "invalidated by an archive". A closed view never fetches. Open and `idle`
  // renders as loading (`archivedLoading`), so the status need not move here.
  useEffect(() => {
    if (showArchived && archivedStatus === 'idle') void fetchArchived();
  }, [showArchived, archivedStatus, archivedEpoch, fetchArchived]);
  const archivedLoading =
    archivedStatus === 'loading' || (showArchived && archivedStatus === 'idle');

  /**
   * Archive: the soft-delete, and the ONLY way to retire a pipeline that has
   * ever run (`deletePipeline` is refused with a 409 once run history exists).
   *
   * The confirmation is where every consequence is named — the route discards
   * the `disabledTriggerIds` it computed, so nothing can be reported after the
   * fact even if we wanted to.
   */
  const onArchive = useCallback(
    (p: Pipeline, origin: RowMenuOrigin) =>
      runRemove(p.id, async () => {
        const confirmed = await confirm({
          message: archiveConfirmMessage(p.name),
          confirmLabel: 'Archive',
          restoreFocus: removalFocus(origin),
        });
        if (!confirmed) return;
        const forget = removingRow(p.id, origin);
        setActionMsg(null);
        try {
          await archivePipeline(p.id);
          // The row leaves the live list; the archived list it joins is now
          // stale. Refetch it when it is open, invalidate it when it is not.
          await refresh();
          if (showArchivedRef.current) await loadArchived();
          else invalidateArchived();
        } catch (err) {
          forget();
          setActionMsg(`Could not archive “${p.name}”: ${messageOf(err)}`);
        }
      }),
    [removalFocus, removingRow, runRemove, confirm, refresh, loadArchived, invalidateArchived],
  );

  /**
   * The way back. `restorePipeline` is the API verb; every string here says
   * UNARCHIVE, matching the canvas banner — "restore" already means restoring
   * an old VERSION on that screen (#903).
   */
  const onUnarchive = useCallback(
    async (p: Pipeline) => {
      setActionMsg(null);
      try {
        await restorePipeline(p.id);
        // Both lists change: the row leaves this one and rejoins the live one.
        await Promise.all([loadArchived(), refresh()]);
      } catch (err) {
        setActionMsg(`Could not unarchive “${p.name}”: ${messageOf(err)}`);
      }
    },
    [loadArchived, refresh],
  );

  const base = showArchived ? archived : pipelines;
  const rows = useMemo(
    () =>
      filterPipelines(
        sortPipelines(base, summaries?.byId, { key: sortKey, dir: sortDir }),
        (p) => {
          const state = versionStates?.get(p.id);
          return {
            summary: summaries?.byId.get(p.id),
            liveKeys:
              state === undefined
                ? undefined
                : liveStateKeys({ state, gitConnected, sync: gitSync }),
          };
        },
        filters,
      ),
    [base, summaries, sortKey, sortDir, versionStates, gitConnected, gitSync, filters],
  );
  const filtering = hasPipelineFilters(filters);
  const readOf = (value: unknown, failed: boolean): FactsRead =>
    value != null ? 'ready' : failed ? 'failed' : 'loading';
  // The archived view has no facts to wait for: search there is name and folder.
  const factsStatus: FactsRead = showArchived
    ? 'ready'
    : filterFactsStatus(filters, {
        summaries: readOf(summaries, readFailed.summaries),
        liveStates:
          filters.live === undefined
            ? 'ready'
            : liveFactsRead(filters.live, {
                states: readOf(versionStates, readFailed.states),
                git: readOf(gitConnected, readFailed.git),
                gitConnected,
                // `null` is the server's own fetch failing: no drift reading.
                sync: gitSync === null ? 'failed' : readOf(gitSync, readFailed.sync),
              }),
      });
  const folderOptions = useMemo(() => folderOptionsOf(base), [base]);

  const clearFilters = () => {
    setSearchText('');
    setSearchParams((prev) => withParams(prev, CLEARED_PIPELINE_FILTERS));
  };

  return (
    <section aria-labelledby="pipelines-heading" className="pipelines-page">
      <div className="page-header">
        <h2 id="pipelines-heading">Pipelines</h2>
        {/* #1569 slice 3 — the toolbar: each opens the drawer beside the list. */}
        <div className="pipelines-page__toolbar">
          <button
            ref={newButtonRef}
            type="button"
            className="primary"
            aria-disabled={drawerBusy}
            onClick={(e) => openFromToolbar(e.currentTarget, { kind: 'new', name: '', folder: '' })}
          >
            + New pipeline
          </button>
          <button
            type="button"
            aria-disabled={drawerBusy}
            onClick={(e) => openFromToolbar(e.currentTarget, { kind: 'import' })}
          >
            Import
          </button>
        </div>
      </div>

      {/* #1396 — the list and the drawer side by side; the drawer is a column,
          not an overlay, so the row actions stay reachable while it is open. */}
      {guard.routeHold}
      <div className={drawerForm ? 'drawer-layout-open' : undefined}>
        <div>
          {loadError && (
            <p className="error" role="alert">
              {loadError}
            </p>
          )}
          {/* The page needs its OWN recovery control. `ensureFresh` deliberately
          does not retry from `error`, and the Factory Resources pane's Retry
          can be put away — pane collapse is a persisted GLOBAL preference, and
          a collapsed pane is `hidden`, so it is neither clickable nor
          focusable. Without this, a failed first load with a collapsed pane
          left no in-app way back at all. */}
          {status === 'error' && (
            <p>
              <button type="button" onClick={() => void refresh()}>
                Retry
              </button>
            </p>
          )}
          {/* Every message this carries is a FAILURE — a create, an export or a
          delete that did not happen — so it announces as an alert, matching
          the other three surfaces that report an export failure. */}
          {actionMsg && (
            <p className="error" role="alert">
              {actionMsg}
            </p>
          )}

          {/* #1569 slice 2 — ONE row, the runs bar's conventions: each control
          keeps its label for assistive tech but draws none. Always drawn: not
          only when there are live rows (a workspace whose every pipeline is
          archived would have no way to reach them), and not only once a load
          has succeeded (the store reloads on every change, and the bar — with
          its Clear — would blink out under a filtered list). */}
          <div className="run-filters pipelines-filters" role="group" aria-label="Filter pipelines">
            <div role="search" className="pipelines-filters__search">
              <LabelledControl label={<span className="visually-hidden">Search pipelines</span>}>
                {(id) => (
                  <input
                    id={id}
                    type="search"
                    placeholder={
                      showArchived
                        ? 'Search name, folder…'
                        : 'Search name, description, annotations…'
                    }
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                  />
                )}
              </LabelledControl>
            </div>
            <FilterPicker
              label={<span className="visually-hidden">Filter by folder</span>}
              allLabel="All folders"
              value={filters.folder}
              options={folderOptions}
              onChange={(next) => setFilter(PIPELINE_FILTER_PARAMS.folder, next)}
            />
            {!showArchived && (
              <>
                <FilterMenu
                  label="Last run"
                  name="last"
                  values={LAST_RUN_FILTERS}
                  checked={filters.last}
                  labelOf={lastRunFilterLabel}
                  countNoun="statuses"
                  onChange={(items) => setFilter(PIPELINE_FILTER_PARAMS.last, lastRunParam(items))}
                />
                <LabelledControl label={<span className="visually-hidden">Triggers</span>}>
                  {(id) => (
                    <select
                      id={id}
                      value={filters.triggers ?? ''}
                      onChange={(e) => setFilter(PIPELINE_FILTER_PARAMS.triggers, e.target.value)}
                    >
                      <option value="">All triggers</option>
                      {TRIGGERS_FILTERS.map((t) => (
                        <option key={t} value={t}>
                          {TRIGGERS_FILTER_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  )}
                </LabelledControl>
                <LabelledControl label={<span className="visually-hidden">Live state</span>}>
                  {(id) => (
                    <select
                      id={id}
                      value={filters.live ?? ''}
                      onChange={(e) => setFilter(PIPELINE_FILTER_PARAMS.live, e.target.value)}
                    >
                      <option value="">All live states</option>
                      {LIVE_STATE_KEYS.map((k) => (
                        <option key={k} value={k}>
                          {LIVE_STATE_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  )}
                </LabelledControl>
              </>
            )}
            {/* #1058 — the way back out of archive, and out of an archive this
              page did NOT perform: a git import soft-archives every resource
              absent from the branch. "A refusal is safe exactly when the way
              back is reachable by the same person" (#907). */}
            <ToggleButton size="small" checked={showArchived} onClick={onToggleArchived}>
              Archived
            </ToggleButton>
            {/* "Clear" on screen to keep the bar one row; the accessible name
              keeps the whole phrase, and starts with the visible word. */}
            {filtering && (
              <button type="button" onClick={clearFilters} aria-label="Clear filters">
                Clear
              </button>
            )}
            {/* #1569 OR37 — the viewer's columns. The Archived view draws a fixed
              pair, so it has no picker. */}
            {!showArchived && <PipelineGridColumnsMenu sortKey={sort.key} ui={ui} />}
          </div>

          {showArchived && (
            <>
              {archivedError && (
                <p className="error" role="alert">
                  {archivedError}
                </p>
              )}
              {/* Its own Retry, for the same reason the live list has one: this
              view is the only in-app route back out of archive, so a failed
              load must not be a dead end. */}
              {archivedStatus === 'error' && (
                <p>
                  <button type="button" onClick={() => void loadArchived()}>
                    Retry loading archived
                  </button>
                </p>
              )}
              {archivedLoading && <p>Loading archived pipelines…</p>}
              {/* Gated on a load having SUCCEEDED — an empty list and a failed
              load are different facts, and this is the view where confusing
              them tells the operator their pipeline is gone. */}
              {archivedStatus === 'ready' && archived.length === 0 && <p>No archived pipelines.</p>}
            </>
          )}

          {/* Gated on a load having SUCCEEDED: an empty list and a failed load are
          different facts, and "no pipelines yet" is a lie about the second. */}
          {!showArchived && status === 'ready' && pipelines.length === 0 && (
            <p>No pipelines yet.</p>
          )}

          {/* Under a filter whose facts have not been read, every row is held back
          (a row never matches a fact nobody has) — so say that, rather than
          "no match", which would be a claim about the facts. */}
          {base.length > 0 && factsStatus === 'loading' && (
            <p className="page-hint">Loading run facts…</p>
          )}
          {base.length > 0 && factsStatus === 'failed' && (
            <p className="error" role="alert">
              Could not read the run facts these filters need.
            </p>
          )}
          {/* Only over a list known to be whole: not while facts are held back,
          and not over an archived list that is being re-read. */}
          {factsStatus === 'ready' &&
            !(showArchived && archivedLoading) &&
            filtering &&
            base.length > 0 &&
            rows.length === 0 && <p>No pipelines match the filters.</p>}

          {rows.length > 0 && (
            <PipelinesGrid
              pipelines={rows}
              summaries={showArchived ? undefined : summaries?.byId}
              loadedAt={summaries?.loadedAt}
              sort={sort}
              onSort={onSort}
              {...(showArchived ? { columns: ARCHIVED_COLUMNS } : {})}
              ui={ui}
              liveState={(p) => {
                const state = versionStates?.get(p.id);
                return state === undefined ? null : (
                  <RowStateBadge
                    pipelineName={p.name}
                    {...listRowBadge({ state, gitConnected, sync: gitSync })}
                  />
                );
              }}
              actions={(p) =>
                showArchived ? (
                  <RowMoreMenu
                    name={p.name}
                    actions={[{ label: 'Unarchive', onSelect: () => void onUnarchive(p) }]}
                  />
                ) : (
                  /* #1397 — the name is the row's one inline action; the rest are
                 in its menu. #1058: Archive stays in the same menu as Delete on
                 purpose. Delete is refused with a 409 the moment the pipeline
                 has run history, and `pipelineHasRunsMessage` (shared with the
                 Factory Resources pane, which has no Archive) names where
                 Archive is. Here it is the item above Delete. */
                  <RowMoreMenu
                    name={p.name}
                    actions={[
                      {
                        label: 'Export',
                        onSelect: () => void onExport(p),
                        disabled: exporting.has(p.id),
                      },
                      { label: 'Archive', onSelect: (origin) => void onArchive(p, origin) },
                    ]}
                    destructive={{
                      label: 'Delete',
                      onSelect: (origin) => void onDelete(p, origin),
                    }}
                  />
                )
              }
            />
          )}
        </div>

        {drawerForm?.kind === 'new' && (
          <NewPipelineDrawer
            key={drawerSeq}
            form={drawerForm}
            onChange={setDrawerForm}
            folderNames={liveFolderNames}
            guard={guard}
            returnFocusTo={openerRef}
            onClose={drawer.requestClose}
            onBusyChange={setDrawerBusy}
            onCreated={async () => {
              // Only when it is THIS drawer that closes: armed for a drawer
              // already replaced, the flag would fire on some later close.
              if (drawer.isLatest(drawerSeq)) leaveArchivedRef.current = showArchivedRef.current;
              drawer.closeIfLatest(drawerSeq);
              await refresh();
            }}
          />
        )}
        {drawerForm?.kind === 'import' && (
          <PipelineImportDrawer
            key={drawerSeq}
            guard={guard}
            returnFocusTo={openerRef}
            onClose={drawer.requestClose}
            onChanged={refresh}
            onBusyChange={setDrawerBusy}
          />
        )}
      </div>
      {confirmDialog}
    </section>
  );
}
