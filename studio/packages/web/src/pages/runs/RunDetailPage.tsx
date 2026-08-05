import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { TERMINAL_RUN_STATUS } from '@autonomy-studio/shared';
import type { PipelineVersion, Run, RunStatus } from '@autonomy-studio/shared';
import { useNavigate } from 'react-router';
import { getRun, getRunDetail, rerunFromFailed } from '../../api/runs';
import { messageOf } from '../../api/client';
import { owesCallback } from './externalWaits';
import { PendingCallbacks } from './PendingCallbacks';
import { canRerunFromFailed, RERUN_COST_WARNING } from './rerunAction';
import { runDetailPath } from './runPath';
import { useRunStream, type StreamPhase } from './useRunStream';
import {
  deriveNodeActivity,
  deriveRunLifecycle,
  reconcileNodeActivity,
  type RunLifecycle,
} from './runSummary';
import { eventGloss, failureClass, formatClock, formatNodeDuration, formatWhen } from './format';
import { activityLabels } from '../pipeline/activityLabel';
import { nodeStatusLabel } from './nodeStatus';
import { runStatusLabel } from './runStatus';
import { NodeActivityPanel, PANEL_ID } from './NodeActivityPanel';
import { RunGraph } from './RunGraph.lazy';
import { useRunProjection } from './useRunProjection';

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
 *   - a per-node activity table lights up as nodes dispatch and settle;
 *   - a raw event feed shows every append in order.
 */
