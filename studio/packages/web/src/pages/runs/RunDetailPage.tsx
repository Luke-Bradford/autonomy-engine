import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { computeRunUsage, TERMINAL_RUN_ROW_STATUS } from '@autonomy-studio/shared';
import type { PipelineVersion, Run, RunStatus } from '@autonomy-studio/shared';
import { useNavigate } from 'react-router';
import { useLatestSearchParams } from '../../lib/useLatestSearchParams';
import { cancelRun, getRun, getRunDetail, rerunFromFailed } from '../../api/runs';
import { messageOf } from '../../api/client';
import { owesCallback } from './externalWaits';
import { PendingCallbacks } from './PendingCallbacks';
import { canRerunFromFailed, RERUN_COST_WARNING } from './rerunAction';
import { RerunHistory } from './RerunHistory';
import { canCancelRun, cancelConfirmMessage } from './cancelAction';
import { runDetailPath } from './runPath';
import { useRunStream, type StreamPhase } from './useRunStream';
import {
  deriveNodeActivity,
  deriveRunLifecycle,
  reconcileNodeActivity,
  runLifecycleView,
  streamStillLive,
} from './runSummary';
import { eventGloss } from './format';
import { activityLabel, activityLabels } from '../pipeline/activityLabel';
import { runStatusLabel } from './runStatus';
import { AttemptTimeline } from './AttemptTimeline';
import { NodeActivityPanel } from './NodeActivityPanel';
import { drawerFileStem, type DrawerTab } from './drawerTab';
import { ActivityRunsTable, SkipWhy } from './ActivityRunsTable';
import { activityOfRow, attemptOutputLines, latestOutputByAttempt } from './attemptActivity';
import { iterationLabel } from './activityRunsColumns';
import { activityRunOfNode } from './activityRunsTree';
import { RunDrawer } from './RunDrawer';
import { RunHeader, type RunHeaderNames } from './RunHeader';
import { RunFailureBanner } from './RunFailureBanner';
import {
  FAILURE_BANNER_HOLD_MS,
  failedNodeId,
  runFailure,
  runFinished,
  runStartedAt,
} from './runFailure';
import { HelpDisclosure } from '../../lib/HelpDisclosure';
import { containerLabels } from '../pipeline/containerRules';
import { useActivityRuns } from './useActivityRuns';
import { RunCostSummary } from './RunCostSummary';
import { RunGlobals } from './RunGlobals';
import { RunVariables } from './RunVariables';
import { PanelTabs } from '../pipeline/PanelTabs';
import { withParams } from '../../lib/withParams';
import {
  readRunDetailTab,
  RUN_DETAIL_TAB_LABELS,
  runDetailTabParams,
  type RunDetailTab,
} from './runDetailTabs';
import { RunDiagnostics } from './RunDiagnostics';
import { RunGraph } from './RunGraph.lazy';
import { useRunProjection } from './useRunProjection';
import { runVersionPath } from '../author/pipelinePath';
import { useConfirm } from '../../lib/confirm/useConfirm';
import { shortId } from '../../lib/ids';
import { useShellLabel } from '../../shell/shellLabel';
import { useDisplayTimeZone } from '../../lib/useDisplayTimeZone';
import { formatTimeOfDay, zoneLabel } from '../../lib/displayTime';

/* The local `message(err)` this file used to declare was one of the twenty-odd
   inline copies `messageOf` was named to replace; `api/client.ts` asks each to
   migrate as its file is touched, so it did. */

/** Cap on the raw event feed's rendered rows (most recent kept) — bounds the
 * DOM on a chatty run. Node activity is still folded from the full log. */
const MAX_FEED_ROWS = 500;

/** A short, accessible label for the live-connection state. */
function phaseLabel(phase: StreamPhase): string {
  switch (phase) {
    case 'connecting':
      return 'connecting…';
    case 'replaying':
      return 'loading history…';
    case 'live':
      return '● live';
    case 'closed':
      return 'stream ended';
    case 'error':
      return 'stream error';
  }
}

/**
 * The live run monitor — the "watch it run live" MVP step. It fetches the run's
 * immutable metadata once (REST), then tails `run_events` over the WebSocket
 * (replay-then-live via `useRunStream`). Everything below the header is derived
 * PURELY from the event log, so the same code renders a finished run's history
 * and a running run's live feed identically:
 *   - the run's lifecycle status comes from the log (`deriveRunLifecycle`),
 *     falling back to the REST row until the first lifecycle event lands;
 *   - the activity runs light up as nodes dispatch and settle;
 *   - a raw event feed shows every append in order.
 */
export function RunDetailPage({ runId }: { runId: string }) {
  const zone = useDisplayTimeZone();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useLatestSearchParams();
  const detailTab = readRunDetailTab(searchParams);
  const [run, setRun] = useState<Run | null>(null);
  const [doc, setDoc] = useState<PipelineVersion | null>(null);
  // #1392 — the names R1 resolves alongside the doc. A `null` name (none the
  // owner may see), or no names at all on the fallback path (the doc would not
  // resolve), leaves the page showing ids, as it did before.
  // The names `/detail` resolves, in the header's own shape (`RunHeaderNames`).
  const [names, setNames] = useState<RunHeaderNames | null>(null);
  useShellLabel(names?.pipeline ? `${names.pipeline} · run ${shortId(runId)}` : undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  /* Whether this mount is still on screen, read by the rerun settle handlers.
     Set on mount rather than only cleared on unmount, so a StrictMode
     mount-unmount-remount leaves it TRUE rather than permanently false. */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  /**
   * RS2 — start a rerun-from-failed of THIS run and follow the new one.
   *
   * The server replies `202 { runId }` as soon as R2 is durably created; R2 then
   * drives in the background. So there is nothing to wait for beyond the
   * acknowledgement, and the right destination is R2's own page, where the live
   * tail takes over and shows the rerun actually happening.
   *
   * `rerunning` guards a double-click WITHIN one mount: without it a second
   * click before the request resolves would start a SECOND rerun, and unlike a
   * re-read that is not idempotent — it would spend money twice and leave an
   * orphan run. It does NOT survive a remount — `RunDetailRoute` keys this page
   * by `runId`, so leaving mid-flight and coming back yields a fresh mount with
   * the flag back to `false` and the button live again — and that is no longer
   * the last line of defence: since #896 the SERVER refuses a rerun of a source
   * run that already has a live one, so the second click gets a `409` naming the
   * rerun already in progress rather than a second bill. This flag now does what
   * it can honestly do (keep the button from firing twice in one mount, and show
   * the pending state); the money is guarded where a second tab and a bare
   * `curl` are covered too.
   *
   * `live` is why the settle handlers check before touching anything. The
   * component has three other ways to unmount while a request is open — the
   * "← All runs" link, the lineage links, and the browser's own back — and
   * react-router's `navigate` carries no unmount guard of its own (its active
   * flag is set in a layout effect with no cleanup). Without this check, a 202
   * landing after the operator has already walked away would yank them off the
   * runs list onto R2, which is a navigation nobody asked for.
   *
   * Failures are shown, not swallowed. A `409` here is the expected, meaningful
   * case (the server found the run ineligible after all) and its message is the
   * server's own sentence; anything else surfaces just as plainly rather than
   * leaving a button that silently did nothing. `async`/`try`/`catch` rather
   * than a two-argument `then`, matching `PipelinesPage.onDelete`: a throw from
   * the success path lands in the same `catch` instead of stranding the button
   * disabled with nothing said.
   */
  const onRerun = async () => {
    if (rerunning) return;
    setRerunning(true);
    setRerunError(null);
    try {
      const { runId: newRunId } = await rerunFromFailed(runId);
      if (live.current) void navigate(runDetailPath(newRunId));
    } catch (err: unknown) {
      if (!live.current) return;
      setRerunError(messageOf(err));
      setRerunning(false);
    }
  };

  // `RunDetailRoute` renders this with `key={runId}`, so a different run
  // remounts the component fresh (state back to null) rather than us resetting
  // state synchronously in the effect body — the effect only performs the fetch.
  useEffect(() => {
    const ac = new AbortController();
    getRunDetail(runId, ac.signal)
      .then((d) => {
        setRun(d.run);
        setDoc(d.pipelineVersion);
        setNames({
          pipeline: d.pipelineName,
          trigger: d.triggerName,
          debug: d.debug,
          triggeredByKind: d.triggeredByKind,
          parentPipelineName: d.parentPipelineName,
          parentActivity: null,
        });
        /* #1541 — the activity that called this run, named as the PARENT's
           editor names it, so against the parent's version: `/detail` gives
           its id, and naming is this layer's (`activityLabels`). A parent that
           will not read leaves the id itself, never a blank. */
        const callerId = d.parentActivityId;
        if (d.run.parentRunId === null || callerId === null) return;
        const named = (parentActivity: string) =>
          setNames((prev) => (prev === null ? prev : { ...prev, parentActivity }));
        void getRunDetail(d.run.parentRunId, ac.signal)
          .then((p) => activityLabels(p.pipelineVersion.nodes).get(callerId) ?? callerId)
          .catch(() => callerId)
          .then((name) => {
            if (!ac.signal.aborted) named(name);
          });
      })
      .catch((detailErr: unknown) => {
        if (ac.signal.aborted) return;
        /* R1 resolves the run AND its doc together, so a doc that will not
           resolve (409 — deleted, or present but no longer parsing) would
           otherwise cost the operator the run's metadata, the activity runs and the
           event feed as well. None of those need the doc, and a run whose graph
           is gone is exactly when they matter most — `terminalFactFromLog`
           records the same preference on the server. So fall back to the plain
           run read; only if THAT fails is the page genuinely empty. */
        return getRun(runId, ac.signal).then(
          (r) => {
            setRun(r);
            setLoadError(
              `The pipeline graph could not be loaded, so there is no node overlay: ${messageOf(detailErr)}`,
            );
          },
          () => {
            if (ac.signal.aborted) return;
            setLoadError(messageOf(detailErr));
          },
        );
      });
    return () => ac.abort();
  }, [runId]);

  const stream = useRunStream(runId);

  /* U25 — ONE projection for the whole page. The Graph tab takes this same
     overlay rather than folding the log a second time inside its lazy chunk,
     and the per-node record (the timeline, the run's spend, the cancel
     confirmation) reconciles against it, so neither surface can invent a
     status the other does not have: they read one value.

     They can still SAY different amounts about one node, and the honest
     statement of the guarantee is narrower than "they agree". A parallel
     foreach's body node has no bare-id entry in `state.nodes` at all, so the
     graph draws it with no status while the table shows the fold's — the graph
     is silent, not contradictory, and the table is the better-informed of the
     two. That predates U25 (`runFlow.ts` reads `state.nodes[n.id]` directly)
     and is #439 UI work, not a reconciliation bug. */
  const overlay = useRunProjection(doc, stream);
  const folded = useMemo(() => deriveNodeActivity(stream.events), [stream.events]);
  const nodes = useMemo(
    /* When the engine has an opinion it wins, and it brings the rows the log
       alone cannot produce — a node that never started, and a node routed
       AROUND (which the reducer computes and appends no event for, so the fold
       structurally cannot show it). Without a trustworthy projection the
       doc-free fold stands on its own, which is the case a run whose version no
       longer resolves has always depended on. */
    () => (overlay.ready ? reconcileNodeActivity(folded, overlay.state) : folded),
    [folded, overlay],
  );
  const lifecycle = useMemo(() => deriveRunLifecycle(stream.events), [stream.events]);
  /* U27 (#930) — what the whole run spent. Folded INDEPENDENTLY of `folded`
     rather than summed out of its per-node `cost` map, and the difference is a
     money one: `deriveNodeActivity` drops an `activity.metered` event whose node
     has no row (documented unreachable, but a drop nonetheless), whereas this
     counts every metered row in the log — the same set `GET /api/runs/:id/cost`
     sums, so the page and the route cannot disagree about spend.

     A FIFTH walk of the log on this page (#849 — see `waitEpoch` above). It rides
     the same memoized `stream.events` and belongs in #849's consolidation, not
     ahead of it.

     It is the one walk that cannot share `parseEngineEvent`'s memo: `computeRunUsage`
     lives in `shared` (the cost route folds through it too) and takes bare
     `{ payload: unknown }` rows, not `RunEvent`s. So the rows are narrowed BEFORE
     the call instead, which is the same saving by a different route — the fold
     already discards every non-`activity.metered` row (`run-cost.ts`), and it is
     sound to pre-filter on the envelope's `type` column because the append path
     writes that column FROM the validated payload
     (`appendEngineEvent`: `{ type: parsed.type, payload: parsed }`). `waitEpoch`
     below already reads the log the same way. */
  const runUsage = useMemo(
    () => computeRunUsage(stream.events.filter((e) => e.type === 'activity.metered')),
    [stream.events],
  );

  /* #882 — the ONE name a node has in this view. The Graph tab reads the same
     `activityLabels` map off the same doc, so the table and the picture in that
     tab cannot come to call one node two things.

     Two cases have no name and are not given an invented one.

     `doc` is null whenever the bound version will not resolve, which this page
     is built to survive (U11) — the whole table still renders, from the doc-free
     fold. That is the common one.

     The other is narrower than it first looks, and worth stating exactly rather
     than hand-waving at "the lists differ". A RERUN cannot cause it: `reseed`
     pins R1's own `pipelineVersionId` and versions are immutable, so a rerun's
     rows are always the bound doc's nodes. What can is the instance-key fold —
     `deriveNodeActivity` folds a parallel foreach's `w@1`/`w@2` events onto the
     canvas node `w`, and a doc carrying a LITERAL node id shaped `x@2` is folded
     onto `x` with it (`runSummary.ts` records this, and save-time refuses such
     ids only for parallel docs). A doc with `x@2` and no `x` therefore yields a
     row `x` that this map cannot name.

     Both fall back to the raw id — the fold key, which is what the event feed
     below is keyed on and so still leads somewhere, even in the `x@2` case where
     it names no doc node. A placeholder would be a THIRD name for the same node,
     which is the defect this closes rather than a smaller version of it. */
  const nodeNames = useMemo(() => (doc === null ? null : activityLabels(doc.nodes)), [doc]);
  const nameOf = (nodeId: string) => nodeNames?.get(nodeId) ?? null;
  const nodeTypes = useMemo(
    () => (doc === null ? null : new Map(doc.nodes.map((n) => [n.id, activityLabel(n)]))),
    [doc],
  );
  const typeOf = (nodeId: string) => nodeTypes?.get(nodeId) ?? null;

  /* #870 — the RUN's status and, when it is parked, WHY. The precedence is
     `runLifecycleView`'s, shared with the editor's run overlay (#1395). */
  const view = useMemo(() => runLifecycleView(lifecycle, overlay), [lifecycle, overlay]);

  const status: RunStatus = view?.status ?? run?.status ?? 'pending';
  /* The REST row carries no park reason (`RunSchema` has no such column), so
     the fallback tail is `null` rather than a guess — see `runStatusLabel`. */
  const waitingReason = view?.waitingReason ?? null;
  /* #890 — whether a running node's Duration may COUNT UP. Only while this page
     would hear the node settle: the socket open with its replay complete
     (`live` is set only after `replay_complete`, so a truncated log never
     counts), and the run not yet terminal. The run clause covers the moment
     between a terminal event and the server's close, and a finished or
     cancelled run's never-closed span, which must not tick forever. The ROW
     set, as `settled` below, because `status` can fall back
     to the REST row's `queued`/`skipped`. */
  const countingLive = streamStillLive(stream.phase, status);
  /* Whether the run has ended, for the sections that say "so far" or "final".
     The ROW-status set, not the lifecycle one: `status` falls back to
     `run.status`, which can be `queued` or `skipped` — neither of which the
     lifecycle set knows about. See `TERMINAL_RUN_ROW_STATUS`. */
  const settled = TERMINAL_RUN_ROW_STATUS.has(status);
  /* #1484 M2 — the activity runs, re-read as the log grows, and while a run
     this one called is still going and the page would hear this run settle. */
  const lastSeq = stream.events.at(-1)?.seq;
  const activityRuns = useActivityRuns(runId, lastSeq, countingLive);
  /* #1484 M2 — when the run ended and why. The `run.finished` event as well as
     the row's stamp, because the row was read once and the run may have ended
     since. */
  const finished = useMemo(() => runFinished(stream.events), [stream.events]);
  const endedAt = run?.finishedAt ?? finished?.ts ?? null;
  // The log's start, which a run admitted from the queue since the row was read
  // has and the row does not (its `startedAt` was the enqueue placeholder).
  const loggedStart = useMemo(() => runStartedAt(stream.events), [stream.events]);
  const streamEnded = stream.phase === 'closed' || stream.phase === 'error';
  /* #1541 — a FAILED run's activity runs are read after its log, throttled, so
     for a read cycle they can be older than it: the banner would name no row
     (no Show activity) or an earlier attempt's error. It waits for rows read at
     the log's newest event, for at most `FAILURE_BANNER_HOLD_MS` once the run
     has finished. A failed read releases it at once. */
  const rowsBehind =
    status === 'failure' &&
    finished !== null &&
    lastSeq !== undefined &&
    activityRuns.error === null &&
    (activityRuns.readAt === null || activityRuns.readAt < lastSeq);
  const [holdLapsed, setHoldLapsed] = useState(false);
  useEffect(() => {
    if (!rowsBehind || holdLapsed) return;
    const timer = setTimeout(() => setHoldLapsed(true), FAILURE_BANNER_HOLD_MS);
    return () => clearTimeout(timer);
  }, [rowsBehind, holdLapsed]);
  /* The failure banner, on a FAILED run only. It names what the log blames, so
     it waits for the projected state the container walk needs, unless that
     will never come (the stream has ended, or the version will not resolve).
     A failed run whose log never says why (a truncated log, or the REST
     fallback) still gets a banner, saying only that it failed. */
  const failure = useMemo(() => {
    if (status !== 'failure') return null;
    if (finished === null) return streamEnded ? runFailure(null, null, null) : null;
    if (!overlay.ready && !streamEnded && loadError === null) return null;
    if (rowsBehind && !holdLapsed) return null;
    return runFailure(
      finished.reason,
      overlay.ready ? overlay.state.containers : null,
      activityRuns.rows,
    );
  }, [
    status,
    finished,
    streamEnded,
    overlay,
    loadError,
    rowsBehind,
    holdLapsed,
    activityRuns.rows,
  ]);
  /* A container has no node label, so the banner names one by its container
     label, as the editor does. */
  const containerNames = useMemo(
    () => (doc === null ? null : containerLabels(doc.containers)),
    [doc],
  );
  // #1484 M2 — the row "Show activity" asked for; a new object per ask.
  const [selectedRow, setSelectedRow] = useState<{ key: string } | null>(null);
  /* #1484 M2 — the activity run the detail drawer shows. Held as the row's key
     and resolved against the latest read, so the drawer follows a running
     attempt and closes if its row goes. */
  const [drawer, setDrawer] = useState<{
    key: string;
    opener: HTMLElement;
    /** Which open this is: every open mounts the drawer afresh, so it takes
     * focus and hands it back to THIS opener, even when the row was already
     * open from somewhere else (its graph node, then "Show activity"). */
    n: number;
  } | null>(null);
  const opens = useRef(0);
  const openDrawer = useCallback((key: string, opener: HTMLElement) => {
    opens.current += 1;
    setDrawer({ key, opener, n: opens.current });
  }, []);
  const drawerRow = activityRuns.rows?.find((r) => r.key === drawer?.key) ?? null;
  const drawerNode = useMemo(
    () => (drawerRow === null ? null : activityOfRow(stream.events, folded, drawerRow)),
    [drawerRow, stream.events, folded],
  );
  const drawerAttemptId = drawerRow?.attemptId ?? null;
  const drawerLines = useMemo(
    () => (drawerAttemptId === null ? [] : attemptOutputLines(stream.events, drawerAttemptId)),
    [drawerAttemptId, stream.events],
  );
  /* #1484 M2 — a graph node opens its activity run in the same drawer, and the
     open record's node is marked on the graph whichever way it was opened. The
     row is chosen at the click from the latest read (`activityRunOfNode`), held
     in a ref so the open callback keeps one identity across reads. A graph open
     does not touch the table: the open row says so itself (`data-open`), and
     expanding or scrolling a table the operator is not looking at would move
     the page out from under the graph. */
  const latestRows = useRef(activityRuns.rows);
  useLayoutEffect(() => {
    latestRows.current = activityRuns.rows;
  });
  const openNode = useCallback(
    (nodeId: string, opener: HTMLElement) => {
      const row = activityRunOfNode(latestRows.current ?? [], nodeId);
      if (row === null) return;
      setSelectedRow(null);
      openDrawer(row.key, opener);
    },
    [openDrawer],
  );
  const closeDrawer = () => {
    setDrawer(null);
    setSelectedRow(null);
  };
  /* The nodes with a run to open. Every read is a new array, so the set is
     keyed on its contents: the canvas hands it to every node through context,
     and a new set per read would re-render each one. */
  const openableKey = useMemo(
    () => [...new Set((activityRuns.rows ?? []).map((r) => r.activityId))].sort().join('\n'),
    [activityRuns.rows],
  );
  const openableNodeIds = useMemo(
    () => new Set(openableKey === '' ? [] : openableKey.split('\n')),
    [openableKey],
  );
  /* The drawer tab the operator picked, held here so stepping from row to row
     keeps it; `null` until they pick one, so each row opens on its error or its
     output (`defaultDrawerTab`). Close keeps it too. */
  const [drawerTab, setDrawerTab] = useState<DrawerTab | null>(null);
  const latestOutputs = useMemo(() => latestOutputByAttempt(stream.events), [stream.events]);
  const drawerIteration = (() => {
    const it = drawerRow?.iteration ?? null;
    if (it === null) return '';
    return iterationLabel(
      activityRuns.groups.find((g) => g.containerId === it.containerId)?.kind,
      it,
    );
  })();

  /* CX4 (#1320) — "Cancelling…": the cancel is FOLDED (the log carries
     `run.cancelRequested`) but the run has not finished, because in-flight work
     drains first (spec D2). Read off the log, never off the 202: a `requested`
     answer means the intent was accepted, and only the fold means the run will
     actually stop — an intent lost with a crashed process leaves the run
     running exactly as if nobody had cancelled (D6/D7), and the page must not
     claim otherwise. */
  const cancelling = canCancelRun(status) && view?.cancelRequested === true;
  /* A parent parked on a live child finishes once that child's own cancel has
     (CX3, spec D8), so the page says why "Cancelling…" may last a moment. */
  const cancelWaitsOnChild = cancelling && nodes.some((n) => n.status === 'waiting');

  /**
   * CX4 (#1320) — cancel THIS run, after a confirmation that names what stops.
   *
   * Confirmed like every other destructive action in the app, through
   * `useConfirm` (#1397). The text is built from the page's per-node record, so
   * it names what is in progress in the words the page's status pills use.
   * The dismiss button says "Keep running": [Cancel] beside [Cancel run] would
   * not say which one leaves the run alone.
   *
   * Unlike `window.confirm`, the dialog does not freeze the stream while it is
   * open, so the run can end — or a listed node finish — before the answer. The
   * list is the moment of asking, and the server is the authority: a cancel of a
   * run that has meanwhile ended is a `409 conflict` saying so, shown as the
   * cancel error rather than as a cancel that happened.
   *
   * A second cancel is harmless — the server answers `202` and appends nothing
   * (D5) — so `cancelBusy` only keeps one mount from sending two requests and
   * shows the pending state; it is not guarding money the way `rerunning` is.
   *
   * `cancelled` is the QUEUED case: the server cancelled the row by a patch and
   * no event will ever tail in, so the row is re-read to show it. `requested`
   * needs nothing — the fold arrives over the stream.
   *
   * The re-read is NOT part of the cancel's success. If it fails, the cancel
   * still happened — the `202` said so — so the row is patched to the status the
   * server reported rather than raising a "cancel failed" alert over a cancel
   * that worked and putting the button back on a run that is gone.
   */
  const onCancel = async () => {
    if (cancelBusy) return;
    const message = cancelConfirmMessage(
      nodes.map((n) => ({ name: nameOf(n.nodeId) ?? n.nodeId, status: n.status })),
    );
    if (!(await confirm({ message, confirmLabel: 'Cancel run', cancelLabel: 'Keep running' }))) {
      return;
    }
    setCancelBusy(true);
    setCancelError(null);
    try {
      const { state } = await cancelRun(runId);
      if (state === 'cancelled') {
        const fresh = await getRun(runId).catch(() => null);
        if (live.current) {
          setRun((prev) => fresh ?? (prev && { ...prev, status: 'cancelled' }));
        }
      }
    } catch (err: unknown) {
      if (live.current) setCancelError(messageOf(err));
    } finally {
      if (live.current) setCancelBusy(false);
    }
  };

  /* #900 — whether this run owes an inbound callback, and a tick that changes
     whenever the set of pending ones does.

     Gated on the waiting REASON, not the bare `waiting` status. A `wait`-timer park
     is equally `waiting` and owes no callback, so the status alone would fire a
     request on every timer park and then render an empty section under a heading
     claiming a callback is owed. The reducer gives `waiting_external` precedence
     when a run is parked on both, so the reason loses no case. */
  const parkedOnCallback = owesCallback(waitingReason);

  /* The tick counts EVERY event that changes the pending set — created, completed
     AND expired — and all three are load-bearing. It is the `key` of the section
     below, so a change to it REMOUNTS that component: fresh list, cleared error,
     and no revealed token surviving the wait it belonged to.

     Counting only `created` was the first cut, and it was wrong. Two webhooks in
     SEQUENCE is the easy case it did handle: one completes and the next parks, and
     those frames can arrive in one stream batch, so React may never render the
     un-parked state in between and a `parkedOnCallback` dep alone would not
     re-fire. Two webhooks in PARALLEL is the case it could not see at all — a fork,
     or a `foreach` webhook body, which this surface explicitly supports. Completing
     one leaves the OTHER parked, so `parkReason` answers `waiting_external` again
     and the run re-parks with NO new `externalWait.created`: the tick would not
     move, the list would never be re-asked, and the completed wait's dead token
     would stay on screen — the exact failure the tick exists to prevent.

     A fourth walk of the log on this page (#849 — it already folds three times a
     frame); this one is a bare counter rather than a fold, and it rides the same
     memoized `stream.events`. It belongs in #849's consolidation, not ahead of it. */
  const waitEpoch = useMemo(
    () =>
      stream.events.reduce(
        (n, e) =>
          e.type === 'externalWait.created' ||
          e.type === 'externalWait.completed' ||
          e.type === 'externalWait.expired'
            ? n + 1
            : n,
        0,
      ),
    [stream.events],
  );

  /* #901 — the callback bodies the operator is part-way through typing, keyed by
     `waitKey`. Lives HERE rather than in `PendingCallbacks` because that component
     is deliberately remounted on every `waitEpoch` change, and a remount must not
     take unsaved input with it: with two parallel waits open, an external caller
     settling one would otherwise wipe what was typed into the other. Presence of a
     key also means "that editor is open" — see `PendingCallbacks`' docblock.

     Not pruned when a wait settles. A draft for a key nothing renders costs one
     string and is unreachable; pruning it would mean reconciling this map against
     every list refresh, which is precisely the hand-rolled freshness protocol the
     epoch key exists to avoid. */
  const [waitDrafts, setWaitDrafts] = useState<Record<string, string>>({});

  // The raw feed is capped to the most recent rows so a chatty run (thousands of
  // `node.output` frames) can't grow the DOM without bound; node activity above
  // is still folded from the FULL log, so nothing is lost from the summary.
  const totalEvents = stream.events.length;
  const feed = useMemo(
    () => (totalEvents > MAX_FEED_ROWS ? stream.events.slice(-MAX_FEED_ROWS) : stream.events),
    [stream.events, totalEvents],
  );

  /* The Graph tab's content, and nothing while another tab is open (see the
     run views below). */
  const graphView =
    detailTab !== 'graph' ? null : doc === null ? (
      <p>
        {loadError === null
          ? 'Loading the pipeline graph…'
          : 'The pipeline graph is unavailable, so there is no node overlay. The event feed is unaffected.'}
      </p>
    ) : (
      /* #698 — React Flow loads on demand, so the run metadata, activity
         runs and event feed paint without waiting on it. The boundary is HERE
         rather than at the route for that reason: all of that is useful
         without the graph. */
      <Suspense fallback={<p className="page-hint">Loading the graph…</p>}>
        <RunGraph
          doc={doc}
          overlay={overlay}
          activity={nodes}
          selectedNodeId={drawerRow?.activityId}
          onOpenNode={openNode}
          openableNodeIds={openableNodeIds}
        />
      </Suspense>
    );

  return (
    <section aria-labelledby="run-heading" className="run-page">
      <RunHeader
        runId={runId}
        run={run}
        doc={doc}
        names={names}
        status={status}
        startedAt={loggedStart ?? run?.startedAt ?? 0}
        statusPill={
          <>
            {cancelling ? (
              <span className="run-status run-status-cancelling">Cancelling…</span>
            ) : (
              <span className={`run-status run-status-${status}`}>
                {runStatusLabel(status, waitingReason)}
              </span>
            )}{' '}
            <span className={`stream-phase stream-phase-${stream.phase}`} role="status">
              {phaseLabel(stream.phase)}
            </span>
          </>
        }
        endedAt={endedAt}
        counting={countingLive}
        actions={
          <>
            {/* RS2 — the rerun action, offered only on a run that FAILED. The
                spec's cost warning is the button's accessible description and
                its `?` help (#1484 principle 1: explanations live in help, not
                in prose on the page), so the header stays one band. */}
            {canRerunFromFailed(status) && (
              <>
                <button
                  type="button"
                  onClick={() => void onRerun()}
                  disabled={rerunning}
                  aria-describedby="rerun-cost-warning"
                >
                  {rerunning ? 'Starting rerun…' : 'Rerun from failed'}
                </button>
                <HelpDisclosure
                  label="About rerunning from the failure"
                  noteId="rerun-cost-warning"
                >
                  {RERUN_COST_WARNING}
                </HelpDisclosure>
              </>
            )}
            {/* CX4 (#1320) — the cancel action, on any run that has not ended
                (D5), and withdrawn once the cancel is folded: the run is then
                already stopping, and the header says so. */}
            {canCancelRun(status) && !cancelling && (
              <button type="button" onClick={() => void onCancel()} disabled={cancelBusy}>
                {cancelBusy ? 'Cancelling…' : 'Cancel run'}
              </button>
            )}
          </>
        }
      />
      {failure !== null && (
        <RunFailureBanner
          failure={failure}
          nameOf={(id) => nameOf(id) ?? containerNames?.get(id) ?? null}
          versionHref={
            doc === null || names === null
              ? null
              : runVersionPath(
                  doc.pipelineId,
                  doc.version,
                  names.debug,
                  failure.kind === 'run' ? undefined : failedNodeId(failure),
                )
          }
          onShowActivity={(key, opener) => {
            // Takes the reader to the row, and opens it.
            setSelectedRow({ key });
            openDrawer(key, opener);
          }}
        />
      )}
      {cancelWaitsOnChild && (
        <p className="page-hint">
          Waiting for a child run to stop — it is being cancelled too, and this run stops once it
          has.
        </p>
      )}
      {cancelError && (
        <p role="alert" className="error">
          {cancelError}
        </p>
      )}
      {rerunError && (
        <p role="alert" className="error">
          {rerunError}
        </p>
      )}

      {loadError && (
        <p role="alert" className="error">
          {loadError}
        </p>
      )}
      {stream.phase === 'error' && stream.error && (
        <p role="alert" className="error">
          {stream.error}
        </p>
      )}

      {/* #900 — the parked-on-a-callback surface. Rendered only for an EXTERNAL
          park, so it never appears over a timer wait, and KEYED on the wait epoch
          so any change to the pending set remounts it (see `waitEpoch` above —
          that key is the component's entire freshness model). */}
      {parkedOnCallback && (
        <PendingCallbacks
          key={waitEpoch}
          runId={runId}
          doc={doc}
          nameOf={nameOf}
          drafts={waitDrafts}
          onDraftChange={(key, value) => setWaitDrafts((d) => ({ ...d, [key]: value }))}
          onDraftClear={(key) =>
            setWaitDrafts((d) => {
              const rest = { ...d };
              delete rest[key];
              return rest;
            })
          }
        />
      )}

      {/* #1484 OR35 M2 — the activity runs, directly under the run's header and
          any action the operator has to take, so the first thing below the run
          is what each activity did. A row opens the detail drawer. */}
      <ActivityRunsTable
        rows={activityRuns.rows}
        groups={activityRuns.groups}
        basis={activityRuns.basis}
        error={activityRuns.error}
        runStatus={status}
        nameOf={nameOf}
        typeOf={typeOf}
        containerNameOf={(id) => containerNames?.get(id) ?? null}
        selected={selectedRow}
        live={countingLive}
        openKey={drawerRow?.key ?? null}
        onOpen={(key, opener) => {
          // The row opened is the one marked; an earlier ask's outline goes.
          setSelectedRow(null);
          openDrawer(key, opener);
        }}
        latestOutputs={latestOutputs}
      />

      {/* The run's inputs and its downward rerun lineage (RS6): facts about the
          run that the header has no room for, below the activity runs. */}
      {run && (
        <dl className="run-meta">
          <dt>Params</dt>
          <dd>
            <code>{JSON.stringify(run.params)}</code>
          </dd>
          <RerunHistory runId={run.id} />
        </dl>
      )}

      {/* #1484 OR35 M2 — the run's secondary views, as tabs below the activity
          runs (principle 2: the table is the primary view). The tab is in the
          URL, so a link to a run's events opens on them. `PanelTabs` keeps every
          panel mounted, so a tab switch does not re-read the diagnostics or
          rebuild the feed — except the graph, which mounts only while its tab is
          open: React Flow measures its container to fit the view, and a hidden
          panel measures zero. That costs the graph its pan and zoom on a switch.
          The wrapper lifts the dock's form-width cap off these panels. */}
      <div className="run-views">
        <PanelTabs<RunDetailTab>
          label="Run views"
          selected={detailTab}
          onSelect={(next) => setSearchParams((prev) => withParams(prev, runDetailTabParams(next)))}
          tabs={[
            {
              key: 'gantt',
              label: RUN_DETAIL_TAB_LABELS.gantt,
              /* U12a (#1007) — each node's attempts on a shared time axis. */
              content:
                nodes.length > 0 ? (
                  <AttemptTimeline nodes={nodes} nameOf={nameOf} runStatus={status} />
                ) : (
                  <p className="page-hint">
                    {overlay.ready ? 'No activity has started.' : overlay.reason}
                  </p>
                ),
            },
            {
              key: 'graph',
              label: RUN_DETAIL_TAB_LABELS.graph,
              content: graphView,
            },
            {
              key: 'events',
              label: RUN_DETAIL_TAB_LABELS.events,
              content: (
                <>
                  {/* #1065 — the reducer's explanations, above the raw decision
                    log they explain: the only section that answers "why".
                    Rendered unconditionally — "the reducer neutralized nothing"
                    is itself a fact worth stating. */}
                  <RunDiagnostics runId={runId} settled={settled} />
                  {totalEvents === 0 ? (
                    <p>No events yet.</p>
                  ) : (
                    <table className="event-feed">
                      <thead>
                        <tr>
                          <th scope="col">Seq</th>
                          {/* Clock times only, so the zone is named once, here. */}
                          <th scope="col">
                            Time{feed.length > 0 ? ` (${zoneLabel(feed[0]!.ts, zone)})` : ''}
                          </th>
                          <th scope="col">Type</th>
                          <th scope="col">Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {totalEvents > MAX_FEED_ROWS && (
                          <tr>
                            <td colSpan={4}>
                              … showing the most recent {MAX_FEED_ROWS} of {totalEvents} events
                            </td>
                          </tr>
                        )}
                        {feed.map((e) => (
                          <tr key={e.seq}>
                            <td>{e.seq}</td>
                            <td>{formatTimeOfDay(e.ts, zone, 'ms')}</td>
                            <td>
                              <code>{e.type}</code>
                            </td>
                            <td>{eventGloss(e)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              ),
            },
            {
              key: 'variables',
              label: RUN_DETAIL_TAB_LABELS.variables,
              /* #844 V7 / GL5 — the run's variables and the globals it read, from
               the same one projection the graph and the drawer read. Each says
               why it is absent, since the reader opened this tab to look. */
              content: (
                <>
                  <RunVariables
                    declared={doc?.variables}
                    overlay={overlay}
                    settled={settled}
                    empty={
                      <p className="page-hint">
                        {doc === null
                          ? 'The pipeline version is not loaded, so its variables are not shown.'
                          : 'This pipeline declares no variables.'}
                      </p>
                    }
                  />
                  {/* The snapshot is taken at `run.started`, so "none" waits for
                      it: a queued run has not got there yet, and a skipped one
                      never will. */}
                  <RunGlobals
                    overlay={overlay}
                    empty={
                      stream.events.some((e) => e.type === 'run.started') ? (
                        <p className="page-hint">This run read no global parameters.</p>
                      ) : null
                    }
                  />
                </>
              ),
            },
            {
              key: 'cost',
              label: RUN_DETAIL_TAB_LABELS.cost,
              /* U27 (#930) — the run-level spend. Rendered unconditionally — see
               `RunCostSummary`, which owns every "should this say anything"
               decision so the page cannot make a second one. */
              content: (
                <RunCostSummary
                  usage={runUsage}
                  nodes={nodes}
                  settled={settled}
                  replayComplete={stream.replayComplete}
                  logTruncated={
                    (stream.phase === 'closed' || stream.phase === 'error') &&
                    !stream.replayComplete
                  }
                />
              ),
            },
          ]}
        />
      </div>
      {drawerRow !== null && drawerNode !== null && (
        <RunDrawer
          key={`${drawerRow.key}:${drawer?.n}`}
          onClose={closeDrawer}
          returnFocusTo={drawer?.opener ?? null}
        >
          <NodeActivityPanel
            node={drawerNode}
            name={nameOf(drawerRow.activityId)}
            runStatus={status}
            live={countingLive}
            onClose={closeDrawer}
            tab={drawerTab}
            onTab={setDrawerTab}
            fileStem={drawerFileStem([
              'run',
              shortId(runId),
              nameOf(drawerRow.activityId) ?? drawerRow.activityId,
              drawerRow.attempt === null ? '' : `attempt ${drawerRow.attempt}`,
              drawerIteration,
            ])}
            run={{
              attempt: drawerRow.attempt,
              iteration: drawerIteration,
              lines: drawerLines,
              skipWhy: (
                <SkipWhy
                  status={drawerRow.status}
                  reason={drawerRow.skipReason}
                  nameOf={(id) => nameOf(id) ?? containerNames?.get(id) ?? null}
                />
              ),
            }}
          />
        </RunDrawer>
      )}
      {confirmDialog}
    </section>
  );
}