export function RunDetailPage({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [doc, setDoc] = useState<PipelineVersion | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

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
   * orphan run. It does NOT survive a remount, which is a real residual and is
   * filed rather than implied: `RunDetailRoute` keys this page by `runId`, so
   * leaving the page and coming back mid-flight yields a fresh mount with the
   * flag back to `false` and the button live again (#896).
   *
   * `live` is why the settle handlers check before touching anything. The
   * component has three other ways to unmount while a request is open — the
   * "← All runs" button, the lineage link, and the browser's own back — and
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
      })
      .catch((detailErr: unknown) => {
        if (ac.signal.aborted) return;
        /* R1 resolves the run AND its doc together, so a doc that will not
           resolve (409 — deleted, or present but no longer parsing) would
           otherwise cost the operator the run's metadata, the node table and the
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

  /* U25 — ONE projection for the whole page. The graph below takes this same
     overlay rather than folding the log a second time inside its lazy chunk,
     and the node table reconciles against it, so neither surface can invent a
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

  /* #882 — the ONE name a node has in this view. The graph below reads the same
     `activityLabels` map off the same doc, so the table and the picture beside
     it cannot come to call one node two things.

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

  // U24 — which node's drill-in is open. Held as an ID and RESOLVED against the
  // live fold rather than storing the row itself, so the panel tracks a running
  // node's state as frames arrive, and a node that leaves the table (a different
  // run's log replacing this one) closes the panel by simply not resolving.
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  const openNode = useMemo(
    () => nodes.find((n) => n.nodeId === openNodeId) ?? null,
    [nodes, openNodeId],
  );
  /* #870 — the RUN's status and, when it is parked, WHY.
     U25's split of authority one level up, but the line falls in a DIFFERENT
     place here, and the two halves are each measured rather than assumed.

     THE PARK GOES TO THE ENGINE. The reducer un-parks only after the parked
     NODE's own guard passes — the node must still be at the attempt the event
     names — so a redelivered or superseded alarm no-ops and the run stays
     parked. The doc-free fold has no node state and cannot make that check, so
     it un-parks on any `timer.due`/`externalWait.*`. Measured, for
     `run.waiting → timer.due{stale attempt}`: reducer `waiting/waiting_timer`,
     fold `running`. The row stays `waiting` too, so preferring the fold would
     put this header at odds with the runs list — the exact drift #870 closes.

     THE TERMINAL STAYS WITH THE FOLD, and NOT for the reason a first pass here
     claimed. The reducer does fold `run.finished` into `RunState.status`
     (measured: a valid `…node.succeeded → run.finished{success}` log projects
     `success`) — an earlier note said otherwise, generalising from a log the
     reducer had REJECTED as impossible. What is true is narrower and is exactly
     the case that matters: the top-level fold guard admits only unpark events on
     a non-`running` run, so a terminal arriving on a PARKED run is not folded at
     all. Measured, `run.waiting → run.finished{failure}`: projection `waiting`,
     while `terminalFactFromLog` and the row both say `failure`. This fold reads
     terminals through `terminalStatusOf` — the same SSOT the server reads — so
     it agrees with the row where the projection would not.

     Hence: a terminal wins outright; otherwise the projection settles parked vs
     running when it is ready; otherwise the fold; otherwise the REST row. The
     one direction not handled is projection-`running` over fold-`waiting`, which
     cannot arise: the fold un-parks on a superset of the events the reducer
     does, never a subset. */
  const view = useMemo((): RunLifecycle | null => {
    if (lifecycle !== null && TERMINAL_RUN_STATUS.has(lifecycle.status)) return lifecycle;
    if (overlay.ready && overlay.state.status === 'waiting') {
      return { status: 'waiting', waitingReason: overlay.state.waitingReason };
    }
    return lifecycle;
  }, [lifecycle, overlay]);

  const status: RunStatus = view?.status ?? run?.status ?? 'pending';
  /* The REST row carries no park reason (`RunSchema` has no such column), so
     the fallback tail is `null` rather than a guess — see `runStatusLabel`. */
  const waitingReason = view?.waitingReason ?? null;
  /* Bound once so the lineage row below narrows without a non-null assertion —
     `run.rerunOf` inside a callback would not stay narrowed. */
  const rerunOf = run?.rerunOf ?? null;

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

  return (
    <section aria-labelledby="run-heading">
      <div className="page-header">
        <h2 id="run-heading">
          Run <code>{runId}</code>
        </h2>
        <button type="button" onClick={() => void navigate('/monitor/runs')}>
          ← All runs
        </button>
      </div>

      <p className="page-hint">
        <span className={`run-status run-status-${status}`}>
          {runStatusLabel(status, waitingReason)}
        </span>{' '}
        <span className={`stream-phase stream-phase-${stream.phase}`} role="status">
          {phaseLabel(stream.phase)}
        </span>
      </p>

      {/* RS2 — the rerun action, offered only on a run that FAILED. `status` is
          the page's one status value (the log's, falling back to the row), so the
          control appears on exactly what the header says failed. The spec's cost
          warning sits beside the button rather than behind a confirm: it is the
          fact an operator needs BEFORE deciding, and "Fire now" on the triggers
          page sets the precedent that starting work is a direct action here. */}
      {canRerunFromFailed(status) && (
        <div className="run-actions">
          <button type="button" onClick={() => void onRerun()} disabled={rerunning}>
            {rerunning ? 'Starting rerun…' : 'Rerun from failed'}
          </button>
          <span className="page-hint">{RERUN_COST_WARNING}</span>
        </div>
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

      {run && (
        <dl className="run-meta">
          <dt>Pipeline version</dt>
          <dd>
            <code>{run.pipelineVersionId}</code>
          </dd>
          <dt>Trigger</dt>
          <dd>{run.triggerId ? <code>{run.triggerId}</code> : '—'}</dd>
          {/* RS6 lineage — shown only when there IS a source run. `rerunOf` is
              the durable row projection of `run.started.rerunOf`, written in the
              same transaction as the reseed pair, so it cannot disagree with the
              log. A row reading "—" on every ordinary run would be noise; the
              absence of this row is what "not a rerun" looks like.

              This is the LINK half only. The copied-vs-executed render — a
              copied frontier node saying "reused from run R1" rather than a
              plain "success" — is the rest of RS6 and is NOT built here; see
              #438. */}
          {rerunOf !== null && (
            <>
              <dt>Rerun of</dt>
              <dd>
                <button type="button" onClick={() => void navigate(runDetailPath(rerunOf))}>
                  <code>{rerunOf}</code>
                </button>
              </dd>
            </>
          )}
          <dt>Started</dt>
          <dd>{formatWhen(run.startedAt)}</dd>
          <dt>Finished</dt>
          <dd>{formatWhen(run.finishedAt)}</dd>
          <dt>Params</dt>
          <dd>
            <code>{JSON.stringify(run.params)}</code>
          </dd>
        </dl>
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

      <h3>Graph</h3>
      {doc === null ? (
        <p>
          {loadError === null
            ? 'Loading the pipeline graph…'
            : 'The pipeline graph is unavailable, so there is no node overlay. The event feed below is unaffected.'}
        </p>
      ) : (
        /* #698 — React Flow loads on demand, so the run metadata, node table
           and event feed below paint without waiting on it. The boundary is
           HERE rather than at the route for that reason: all of that is useful
           without the graph. The engine reducer used to sit behind this
           boundary too and no longer does (U25 lifted the projection to the
           page so the table could reconcile against it) — which changed no
           bytes, because eager code already imported the engine barrel and
           `reduce.js` was placed in the entry chunk regardless. */
        <Suspense fallback={<p className="page-hint">Loading the graph…</p>}>
          <RunGraph doc={doc} overlay={overlay} />
        </Suspense>
      )}

      <h3>Nodes</h3>
      {nodes.length === 0 ? (
        <p>No node activity yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Node</th>
              <th scope="col">Status</th>
              <th scope="col">Attempts</th>
              {/* #867 — wall clock for the node's LATEST attempt. The full
                  sentence lives in the drill-in panel, where there is room to
                  say what it includes; a header cannot carry it, and a `title`
                  on a `th` is not reliably announced. */}
              <th scope="col">Duration</th>
              <th scope="col">Outputs</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => {
              /* U24 — the failure CLASS beside the message. `""` when the
                 failure carries none, which is a real state (an expired
                 external wait), so it renders as nothing rather than a guess. */
              const cls = failureClass(n.failureKind, n.failureCode);
              /* One lookup per row, read twice below: the button renders the
                 name, and the sibling `<code>` exists only when there IS one. */
              const name = nameOf(n.nodeId);
              return (
                <tr key={n.nodeId}>
                  <td>
                    {/* A real <button> rather than a clickable/aria-ified <tr>:
                        it takes its accessible name from its own content for
                        free and is keyboard-operable without inventing key
                        handling.

                        #882 — the button's content is the NAME, and the raw id
                        sits beside it rather than inside it. Text inside a button
                        joins its accessible name, so an id in here would make
                        every row announce "HTTP Request 1 n_7c44a16f-98f1-…".
                        Outside, the visible label and the accessible name are one
                        string, and the id is still on screen — which it must be,
                        because it is the only thing
                        that matches the `${nodes.<id>.output.…}` expressions in
                        the doc and the ids in the event feed below. */}
                    <button
                      type="button"
                      className="node-drill-in"
                      aria-expanded={openNodeId === n.nodeId}
                      aria-controls={openNodeId === n.nodeId ? PANEL_ID : undefined}
                      onClick={() => setOpenNodeId(openNodeId === n.nodeId ? null : n.nodeId)}
                    >
                      {name ?? <code>{n.nodeId}</code>}
                    </button>
                    {name !== null && <code className="node-id">{n.nodeId}</code>}
                  </td>
                  <td>
                    {/* U25 — the word comes from `nodeStatus.ts`, which the
                        graph reads too, so the two surfaces cannot describe one
                        node differently. The CLASS stays keyed on the raw
                        status: the graph's six tones put a retry backoff and a
                        routine park in one `holding` hue, and #483 established
                        that those must not share a colour here. */}
                    <span className={`node-status node-status-${n.status}`}>
                      {nodeStatusLabel(n.status)}
                    </span>
                  </td>
                  <td>{n.attempts}</td>
                  <td className="node-duration">{formatNodeDuration(n)}</td>
                  <td>{n.outputs}</td>
                  <td>
                    {n.error !== undefined
                      ? cls === ''
                        ? n.error
                        : `${n.error} (${cls})`
                      : n.lastOutputName
                        ? `output: ${n.lastOutputName}`
                        : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {openNode !== null && (
        <NodeActivityPanel
          node={openNode}
          name={nameOf(openNode.nodeId)}
          onClose={() => setOpenNodeId(null)}
        />
      )}

      <h3>Events</h3>
      {totalEvents === 0 ? (
        <p>No events yet.</p>
      ) : (
        <table className="event-feed">
          <thead>
            <tr>
              <th scope="col">Seq</th>
              <th scope="col">Time</th>
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
                <td>{formatClock(e.ts)}</td>
                <td>
                  <code>{e.type}</code>
                </td>
                <td>{eventGloss(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
